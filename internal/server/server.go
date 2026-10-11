package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"workbench/internal/terminal"
	"workbench/internal/tmux"
	"workbench/internal/websocket"
	webassets "workbench/web"
)

type Server struct {
	tmux            tmux.Client
	logger          *slog.Logger
	static          fs.FS
	filesystemRoot  string
	groupStore      *groupStore
	gitRunner       string
	gitAssociations *gitAssociationStore
	gitPRMu         sync.Mutex
	gitPRCache      map[string]cachedGitPR
	gitPRFlights    map[string]*gitPRFlight
	createMu        sync.Mutex
	fileWriteMu     sync.Mutex
}

type resizeMessage struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type renameSessionRequest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type createSessionRequest struct {
	Path string `json:"path"`
}

func New(tmuxBinary string, logger *slog.Logger) http.Handler {
	return NewWithFilesystemRoot(tmuxBinary, logger, "")
}

// NewWithFilesystemRoot serves session files from filesystemRoot when it is
// configured. This supports host-tmux deployments that expose the host tree
// read-only at a path such as /host inside the web container.
func NewWithFilesystemRoot(tmuxBinary string, logger *slog.Logger, filesystemRoot string) http.Handler {
	handler, err := newHandler(tmuxBinary, logger, filesystemRoot, newMemoryGroupStore(), newMemoryGitAssociationStore(), "")
	if err != nil {
		panic(err)
	}
	return handler
}

// NewWithOptions creates a handler with persisted daemon-wide workspace groups.
// Initialization errors are returned so the executable can fail at startup
// instead of silently discarding or resetting saved state.
func NewWithOptions(tmuxBinary string, logger *slog.Logger, filesystemRoot, stateDir string) (http.Handler, error) {
	return NewWithGitOptions(tmuxBinary, logger, filesystemRoot, stateDir, "")
}

// NewWithGitOptions adds optional host Git and GitHub CLI execution to the
// persistent handler. The runner receives the tool name, logical repository
// path, and arguments as separate arguments.
func NewWithGitOptions(tmuxBinary string, logger *slog.Logger, filesystemRoot, stateDir, gitRunner string) (http.Handler, error) {
	store, err := newPersistentGroupStore(stateDir)
	if err != nil {
		return nil, err
	}
	associations, err := newPersistentGitAssociationStore(stateDir)
	if err != nil {
		return nil, err
	}
	return newHandler(tmuxBinary, logger, filesystemRoot, store, associations, gitRunner)
}

func newHandler(tmuxBinary string, logger *slog.Logger, filesystemRoot string, store *groupStore, associations *gitAssociationStore, gitRunner string) (http.Handler, error) {
	static, err := fs.Sub(webassets.Files, "dist")
	if err != nil {
		return nil, err
	}
	server := &Server{
		tmux:            tmux.Client{Binary: tmuxBinary},
		logger:          logger,
		static:          static,
		filesystemRoot:  filesystemRoot,
		groupStore:      store,
		gitRunner:       gitRunner,
		gitAssociations: associations,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", server.health)
	mux.HandleFunc("GET /api/sessions", server.sessions)
	mux.HandleFunc("GET /api/groups", server.groups)
	mux.HandleFunc("PUT /api/groups", server.groups)
	mux.HandleFunc("GET /api/git", server.gitStatus)
	mux.HandleFunc("GET /api/git/pr/changes", server.gitPRChanges)
	mux.HandleFunc("GET /api/git/pr/diff", server.gitPRDiff)
	mux.HandleFunc("GET /api/git/recommendations", server.gitRecommendations)
	mux.HandleFunc("PUT /api/git/association", server.gitAssociation)
	mux.HandleFunc("GET /api/git/diff", server.gitDiff)
	mux.HandleFunc("GET /api/files", server.files)
	mux.HandleFunc("GET /api/file", server.file)
	mux.HandleFunc("PUT /api/file", server.saveFile)
	mux.HandleFunc("POST /api/file/create", server.createFile)
	mux.HandleFunc("POST /api/file/upload", server.uploadFile)
	mux.HandleFunc("GET /api/file/image", server.fileImage)
	mux.HandleFunc("POST /api/sessions", server.createSession)
	mux.HandleFunc("PATCH /api/sessions/rename", server.renameSession)
	mux.HandleFunc("GET /api/capture", server.capture)
	mux.HandleFunc("GET /ws", server.connect)
	mux.HandleFunc("/", server.frontend)
	return securityHeaders(mux), nil
}

func (s *Server) capture(writer http.ResponseWriter, request *http.Request) {
	session := request.URL.Query().Get("session")
	if session == "" {
		writeError(writer, http.StatusBadRequest, "A tmux session is required")
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	exists, err := s.tmux.Has(ctx, session)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "Unable to read tmux sessions")
		return
	}
	if !exists {
		writeError(writer, http.StatusNotFound, "The tmux session no longer exists")
		return
	}
	content, err := s.tmux.Capture(ctx, session)
	if err != nil {
		s.logger.Debug("failed to capture tmux pane", "session", session, "error", err)
		writeError(writer, http.StatusServiceUnavailable, "Unable to capture the tmux pane")
		return
	}
	if len(content) > 8<<20 {
		writeError(writer, http.StatusRequestEntityTooLarge, "The tmux pane history is too large")
		return
	}
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(content)
}

