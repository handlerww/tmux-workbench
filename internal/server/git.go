package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
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
	gitCommandTimeout = 6 * time.Second
	gitStatusMaxBytes = 2 << 20
	gitDiffMaxBytes   = 1 << 20
	gitMaxChanges     = 2000
	gitRecommendLimit = 50
	gitScanMaxDirs    = 10000
	gitScanMaxEntries = 100000
	gitMaxRepoMarkers = 500
	gitScanMaxDepth   = 64
	gitScanTimeout    = 5 * time.Second
)

var skippedGitSearchDirectories = map[string]struct{}{
	".cache": {}, ".next": {}, ".nuxt": {}, ".pytest_cache": {}, ".tox": {},
	".turbo": {}, "__pycache__": {}, "coverage": {}, "node_modules": {},
	"venv": {}, ".venv": {},
}

var errGitOutputLimit = errors.New("Git command output exceeded its limit")

type gitRepositoryInfo struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Head   string `json:"head"`
	Ahead  int    `json:"ahead"`
	Behind int    `json:"behind"`
}

type gitChange struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"`
	Staged    bool   `json:"staged"`
	Unstaged  bool   `json:"unstaged"`
	Untracked bool   `json:"untracked"`
}

type gitPRData struct {
	Number              int             `json:"number"`
	Title               string          `json:"title"`
	URL                 string          `json:"url"`
	State               string          `json:"state"`
	IsDraft             bool            `json:"isDraft"`
	BaseRefName         string          `json:"baseRefName"`
	HeadRefName         string          `json:"headRefName"`
	HeadRefOID          string          `json:"headRefOid"`
	HeadRepositoryOwner *gitGHOOwner    `json:"headRepositoryOwner,omitempty"`
	ReviewDecision      string          `json:"reviewDecision,omitempty"`
	StatusCheckRollup   json.RawMessage `json:"statusCheckRollup,omitempty"`
	UpdatedAt           time.Time       `json:"updatedAt"`
}

type gitGHOOwner struct {
	Login string `json:"login"`
}

type gitPR struct {
	Status  string     `json:"status"`
	Message string     `json:"message,omitempty"`
	Data    *gitPRData `json:"data,omitempty"`
}

type cachedGitPR struct {
	pr        gitPR
	expiresAt time.Time
}

type gitPRFlight struct {
	done   chan struct{}
	result gitPR
}

type gitStatusResponse struct {
	Session         string             `json:"session"`
	Repository      *gitRepositoryInfo `json:"repository"`
	RepositoryError string             `json:"repositoryError,omitempty"`
	Association     gitAssociation     `json:"association"`
	Changes         []gitChange        `json:"changes"`
	PR              gitPR              `json:"pr"`
}

type gitAssociationRequest struct {
	Session  string  `json:"session"`
	Path     *string `json:"path"`
	Revision string  `json:"revision"`
}

type gitDiffResponse struct {
	Path       string `json:"path"`
	Repository string `json:"repository"`
	Original   string `json:"original"`
	Modified   string `json:"modified"`
	Language   string `json:"language"`
	Binary     bool   `json:"binary"`
	Truncated  bool   `json:"truncated"`
}

type gitRepositoryRecommendation struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

