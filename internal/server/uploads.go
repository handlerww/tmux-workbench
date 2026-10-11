package server

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"
	"unsafe"
)

const maxUploadBytes = 50 << 20

type fileUploadResponse struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func (s *Server) uploadFile(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "Request origin is not allowed")
		return
	}
	query := request.URL.Query()
	sessionID := query.Get("session")
	expectedRoot := query.Get("root")
	directoryPath, message := cleanRelativeFilePath(query.Get("directory"), true)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	name, validName := uploadFileName(query.Get("name"))
	if !validName {
		writeError(writer, http.StatusBadRequest, "A plain filename is required")
		return
	}
	if sessionID == "" || expectedRoot == "" {
		writeError(writer, http.StatusBadRequest, "A tmux session and expected root are required")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxUploadBytes)

	ctx := request.Context()
	session, logicalRoot, err := s.fileSession(ctx, sessionID)
	if err != nil {
		writeFileError(writer, err)
		return
	}
	if filepath.Clean(expectedRoot) != logicalRoot {
		writeJSON(writer, http.StatusConflict, map[string]string{
			"error": "The session directory changed; reload before uploading",
			"root":  logicalRoot,
		})
		return
	}
	root, err := s.openSessionRoot(session)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer root.Close()
	parent, err := openFileParent(root, directoryPath)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer parent.Close()
	parentInfo, err := parent.Stat()
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if !parentInfo.IsDir() {
		writeError(writer, http.StatusBadRequest, "Upload destination is not a directory")
		return
	}
	temporaryName, temporary, err := createSaveTemp(parent)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	keepTemporary := true
	defer func() {
		_ = temporary.Close()
		if keepTemporary {
			_ = syscall.Unlinkat(int(parent.Fd()), temporaryName)
		}
	}()
	written, err := io.Copy(temporary, request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(writer, http.StatusRequestEntityTooLarge, "Uploads are limited to 50 MiB per file")
			return
		}
		if ctx.Err() != nil {
			writeError(writer, http.StatusRequestTimeout, "Upload was cancelled")
			return
		}
		writeError(writer, http.StatusBadRequest, "Unable to read upload body")
		return
	}
	if written > maxUploadBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "Uploads are limited to 50 MiB per file")
		return
	}
	if ctx.Err() != nil {
		writeError(writer, http.StatusRequestTimeout, "Upload was cancelled")
		return
	}
	if err := temporary.Sync(); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	directoryStat, ok := parentInfo.Sys().(*syscall.Stat_t)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "Unable to preserve destination ownership")
		return
	}
	if err := syscall.Fchown(int(temporary.Fd()), int(directoryStat.Uid), int(directoryStat.Gid)); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if err := syscall.Fchmod(int(temporary.Fd()), 0o644); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if err := temporary.Sync(); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if err := temporary.Close(); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if ctx.Err() != nil {
		writeError(writer, http.StatusRequestTimeout, "Upload was cancelled")
		return
	}
	currentSession, currentRoot, err := s.fileSession(ctx, sessionID)
	if err != nil {
		writeFileError(writer, err)
		return
	}
	if currentRoot != logicalRoot {
		writeJSON(writer, http.StatusConflict, map[string]string{
			"error": "The session directory changed; reload before uploading",
			"root":  currentRoot,
		})
		return
	}
	if ctx.Err() != nil {
		writeError(writer, http.StatusRequestTimeout, "Upload was cancelled")
		return
	}
	currentFSRoot, err := s.openSessionRoot(currentSession)
	if err != nil {
		writeError(writer, http.StatusConflict, "The upload destination changed; reload before uploading")
		return
	}
	defer currentFSRoot.Close()
	currentParent, err := openFileParent(currentFSRoot, directoryPath)
	if err != nil {
		writeError(writer, http.StatusConflict, "The upload destination changed; reload before uploading")
		return
	}
	defer currentParent.Close()
	currentParentInfo, err := currentParent.Stat()
	if err != nil || !os.SameFile(parentInfo, currentParentInfo) {
		writeError(writer, http.StatusConflict, "The upload destination changed; reload before uploading")
		return
	}
	if ctx.Err() != nil {
		writeError(writer, http.StatusRequestTimeout, "Upload was cancelled")
		return
	}
	if err := linkNoReplaceAt(parent, temporaryName, name); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			writeError(writer, http.StatusConflict, "A file with that name already exists")
			return
		}
		writeFileSystemError(writer, err)
		return
	}
	if err := syscall.Unlinkat(int(parent.Fd()), temporaryName); err != nil {
		// The published file is valid; leave cleanup of the private temporary
		// hardlink to the deferred cleanup path.
		writeFileSystemError(writer, err)
		return
	}
	keepTemporary = false
	_ = syscall.Fsync(int(parent.Fd()))
	writeJSON(writer, http.StatusCreated, fileUploadResponse{
		Root: logicalRoot,
		Path: path.Join(directoryPath, name),
		Name: name,
		Size: written,
	})
}

func uploadFileName(value string) (string, bool) {
	if value == "" || value == "." || value == ".." || len(value) > 255 || !utf8.ValidString(value) || strings.ContainsAny(value, "/\\") {
		return "", false
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return "", false
		}
	}
	return value, true
}

// linkNoReplaceAt publishes a completed temporary file using a directory fd.
// linkat is atomic and fails with EEXIST instead of replacing any destination.
func linkNoReplaceAt(directory *os.File, oldName, newName string) error {
	oldPointer, err := syscall.BytePtrFromString(oldName)
	if err != nil {
		return err
	}
	newPointer, err := syscall.BytePtrFromString(newName)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(syscall.SYS_LINKAT,
		uintptr(directory.Fd()), uintptr(unsafe.Pointer(oldPointer)),
		uintptr(directory.Fd()), uintptr(unsafe.Pointer(newPointer)), 0, 0)
	if errno != 0 {
		return fmt.Errorf("link upload into destination: %w", errno)
	}
	return nil
}