func (s *Server) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) sessions(writer http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	sessions, err := s.tmux.List(ctx)
	if err != nil {
		s.logger.Error("failed to list tmux sessions", "error", err)
		writeError(writer, http.StatusServiceUnavailable, "Unable to read tmux sessions")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"sessions": sessions})
}

func (s *Server) createSession(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "Request origin is not allowed")
		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, 8<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input createSessionRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(writer, http.StatusBadRequest, "Invalid create request")
		return
	}
	if err := ensureJSONEnd(decoder); err != nil {
		writeError(writer, http.StatusBadRequest, "Invalid create request")
		return
	}
	workingDirectory, message := validateSessionPath(input.Path)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}

	s.createMu.Lock()
	defer s.createMu.Unlock()
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	for attempt := 0; attempt < 3; attempt++ {
		sessions, err := s.tmux.List(ctx)
		if err != nil {
			s.logger.Error("failed to list tmux sessions before create", "error", err)
			writeError(writer, http.StatusServiceUnavailable, "Unable to read tmux sessions")
			return
		}
		name := nextNumericSessionName(sessions)
		session, err := s.tmux.Create(ctx, name, workingDirectory)
		if errors.Is(err, tmux.ErrSessionExists) {
			continue
		}
		if err != nil {
			s.logger.Error("failed to create tmux session", "name", name, "path", workingDirectory, "error", err)
			writeError(writer, http.StatusServiceUnavailable, "Unable to create the tmux session in that directory")
			return
		}
		writeJSON(writer, http.StatusCreated, map[string]any{"session": session})
		return
	}
	writeError(writer, http.StatusConflict, "Could not allocate an unused numeric session name")
}

func nextNumericSessionName(sessions []tmux.Session) string {
	used := make(map[int]struct{}, len(sessions))
	for _, session := range sessions {
		value, err := strconv.Atoi(session.Name)
		if err == nil && value >= 0 && strconv.Itoa(value) == session.Name {
			used[value] = struct{}{}
		}
	}
	for candidate := 0; ; candidate++ {
		if _, exists := used[candidate]; !exists {
			return strconv.Itoa(candidate)
		}
	}
}

func validateSessionPath(value string) (string, string) {
	if value == "" {
		return "", "A working directory is required"
	}
	if !utf8.ValidString(value) || len(value) > 4096 {
		return "", "Working directories must be valid UTF-8 paths up to 4096 bytes"
	}
	if strings.TrimSpace(value) != value {
		return "", "Working directories cannot start or end with whitespace"
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", "Working directories cannot contain control characters"
		}
	}
	if !filepath.IsAbs(value) {
		return "", "Working directories must be absolute paths"
	}
	return filepath.Clean(value), ""
}

func (s *Server) renameSession(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "Request origin is not allowed")
		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, 4<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input renameSessionRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(writer, http.StatusBadRequest, "Invalid rename request")
		return
	}
	if err := ensureJSONEnd(decoder); err != nil {
		writeError(writer, http.StatusBadRequest, "Invalid rename request")
		return
	}
	if input.ID == "" {
		writeError(writer, http.StatusBadRequest, "A tmux session is required")
		return
	}
	if message := validateSessionName(input.Name); message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	sessions, err := s.tmux.List(ctx)
	if err != nil {
		s.logger.Error("failed to list tmux sessions before rename", "error", err)
		writeError(writer, http.StatusServiceUnavailable, "Unable to read tmux sessions")
		return
	}

	var current *tmux.Session
	for index := range sessions {
		session := &sessions[index]
		if session.ID == input.ID {
			current = session
		}
		if session.Name == input.Name && session.ID != input.ID {
			writeError(writer, http.StatusConflict, "A tmux session with that name already exists")
			return
		}
	}
	if current == nil {
		writeError(writer, http.StatusNotFound, "The tmux session no longer exists")
		return
	}
	if current.Name == input.Name {
		writeJSON(writer, http.StatusOK, map[string]string{"id": input.ID, "name": input.Name})
		return
	}

	if err := s.tmux.Rename(ctx, input.ID, input.Name); err != nil {
		switch {
		case errors.Is(err, tmux.ErrSessionExists):
			writeError(writer, http.StatusConflict, "A tmux session with that name already exists")
		case errors.Is(err, tmux.ErrSessionNotFound):
			writeError(writer, http.StatusNotFound, "The tmux session no longer exists")
		default:
			s.logger.Error("failed to rename tmux session", "session_id", input.ID, "error", err)
			writeError(writer, http.StatusServiceUnavailable, "Unable to rename the tmux session")
		}
		return
	}

	writeJSON(writer, http.StatusOK, map[string]string{"id": input.ID, "name": input.Name})
}

