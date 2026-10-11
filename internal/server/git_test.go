package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"workbench/internal/tmux"
)

func TestGitStatusDiffsAndPullRequestMetadata(t *testing.T) {
	repository := newGitFixture(t)
	initialHead := gitOutput(t, repository, "rev-parse", "HEAD")
	writeFile(t, filepath.Join(repository, "base.txt"), "base staged\n")
	gitRun(t, repository, "add", "base.txt")
	writeFile(t, filepath.Join(repository, "base.txt"), "base unstaged\n")
	gitRun(t, repository, "mv", "rename-old.txt", "rename-new.txt")
	writeFile(t, filepath.Join(repository, "rename-new.txt"), "rename unstaged\n")
	gitRun(t, repository, "rm", "delete-staged.txt")
	if err := os.Remove(filepath.Join(repository, "delete-unstaged.txt")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(repository, "untracked.txt"), "new untracked\n")

	binDir := t.TempDir()
	gh := filepath.Join(binDir, "gh")
	ghScript := fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = auth ]; then exit 0; fi\nprintf '%%s' '{\"number\":41,\"title\":\"Fixture PR\",\"url\":\"https://github.com/example/project/pull/41\",\"state\":\"OPEN\",\"isDraft\":false,\"baseRefName\":\"main\",\"headRefName\":\"main\",\"headRefOid\":\"%s\",\"headRepositoryOwner\":{\"login\":\"example\"},\"reviewDecision\":\"APPROVED\",\"statusCheckRollup\":[{\"name\":\"unit\",\"conclusion\":\"SUCCESS\"}],\"updatedAt\":\"2026-10-08T00:00:00Z\"}'\n", initialHead)
	if err := os.WriteFile(gh, []byte(ghScript), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "project", Path: repository}}, "", t.TempDir())
	updateGitAssociation(t, handler, "$1", stringPointer(repository))
	response := gitRequest(handler, http.MethodGet, "/api/git?session=%24%31", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET Git status returned %d: %s", response.Code, response.Body.String())
	}
	var status gitStatusResponse
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Repository == nil || status.Repository.Path != repository || status.Repository.Branch != "main" || status.Repository.Head != initialHead {
		t.Fatalf("unexpected repository metadata: %#v", status.Repository)
	}
	if status.PR.Status != "ready" || status.PR.Data == nil || status.PR.Data.Number != 41 || status.PR.Data.ReviewDecision != "APPROVED" {
		t.Fatalf("unexpected PR metadata: %#v", status.PR)
	}
	changes := make(map[string]gitChange, len(status.Changes))
	for _, change := range status.Changes {
		changes[change.Path] = change
	}
	if change, ok := changes["base.txt"]; !ok || !change.Staged || !change.Unstaged || change.Untracked {
		t.Errorf("staged and unstaged changes were not preserved: %#v", change)
	}
	if change, ok := changes["rename-new.txt"]; !ok || change.OldPath != "rename-old.txt" || !change.Staged || !change.Unstaged {
		t.Errorf("rename was not preserved: %#v", change)
	}
	if change, ok := changes["delete-staged.txt"]; !ok || !change.Staged {
		t.Errorf("staged deletion missing: %#v", change)
	}
	if change, ok := changes["delete-unstaged.txt"]; !ok || !change.Unstaged {
		t.Errorf("unstaged deletion missing: %#v", change)
	}
	if change, ok := changes["untracked.txt"]; !ok || !change.Untracked || change.Staged || change.Unstaged {
		t.Errorf("untracked file missing or marked as staged: %#v", change)
	}

	checks := []struct {
		path, oldPath, kind, wantOriginal, wantModified string
	}{
		{"base.txt", "", "staged", "base original\n", "base staged\n"},
		{"base.txt", "", "unstaged", "base staged\n", "base unstaged\n"},
		{"rename-new.txt", "", "staged", "rename original\n", "rename original\n"},
		{"delete-staged.txt", "", "staged", "delete staged original\n", ""},
		{"delete-unstaged.txt", "", "unstaged", "delete unstaged original\n", ""},
		{"untracked.txt", "", "untracked", "", "new untracked\n"},
	}
	for _, check := range checks {
		values := url.Values{"session": {"$1"}, "repository": {repository}, "path": {check.path}, "kind": {check.kind}}
		if check.oldPath != "" {
			values.Set("oldPath", check.oldPath)
		}
		diffResponse := gitRequest(handler, http.MethodGet, "/api/git/diff?"+values.Encode(), nil, "")
		if diffResponse.Code != http.StatusOK {
			t.Errorf("diff %s %s returned %d: %s", check.kind, check.path, diffResponse.Code, diffResponse.Body.String())
			continue
		}
		var diff gitDiffResponse
		if err := json.Unmarshal(diffResponse.Body.Bytes(), &diff); err != nil {
			t.Fatal(err)
		}
		if diff.Original != check.wantOriginal || diff.Modified != check.wantModified || diff.Binary || diff.Truncated {
			t.Errorf("diff %s %s = (%q,%q,binary=%v,truncated=%v), want (%q,%q)", check.kind, check.path, diff.Original, diff.Modified, diff.Binary, diff.Truncated, check.wantOriginal, check.wantModified)
		}
	}
}

