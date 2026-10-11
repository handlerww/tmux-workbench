package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	gitPRFilesPageSize = 100
	gitPRFilesLimit    = 500
	gitPRDiffMaxBytes  = 1 << 20
	gitPRAPITimeout    = 12 * time.Second
	gitPRFilesTTL      = 20 * time.Second
	gitPRFilesCacheMax = 128
)

type gitPRChangedFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

type gitPRChangesResponse struct {
	Session     string             `json:"session"`
	Association gitAssociation     `json:"association"`
	Repository  string             `json:"repository"`
	PR          gitPR              `json:"pr"`
	Status      string             `json:"status"`
	Message     string             `json:"message,omitempty"`
	Files       []gitPRChangedFile `json:"files"`
	Truncated   bool               `json:"truncated"`
	BaseSHA     string             `json:"baseSha,omitempty"`
	HeadSHA     string             `json:"headSha,omitempty"`
}

type gitPRDiffResponse struct {
	Path       string `json:"path"`
	Repository string `json:"repository"`
	Original   string `json:"original"`
	Modified   string `json:"modified"`
	Language   string `json:"language"`
	Binary     bool   `json:"binary"`
	Truncated  bool   `json:"truncated"`
	Number     int    `json:"number"`
	BaseSHA    string `json:"baseSha"`
	HeadSHA    string `json:"headSha"`
}

type githubPRIdentity struct {
	host  string
	owner string
	repo  string
}