func validateSessionName(name string) string {
	if name == "" {
		return "A session name is required"
	}
	if !utf8.ValidString(name) || len([]rune(name)) > 100 {
		return "Session names must be at most 100 characters"
	}
	if strings.TrimSpace(name) != name {
		return "Session names cannot start or end with whitespace"
	}
	for _, character := range name {
		if unicode.IsControl(character) {
			return "Session names cannot contain control characters"
		}
	}
	return ""
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("unexpected data after JSON object")
	}
	return err
}

func (s *Server) connect(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "WebSocket origin is not allowed")
		return
	}
	session := request.URL.Query().Get("session")
	if session == "" {
		writeError(writer, http.StatusBadRequest, "A tmux session is required")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	exists, err := s.tmux.Has(ctx, session)
	cancel()
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "Unable to read tmux sessions")
		return
	}
	if !exists {
		writeError(writer, http.StatusNotFound, "The tmux session no longer exists")
		return
	}

	columns, rows := dimensions(request.URL.Query())
	pty, err := terminal.Attach(s.tmux.Binary, session, columns, rows)
	if err != nil {
		s.logger.Error("failed to attach tmux session", "session", session, "error", err)
		writeError(writer, http.StatusInternalServerError, "Unable to attach the tmux session")
		return
	}
	defer pty.Close()

	connection, err := websocket.Upgrade(writer, request)
	if err != nil {
		s.logger.Warn("websocket upgrade failed", "error", err)
		return
	}
	defer connection.Close()
	s.logger.Info("tmux browser client connected", "session", session)
	defer s.logger.Info("tmux browser client disconnected", "session", session)

	outputDone := make(chan error, 1)
	go func() {
		buffer := make([]byte, 32*1024)
		for {
			count, readErr := pty.Read(buffer)
			if count > 0 {
				if writeErr := connection.WriteMessage(websocket.OpBinary, buffer[:count]); writeErr != nil {
					outputDone <- writeErr
					return
				}
			}
			if readErr != nil {
				outputDone <- readErr
				return
			}
		}
	}()

	inputDone := make(chan error, 1)
	go func() {
		for {
			opcode, payload, readErr := connection.ReadMessage()
			if readErr != nil {
				inputDone <- readErr
				return
			}
			switch opcode {
			case websocket.OpBinary:
				if _, writeErr := pty.Write(payload); writeErr != nil {
					inputDone <- writeErr
					return
				}
			case websocket.OpText:
				if controlErr := applyControlMessage(pty, payload); controlErr != nil {
					s.logger.Debug("ignored invalid terminal control message", "error", controlErr)
				}
			}
		}
	}()

	select {
	case err := <-outputDone:
		if !isNormalDisconnect(err) {
			s.logger.Debug("terminal output ended", "session", session, "error", err)
		}
	case err := <-inputDone:
		if !isNormalDisconnect(err) {
			s.logger.Debug("terminal input ended", "session", session, "error", err)
		}
	}
}

func (s *Server) frontend(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		writeError(writer, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	filePath := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
	if filePath == "." || filePath == "" {
		filePath = "index.html"
	}
	file, err := s.static.Open(filePath)
	if err != nil {
		filePath = "index.html"
		file, err = s.static.Open(filePath)
	}
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.IsDir() {
		http.NotFound(writer, request)
		return
	}
	if filePath == "manifest.webmanifest" {
		writer.Header().Set("Content-Type", "application/manifest+json")
	} else if contentType := mime.TypeByExtension(path.Ext(filePath)); contentType != "" {
		writer.Header().Set("Content-Type", contentType)
	}
	if filePath == "index.html" || filePath == "sw.js" || filePath == "manifest.webmanifest" {
		writer.Header().Set("Cache-Control", "no-cache")
	} else if strings.Contains(filePath, "assets/") {
		writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(writer, request, stat.Name(), stat.ModTime(), file.(io.ReadSeeker))
}

func applyControlMessage(pty *terminal.PTY, payload []byte) error {
	var message resizeMessage
	if err := json.Unmarshal(payload, &message); err != nil {
		return err
	}
	if message.Type != "resize" {
		return fmt.Errorf("unsupported control message %q", message.Type)
	}
	if message.Cols < 2 || message.Cols > 500 || message.Rows < 1 || message.Rows > 300 {
		return errors.New("terminal dimensions are outside the supported range")
	}
	return pty.Resize(uint16(message.Cols), uint16(message.Rows))
}

func dimensions(query url.Values) (uint16, uint16) {
	columns := boundedDimension(query.Get("cols"), 120, 2, 500)
	rows := boundedDimension(query.Get("rows"), 32, 1, 300)
	return uint16(columns), uint16(rows)
}

func boundedDimension(value string, fallback, minimum, maximum int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		return fallback
	}
	return parsed
}

func sameOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Host, request.Host) && (parsed.Scheme == "http" || parsed.Scheme == "https")
}

func isNormalDisconnect(err error) bool {
	return err == nil || errors.Is(err, websocket.ErrClosed) || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; font-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(writer, request)
	})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}
