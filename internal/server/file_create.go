package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

type createFileRequest struct {
	Session string `json:"session"`
	Root    string `json:"root"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
}

type createFileResponse struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
	Root string `json:"root"`
}

func (s *Server) createFile(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "Request origin is not allowed")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 16<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input createFileRequest
	if err := decoder.Decode(&input); err != nil || ensureJSONEnd(decoder) != nil {
		writeError(writer, http.StatusBadRequest, "Invalid file creation request")
		return
	}
	if input.Session == "" || input.Root == "" {
		writeError(writer, http.StatusBadRequest, "A tmux session and expected root are required")
		return
	}
	if input.Kind != "file" && input.Kind != "directory" {
		writeError(writer, http.StatusBadRequest, "Kind must be file or directory")
		return
	}
	relativePath, message := cleanRelativeFilePath(input.Path, false)
	if message != "" || !validCreatePath(input.Path) {
		writeError(writer, http.StatusBadRequest, "A clean relative path is required")
		return
	}
	logicalPath := filepath.ToSlash(relativePath)
	parentPath := path.Dir(logicalPath)
	name := path.Base(logicalPath)

	session, logicalRoot, err := s.fileSession(request.Context(), input.Session)
	if err != nil {
		writeFileError(writer, err)
		return
	}
	if filepath.Clean(input.Root) != logicalRoot {
		writeJSON(writer, http.StatusConflict, map[string]string{
			"error": "The session directory changed; reload before creating a file",
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
	parent, err := openFileParent(root, parentPath)
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
		writeError(writer, http.StatusBadRequest, "The parent path is not a directory")
		return
	}
	if err := s.verifyCreateDestination(request, input.Session, logicalRoot, parentPath, parentInfo); err != nil {
		writeError(writer, http.StatusConflict, "The session directory or destination changed; reload and try again")
		return
	}
	createdInfo, err := createAt(parent, name, input.Kind, parentInfo)
	if err != nil {
		if errors.Is(err, syscall.EEXIST) {
			writeError(writer, http.StatusConflict, "A file or folder with that name already exists")
			return
		}
		writeFileSystemError(writer, err)
		return
	}
	if err := s.verifyCreateDestination(request, input.Session, logicalRoot, parentPath, parentInfo); err != nil {
		if cleanupErr := removeCreatedAt(parent, name, input.Kind, createdInfo); cleanupErr != nil {
			writeError(writer, http.StatusInternalServerError, "The destination changed and the new item could not be safely removed")
			return
		}
		writeError(writer, http.StatusConflict, "The session directory or destination changed; reload and try again")
		return
	}
	_ = syscall.Fsync(int(parent.Fd()))
	writeJSON(writer, http.StatusCreated, createFileResponse{
		Path: logicalPath,
		Kind: input.Kind,
		Root: logicalRoot,
	})
}

func validCreatePath(value string) bool {
	if value == "" || len(value) > 4096 || strings.Contains(value, `\`) || path.IsAbs(value) || path.Clean(value) != value || value == "." {
		return false
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || component == "." || component == ".." {
			return false
		}
	}
	return true
}

func (s *Server) verifyCreateDestination(request *http.Request, sessionID, logicalRoot, parentPath string, originalInfo os.FileInfo) error {
	if request.Context().Err() != nil {
		return request.Context().Err()
	}
	session, currentRoot, err := s.fileSession(request.Context(), sessionID)
	if err != nil || currentRoot != logicalRoot {
		return errors.New("session root changed")
	}
	root, err := s.openSessionRoot(session)
	if err != nil {
		return err
	}
	defer root.Close()
	parent, err := openFileParent(root, parentPath)
	if err != nil {
		return err
	}
	defer parent.Close()
	currentInfo, err := parent.Stat()
	if err != nil || !os.SameFile(originalInfo, currentInfo) {
		return errors.New("destination directory changed")
	}
	return nil
}

func createAt(parent *os.File, name, kind string, parentInfo os.FileInfo) (os.FileInfo, error) {
	parentStat, ok := parentInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, errors.New("unable to inspect parent ownership")
	}
	switch kind {
	case "file":
		fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o644)
		if err != nil {
			return nil, err
		}
		file := os.NewFile(uintptr(fd), name)
		keep := true
		defer func() {
			_ = file.Close()
			if keep {
				_ = syscall.Unlinkat(int(parent.Fd()), name)
			}
		}()
		if err := syscall.Fchown(fd, int(parentStat.Uid), int(parentStat.Gid)); err != nil {
			return nil, err
		}
		if err := syscall.Fchmod(fd, 0o644); err != nil {
			return nil, err
		}
		if err := file.Sync(); err != nil {
			return nil, err
		}
		createdInfo, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
		keep = false
		return createdInfo, nil
	case "directory":
		if err := syscall.Mkdirat(int(parent.Fd()), name, 0o755); err != nil {
			return nil, err
		}
		keep := true
		defer func() {
			if keep {
				_ = unlinkDirectoryAt(int(parent.Fd()), name)
			}
		}()
		fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		directory := os.NewFile(uintptr(fd), name)
		defer directory.Close()
		if err := syscall.Fchown(fd, int(parentStat.Uid), int(parentStat.Gid)); err != nil {
			return nil, err
		}
		mode := uint32(0o755)
		if parentStat.Mode&syscall.S_ISGID != 0 {
			mode |= syscall.S_ISGID
		}
		if err := syscall.Fchmod(fd, mode); err != nil {
			return nil, err
		}
		createdInfo, err := directory.Stat()
		if err != nil {
			return nil, err
		}
		keep = false
		return createdInfo, nil
	default:
		return nil, errors.New("unsupported creation kind")
	}
}

func removeCreatedAt(parent *os.File, name, kind string, expectedInfo os.FileInfo) error {
	flags := syscall.O_RDONLY | syscall.O_NONBLOCK | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	if kind == "directory" {
		flags |= syscall.O_DIRECTORY
	}
	fd, err := syscall.Openat(int(parent.Fd()), name, flags, 0)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ELOOP) {
			return nil
		}
		return err
	}
	item := os.NewFile(uintptr(fd), name)
	defer item.Close()
	actualInfo, err := item.Stat()
	if err != nil {
		return err
	}
	if !actualInfo.Mode().IsRegular() && kind == "file" || !actualInfo.IsDir() && kind == "directory" {
		return nil
	}
	if !os.SameFile(expectedInfo, actualInfo) {
		return nil
	}
	if kind == "directory" {
		return unlinkDirectoryAt(int(parent.Fd()), name)
	}
	return syscall.Unlinkat(int(parent.Fd()), name)
}

func unlinkDirectoryAt(directoryFD int, name string) error {
	namePointer, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_UNLINKAT, uintptr(directoryFD), uintptr(unsafe.Pointer(namePointer)), uintptr(0x200))
	if errno != 0 {
		return errno
	}
	return nil
}