func (s *Server) gitStatus(writer http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), gitCommandTimeout)
	defer cancel()
	session, _, err := s.fileSession(ctx, request.URL.Query().Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	response, status, err := s.readGitStatus(ctx, session)
	if err != nil {
		writeError(writer, status, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (s *Server) readGitStatus(ctx context.Context, session tmux.Session) (gitStatusResponse, int, error) {
	response := gitStatusResponse{
		Session:     session.ID,
		Association: s.gitAssociations.get(session.ID),
		Changes:     []gitChange{},
		PR:          gitPR{Status: "none"},
	}
	if response.Association.Path == nil {
		return response, http.StatusOK, nil
	}
	repositoryPath, found, err := s.findRepositoryRoot(ctx, *response.Association.Path)
	if err != nil {
		return gitStatusResponse{}, http.StatusServiceUnavailable, errors.New("Unable to inspect the Git repository")
	}
	if !found {
		response.RepositoryError = "The manually associated Git repository is unavailable"
		return response, http.StatusOK, nil
	}
	info, err := s.repositoryInfo(ctx, repositoryPath)
	if err != nil {
		return gitStatusResponse{}, http.StatusServiceUnavailable, errors.New("Unable to read Git repository status")
	}
	response.Repository = &info
	changes, err := s.repositoryChanges(ctx, repositoryPath)
	if err != nil {
		return gitStatusResponse{}, http.StatusServiceUnavailable, errors.New("Unable to read Git repository changes")
	}
	response.Changes = changes
	response.PR = s.pullRequest(ctx, repositoryPath, info.Branch, info.Head)
	return response, http.StatusOK, nil
}

func (s *Server) gitAssociation(writer http.ResponseWriter, request *http.Request) {
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "Request origin is not allowed")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, 16<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input gitAssociationRequest
	if err := decoder.Decode(&input); err != nil || ensureJSONEnd(decoder) != nil {
		writeError(writer, http.StatusBadRequest, "Invalid Git association request")
		return
	}
	if input.Revision == "" || len(input.Revision) != 64 || strings.ToLower(input.Revision) != input.Revision {
		writeError(writer, http.StatusBadRequest, "A lowercase SHA-256 association revision is required")
		return
	}
	if _, err := hex.DecodeString(input.Revision); err != nil {
		writeError(writer, http.StatusBadRequest, "A lowercase SHA-256 association revision is required")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), gitCommandTimeout)
	defer cancel()
	session, _, err := s.fileSession(ctx, input.Session)
	if err != nil {
		writeFileError(writer, err)
		return
	}
	if input.Path != nil {
		if err := validateLogicalRepositoryPath(*input.Path); err != nil {
			writeError(writer, http.StatusBadRequest, "Repository paths must be clean absolute paths")
			return
		}
		root, found, err := s.findRepositoryRoot(ctx, *input.Path)
		if err != nil {
			writeError(writer, http.StatusServiceUnavailable, "Unable to inspect the Git repository")
			return
		}
		if !found || root != *input.Path {
			writeError(writer, http.StatusBadRequest, "The selected path is not a Git repository root")
			return
		}
		input.Path = stringPointer(root)
	}
	association, updated, err := s.gitAssociations.set(session.ID, input.Revision, input.Path)
	if err != nil {
		s.logger.Error("failed to persist Git repository association", "error", err)
		writeError(writer, http.StatusInternalServerError, "Unable to save the Git repository association")
		return
	}
	status := http.StatusOK
	if !updated {
		status = http.StatusConflict
	}
	response := map[string]any{"session": session.ID, "association": association}
	if status == http.StatusConflict {
		response["error"] = "The Git association changed; review the current association before retrying"
	}
	writeJSON(writer, status, response)
}

func (s *Server) gitRecommendations(writer http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 8*time.Second)
	defer cancel()
	session, _, err := s.fileSession(ctx, request.URL.Query().Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	query := strings.TrimSpace(request.URL.Query().Get("q"))
	if len(query) > 256 {
		writeError(writer, http.StatusBadRequest, "Repository search text is too long")
		return
	}
	rootPath := filepath.Clean(session.Path)
	repositories, truncated := s.discoverScopedRepositories(ctx, rootPath, query)
	writeJSON(writer, http.StatusOK, map[string]any{"root": rootPath, "repositories": repositories, "truncated": truncated})
}

type gitSearchDirectory struct {
	relative string
	depth    int
	prune    bool
}

type gitSearchCandidate struct {
	path  string
	depth int
}

func (s *Server) discoverScopedRepositories(ctx context.Context, rootPath, query string) ([]gitRepositoryRecommendation, bool) {
	root, err := s.openLogicalRoot(rootPath)
	if err != nil {
		return []gitRepositoryRecommendation{}, true
	}
	defer root.Close()
	query = strings.TrimSpace(query)
	absRepositoryQuery := ""
	words := strings.Fields(strings.ToLower(query))
	queue := []gitSearchDirectory{{relative: ".", depth: 0}}
	candidates := make([]gitSearchCandidate, 0, 64)
	truncated := false
	if filepath.IsAbs(query) {
		absQuery := filepath.Clean(query)
		relative, relErr := filepath.Rel(rootPath, absQuery)
		if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return []gitRepositoryRecommendation{}, false
		}
		if repository, found, findErr := s.findRepositoryRoot(ctx, absQuery); findErr == nil && found {
			if relativeRepository, pathErr := filepath.Rel(rootPath, repository); pathErr == nil && relativeRepository != ".." && !strings.HasPrefix(relativeRepository, ".."+string(filepath.Separator)) {
				if repositoryRoot, openErr := root.OpenRoot(relativeRepository); openErr == nil {
					if hasGitMarker(repositoryRoot) {
						absRepositoryQuery = repository
					}
					_ = repositoryRoot.Close()
				}
			}
		} else if findErr != nil {
			truncated = true
		}
	}
	// Leave time to validate discovered roots even when a large tree reaches
	// the enumeration budget, so partial results remain useful.
	scanCtx, cancelScan := context.WithTimeout(ctx, gitScanTimeout)
	defer cancelScan()
	directoriesSeen, entriesSeen, markerCount := 0, 0, 0
	for index := 0; index < len(queue); index++ {
		if scanCtx.Err() != nil {
			truncated = true
			break
		}
		if directoriesSeen >= gitScanMaxDirs {
			truncated = true
			break
		}
		node := queue[index]
		directoriesSeen++
		directoryRoot, err := root.OpenRoot(node.relative)
		if err != nil {
			truncated = true
			continue
		}
		if hasGitMarker(directoryRoot) {
			markerCount++
			if markerCount > gitMaxRepoMarkers {
				truncated = true
				_ = directoryRoot.Close()
				break
			}
			logicalPath := rootPath
			if node.relative != "." {
				logicalPath = filepath.Join(rootPath, node.relative)
			}
			candidates = append(candidates, gitSearchCandidate{path: logicalPath, depth: node.depth})
		}
		if node.prune {
			_ = directoryRoot.Close()
			continue
		}
		opened, err := directoryRoot.Open(".")
		if err != nil {
			truncated = true
			_ = directoryRoot.Close()
			continue
		}
		for {
			if scanCtx.Err() != nil {
				truncated = true
				break
			}
			entries, readErr := opened.ReadDir(256)
			for _, entry := range entries {
				entriesSeen++
				if entriesSeen > gitScanMaxEntries {
					truncated = true
					break
				}
				name := entry.Name()
				if name == ".git" || !utf8.ValidString(name) || entry.Type()&os.ModeSymlink != 0 {
					continue
				}
				isDirectory := entry.IsDir()
				if entry.Type()&os.ModeType == 0 {
					info, infoErr := entry.Info()
					if infoErr != nil {
						truncated = true
						continue
					}
					if info.Mode()&os.ModeSymlink != 0 {
						continue
					}
					isDirectory = info.IsDir()
				}
				if !isDirectory {
					continue
				}
				if node.depth >= gitScanMaxDepth {
					truncated = true
					continue
				}
				relative := name
				if node.relative != "." {
					relative = filepath.Join(node.relative, name)
				}
				_, prune := skippedGitSearchDirectories[strings.ToLower(name)]
				queue = append(queue, gitSearchDirectory{relative: relative, depth: node.depth + 1, prune: prune})
			}
			if entriesSeen > gitScanMaxEntries {
				break
			}
			if errors.Is(readErr, io.EOF) {
				break
			}
			if readErr != nil {
				truncated = true
				break
			}
		}
		_ = opened.Close()
		_ = directoryRoot.Close()
		if entriesSeen > gitScanMaxEntries {
			break
		}
	}
	if absRepositoryQuery != "" {
		candidateExists := false
		for _, candidate := range candidates {
			if candidate.path == absRepositoryQuery {
				candidateExists = true
				break
			}
		}
		if !candidateExists {
			if relative, err := filepath.Rel(rootPath, absRepositoryQuery); err == nil {
				candidates = append(candidates, gitSearchCandidate{path: absRepositoryQuery, depth: pathDepth(relative)})
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].depth != candidates[j].depth {
			return candidates[i].depth < candidates[j].depth
		}
		return candidates[i].path < candidates[j].path
	})
	repositories := make([]gitRepositoryRecommendation, 0, gitRecommendLimit)
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			truncated = true
			break
		}
		if !repositorySearchMatches(candidate.path, query, words, absRepositoryQuery) {
			continue
		}
		validatedRoot, found, err := s.findRepositoryRoot(ctx, candidate.path)
		if err != nil {
			truncated = true
			break
		}
		if !found || validatedRoot != candidate.path {
			continue
		}
		if len(repositories) == gitRecommendLimit {
			truncated = true
			break
		}
		source := "descendant"
		if candidate.depth == 0 {
			source = "cwd"
		}
		repositories = append(repositories, gitRepositoryRecommendation{Path: candidate.path, Source: source})
	}
	return repositories, truncated
}

