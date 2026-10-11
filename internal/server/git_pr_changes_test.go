package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"workbench/internal/tmux"
)

func TestGitPRChangesAndDiffsUseMergeBaseAndHeadContent(t *testing.T) {
	repository := newGitFixture(t)
	files := []githubPRFile{
		{Filename: "modified.txt", Status: "modified", Additions: 2, Deletions: 1},
		{Filename: "renamed-new.txt", PreviousFilename: "renamed-old.txt", Status: "renamed", Additions: 1, Deletions: 1},
		{Filename: "added.txt", Status: "added", Additions: 1},
		{Filename: "deleted.txt", Status: "removed", Deletions: 1},
		{Filename: "binary.bin", Status: "modified"},
		{Filename: "large.txt", Status: "modified"},
	}
	fixture := newGitHubPRFixture(t, repository, [][]githubPRFile{files})
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "project", Path: repository}}, "", t.TempDir())
	t.Setenv("PATH", fixture.binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	updateGitAssociation(t, handler, "$1", stringPointer(repository))

	response := gitRequest(handler, http.MethodGet, "/api/git/pr/changes?session=%24%31", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("PR changes returned %d: %s", response.Code, response.Body.String())
	}
	var changes gitPRChangesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &changes); err != nil {
		t.Fatal(err)
	}
	if changes.Status != "ready" || changes.PR.Status != "ready" || changes.Association.Path == nil || *changes.Association.Path != repository || changes.Repository != repository || changes.BaseSHA != fixture.mergeBase || changes.BaseSHA == fixture.baseTip || changes.HeadSHA != fixture.headSHA || len(changes.Files) != len(files) {
		t.Fatalf("unexpected PR change response: %#v", changes)
	}
	if changes.Files[1].OldPath != "renamed-old.txt" || changes.Files[1].Status != "renamed" || changes.Files[0].Additions != 2 {
		t.Fatalf("PR file metadata did not preserve rename/counts: %#v", changes.Files)
	}

	checks := []struct {
		path, oldPath, wantOriginal, wantModified string
		binary                                    bool
	}{
		{"modified.txt", "", "base version\n", "head version\n", false},
		{"renamed-new.txt", "renamed-old.txt", "old name contents\n", "new name contents\n", false},
		{"added.txt", "", "", "added contents\n", false},
		{"deleted.txt", "", "deleted contents\n", "", false},
		{"binary.bin", "", "", "", true},
	}
	largeValues := url.Values{
		"session": {"$1"}, "repository": {repository}, "path": {"large.txt"},
		"number": {"42"}, "baseSha": {fixture.mergeBase}, "headSha": {fixture.headSHA},
	}
	largeResponse := gitRequest(handler, http.MethodGet, "/api/git/pr/diff?"+largeValues.Encode(), nil, "")
	if largeResponse.Code != http.StatusOK {
		t.Fatalf("large PR diff returned %d: %s", largeResponse.Code, largeResponse.Body.String())
	}
	var largeDiff gitPRDiffResponse
	if err := json.Unmarshal(largeResponse.Body.Bytes(), &largeDiff); err != nil {
		t.Fatal(err)
	}
	if !largeDiff.Truncated || len(largeDiff.Original) != gitPRDiffMaxBytes || len(largeDiff.Modified) != gitPRDiffMaxBytes {
		t.Fatalf("large PR diff was not bounded: original=%d modified=%d truncated=%v", len(largeDiff.Original), len(largeDiff.Modified), largeDiff.Truncated)
	}
	for _, check := range checks {
		values := url.Values{
			"session": {"$1"}, "repository": {repository}, "path": {check.path},
			"number": {"42"}, "baseSha": {fixture.mergeBase}, "headSha": {fixture.headSHA},
		}
		if check.oldPath != "" {
			values.Set("oldPath", check.oldPath)
		}
		diffResponse := gitRequest(handler, http.MethodGet, "/api/git/pr/diff?"+values.Encode(), nil, "")
		if diffResponse.Code != http.StatusOK {
			t.Errorf("PR diff %q returned %d: %s", check.path, diffResponse.Code, diffResponse.Body.String())
			continue
		}
		var diff gitPRDiffResponse
		if err := json.Unmarshal(diffResponse.Body.Bytes(), &diff); err != nil {
			t.Fatal(err)
		}
		if diff.Original != check.wantOriginal || diff.Modified != check.wantModified || diff.Binary != check.binary || diff.BaseSHA != fixture.mergeBase || diff.HeadSHA != fixture.headSHA {
			t.Errorf("PR diff %q = %#v", check.path, diff)
		}
	}

	second := gitRequest(handler, http.MethodGet, "/api/git/pr/changes?session=%24%31", nil, "")
	if second.Code != http.StatusOK {
		t.Fatalf("cached PR changes returned %d: %s", second.Code, second.Body.String())
	}
	callLog, err := os.ReadFile(fixture.calls)
	if err != nil {
		t.Fatal(err)
	}
	pageCalls := 0
	for _, line := range strings.Split(string(callLog), "\n") {
		if strings.Contains(line, "/files?") {
			pageCalls++
		}
	}
	if pageCalls != 1 {
		t.Fatalf("pull file list fetched %d times, want one cached page", pageCalls)
	}
}

