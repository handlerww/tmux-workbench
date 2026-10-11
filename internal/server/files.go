package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"workbench/internal/tmux"
)

const (
	maxPreviewBytes     = 2 << 20
	maxImageBytes       = 10 << 20
	maxDirectoryEntries = 1000
)

var (
	errFileTooLarge = errors.New("file exceeds the text edit limit")
	errNotRegular   = errors.New("path is not a regular file")
)

type fileEntry struct {
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	Type        string    `json:"type"`
	Size        int64     `json:"size"`
	ModifiedAt  time.Time `json:"modifiedAt"`
	PreviewType string    `json:"previewType,omitempty"`
}

type fileListResponse struct {
	Root      string      `json:"root"`
	Path      string      `json:"path"`
	Entries   []fileEntry `json:"entries"`
	Truncated bool        `json:"truncated,omitempty"`
}

type fileResponse struct {
	Root     string `json:"root"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	Content  string `json:"content"`
	Language string `json:"language"`
	Size     int64  `json:"size"`
	Revision string `json:"revision"`
}

type saveFileRequest struct {
	Session  string `json:"session"`
	Root     string `json:"root,omitempty"`
	Path     string `json:"path"`
	Content  string `json:"content"`
	Revision string `json:"revision"`
}

func (s *Server) files(writer http.ResponseWriter, request *http.Request) {
	session, logicalRoot, err := s.fileSession(request.Context(), request.URL.Query().Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	relativePath, message := cleanRelativeFilePath(request.URL.Query().Get("path"), true)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}

	root, err := s.openSessionRoot(session)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer root.Close()

	pathInfo, err := root.Stat(relativePath)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if !pathInfo.IsDir() {
		writeError(writer, http.StatusBadRequest, "The requested path is not a directory")
		return
	}
	directory, err := root.OpenFile(relativePath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if !info.IsDir() {
		writeError(writer, http.StatusBadRequest, "The requested path is not a directory")
		return
	}

	response := fileListResponse{Root: logicalRoot, Path: relativePath, Entries: make([]fileEntry, 0)}
	for len(response.Entries) <= maxDirectoryEntries {
		batch, readErr := directory.ReadDir(128)
		for _, entry := range batch {
			entryPath := path.Join(relativePath, entry.Name())
			entryInfo, statErr := root.Stat(entryPath)
			if statErr != nil || (!entryInfo.IsDir() && !entryInfo.Mode().IsRegular()) {
				// Broken/outside symlinks and special files are deliberately hidden.
				continue
			}
			if len(response.Entries) >= maxDirectoryEntries {
				response.Truncated = true
				break
			}
			typeName := "file"
			if entryInfo.IsDir() {
				typeName = "directory"
			}
			previewEntry := fileEntry{
				Name:       entry.Name(),
				Path:       entryPath,
				Type:       typeName,
				Size:       entryInfo.Size(),
				ModifiedAt: entryInfo.ModTime().UTC(),
			}
			if typeName == "file" && isImageFileName(entry.Name()) {
				previewEntry.PreviewType = "image"
			}
			response.Entries = append(response.Entries, previewEntry)
		}
		if response.Truncated || errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			writeFileSystemError(writer, readErr)
			return
		}
	}
	sort.Slice(response.Entries, func(i, j int) bool {
		if response.Entries[i].Type != response.Entries[j].Type {
			return response.Entries[i].Type == "directory"
		}
		return strings.ToLower(response.Entries[i].Name) < strings.ToLower(response.Entries[j].Name)
	})
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) file(writer http.ResponseWriter, request *http.Request) {
	session, logicalRoot, err := s.fileSession(request.Context(), request.URL.Query().Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	relativePath, message := cleanRelativeFilePath(request.URL.Query().Get("path"), false)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}

	root, err := s.openSessionRoot(session)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer root.Close()

	pathInfo, err := root.Stat(relativePath)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if !pathInfo.Mode().IsRegular() {
		writeError(writer, http.StatusBadRequest, "Only regular files can be previewed")
		return
	}
	file, err := root.OpenFile(relativePath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if !info.Mode().IsRegular() {
		writeError(writer, http.StatusBadRequest, "Only regular files can be previewed")
		return
	}
	if info.Size() > maxPreviewBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "File previews are limited to 2 MiB")
		return
	}
	content, err := io.ReadAll(io.LimitReader(file, maxPreviewBytes+1))
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if len(content) > maxPreviewBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "File previews are limited to 2 MiB")
		return
	}
	if bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		writeError(writer, http.StatusUnsupportedMediaType, "Binary files cannot be previewed")
		return
	}
	writeJSON(writer, http.StatusOK, fileResponse{
		Root:     logicalRoot,
		Path:     relativePath,
		Name:     path.Base(relativePath),
		Content:  string(content),
		Language: monacoLanguage(relativePath),
		Size:     int64(len(content)),
		Revision: fileRevision(content),
	})
}

func (s *Server) saveFile(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "Request origin is not allowed")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxPreviewBytes*6+(16<<10))
	body, err := io.ReadAll(request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(writer, http.StatusRequestEntityTooLarge, "Save request is too large")
			return
		}
		writeError(writer, http.StatusBadRequest, "Invalid save request")
		return
	}
	if !utf8.Valid(body) {
		writeError(writer, http.StatusBadRequest, "Save request must be valid UTF-8 JSON")
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var input saveFileRequest
	if err := decoder.Decode(&input); err != nil || ensureJSONEnd(decoder) != nil {
		writeError(writer, http.StatusBadRequest, "Invalid save request")
		return
	}
	if input.Session == "" {
		writeError(writer, http.StatusBadRequest, "A tmux session is required")
		return
	}
	relativePath, message := cleanRelativeFilePath(input.Path, false)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	content := []byte(input.Content)
	if len(content) > maxPreviewBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "Text files are limited to 2 MiB")
		return
	}
	if !utf8.Valid(content) || bytes.IndexByte(content, 0) >= 0 {
		writeError(writer, http.StatusUnsupportedMediaType, "Only UTF-8 text files can be edited")
		return
	}
	expectedRevision, err := hex.DecodeString(input.Revision)
	if err != nil || len(expectedRevision) != sha256.Size {
		writeError(writer, http.StatusBadRequest, "A SHA-256 file revision is required")
		return
	}

	s.fileWriteMu.Lock()
	defer s.fileWriteMu.Unlock()
	session, logicalRoot, err := s.fileSession(request.Context(), input.Session)
	if err != nil {
		writeFileError(writer, err)
		return
	}
	if input.Root != "" && filepath.Clean(input.Root) != logicalRoot {
		writeJSON(writer, http.StatusConflict, map[string]string{
			"error": "The session directory changed; reload before saving",
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

	parentPath := path.Dir(filepath.ToSlash(relativePath))
	baseName := path.Base(filepath.ToSlash(relativePath))
	parent, err := openFileParent(root, parentPath)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer parent.Close()

	current, currentInfo, err := readRegularFileAt(parent, baseName)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if len(current) > maxPreviewBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "Text files are limited to 2 MiB")
		return
	}
	if !utf8.Valid(current) || bytes.IndexByte(current, 0) >= 0 {
		writeError(writer, http.StatusUnsupportedMediaType, "Only UTF-8 text files can be edited")
		return
	}
	currentRevision := fileRevision(current)
	if input.Revision != currentRevision {
		writeSaveConflict(writer, currentRevision)
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
	if _, err := temporary.Write(content); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if err := temporary.Sync(); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	stat, ok := currentInfo.Sys().(*syscall.Stat_t)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "Unable to preserve file ownership")
		return
	}
	if err := syscall.Fchown(int(temporary.Fd()), int(stat.Uid), int(stat.Gid)); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if err := syscall.Fchmod(int(temporary.Fd()), uint32(currentInfo.Mode().Perm())); err != nil {
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

	latest, latestInfo, err := readRegularFileAt(parent, baseName)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	latestRevision := fileRevision(latest)
	if !os.SameFile(currentInfo, latestInfo) || latestRevision != currentRevision {
		writeSaveConflict(writer, latestRevision)
		return
	}
	if err := syscall.Renameat(int(parent.Fd()), temporaryName, int(parent.Fd()), baseName); err != nil {
		writeFileSystemError(writer, err)
		return
	}
	keepTemporary = false
	_ = syscall.Fsync(int(parent.Fd()))
	newRevision := fileRevision(content)
	writeJSON(writer, http.StatusOK, fileResponse{
		Root:     logicalRoot,
		Path:     relativePath,
		Name:     path.Base(relativePath),
		Content:  input.Content,
		Language: monacoLanguage(relativePath),
		Size:     int64(len(content)),
		Revision: newRevision,
	})
}

func (s *Server) fileImage(writer http.ResponseWriter, request *http.Request) {
	session, _, err := s.fileSession(request.Context(), request.URL.Query().Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	relativePath, message := cleanRelativeFilePath(request.URL.Query().Get("path"), false)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}

	root, err := s.openSessionRoot(session)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer root.Close()

	pathInfo, err := root.Stat(relativePath)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if !pathInfo.Mode().IsRegular() {
		writeError(writer, http.StatusBadRequest, "Only regular image files can be previewed")
		return
	}
	if pathInfo.Size() > maxImageBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "Image previews are limited to 10 MiB")
		return
	}
	file, err := root.OpenFile(relativePath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if !info.Mode().IsRegular() {
		writeError(writer, http.StatusBadRequest, "Only regular image files can be previewed")
		return
	}
	if info.Size() > maxImageBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "Image previews are limited to 10 MiB")
		return
	}
	content, err := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
	if err != nil {
		writeFileSystemError(writer, err)
		return
	}
	if len(content) > maxImageBytes {
		writeError(writer, http.StatusRequestEntityTooLarge, "Image previews are limited to 10 MiB")
		return
	}
	contentType := sniffImageContentType(content)
	if contentType == "" {
		writeError(writer, http.StatusUnsupportedMediaType, "Only PNG, JPEG, GIF, WebP, BMP, AVIF, and SVG images can be previewed")
		return
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Content-Length", strconv.Itoa(len(content)))
	writer.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": path.Base(relativePath)}))
	writer.Header().Set("Cache-Control", "no-store")
	if contentType == "image/svg+xml" {
		writer.Header().Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
	}
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(content)
}

func openFileParent(root *os.Root, parentPath string) (*os.File, error) {
	directory, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	if parentPath == "." {
		return directory, nil
	}
	for _, component := range strings.Split(parentPath, "/") {
		fd, openErr := syscall.Openat(int(directory.Fd()), component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr != nil {
			_ = directory.Close()
			return nil, openErr
		}
		_ = directory.Close()
		directory = os.NewFile(uintptr(fd), component)
	}
	return directory, nil
}

func readRegularFileAt(directory *os.File, name string) ([]byte, os.FileInfo, error) {
	fd, err := syscall.Openat(int(directory.Fd()), name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, info, errNotRegular
	}
	if info.Size() > maxPreviewBytes {
		return nil, info, errFileTooLarge
	}
	content, err := io.ReadAll(io.LimitReader(file, maxPreviewBytes+1))
	if err != nil {
		return nil, info, err
	}
	if len(content) > maxPreviewBytes {
		return nil, info, errFileTooLarge
	}
	return content, info, nil
}

func createSaveTemp(directory *os.File) (string, *os.File, error) {
	for attempt := 0; attempt < 8; attempt++ {
		var randomName [16]byte
		if _, err := rand.Read(randomName[:]); err != nil {
			return "", nil, err
		}
		name := ".workbench-save-" + hex.EncodeToString(randomName[:])
		fd, err := syscall.Openat(int(directory.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
		if errors.Is(err, syscall.EEXIST) {
			continue
		}
		if err != nil {
			return "", nil, err
		}
		return name, os.NewFile(uintptr(fd), name), nil
	}
	return "", nil, errors.New("could not allocate a temporary save file")
}

func fileRevision(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}

func writeSaveConflict(writer http.ResponseWriter, revision string) {
	writeJSON(writer, http.StatusConflict, map[string]string{
		"error":    "File changed on disk; reload before saving",
		"revision": revision,
	})
}

func (s *Server) fileSession(ctx context.Context, requested string) (tmux.Session, string, error) {
	if requested == "" {
		return tmux.Session{}, "", fileAPIError{status: http.StatusBadRequest, message: "A tmux session is required"}
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	sessions, err := s.tmux.List(ctx)
	if err != nil {
		s.logger.Error("failed to list tmux sessions for file access", "error", err)
		return tmux.Session{}, "", fileAPIError{status: http.StatusServiceUnavailable, message: "Unable to read tmux sessions"}
	}
	for _, session := range sessions {
		if session.ID == requested {
			return session, filepath.Clean(session.Path), nil
		}
	}
	for _, session := range sessions {
		if session.Name == requested {
			return session, filepath.Clean(session.Path), nil
		}
	}
	return tmux.Session{}, "", fileAPIError{status: http.StatusNotFound, message: "The tmux session no longer exists"}
}

func (s *Server) openSessionRoot(session tmux.Session) (*os.Root, error) {
	if !filepath.IsAbs(session.Path) {
		return nil, os.ErrNotExist
	}
	base := filepath.Clean(session.Path)
	if s.filesystemRoot != "" {
		if !filepath.IsAbs(s.filesystemRoot) {
			return nil, errors.New("filesystem root must be an absolute path")
		}
		hostRoot, err := os.OpenRoot(filepath.Clean(s.filesystemRoot))
		if err != nil {
			return nil, err
		}
		relativeRoot := strings.TrimLeft(filepath.Clean(session.Path), string(filepath.Separator))
		if relativeRoot == "" {
			relativeRoot = "."
		}
		root, err := hostRoot.OpenRoot(relativeRoot)
		_ = hostRoot.Close()
		return root, err
	}
	return os.OpenRoot(base)
}

func cleanRelativeFilePath(value string, allowRoot bool) (string, string) {
	if value == "" && allowRoot {
		return ".", ""
	}
	if value == "" {
		return "", "A relative file path is required"
	}
	if !utf8.ValidString(value) || len(value) > 4096 || strings.ContainsRune(value, '\x00') {
		return "", "File paths must be valid UTF-8 paths up to 4096 bytes"
	}
	if strings.Contains(value, `\`) {
		return "", "File paths must use forward slashes"
	}
	if path.IsAbs(value) {
		return "", "Absolute file paths are not allowed"
	}
	cleaned := path.Clean(value)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", "File paths cannot escape the session directory"
	}
	if cleaned == "." && !allowRoot {
		return "", "A file path is required"
	}
	return filepath.FromSlash(cleaned), ""
}

type fileAPIError struct {
	status  int
	message string
}

func (e fileAPIError) Error() string { return e.message }

func writeFileError(writer http.ResponseWriter, err error) {
	var apiError fileAPIError
	if errors.As(err, &apiError) {
		writeError(writer, apiError.status, apiError.message)
		return
	}
	writeFileSystemError(writer, err)
}

func writeFileSystemError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFileTooLarge):
		writeError(writer, http.StatusRequestEntityTooLarge, "Text files are limited to 2 MiB")
	case errors.Is(err, errNotRegular):
		writeError(writer, http.StatusBadRequest, "Only regular files can be edited")
	case errors.Is(err, os.ErrNotExist):
		writeError(writer, http.StatusNotFound, "The requested file or directory does not exist")
	case errors.Is(err, os.ErrPermission):
		writeError(writer, http.StatusForbidden, "The requested file or directory cannot be accessed")
	default:
		writeError(writer, http.StatusBadRequest, "The requested path is not available")
	}
}

func monacoLanguage(filePath string) string {
	extension := strings.ToLower(filepath.Ext(filePath))
	if extension == ".d.ts" {
		return "typescript"
	}
	known := map[string]string{
		".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "csharp", ".css": "css",
		".go": "go", ".h": "cpp", ".html": "html", ".ini": "ini", ".java": "java",
		".js": "javascript", ".json": "json", ".jsx": "javascript", ".less": "less",
		".lua": "lua", ".md": "markdown", ".php": "php", ".py": "python", ".rb": "ruby",
		".rs": "rust", ".scss": "scss", ".sh": "shell", ".sql": "sql", ".toml": "toml",
		".ts": "typescript", ".tsx": "typescript", ".xml": "xml", ".yaml": "yaml", ".yml": "yaml",
	}
	if language, ok := known[extension]; ok {
		return language
	}
	if strings.EqualFold(filepath.Base(filePath), "dockerfile") {
		return "dockerfile"
	}
	if contentType := mime.TypeByExtension(extension); strings.Contains(contentType, "json") {
		return "json"
	}
	return "plaintext"
}

func isImageFileName(fileName string) bool {
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg":
		return true
	default:
		return false
	}
}

func sniffImageContentType(content []byte) string {
	switch {
	case len(content) >= 8 && bytes.Equal(content[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return "image/png"
	case len(content) >= 3 && content[0] == 0xff && content[1] == 0xd8 && content[2] == 0xff:
		return "image/jpeg"
	case len(content) >= 6 && (string(content[:6]) == "GIF87a" || string(content[:6]) == "GIF89a"):
		return "image/gif"
	case len(content) >= 12 && string(content[:4]) == "RIFF" && string(content[8:12]) == "WEBP":
		return "image/webp"
	case len(content) >= 2 && string(content[:2]) == "BM":
		return "image/bmp"
	case isAVIF(content):
		return "image/avif"
	case isSafeSVG(content):
		return "image/svg+xml"
	default:
		return ""
	}
}

func isSafeSVG(content []byte) bool {
	if !utf8.Valid(content) {
		return false
	}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	rootSeen := false
	rootIsSVG := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return rootSeen && rootIsSVG
		}
		if err != nil {
			return false
		}
		switch token := token.(type) {
		case xml.Directive:
			// Exclude DTDs so no entity declarations or external references are accepted.
			return false
		case xml.ProcInst:
			if token.Target != "xml" || rootSeen {
				return false
			}
		case xml.StartElement:
			if !rootSeen {
				rootSeen = true
				rootIsSVG = token.Name.Local == "svg" && (token.Name.Space == "" || token.Name.Space == "http://www.w3.org/2000/svg")
				if !rootIsSVG {
					return false
				}
			}
		}
	}
}

func isAVIF(content []byte) bool {
	if len(content) < 16 || string(content[4:8]) != "ftyp" {
		return false
	}
	boxSize := int64(binaryBigEndianUint32(content[:4]))
	if boxSize < 16 || boxSize > int64(len(content)) {
		return false
	}
	if isAVIFBrand(string(content[8:12])) {
		return true
	}
	for offset := 16; offset+4 <= int(boxSize); offset += 4 {
		brand := string(content[offset : offset+4])
		if isAVIFBrand(brand) {
			return true
		}
	}
	return false
}

func isAVIFBrand(brand string) bool {
	return brand == "avif" || brand == "avis"
}

func binaryBigEndianUint32(value []byte) uint32 {
	return uint32(value[0])<<24 | uint32(value[1])<<16 | uint32(value[2])<<8 | uint32(value[3])
}