func hasGitMarker(directory *os.Root) bool {
	opened, err := directory.Open(".")
	if err != nil {
		return false
	}
	defer opened.Close()
	fd, err := syscall.Openat(int(opened.Fd()), ".git", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	marker := os.NewFile(uintptr(fd), ".git")
	defer marker.Close()
	info, err := marker.Stat()
	return err == nil && (info.IsDir() || info.Mode().IsRegular())
}

func pathDepth(relative string) int {
	if relative == "." || relative == "" {
		return 0
	}
	return len(strings.Split(filepath.Clean(relative), string(filepath.Separator)))
}

func repositorySearchMatches(repositoryPath, query string, words []string, absoluteRepository string) bool {
	if absoluteRepository != "" {
		return absoluteRepository == repositoryPath
	}
	pathLower := strings.ToLower(repositoryPath)
	for _, word := range words {
		if !strings.Contains(pathLower, word) {
			return false
		}
	}
	return true
}

func (s *Server) gitDiff(writer http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), gitCommandTimeout)
	defer cancel()
	session, _, err := s.fileSession(ctx, request.URL.Query().Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	repository := request.URL.Query().Get("repository")
	if err := validateLogicalRepositoryPath(repository); err != nil {
		writeError(writer, http.StatusBadRequest, "A repository path is required")
		return
	}
	kind := request.URL.Query().Get("kind")
	if kind != "staged" && kind != "unstaged" && kind != "untracked" {
		writeError(writer, http.StatusBadRequest, "Diff kind must be staged, unstaged, or untracked")
		return
	}
	relativePath, message := cleanRelativeFilePath(request.URL.Query().Get("path"), false)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	oldRelativePath := ""
	if request.URL.Query().Get("oldPath") != "" {
		oldRelativePath, message = cleanRelativeFilePath(request.URL.Query().Get("oldPath"), false)
		if message != "" {
			writeError(writer, http.StatusBadRequest, message)
			return
		}
	}
	association := s.gitAssociations.get(session.ID)
	if association.Path == nil {
		writeError(writer, http.StatusConflict, "This session has no manually associated Git repository")
		return
	}
	actualRoot, found, err := s.findRepositoryRoot(ctx, repository)
	if err != nil || !found || actualRoot != repository {
		writeError(writer, http.StatusConflict, "The selected Git repository is no longer available")
		return
	}
	resolvedRoot, currentFound, err := s.findRepositoryRoot(ctx, *association.Path)
	if err != nil || !currentFound || resolvedRoot != repository {
		writeError(writer, http.StatusConflict, "The selected Git repository is no longer associated with this session")
		return
	}
	changes, err := s.repositoryChanges(ctx, repository)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "Unable to read Git repository changes")
		return
	}
	changeFound := false
	matchedChange := gitChange{}
	for _, change := range changes {
		if change.Path != filepath.ToSlash(relativePath) || oldRelativePath != "" && change.OldPath != filepath.ToSlash(oldRelativePath) {
			continue
		}
		switch kind {
		case "staged":
			changeFound = change.Staged
		case "unstaged":
			changeFound = change.Unstaged
		case "untracked":
			changeFound = change.Untracked
		}
		if changeFound {
			matchedChange = change
			break
		}
	}
	if !changeFound {
		writeError(writer, http.StatusNotFound, "The selected path no longer has that Git change")
		return
	}
	if oldRelativePath == "" && matchedChange.OldPath != "" {
		oldRelativePath = filepath.FromSlash(matchedChange.OldPath)
	}
	original, modified, err := s.readDiffContents(ctx, repository, relativePath, oldRelativePath, kind)
	if err != nil {
		var limit outputLimitError
		if errors.As(err, &limit) {
			writeError(writer, http.StatusRequestEntityTooLarge, "Git file previews are limited to 1 MiB")
		} else {
			writeError(writer, http.StatusBadRequest, "Unable to read the selected Git diff")
		}
		return
	}
	binary := bytes.IndexByte(original, 0) >= 0 || bytes.IndexByte(modified, 0) >= 0 || !utf8.Valid(original) || !utf8.Valid(modified)
	truncated := len(original) > gitDiffMaxBytes || len(modified) > gitDiffMaxBytes
	if len(original) > gitDiffMaxBytes {
		original = original[:gitDiffMaxBytes]
	}
	if len(modified) > gitDiffMaxBytes {
		modified = modified[:gitDiffMaxBytes]
	}
	if binary {
		original = nil
		modified = nil
	}
	writeJSON(writer, http.StatusOK, gitDiffResponse{
		Path:       filepath.ToSlash(relativePath),
		Repository: repository,
		Original:   string(original),
		Modified:   string(modified),
		Language:   monacoLanguage(relativePath),
		Binary:     binary,
		Truncated:  truncated,
	})
}