type githubPRDetails struct {
	Number       int    `json:"number"`
	State        string `json:"state"`
	URL          string `json:"html_url"`
	MergeBaseSHA string `json:"mergeBaseSha"`
	Base         struct {
		SHA        string `json:"sha"`
		Ref        string `json:"ref"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"base"`
	Head struct {
		SHA        string `json:"sha"`
		Ref        string `json:"ref"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
}

type githubPRFile struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previous_filename"`
	Status           string `json:"status"`
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
}

type cachedPRFileList struct {
	files     []gitPRChangedFile
	truncated bool
	expires   time.Time
}

var githubPRFileCache = struct {
	sync.Mutex
	entries map[string]cachedPRFileList
}{entries: make(map[string]cachedPRFileList)}

func (s *Server) gitPRChanges(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(request.Context(), gitPRAPITimeout)
	defer cancel()
	view, err := s.currentGitPRView(ctx, request.URL.Query().Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	if view.association.Path == nil {
		view.response.Status = "none"
		view.response.Message = "This session has no manually associated Git repository"
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	if view.repositoryError != "" {
		view.response.Status = "unavailable"
		view.response.Message = view.repositoryError
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	if view.pr.Status != "ready" || view.pr.Data == nil {
		view.response.Status = view.pr.Status
		view.response.Message = view.pr.Message
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	identity, err := parseGitHubPRIdentity(view.pr.Data.URL, view.pr.Data.Number)
	if err != nil {
		view.response.Status = "error"
		view.response.Message = "Pull request URL is invalid"
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	details, err := s.fetchGitHubPRDetails(ctx, view.repository, identity, view.pr.Data.Number)
	if err != nil {
		view.response.Status, view.response.Message = gitHubAPIState(err)
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	if !prDetailsMatchCurrent(view.pr.Data, details) {
		view.response.Status = "error"
		view.response.Message = "The pull request changed; refresh and try again"
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	files, truncated, err := fetchGitHubPRFiles(ctx, s, view.repository, identity, details)
	if err != nil {
		view.response.Status, view.response.Message = gitHubAPIState(err)
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	latest, err := s.fetchGitHubPRDetails(ctx, view.repository, identity, view.pr.Data.Number)
	if err != nil || !prDetailsMatchCurrent(view.pr.Data, latest) || latest.Base.SHA != details.Base.SHA || latest.Head.SHA != details.Head.SHA || latest.MergeBaseSHA != details.MergeBaseSHA {
		view.response.Status = "error"
		view.response.Message = "The pull request changed while loading; refresh and try again"
		writeJSON(writer, http.StatusOK, view.response)
		return
	}
	if err := s.validateCurrentGitPRView(ctx, view); err != nil {
		writeError(writer, http.StatusConflict, "The Git repository association changed; reload pull request files")
		return
	}
	view.response.Status = "ready"
	view.response.Files = files
	view.response.Truncated = truncated
	view.response.BaseSHA = details.MergeBaseSHA
	view.response.HeadSHA = details.Head.SHA
	writeJSON(writer, http.StatusOK, view.response)
}

func (s *Server) gitPRDiff(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(request.Context(), gitPRAPITimeout)
	defer cancel()
	query := request.URL.Query()
	view, err := s.currentGitPRView(ctx, query.Get("session"))
	if err != nil {
		writeFileError(writer, err)
		return
	}
	if view.association.Path == nil || view.pr.Status != "ready" || view.pr.Data == nil {
		writeError(writer, http.StatusConflict, "This session has no current associated pull request")
		return
	}
	repository := query.Get("repository")
	if err := validateLogicalRepositoryPath(repository); err != nil {
		writeError(writer, http.StatusBadRequest, "A repository path is required")
		return
	}
	if repository != view.repository {
		writeError(writer, http.StatusConflict, "The selected repository is no longer associated with this session")
		return
	}
	number, err := strconv.Atoi(query.Get("number"))
	if err != nil || number <= 0 || number != view.pr.Data.Number {
		writeError(writer, http.StatusConflict, "The pull request number is stale")
		return
	}
	baseSHA, headSHA := query.Get("baseSha"), query.Get("headSha")
	if !validGitSHA(baseSHA) || !validGitSHA(headSHA) {
		writeError(writer, http.StatusBadRequest, "Valid baseSha and headSha values are required")
		return
	}
	relativePath, message := cleanRelativeFilePath(query.Get("path"), false)
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	oldRelativePath := ""
	if query.Get("oldPath") != "" {
		oldRelativePath, message = cleanRelativeFilePath(query.Get("oldPath"), false)
		if message != "" {
			writeError(writer, http.StatusBadRequest, message)
			return
		}
	}
	identity, err := parseGitHubPRIdentity(view.pr.Data.URL, view.pr.Data.Number)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "Pull request identity is unavailable")
		return
	}
	details, err := s.fetchGitHubPRDetails(ctx, repository, identity, number)
	if err != nil {
		_, text := gitHubAPIState(err)
		writeError(writer, http.StatusServiceUnavailable, text)
		return
	}
	if !prDetailsMatchCurrent(view.pr.Data, details) || details.MergeBaseSHA != baseSHA || details.Head.SHA != headSHA {
		writeError(writer, http.StatusConflict, "The pull request revisions changed; reload pull request files")
		return
	}
	files, _, err := fetchGitHubPRFiles(ctx, s, repository, identity, details)
	if err != nil {
		_, text := gitHubAPIState(err)
		writeError(writer, http.StatusServiceUnavailable, text)
		return
	}
	file, found := findPRFile(files, filepath.ToSlash(relativePath), filepath.ToSlash(oldRelativePath))
	if !found {
		writeError(writer, http.StatusNotFound, "The selected path is not part of the current pull request")
		return
	}
	originalPath := relativePath
	if file.OldPath != "" {
		originalPath, _ = cleanRelativeFilePath(file.OldPath, false)
	}
	original, originalTruncated := []byte(nil), false
	modified, modifiedTruncated := []byte(nil), false
	headIdentity, err := githubRepositoryIdentity(identity.host, details.Head.Repository.FullName)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "Pull request head repository is unavailable")
		return
	}
	if file.Status != "added" {
		original, originalTruncated, err = s.readGitHubPRFile(ctx, repository, identity, originalPath, baseSHA)
		if err != nil {
			writeError(writer, http.StatusServiceUnavailable, "Unable to read the pull request base file")
			return
		}
	}
	if file.Status != "removed" {
		modified, modifiedTruncated, err = s.readGitHubPRFile(ctx, repository, headIdentity, relativePath, headSHA)
		if err != nil {
			writeError(writer, http.StatusServiceUnavailable, "Unable to read the pull request head file")
			return
		}
	}
	truncated := originalTruncated || modifiedTruncated || len(original) > gitPRDiffMaxBytes || len(modified) > gitPRDiffMaxBytes
	if len(original) > gitPRDiffMaxBytes {
		original = original[:gitPRDiffMaxBytes]
	}
	if len(modified) > gitPRDiffMaxBytes {
		modified = modified[:gitPRDiffMaxBytes]
	}
	binary := !utf8.Valid(original) || !utf8.Valid(modified) || containsNUL(original) || containsNUL(modified)
	if binary {
		original, modified = nil, nil
	}
	latest, err := s.fetchGitHubPRDetails(ctx, repository, identity, number)
	if err != nil || !prDetailsMatchCurrent(view.pr.Data, latest) || latest.Base.SHA != details.Base.SHA || latest.Head.SHA != details.Head.SHA || latest.MergeBaseSHA != details.MergeBaseSHA {
		writeError(writer, http.StatusConflict, "The pull request changed while loading; reload this diff")
		return
	}
	if err := s.validateCurrentGitPRView(ctx, view); err != nil {
		writeError(writer, http.StatusConflict, "The Git repository association changed; reload this diff")
		return
	}
	writeJSON(writer, http.StatusOK, gitPRDiffResponse{
		Path: filepath.ToSlash(relativePath), Repository: repository,
		Original: string(original), Modified: string(modified), Language: monacoLanguage(relativePath),
		Binary: binary, Truncated: truncated, Number: number, BaseSHA: baseSHA, HeadSHA: headSHA,
	})
}

type currentGitPRView struct {
	session         string
	repository      string
	branch          string
	head            string
	repositoryError string
	association     gitAssociation
	pr              gitPR
	response        gitPRChangesResponse
}

func (s *Server) currentGitPRView(ctx context.Context, requestedSession string) (currentGitPRView, error) {
	session, _, err := s.fileSession(ctx, requestedSession)
	if err != nil {
		return currentGitPRView{}, err
	}
	status, statusCode, err := s.readGitStatus(ctx, session)
	if err != nil {
		return currentGitPRView{}, fileAPIError{status: statusCode, message: err.Error()}
	}
	view := currentGitPRView{
		session: session.ID, association: status.Association, pr: status.PR,
		repositoryError: status.RepositoryError,
		response: gitPRChangesResponse{
			Session: session.ID, Association: status.Association, Repository: "", PR: status.PR,
			Files: []gitPRChangedFile{},
		},
	}
	if status.Association.Path != nil {
		view.repository = *status.Association.Path
		view.response.Repository = view.repository
	}
	if status.Repository != nil {
		view.branch = status.Repository.Branch
		view.head = status.Repository.Head
	}
	return view, nil
}

func (s *Server) validateCurrentGitPRView(ctx context.Context, view currentGitPRView) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if _, _, err := s.fileSession(ctx, view.session); err != nil {
		return err
	}
	association := s.gitAssociations.get(view.session)
	if association.Path == nil || *association.Path != view.repository || association.Revision != view.association.Revision {
		return errors.New("association changed")
	}
	root, found, err := s.findRepositoryRoot(ctx, view.repository)
	if err != nil || !found || root != view.repository {
		return errors.New("repository root changed")
	}
	info, err := s.repositoryInfo(ctx, view.repository)
	if err != nil || info.Branch != view.branch || info.Head != view.head {
		return errors.New("repository revision changed")
	}
	return nil
}

func (s *Server) fetchGitHubPRDetails(ctx context.Context, repository string, identity githubPRIdentity, number int) (githubPRDetails, error) {
	endpoint := fmt.Sprintf("repos/%s/%s/pulls/%d", url.PathEscape(identity.owner), url.PathEscape(identity.repo), number)
	output, err := s.runGitCommand(ctx, repository, "gh", "api", "--hostname", identity.host, "--jq", "{number,state,html_url,base:{sha:.base.sha,ref:.base.ref,repo:{full_name:.base.repo.full_name}},head:{sha:.head.sha,ref:.head.ref,repo:{full_name:.head.repo.full_name}}}", endpoint)
	if err != nil {
		return githubPRDetails{}, err
	}
	var details githubPRDetails
	if err := json.Unmarshal(output, &details); err != nil || details.Number != number || !validGitSHA(details.Base.SHA) || !validGitSHA(details.Head.SHA) {
		return githubPRDetails{}, errors.New("invalid GitHub pull request details")
	}
	baseIdentity, err := githubRepositoryIdentity(identity.host, details.Base.Repository.FullName)
	if err != nil || !strings.EqualFold(baseIdentity.owner, identity.owner) || !strings.EqualFold(baseIdentity.repo, identity.repo) {
		return githubPRDetails{}, errors.New("pull request base repository did not match its URL")
	}
	headIdentity, err := githubRepositoryIdentity(identity.host, details.Head.Repository.FullName)
	if err != nil {
		return githubPRDetails{}, errors.New("invalid pull request head repository")
	}
	comparison := fmt.Sprintf("repos/%s/%s/compare/%s:%s...%s:%s",
		url.PathEscape(baseIdentity.owner), url.PathEscape(baseIdentity.repo),
		url.PathEscape(baseIdentity.owner), details.Base.SHA,
		url.PathEscape(headIdentity.owner), details.Head.SHA)
	mergeBaseJSON, err := s.runGitCommand(ctx, repository, "gh", "api", "--hostname", identity.host, "--jq", "{merge_base_sha:.merge_base_commit.sha,base_sha:.base_commit.sha}", comparison)
	if err != nil {
		return githubPRDetails{}, err
	}
	var comparisonResult struct {
		MergeBaseSHA string `json:"merge_base_sha"`
		BaseSHA      string `json:"base_sha"`
	}
	if err := json.Unmarshal(mergeBaseJSON, &comparisonResult); err != nil || !validGitSHA(comparisonResult.MergeBaseSHA) || comparisonResult.BaseSHA != details.Base.SHA {
		return githubPRDetails{}, errors.New("invalid GitHub pull request merge base")
	}
	details.MergeBaseSHA = comparisonResult.MergeBaseSHA
	return details, nil
}

func fetchGitHubPRFiles(ctx context.Context, server *Server, repository string, identity githubPRIdentity, details githubPRDetails) ([]gitPRChangedFile, bool, error) {
	cacheKey := strings.Join([]string{repository, identity.host, identity.owner, identity.repo, strconv.Itoa(details.Number), details.MergeBaseSHA, details.Head.SHA}, "\x00")
	if files, truncated, ok := getCachedPRFiles(cacheKey); ok {
		return files, truncated, nil
	}
	endpointBase := fmt.Sprintf("repos/%s/%s/pulls/%d/files", url.PathEscape(identity.owner), url.PathEscape(identity.repo), details.Number)
	files := make([]gitPRChangedFile, 0, 32)
	truncated := false
	for page := 1; page <= (gitPRFilesLimit/gitPRFilesPageSize)+1; page++ {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		endpoint := fmt.Sprintf("%s?per_page=%d&page=%d", endpointBase, gitPRFilesPageSize, page)
		output, err := server.runGitCommand(ctx, repository, "gh", "api", "--hostname", identity.host, "--jq", "[.[] | {filename,previous_filename,status,additions,deletions}]", endpoint)
		if err != nil {
			return nil, false, err
		}
		var pageFiles []githubPRFile
		if err := json.Unmarshal(output, &pageFiles); err != nil {
			return nil, false, errors.New("invalid GitHub pull request file list")
		}
		for _, file := range pageFiles {
			if len(files) >= gitPRFilesLimit {
				truncated = true
				break
			}
			name, message := cleanRelativeFilePath(file.Filename, false)
			if message != "" || filepath.ToSlash(name) != file.Filename || file.Additions < 0 || file.Deletions < 0 {
				return nil, false, errors.New("invalid path in GitHub pull request file list")
			}
			oldPath := ""
			if file.PreviousFilename != "" {
				old, oldMessage := cleanRelativeFilePath(file.PreviousFilename, false)
				if oldMessage != "" || filepath.ToSlash(old) != file.PreviousFilename {
					return nil, false, errors.New("invalid old path in GitHub pull request file list")
				}
				oldPath = filepath.ToSlash(old)
			}
			if !validPRFileStatus(file.Status) {
				return nil, false, errors.New("invalid status in GitHub pull request file list")
			}
			files = append(files, gitPRChangedFile{
				Path: filepath.ToSlash(name), OldPath: oldPath, Status: file.Status,
				Additions: file.Additions, Deletions: file.Deletions,
			})
		}
		if truncated {
			break
		}
		if len(pageFiles) < gitPRFilesPageSize {
			break
		}
		if len(files) >= gitPRFilesLimit {
			truncated = true
			break
		}
	}
	putCachedPRFiles(cacheKey, cachedPRFileList{files: files, truncated: truncated, expires: time.Now().Add(gitPRFilesTTL)})
	return clonePRFiles(files), truncated, nil
}

func getCachedPRFiles(key string) ([]gitPRChangedFile, bool, bool) {
	githubPRFileCache.Lock()
	defer githubPRFileCache.Unlock()
	entry, found := githubPRFileCache.entries[key]
	if !found || time.Now().After(entry.expires) {
		delete(githubPRFileCache.entries, key)
		return nil, false, false
	}
	return clonePRFiles(entry.files), entry.truncated, true
}

func putCachedPRFiles(key string, entry cachedPRFileList) {
	githubPRFileCache.Lock()
	defer githubPRFileCache.Unlock()
	if len(githubPRFileCache.entries) >= gitPRFilesCacheMax {
		for oldKey, old := range githubPRFileCache.entries {
			if time.Now().After(old.expires) || len(githubPRFileCache.entries) >= gitPRFilesCacheMax {
				delete(githubPRFileCache.entries, oldKey)
			}
		}
	}
	entry.files = clonePRFiles(entry.files)
	githubPRFileCache.entries[key] = entry
}

func clonePRFiles(files []gitPRChangedFile) []gitPRChangedFile {
	return append([]gitPRChangedFile(nil), files...)
}

func (s *Server) readGitHubPRFile(ctx context.Context, repository string, identity githubPRIdentity, relativePath, revision string) ([]byte, bool, error) {
	if _, message := cleanRelativeFilePath(filepath.ToSlash(relativePath), false); message != "" {
		return nil, false, errors.New("invalid GitHub file path")
	}
	segments := strings.Split(filepath.ToSlash(relativePath), "/")
	for index := range segments {
		segments[index] = url.PathEscape(segments[index])
	}
	endpoint := fmt.Sprintf("repos/%s/%s/contents/%s?ref=%s", url.PathEscape(identity.owner), url.PathEscape(identity.repo), strings.Join(segments, "/"), url.QueryEscape(revision))
	output, err := s.runGitCommand(ctx, repository, "gh", "api", "--hostname", identity.host, "--header", "Accept: application/vnd.github.raw+json", endpoint)
	if err != nil {
		var limit outputLimitError
		if errors.As(err, &limit) || errors.Is(err, errGitOutputLimit) {
			return output, true, nil
		}
		return nil, false, err
	}
	return output, false, nil
}

func findPRFile(files []gitPRChangedFile, filePath, oldPath string) (gitPRChangedFile, bool) {
	for _, file := range files {
		if file.Path != filePath {
			continue
		}
		if oldPath != "" && file.OldPath != oldPath {
			continue
		}
		return file, true
	}
	return gitPRChangedFile{}, false
}

func parseGitHubPRIdentity(rawURL string, expectedNumber int) (githubPRIdentity, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return githubPRIdentity{}, errors.New("invalid pull request URL")
	}
	parts := strings.Split(strings.Trim(parsed.EscapedPath(), "/"), "/")
	if len(parts) < 4 || parts[len(parts)-2] != "pull" || parts[len(parts)-1] != strconv.Itoa(expectedNumber) {
		return githubPRIdentity{}, errors.New("invalid pull request URL")
	}
	owner, err := url.PathUnescape(parts[len(parts)-4])
	if err != nil || !validGitHubSlug(owner) {
		return githubPRIdentity{}, errors.New("invalid pull request owner")
	}
	repo, err := url.PathUnescape(parts[len(parts)-3])
	if err != nil || !validGitHubSlug(repo) {
		return githubPRIdentity{}, errors.New("invalid pull request repository")
	}
	if len(parts) != 4 {
		return githubPRIdentity{}, errors.New("invalid pull request URL path")
	}
	return githubPRIdentity{host: parsed.Host, owner: owner, repo: strings.TrimSuffix(repo, ".git")}, nil
}

func githubRepositoryIdentity(host, fullName string) (githubPRIdentity, error) {
	parts := strings.Split(fullName, "/")
	if len(parts) != 2 || !validGitHubSlug(parts[0]) || !validGitHubSlug(parts[1]) {
		return githubPRIdentity{}, errors.New("invalid GitHub repository full name")
	}
	return githubPRIdentity{host: host, owner: parts[0], repo: strings.TrimSuffix(parts[1], ".git")}, nil
}

func validGitHubSlug(value string) bool {
	if value == "" || len(value) > 100 {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_' || char == '.') {
			return false
		}
	}
	return value != "." && value != ".."
}

func validGitSHA(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return false
		}
	}
	return true
}

func prDetailsMatchCurrent(pr *gitPRData, details githubPRDetails) bool {
	if pr == nil || details.Number != pr.Number || details.State != "open" ||
		details.Head.SHA != pr.HeadRefOID || details.Head.Ref != pr.HeadRefName ||
		!validGitSHA(details.Base.SHA) || !validGitSHA(details.Head.SHA) || !validGitSHA(details.MergeBaseSHA) {
		return false
	}
	prIdentity, prErr := parseGitHubPRIdentity(pr.URL, pr.Number)
	detailsIdentity, detailsErr := parseGitHubPRIdentity(details.URL, details.Number)
	return prErr == nil && detailsErr == nil &&
		strings.EqualFold(prIdentity.host, detailsIdentity.host) &&
		strings.EqualFold(prIdentity.owner, detailsIdentity.owner) &&
		strings.EqualFold(prIdentity.repo, detailsIdentity.repo)
}

func validPRFileStatus(value string) bool {
	switch value {
	case "added", "removed", "modified", "renamed", "copied", "changed":
		return true
	default:
		return false
	}
}

func gitHubAPIState(err error) (string, string) {
	var commandErr gitCommandError
	if errors.As(err, &commandErr) && isGHAuthenticationError(commandErr.stderr) {
		return "unavailable", "GitHub CLI is not authenticated"
	}
	if errors.Is(err, exec.ErrNotFound) {
		return "unavailable", "GitHub CLI is unavailable"
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "error", "Pull request lookup timed out"
	}
	return "error", "Unable to read pull request files from GitHub"
}

func containsNUL(value []byte) bool {
	for _, character := range value {
		if character == 0 {
			return true
		}
	}
	return false
}