func TestGitStatusAndDiffRequireExplicitAssociation(t *testing.T) {
	repository := newGitFixture(t)
	writeFile(t, filepath.Join(repository, "untracked.txt"), "untracked\n")
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "project", Path: repository}}, "", t.TempDir())

	getStatus := func() gitStatusResponse {
		t.Helper()
		response := gitRequest(handler, http.MethodGet, "/api/git?session=%24%31", nil, "")
		if response.Code != http.StatusOK {
			t.Fatalf("GET Git status returned %d: %s", response.Code, response.Body.String())
		}
		var body gitStatusResponse
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	assertUnassociated := func() {
		t.Helper()
		status := getStatus()
		if status.Repository != nil || status.RepositoryError != "" || status.PR.Status != "none" || len(status.Changes) != 0 || status.Association.Path != nil {
			t.Fatalf("unassociated session exposed Git status: %#v", status)
		}
		diff := gitRequest(handler, http.MethodGet, "/api/git/diff?session=%24%31&repository="+url.QueryEscape(repository)+"&path=untracked.txt&kind=untracked", nil, "")
		if diff.Code != http.StatusConflict {
			t.Fatalf("unassociated diff returned %d, want 409: %s", diff.Code, diff.Body.String())
		}
	}

	// A session cwd inside a Git repository is only a recommendation source; it
	// must not implicitly associate the repository or expose its changes.
	assertUnassociated()
	updateGitAssociation(t, handler, "$1", stringPointer(repository))
	status := getStatus()
	if status.Repository == nil || status.Repository.Path != repository || len(status.Changes) != 1 || !status.Changes[0].Untracked {
		t.Fatalf("explicitly associated repository status missing: %#v", status)
	}

	// Clearing a manual pin must restore the fully unassociated behavior even
	// though the session cwd remains inside the same Git worktree.
	updateGitAssociation(t, handler, "$1", nil)
	assertUnassociated()
	recommendations := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%24%31", nil, "")
	if recommendations.Code != http.StatusOK || !strings.Contains(recommendations.Body.String(), repository) {
		t.Fatalf("unbinding unexpectedly removed cwd recommendation: status=%d body=%s", recommendations.Code, recommendations.Body.String())
	}
}