func TestGitPRDiffRejectsStaleUnassociatedAndUnlistedPaths(t *testing.T) {
	repository := newGitFixture(t)
	fixture := newGitHubPRFixture(t, repository, [][]githubPRFile{{{Filename: "listed.txt", Status: "modified"}}})
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "project", Path: repository}}, "", t.TempDir())
	t.Setenv("PATH", fixture.binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	updateGitAssociation(t, handler, "$1", stringPointer(repository))
	request := func(filePath, baseSHA string) *httptest.ResponseRecorder {
		values := url.Values{"session": {"$1"}, "repository": {repository}, "path": {filePath}, "number": {"42"}, "baseSha": {baseSHA}, "headSha": {fixture.headSHA}}
		return gitRequest(handler, http.MethodGet, "/api/git/pr/diff?"+values.Encode(), nil, "")
	}
	if response := request("listed.txt", fixture.baseTip); response.Code != http.StatusConflict {
		t.Fatalf("stale diff revision returned %d: %s", response.Code, response.Body.String())
	}
	if response := request("../etc/passwd", fixture.mergeBase); response.Code != http.StatusBadRequest {
		t.Fatalf("escaping path returned %d: %s", response.Code, response.Body.String())
	}
	if response := request("not-in-pr.txt", fixture.mergeBase); response.Code != http.StatusNotFound {
		t.Fatalf("unlisted path returned %d: %s", response.Code, response.Body.String())
	}
	newRemoteHead := strings.Repeat("c", 40)
	staleDetails := fmt.Sprintf(`{"number":42,"state":"open","html_url":"https://github.com/example/project/pull/42","base":{"sha":"%s","ref":"main","repo":{"full_name":"example/project"}},"head":{"sha":"%s","ref":"pr-head","repo":{"full_name":"example/project"}}}`, fixture.baseTip, newRemoteHead)
	staleComparison := fmt.Sprintf(`{"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}`, fixture.baseTip, fixture.mergeBase, newRemoteHead)
	if err := os.WriteFile(fixture.detailsPath, []byte(staleDetails), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.comparisonPath, []byte(staleComparison), 0o600); err != nil {
		t.Fatal(err)
	}
	if response := request("listed.txt", fixture.mergeBase); response.Code != http.StatusConflict {
		t.Fatalf("stale remote PR head returned %d: %s", response.Code, response.Body.String())
	}
	updateGitAssociation(t, handler, "$1", nil)
	if response := gitRequest(handler, http.MethodGet, "/api/git/pr/changes?session=%24%31", nil, ""); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"none"`) {
		t.Fatalf("unbound PR changes response = %d %s", response.Code, response.Body.String())
	}
	if response := request("listed.txt", fixture.mergeBase); response.Code != http.StatusConflict {
		t.Fatalf("unbound PR diff returned %d: %s", response.Code, response.Body.String())
	}
}

func TestGitPRDiffReadsForkHeadFromItsOwnRepository(t *testing.T) {
	repository := newGitFixture(t)
	fixture := newGitHubPRFixtureWithHeadRepo(t, repository, [][]githubPRFile{{{Filename: "added.txt", Status: "added", Additions: 1}}}, "contributor/project")
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "project", Path: repository}}, "", t.TempDir())
	t.Setenv("PATH", fixture.binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	updateGitAssociation(t, handler, "$1", stringPointer(repository))
	values := url.Values{
		"session": {"$1"}, "repository": {repository}, "path": {"added.txt"},
		"number": {"42"}, "baseSha": {fixture.mergeBase}, "headSha": {fixture.headSHA},
	}
	response := gitRequest(handler, http.MethodGet, "/api/git/pr/diff?"+values.Encode(), nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("fork PR diff returned %d: %s", response.Code, response.Body.String())
	}
	var diff gitPRDiffResponse
	if err := json.Unmarshal(response.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.Modified != "added contents\n" || diff.Original != "" {
		t.Fatalf("fork PR diff contents = %#v", diff)
	}
	calls, err := os.ReadFile(fixture.calls)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(calls), "repos/contributor/project/contents/added.txt?ref="+fixture.headSHA) {
		t.Fatalf("head content was not read from the fork repository: %s", calls)
	}
}

func TestGitPRChangesPaginationIsBounded(t *testing.T) {
	repository := newGitFixture(t)
	pages := make([][]githubPRFile, 5)
	for page := range pages {
		pages[page] = make([]githubPRFile, 100)
		for index := range pages[page] {
			pages[page][index] = githubPRFile{Filename: fmt.Sprintf("file-%03d.txt", page*100+index), Status: "modified"}
		}
	}
	fixture := newGitHubPRFixture(t, repository, pages)
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "project", Path: repository}}, "", t.TempDir())
	t.Setenv("PATH", fixture.binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	updateGitAssociation(t, handler, "$1", stringPointer(repository))
	response := gitRequest(handler, http.MethodGet, "/api/git/pr/changes?session=%24%31", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("PR changes returned %d: %s", response.Code, response.Body.String())
	}
	var changes gitPRChangesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &changes); err != nil {
		t.Fatal(err)
	}
	if !changes.Truncated || len(changes.Files) != gitPRFilesLimit {
		t.Fatalf("file-list bound not reported: count=%d truncated=%v", len(changes.Files), changes.Truncated)
	}
	callLog, err := os.ReadFile(fixture.calls)
	if err != nil {
		t.Fatal(err)
	}
	pagesFetched := 0
	for _, line := range strings.Split(string(callLog), "\n") {
		if strings.Contains(line, "/files?") {
			pagesFetched++
		}
	}
	if pagesFetched != 5 {
		t.Fatalf("fetched %d pages, want bounded five", pagesFetched)
	}
}

func TestGitPRChangesReportsUnavailableAssociatedRepository(t *testing.T) {
	repository := newGitFixture(t)
	handler := gitHandler(t, []tmux.Session{{ID: "$1", Name: "project", Path: repository}}, "", t.TempDir())
	updateGitAssociation(t, handler, "$1", stringPointer(repository))
	if err := os.Rename(repository, repository+"-moved"); err != nil {
		t.Fatal(err)
	}
	response := gitRequest(handler, http.MethodGet, "/api/git/pr/changes?session=%24%31", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("unavailable PR changes returned %d: %s", response.Code, response.Body.String())
	}
	var changes gitPRChangesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &changes); err != nil {
		t.Fatal(err)
	}
	if changes.Status != "unavailable" || !strings.Contains(changes.Message, "repository") {
		t.Fatalf("missing associated repo was reported as a PR result: %#v", changes)
	}
}

type gitHubPRFixture struct {
	binDir         string
	calls          string
	baseTip        string
	mergeBase      string
	headSHA        string
	detailsPath    string
	comparisonPath string
}

func newGitHubPRFixture(t *testing.T, repository string, pages [][]githubPRFile) gitHubPRFixture {
	return newGitHubPRFixtureWithHeadRepo(t, repository, pages, "example/project")
}

func newGitHubPRFixtureWithHeadRepo(t *testing.T, repository string, pages [][]githubPRFile, headRepository string) gitHubPRFixture {
	t.Helper()
	binDir := t.TempDir()
	calls := filepath.Join(t.TempDir(), "gh-calls.log")
	pagePrefix := filepath.Join(t.TempDir(), "pr-files-page-")
	for name, value := range map[string]string{
		"modified.txt":    "base version\n",
		"renamed-old.txt": "old name contents\n",
		"deleted.txt":     "deleted contents\n",
		"large.txt":       strings.Repeat("a", gitPRDiffMaxBytes+4),
	} {
		if err := os.WriteFile(filepath.Join(repository, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(repository, "binary.bin"), []byte("binary before\x00"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repository, "add", "modified.txt", "renamed-old.txt", "deleted.txt", "large.txt", "binary.bin")
	gitRun(t, repository, "commit", "-m", "PR merge base")
	mergeBase := gitOutput(t, repository, "rev-parse", "HEAD")
	gitRun(t, repository, "checkout", "-b", "pr-head")
	if err := os.WriteFile(filepath.Join(repository, "modified.txt"), []byte("head version\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(repository, "renamed-old.txt"), filepath.Join(repository, "renamed-new.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "renamed-new.txt"), []byte("new name contents\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "added.txt"), []byte("added contents\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repository, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "binary.bin"), []byte("binary after\x00"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "large.txt"), []byte(strings.Repeat("b", gitPRDiffMaxBytes+4)), 0o600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repository, "add", "-A")
	gitRun(t, repository, "commit", "-m", "PR head")
	headSHA := gitOutput(t, repository, "rev-parse", "HEAD")
	gitRun(t, repository, "checkout", "main")
	if err := os.WriteFile(filepath.Join(repository, "base-only.txt"), []byte("advanced base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repository, "add", "base-only.txt")
	gitRun(t, repository, "commit", "-m", "Advance base after fork")
	baseTip := gitOutput(t, repository, "rev-parse", "HEAD")
	gitRun(t, repository, "checkout", "pr-head")
	metadata := fmt.Sprintf(`{"number":42,"title":"Fixture PR","url":"https://github.com/example/project/pull/42","state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"pr-head","headRefOid":"%s","updatedAt":"2026-10-08T00:00:00Z"}`, headSHA)
	details := fmt.Sprintf(`{"number":42,"state":"open","html_url":"https://github.com/example/project/pull/42","base":{"sha":"%s","ref":"main","repo":{"full_name":"example/project"}},"head":{"sha":"%s","ref":"pr-head","repo":{"full_name":"%s"}}}`, baseTip, headSHA, headRepository)
	comparison := fmt.Sprintf(`{"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}`, baseTip, mergeBase, headSHA)
	for index, page := range pages {
		encoded, err := json.Marshal(page)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fmt.Sprintf("%s%d.json", pagePrefix, index+1), encoded, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(pagePrefix+fmt.Sprintf("%d.json", len(pages)+1), []byte("[]"), 0o600); err != nil {
		t.Fatal(err)
	}
	metadataPath := filepath.Join(t.TempDir(), "gh-pr.json")
	detailsPath := filepath.Join(t.TempDir(), "gh-details.json")
	comparisonPath := filepath.Join(t.TempDir(), "gh-compare.json")
	contentsRoot := filepath.Join(t.TempDir(), "github-content")
	for name, value := range map[string]string{metadataPath: metadata, detailsPath: details, comparisonPath: comparison} {
		if err := os.WriteFile(name, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	knownFiles := map[string]bool{
		"modified.txt": true, "renamed-old.txt": true, "renamed-new.txt": true,
		"added.txt": true, "deleted.txt": true, "binary.bin": true, "large.txt": true,
	}
	for _, file := range flattenGitHubPRFiles(pages) {
		if !knownFiles[file.Filename] && !knownFiles[file.PreviousFilename] {
			continue
		}
		basePath := file.Filename
		if file.PreviousFilename != "" {
			basePath = file.PreviousFilename
		}
		if file.Status != "added" {
			writeGitHubFixtureBlob(t, contentsRoot, mergeBase, repository, basePath)
		}
		if file.Status != "removed" {
			writeGitHubFixtureBlob(t, contentsRoot, headSHA, repository, file.Filename)
		}
	}
	script := `#!/bin/sh
if [ "$1" = "pr" ]; then cat "$PR_FIXTURE_METADATA"; exit 0; fi
endpoint=""
jq_filter=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--jq" ]; then jq_filter="$2"; shift 2; else endpoint="$1"; shift; fi
done
echo "$endpoint" >> "$PR_FIXTURE_CALLS"
case "$endpoint" in
  */pulls/42/files*page=*) page=$(printf '%s' "$endpoint" | sed 's/.*page=//'); cat "$PR_FIXTURE_PAGE_PREFIX$page.json" ;;
  */pulls/42) cat "$PR_FIXTURE_DETAILS" ;;
  */compare/*)
    if [ "$jq_filter" = '{merge_base_sha:.merge_base_commit.sha,base_sha:.base_commit.sha}' ]; then
      merge_base=$(sed -n 's/.*"merge_base_commit":{[^}]*"sha":"\([^"]*\)"[^}]*}.*/\1/p' "$PR_FIXTURE_COMPARISON")
      base_sha=$(sed -n 's/.*"base_commit":{[^}]*"sha":"\([^"]*\)"[^}]*}.*/\1/p' "$PR_FIXTURE_COMPARISON")
      printf '{"merge_base_sha":"%s","base_sha":"%s"}' "$merge_base" "$base_sha"
    else
      printf '{"merge_base_sha":"%s","head_sha":null}' "$PR_FIXTURE_MERGE_BASE"
    fi
    ;;
  */contents/*?ref=*) content_path=$(printf '%s' "$endpoint" | sed 's@.*contents/@@; s@?ref=.*@@'); content_ref=$(printf '%s' "$endpoint" | sed 's@.*?ref=@@'); cat "$PR_FIXTURE_CONTENTS/$content_ref/$content_path" ;;
  */contents/large.txt?ref=*) head -c 1048580 /dev/zero | tr '\000' x ;;
  *) echo "unexpected endpoint" >&2; exit 1 ;;
esac
`
	gh := filepath.Join(binDir, "gh")
	if err := os.WriteFile(gh, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PR_FIXTURE_METADATA", metadataPath)
	t.Setenv("PR_FIXTURE_DETAILS", detailsPath)
	t.Setenv("PR_FIXTURE_COMPARISON", comparisonPath)
	t.Setenv("PR_FIXTURE_MERGE_BASE", mergeBase)
	t.Setenv("PR_FIXTURE_PAGE_PREFIX", pagePrefix)
	t.Setenv("PR_FIXTURE_CALLS", calls)
	t.Setenv("PR_FIXTURE_CONTENTS", contentsRoot)
	return gitHubPRFixture{binDir: binDir, calls: calls, baseTip: baseTip, mergeBase: mergeBase, headSHA: headSHA, detailsPath: detailsPath, comparisonPath: comparisonPath}
}

func flattenGitHubPRFiles(pages [][]githubPRFile) []githubPRFile {
	var files []githubPRFile
	for _, page := range pages {
		files = append(files, page...)
	}
	return files
}

func writeGitHubFixtureBlob(t *testing.T, contentsRoot, revision, repository, relativePath string) {
	t.Helper()
	command := exec.Command("git", "-C", repository, "show", revision+":"+relativePath)
	content, err := command.Output()
	if err != nil {
		t.Fatalf("git show %s:%s: %v", revision, relativePath, err)
	}
	filePath := filepath.Join(contentsRoot, revision, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filePath, content, 0o600); err != nil {
		t.Fatal(err)
	}
}