func (s *Server) findRepositoryRoot(ctx context.Context, workingDirectory string) (string, bool, error) {
	if !filepath.IsAbs(workingDirectory) {
		return "", false, nil
	}
	output, err := s.runGitCommand(ctx, workingDirectory, "git", "rev-parse", "--show-toplevel")
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || errors.Is(err, exec.ErrNotFound) {
			return "", false, err
		}
		return "", false, nil
	}
	root := strings.TrimSpace(string(output))
	if !filepath.IsAbs(root) {
		return "", false, errors.New("Git returned a non-absolute repository path")
	}
	return filepath.Clean(root), true, nil
}

func (s *Server) repositoryInfo(ctx context.Context, repository string) (gitRepositoryInfo, error) {
	branchBytes, err := s.runGitCommand(ctx, repository, "git", "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		branchBytes, err = s.runGitCommand(ctx, repository, "git", "symbolic-ref", "--quiet", "--short", "HEAD")
		if err != nil {
			branchBytes = []byte("HEAD")
		}
	}
	headBytes, headErr := s.runGitCommand(ctx, repository, "git", "rev-parse", "--verify", "HEAD")
	branch := strings.TrimSpace(string(branchBytes))
	if headErr != nil {
		if strings.TrimSpace(branch) == "" {
			branch = "unborn"
		}
		headBytes = nil
	}
	info := gitRepositoryInfo{Path: repository, Branch: branch, Head: strings.TrimSpace(string(headBytes))}
	counts, countErr := s.runGitCommand(ctx, repository, "git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
	if countErr == nil {
		fields := strings.Fields(string(counts))
		if len(fields) == 2 {
			info.Behind, _ = strconvAtoi(fields[0])
			info.Ahead, _ = strconvAtoi(fields[1])
		}
	}
	return info, nil
}

func (s *Server) repositoryChanges(ctx context.Context, repository string) ([]gitChange, error) {
	output, err := s.runGitCommand(ctx, repository, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--renames")
	if err != nil {
		return nil, err
	}
	fields := bytes.Split(output, []byte{0})
	changes := make([]gitChange, 0, min(len(fields), gitMaxChanges))
	for index := 0; index < len(fields); index++ {
		field := fields[index]
		if len(field) < 4 || field[2] != ' ' {
			if len(field) == 0 {
				continue
			}
			return nil, errors.New("invalid Git status output")
		}
		x, y := field[0], field[1]
		untracked := x == '?' && y == '?'
		change := gitChange{Path: string(field[3:]), Staged: x != ' ' && x != '?', Unstaged: y != ' ' && y != '?', Untracked: untracked}
		change.Status = string([]byte{x, y})
		if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
			if index+1 < len(fields) {
				index++
				change.OldPath = string(fields[index])
			}
		}
		changes = append(changes, change)
		if len(changes) >= gitMaxChanges {
			break
		}
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	return changes, nil
}

func (s *Server) pullRequest(ctx context.Context, repository, branch, head string) gitPR {
	if branch == "" || branch == "HEAD" || branch == "unborn" || head == "" {
		return gitPR{Status: "none"}
	}
	cacheKey := repository + "\x00" + branch + "\x00" + head
	s.gitPRMu.Lock()
	if cached, exists := s.gitPRCache[cacheKey]; exists && time.Now().Before(cached.expiresAt) {
		s.gitPRMu.Unlock()
		return cached.pr
	}
	if flight, exists := s.gitPRFlights[cacheKey]; exists {
		s.gitPRMu.Unlock()
		select {
		case <-ctx.Done():
			return gitPR{Status: "error", Message: "Pull request lookup timed out"}
		case <-flight.done:
			return flight.result
		}
	}
	if s.gitPRFlights == nil {
		s.gitPRFlights = map[string]*gitPRFlight{}
	}
	flight := &gitPRFlight{done: make(chan struct{})}
	s.gitPRFlights[cacheKey] = flight
	s.gitPRMu.Unlock()
	authCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	var result gitPR
	output, err := s.runGitCommand(authCtx, repository, "gh", "pr", "view", "--json", "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepositoryOwner,reviewDecision,statusCheckRollup,updatedAt")
	if err != nil {
		var commandErr gitCommandError
		if errors.As(err, &commandErr) && strings.Contains(strings.ToLower(commandErr.stderr), "no pull requests found") {
			result = gitPR{Status: "none"}
		} else if errors.As(err, &commandErr) && isGHAuthenticationError(commandErr.stderr) {
			result = gitPR{Status: "unavailable", Message: "GitHub CLI is not authenticated"}
		} else if errors.Is(err, exec.ErrNotFound) {
			result = gitPR{Status: "unavailable", Message: "GitHub CLI is unavailable"}
		} else {
			result = gitPR{Status: "error", Message: "Unable to read pull request metadata"}
		}
	} else {
		var data gitPRData
		if err := json.Unmarshal(output, &data); err != nil || data.Number == 0 {
			result = gitPR{Status: "error", Message: "GitHub CLI returned invalid pull request metadata"}
		} else if data.HeadRefName != branch || data.State != "OPEN" && data.HeadRefOID != head {
			result = gitPR{Status: "none"}
		} else {
			result = gitPR{Status: "ready", Data: &data}
		}
	}
	s.gitPRMu.Lock()
	if s.gitPRCache == nil {
		s.gitPRCache = map[string]cachedGitPR{}
	}
	s.gitPRCache[cacheKey] = cachedGitPR{pr: result, expiresAt: time.Now().Add(30 * time.Second)}
	flight.result = result
	delete(s.gitPRFlights, cacheKey)
	close(flight.done)
	s.gitPRMu.Unlock()
	return result
}

func isGHAuthenticationError(stderr string) bool {
	message := strings.ToLower(stderr)
	return strings.Contains(message, "not logged into") ||
		strings.Contains(message, "authentication required") ||
		strings.Contains(message, "gh auth login") ||
		strings.Contains(message, "no oauth token")
}

func (s *Server) readDiffContents(ctx context.Context, repository, relativePath, oldRelativePath, kind string) ([]byte, []byte, error) {
	var original, modified []byte
	var err error
	switch kind {
	case "staged":
		headPath := relativePath
		if oldRelativePath != "" {
			headPath = oldRelativePath
		}
		original, err = s.showBlob(ctx, repository, "HEAD", headPath)
		if err != nil && !errors.Is(err, errGitObjectMissing) {
			return nil, nil, err
		}
		if errors.Is(err, errGitObjectMissing) {
			original = nil
		}
		modified, err = s.showBlob(ctx, repository, ":", relativePath)
		if err != nil && !errors.Is(err, errGitObjectMissing) {
			return nil, nil, err
		}
		if errors.Is(err, errGitObjectMissing) {
			modified = nil
		}
	case "unstaged":
		modified, err = s.readWorkingTreeFile(repository, relativePath)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, nil, err
		}
		if errors.Is(err, os.ErrNotExist) {
			modified = nil
		}
		original, err = s.showBlob(ctx, repository, ":", relativePath)
		if errors.Is(err, errGitObjectMissing) {
			original, err = s.showBlob(ctx, repository, "HEAD", relativePath)
		}
		if errors.Is(err, errGitObjectMissing) {
			original = nil
			err = nil
		}
		if err != nil {
			return nil, nil, err
		}
	case "untracked":
		modified, err = s.readWorkingTreeFile(repository, relativePath)
		if err != nil {
			return nil, nil, err
		}
	}
	return original, modified, nil
}

var errGitObjectMissing = errors.New("Git object is not present")

func (s *Server) showBlob(ctx context.Context, repository, revision, relativePath string) ([]byte, error) {
	object := revision
	if strings.HasPrefix(revision, ":") {
		object += relativePath
	} else {
		object += ":" + relativePath
	}
	output, err := s.runGitCommand(ctx, repository, "git", "show", object)
	if err != nil {
		var commandErr gitCommandError
		if errors.As(err, &commandErr) && isMissingGitObjectError(commandErr.stderr) {
			return nil, errGitObjectMissing
		}
		return nil, err
	}
	return output, nil
}

func isMissingGitObjectError(stderr string) bool {
	message := strings.ToLower(stderr)
	return strings.Contains(message, "does not exist in the index") ||
		strings.Contains(message, "does not exist (neither on disk nor in the index)") ||
		strings.Contains(message, "exists on disk, but not in") ||
		strings.Contains(message, "invalid object name 'head'") ||
		strings.Contains(message, "not a valid object name") ||
		strings.Contains(message, "pathspec") && strings.Contains(message, "did not match")
}

func (s *Server) readWorkingTreeFile(repository, relativePath string) ([]byte, error) {
	root, err := s.openLogicalRoot(repository)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	components := strings.Split(filepath.Clean(filepath.FromSlash(relativePath)), string(filepath.Separator))
	parent := root
	var openedParent *os.Root
	for _, component := range components[:len(components)-1] {
		openedParent, err = parent.OpenRoot(component)
		if err != nil {
			if parent != root {
				_ = parent.Close()
			}
			return nil, err
		}
		if parent != root {
			_ = parent.Close()
		}
		parent = openedParent
	}
	if parent != root {
		defer parent.Close()
	}
	directory, err := parent.Open(".")
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	fd, err := syscall.Openat(int(directory.Fd()), components[len(components)-1], syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), relativePath)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errNotRegular
	}
	limited := &boundedBuffer{limit: gitDiffMaxBytes + 1}
	if _, err := io.Copy(limited, file); err != nil && !errors.Is(err, errGitOutputLimit) {
		return nil, err
	}
	return limited.Bytes(), nil
}