func TestGitAssociationsPersistCASAndSurviveConcurrentSessions(t *testing.T) {
	repository := newGitFixture(t)
	stateDir := t.TempDir()
	sessions := []tmux.Session{
		{ID: "$1", Name: "one", Path: t.TempDir()},
		{ID: "$2", Name: "two", Path: t.TempDir()},
	}
	handler := gitHandler(t, sessions, "", stateDir)
	initial := make([]gitAssociation, 2)
	for index, session := range sessions {
		response := gitRequest(handler, http.MethodGet, "/api/git?session="+url.QueryEscape(session.ID), nil, "")
		if response.Code != http.StatusOK {
			t.Fatalf("initial status for %s: %d %s", session.ID, response.Code, response.Body.String())
		}
		var body gitStatusResponse
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Repository != nil || body.PR.Status != "none" || body.Association.Path != nil {
			t.Fatalf("non-repository session returned Git state: %#v", body)
		}
		initial[index] = body.Association
	}

	statuses := make(chan int, 2)
	var wait sync.WaitGroup
	for index, session := range sessions {
		wait.Add(1)
		go func(session tmux.Session, revision string) {
			defer wait.Done()
			payload, _ := json.Marshal(gitAssociationRequest{Session: session.ID, Path: stringPointer(repository), Revision: revision})
			response := gitRequest(handler, http.MethodPut, "/api/git/association", payload, "http://127.0.0.1")
			statuses <- response.Code
		}(session, initial[index].Revision)
	}
	wait.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Errorf("association update returned %d, want 200", status)
		}
	}

	stale := gitAssociationRequest{Session: "$1", Path: nil, Revision: initial[0].Revision}
	staleBody, _ := json.Marshal(stale)
	conflict := gitRequest(handler, http.MethodPut, "/api/git/association", staleBody, "http://127.0.0.1")
	if conflict.Code != http.StatusConflict {
		t.Fatalf("stale association update returned %d: %s", conflict.Code, conflict.Body.String())
	}
	var conflictBody struct {
		Association gitAssociation `json:"association"`
		Error       string         `json:"error"`
	}
	if err := json.Unmarshal(conflict.Body.Bytes(), &conflictBody); err != nil {
		t.Fatal(err)
	}
	if conflictBody.Association.Path == nil || *conflictBody.Association.Path != repository || conflictBody.Error == "" {
		t.Fatalf("stale response omitted current association: %#v", conflictBody)
	}

	restarted := gitHandler(t, sessions, "", stateDir)
	for _, session := range sessions {
		response := gitRequest(restarted, http.MethodGet, "/api/git?session="+url.QueryEscape(session.ID), nil, "")
		var body gitStatusResponse
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || body.Association.Path == nil || *body.Association.Path != repository || !body.Association.Manual {
			t.Errorf("association for %s was not persistent: status=%d state=%#v", session.ID, response.Code, body.Association)
		}
	}
}

func TestGitRecommendationsStayWithinSessionTree(t *testing.T) {
	root := newGitFixture(t)
	child := filepath.Join(root, "child-repo")
	initRepositoryAt(t, child, "")
	deep := filepath.Join(root, "subfolder", "Deep Project")
	worktreeGitDir := filepath.Join(t.TempDir(), "worktree-meta")
	initRepositoryAt(t, deep, worktreeGitDir)
	markerInfo, err := os.Lstat(filepath.Join(deep, ".git"))
	if err != nil || !markerInfo.Mode().IsRegular() {
		t.Fatalf("worktree .git marker should be a regular file: info=%v err=%v", markerInfo, err)
	}
	vendorRepo := filepath.Join(root, "vendor")
	initRepositoryAt(t, vendorRepo, "")
	outside := newGitFixture(t)
	if err := os.Symlink(outside, filepath.Join(root, "external-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "hidden-repo"), 0o700); err != nil {
		t.Fatal(err)
	}
	initRepositoryAt(t, filepath.Join(root, "node_modules", "hidden-repo"), "")
	otherSessionRepo := newGitFixture(t)
	sessions := []tmux.Session{{ID: "$1", Name: "current", Path: root}, {ID: "$2", Name: "outside", Path: otherSessionRepo}}
	stateDir := t.TempDir()
	handler := gitHandler(t, sessions, "", stateDir)

	initial := gitRequest(handler, http.MethodGet, "/api/git?session=%241", nil, "")
	var status gitStatusResponse
	if err := json.Unmarshal(initial.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(gitAssociationRequest{Session: "$1", Path: stringPointer(outside), Revision: status.Association.Revision})
	pinned := gitRequest(handler, http.MethodPut, "/api/git/association", payload, "http://127.0.0.1")
	if pinned.Code != http.StatusOK {
		t.Fatalf("pin outside repository: %d %s", pinned.Code, pinned.Body.String())
	}

	response := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("recommendations returned %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Root         string                        `json:"root"`
		Truncated    bool                          `json:"truncated"`
		Repositories []gitRepositoryRecommendation `json:"repositories"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Root != root || body.Truncated {
		t.Fatalf("unexpected scoped search metadata: root=%q truncated=%v", body.Root, body.Truncated)
	}
	want := []string{root, child, vendorRepo, deep}
	if len(body.Repositories) != len(want) {
		t.Fatalf("scoped roots = %#v, want %#v", body.Repositories, want)
	}
	for index, path := range want {
		wantSource := "descendant"
		if index == 0 {
			wantSource = "cwd"
		}
		if body.Repositories[index].Path != path || body.Repositories[index].Source != wantSource {
			t.Errorf("repository[%d] = %#v, want path=%q source=%q", index, body.Repositories[index], path, wantSource)
		}
	}
	if hasRecommendationPath(body.Repositories, outside) || hasRecommendationPath(body.Repositories, otherSessionRepo) {
		t.Fatalf("suggestions escaped the current session tree: %#v", body.Repositories)
	}
	current := gitRequest(handler, http.MethodGet, "/api/git?session=%241", nil, "")
	if err := json.Unmarshal(current.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Association.Path == nil || *status.Association.Path != outside || !status.Association.Manual {
		t.Fatalf("recommendations changed the outside manual pin: %#v", status.Association)
	}
}

func TestGitRecommendationsFilterAllWordsAndScopeAbsolutePaths(t *testing.T) {
	root := t.TempDir()
	initRepositoryAt(t, root, "")
	deep := filepath.Join(root, "Folder", "Sub Project")
	meta := filepath.Join(t.TempDir(), "worktree-meta")
	initRepositoryAt(t, deep, meta)
	outside := newGitFixture(t)
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "current", Path: root}}, "", t.TempDir())

	search := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241&q="+url.QueryEscape("SUB project"), nil, "")
	var body struct {
		Root         string                        `json:"root"`
		Repositories []gitRepositoryRecommendation `json:"repositories"`
	}
	if err := json.Unmarshal(search.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Root != root || len(body.Repositories) != 1 || body.Repositories[0].Path != deep {
		t.Fatalf("all-word case-insensitive search = %#v", body)
	}
	inside := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241&q="+url.QueryEscape(deep), nil, "")
	if err := json.Unmarshal(inside.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Repositories) != 1 || body.Repositories[0].Path != deep {
		t.Fatalf("absolute in-scope search = %#v", body.Repositories)
	}
	outsideSearch := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241&q="+url.QueryEscape(outside), nil, "")
	if err := json.Unmarshal(outsideSearch.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Repositories) != 0 {
		t.Fatalf("absolute outside search escaped scope: %#v", body.Repositories)
	}
}

func TestGitRecommendationsTruncateAfterScopedMatches(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < gitRecommendLimit+2; index++ {
		initRepositoryAt(t, filepath.Join(root, fmt.Sprintf("repo-%02d", index)), "")
	}
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "current", Path: root}}, "", t.TempDir())
	response := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241", nil, "")
	var body struct {
		Truncated    bool                          `json:"truncated"`
		Repositories []gitRepositoryRecommendation `json:"repositories"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(body.Repositories) != gitRecommendLimit || !body.Truncated {
		t.Fatalf("recommendation limit: status=%d count=%d truncated=%v", response.Code, len(body.Repositories), body.Truncated)
	}
	query := url.QueryEscape("repo-51")
	filtered := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241&q="+query, nil, "")
	if err := json.Unmarshal(filtered.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "repo-51")
	if len(body.Repositories) != 1 || body.Repositories[0].Path != want {
		t.Fatalf("deep filtered result was lost to limit: %#v", body.Repositories)
	}
}

func TestGitRecommendationsReportUnavailableRootAsTruncated(t *testing.T) {
	missingRoot := filepath.Join(t.TempDir(), "missing")
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "missing", Path: missingRoot}}, "", t.TempDir())
	response := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241", nil, "")
	var body struct {
		Root         string                        `json:"root"`
		Truncated    bool                          `json:"truncated"`
		Repositories []gitRepositoryRecommendation `json:"repositories"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || body.Root != missingRoot || !body.Truncated || len(body.Repositories) != 0 {
		t.Fatalf("unavailable-root response: status=%d body=%#v", response.Code, body)
	}
}

func TestGitRecommendationsUseHostFilesystemPrefixAndReturnLogicalPaths(t *testing.T) {
	hostRoot := t.TempDir()
	logicalRoot := "/workspace/project"
	realRoot := filepath.Join(hostRoot, strings.TrimPrefix(logicalRoot, string(filepath.Separator)))
	initRepositoryAt(t, realRoot, "")
	logicalChild := filepath.Join(logicalRoot, "nested")
	initRepositoryAt(t, filepath.Join(realRoot, "nested"), "")
	runner := filepath.Join(t.TempDir(), "host-git-fixture")
	script := fmt.Sprintf("#!/bin/sh\ntool=$1\nrepo=$2\nshift 2\ncase \"$tool\" in git) output=$(git -C %s\"$repo\" \"$@\") || exit $?; case \"$output\" in %s*) output=${output#%s} ;; esac; printf '%%s\\n' \"$output\" ;; *) exit 127 ;; esac\n", shellQuote(hostRoot), shellQuote(hostRoot), shellQuote(hostRoot))
	if err := os.WriteFile(runner, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	handler := gitHandlerWithRoot(t, []tmux.Session{{ID: "$1", Name: "mounted", Path: logicalRoot}}, runner, t.TempDir(), hostRoot)
	response := gitRequest(handler, http.MethodGet, "/api/git/recommendations?session=%241", nil, "")
	var body struct {
		Root         string                        `json:"root"`
		Repositories []gitRepositoryRecommendation `json:"repositories"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || body.Root != logicalRoot || len(body.Repositories) != 2 {
		t.Fatalf("host prefix recommendation response: status=%d body=%#v", response.Code, body)
	}
	if body.Repositories[0].Path != logicalRoot || body.Repositories[1].Path != logicalChild {
		t.Fatalf("API returned non-logical repo paths: %#v", body.Repositories)
	}
}

func TestGitAssociationStartupRejectsInvalidState(t *testing.T) {
	stateDir := t.TempDir()
	state := `{"version":2,"associations":{},"recent":[]}`
	if err := os.WriteFile(filepath.Join(stateDir, gitAssociationFileName), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := NewWithGitOptions("unused", logger, "", stateDir, ""); err == nil {
		t.Fatal("unsupported persisted Git association version should fail initialization")
	}
}

func TestGitDiffRejectsEscapingSymlinksAndFIFOs(t *testing.T) {
	repository := newGitFixture(t)
	outsideDir := t.TempDir()
	writeFile(t, filepath.Join(outsideDir, "secret.txt"), "secret\n")
	writeFile(t, filepath.Join(outsideDir, "tracked.txt"), "secret tracked file\n")
	if err := os.Symlink(outsideDir, filepath.Join(repository, "escape-dir")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outsideDir, "secret.txt"), filepath.Join(repository, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repository, "nested", "tracked.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repository, "nested")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(repository, "nested")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repository, "fifo-tracked.txt")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(repository, "fifo-tracked.txt"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "repo", Path: repository}}, "", t.TempDir())
	updateGitAssociation(t, handler, "$1", stringPointer(repository))
	for _, path := range []string{"escape.txt", "escape-dir", "nested/tracked.txt", "fifo-tracked.txt"} {
		values := url.Values{"session": {"$1"}, "repository": {repository}, "path": {path}, "kind": {"untracked"}}
		if path == "nested/tracked.txt" || path == "fifo-tracked.txt" {
			values.Set("kind", "unstaged")
		}
		response := gitRequest(handler, http.MethodGet, "/api/git/diff?"+values.Encode(), nil, "")
		if response.Code == http.StatusOK && strings.Contains(response.Body.String(), "secret") {
			t.Errorf("escaping symlink diff disclosed outside file %q: %s", path, response.Body.String())
		}
		if response.Code != http.StatusBadRequest {
			t.Errorf("special path diff %q status = %d, want 400", path, response.Code)
		}
	}
}

func newGitFixture(t *testing.T) string {
	t.Helper()
	repository := t.TempDir()
	gitRun(t, repository, "init", "--initial-branch=main")
	gitRun(t, repository, "config", "user.name", "Workbench Test")
	gitRun(t, repository, "config", "user.email", "workbench@example.invalid")
	writeFile(t, filepath.Join(repository, "base.txt"), "base original\n")
	writeFile(t, filepath.Join(repository, "rename-old.txt"), "rename original\n")
	writeFile(t, filepath.Join(repository, "delete-staged.txt"), "delete staged original\n")
	writeFile(t, filepath.Join(repository, "delete-unstaged.txt"), "delete unstaged original\n")
	writeFile(t, filepath.Join(repository, "fifo-tracked.txt"), "will become a FIFO\n")
	if err := os.Mkdir(filepath.Join(repository, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(repository, "nested", "tracked.txt"), "nested original\n")
	gitRun(t, repository, "add", ".")
	gitRun(t, repository, "commit", "-m", "initial")
	return repository
}

func gitHandler(t *testing.T, sessions []tmux.Session, runner, stateDir string) http.Handler {
	return gitHandlerWithRoot(t, sessions, runner, stateDir, "")
}

func gitHandlerWithRoot(t *testing.T, sessions []tmux.Session, runner, stateDir, filesystemRoot string) http.Handler {
	t.Helper()
	tmuxBinary := filepath.Join(t.TempDir(), "fake-tmux")
	rows := make([]string, 0, len(sessions))
	for _, session := range sessions {
		rows = append(rows, shellQuote(fmt.Sprintf("%s<<<tmux-webui-field>>>%s<<<tmux-webui-field>>>%s<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000000", session.ID, session.Name, session.Path)))
	}
	script := fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = list-sessions ]; then\nprintf '%%s\\n' %s\nexit 0\nfi\nexit 1\n", strings.Join(rows, " "))
	if err := os.WriteFile(tmuxBinary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, err := NewWithGitOptions(tmuxBinary, logger, filesystemRoot, stateDir, runner)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func gitRequest(handler http.Handler, method, path string, body []byte, origin string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://127.0.0.1"+path, bytes.NewReader(body))
	if origin != "" {
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func updateGitAssociation(t *testing.T, handler http.Handler, session string, path *string) {
	t.Helper()
	statusResponse := gitRequest(handler, http.MethodGet, "/api/git?session="+url.QueryEscape(session), nil, "")
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("GET Git status before association update returned %d: %s", statusResponse.Code, statusResponse.Body.String())
	}
	var status gitStatusResponse
	if err := json.Unmarshal(statusResponse.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(gitAssociationRequest{Session: session, Path: path, Revision: status.Association.Revision})
	if err != nil {
		t.Fatal(err)
	}
	response := gitRequest(handler, http.MethodPut, "/api/git/association", payload, "http://127.0.0.1")
	if response.Code != http.StatusOK {
		t.Fatalf("PUT Git association returned %d: %s", response.Code, response.Body.String())
	}
}

func gitRun(t *testing.T, directory string, arguments ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory, "-c", "safe.directory=*"}, arguments...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(arguments, " "), err, output)
	}
}

func gitOutput(t *testing.T, directory string, arguments ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, arguments...)...)
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(output))
}

func writeFile(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}

func initRepositoryAt(t *testing.T, repository, gitDir string) {
	t.Helper()
	if err := os.MkdirAll(repository, 0o700); err != nil {
		t.Fatal(err)
	}
	if gitDir == "" {
		gitRun(t, repository, "init", "--initial-branch=main")
		return
	}
	if err := os.MkdirAll(filepath.Dir(gitDir), 0o700); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repository, "init", "--initial-branch=main", "--separate-git-dir", gitDir)
}

func hasRecommendationPath(values []gitRepositoryRecommendation, path string) bool {
	for _, value := range values {
		if value.Path == path {
			return true
		}
	}
	return false
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