func (s *Server) openLogicalRoot(logicalPath string) (*os.Root, error) {
	if !filepath.IsAbs(logicalPath) {
		return nil, os.ErrNotExist
	}
	if s.filesystemRoot == "" {
		return os.OpenRoot(filepath.Clean(logicalPath))
	}
	if !filepath.IsAbs(s.filesystemRoot) {
		return nil, errors.New("filesystem root must be an absolute path")
	}
	hostRoot, err := os.OpenRoot(filepath.Clean(s.filesystemRoot))
	if err != nil {
		return nil, err
	}
	relativeRoot := strings.TrimLeft(filepath.Clean(logicalPath), string(filepath.Separator))
	if relativeRoot == "" {
		relativeRoot = "."
	}
	root, err := hostRoot.OpenRoot(relativeRoot)
	_ = hostRoot.Close()
	return root, err
}

func (s *Server) runGitCommand(ctx context.Context, repository, tool string, arguments ...string) ([]byte, error) {
	commandCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	var command *exec.Cmd
	if s.gitRunner != "" {
		commandArguments := make([]string, 0, len(arguments)+12)
		commandArguments = append(commandArguments, tool, repository)
		if tool == "git" {
			commandArguments = append(commandArguments, gitSafetyArguments()...)
		}
		commandArguments = append(commandArguments, arguments...)
		command = exec.CommandContext(commandCtx, s.gitRunner, commandArguments...)
	} else {
		commandArguments := arguments
		if tool == "git" {
			commandArguments = append(gitSafetyArguments(), arguments...)
		}
		command = exec.CommandContext(commandCtx, tool, commandArguments...)
		command.Dir = repository
	}
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		return syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
	stderr := &boundedBuffer{limit: 8192}
	command.Stderr = stderr
	output := &boundedBuffer{limit: gitStatusMaxBytes}
	command.Stdout = output
	if err := command.Run(); err != nil {
		if errors.Is(output.err, errGitOutputLimit) {
			return output.Bytes(), outputLimitError{}
		}
		return output.Bytes(), gitCommandError{err: err, stderr: stderr.String()}
	}
	if errors.Is(output.err, errGitOutputLimit) {
		return output.Bytes(), outputLimitError{}
	}
	return output.Bytes(), nil
}

type gitCommandError struct {
	err    error
	stderr string
}

func (err gitCommandError) Error() string { return err.err.Error() }
func (err gitCommandError) Unwrap() error { return err.err }

func gitSafetyArguments() []string {
	return []string{"-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "diff.external=", "-c", "core.pager=cat", "-c", "color.ui=false"}
}

type boundedBuffer struct {
	bytes.Buffer
	limit int
	err   error
}

func (buffer *boundedBuffer) Write(value []byte) (int, error) {
	if buffer.err != nil {
		return 0, buffer.err
	}
	remaining := buffer.limit - buffer.Len()
	if len(value) > remaining {
		if remaining > 0 {
			_, _ = buffer.Buffer.Write(value[:remaining])
		}
		buffer.err = errGitOutputLimit
		return remaining, buffer.err
	}
	return buffer.Buffer.Write(value)
}

type outputLimitError struct{}

func (outputLimitError) Error() string { return "command output exceeded limit" }

func strconvAtoi(value string) (int, error) {
	return strconv.Atoi(value)
}
