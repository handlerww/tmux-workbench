package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestFileAPIsListAndPreviewSessionFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := fileTestHandler(t, root, "")

	listing := serveFileRequest(handler, "/api/files?session=%247")
	if listing.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listing.Code, listing.Body.String())
	}
	var list fileListResponse
	if err := json.Unmarshal(listing.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Root != root || list.Path != "." || len(list.Entries) != 2 {
		t.Fatalf("unexpected listing: %#v", list)
	}
	if list.Entries[0].Name != "src" || list.Entries[0].Type != "directory" {
		t.Fatalf("directories should sort first: %#v", list.Entries)
	}

	preview := serveFileRequest(handler, "/api/file?session=work&path=src/main.go")
	if preview.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body = %s", preview.Code, preview.Body.String())
	}
	var file fileResponse
	if err := json.Unmarshal(preview.Body.Bytes(), &file); err != nil {
		t.Fatal(err)
	}
	if file.Root != root || file.Path != "src/main.go" || file.Name != "main.go" || file.Content != "package main\n" || file.Language != "go" || file.Size != int64(len(file.Content)) || file.Revision != testRevision([]byte(file.Content)) {
		t.Fatalf("unexpected preview: %#v", file)
	}
}

func TestSaveFileUsesRevisionAndPreservesModeAndOwner(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "edit.txt")
	if err := os.WriteFile(filePath, []byte("before\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filePath, 0o640); err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(filePath)
	if err != nil {
		t.Fatal(err)
	}
	handler := fileTestHandler(t, root, "")
	get := serveFileRequest(handler, "/api/file?session=work&path=edit.txt")
	var before fileResponse
	if err := json.Unmarshal(get.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}
	if before.Revision != testRevision([]byte("before\n")) {
		t.Fatalf("GET revision = %q", before.Revision)
	}

	response := serveSaveRequest(handler, saveFileRequest{Session: "work", Path: "edit.txt", Content: "after\n", Revision: before.Revision}, "http://127.0.0.1")
	if response.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body = %s", response.Code, response.Body.String())
	}
	var saved fileResponse
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Content != "after\n" || saved.Revision != testRevision([]byte("after\n")) {
		t.Fatalf("unexpected save response: %#v", saved)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "after\n" {
		t.Fatalf("saved content = %q", content)
	}
	afterInfo, err := os.Stat(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if afterInfo.Mode().Perm() != beforeInfo.Mode().Perm() {
		t.Errorf("saved mode = %o, want %o", afterInfo.Mode().Perm(), beforeInfo.Mode().Perm())
	}
	if beforeStat, ok := beforeInfo.Sys().(*syscall.Stat_t); ok {
		if afterStat, ok := afterInfo.Sys().(*syscall.Stat_t); !ok || beforeStat.Uid != afterStat.Uid || beforeStat.Gid != afterStat.Gid {
			t.Errorf("saved owner/group changed: before=%#v after=%#v", beforeStat, afterInfo.Sys())
		}
	}
	temporaryFiles, err := filepath.Glob(filepath.Join(root, ".workbench-save-*"))
	if err != nil || len(temporaryFiles) != 0 {
		t.Errorf("temporary files remain after save: %v, err=%v", temporaryFiles, err)
	}
}

func TestSaveFileRejectsStaleRevisionWithoutClobbering(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "edit.txt")
	if err := os.WriteFile(filePath, []byte("first\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := fileTestHandler(t, root, "")
	stale := testRevision([]byte("first\n"))
	if err := os.WriteFile(filePath, []byte("external change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := serveSaveRequest(handler, saveFileRequest{Session: "work", Path: "edit.txt", Content: "browser overwrite\n", Revision: stale}, "http://127.0.0.1")
	if response.Code != http.StatusConflict {
		t.Fatalf("PUT status = %d, want 409: %s", response.Code, response.Body.String())
	}
	var conflict map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil {
		t.Fatal(err)
	}
	if conflict["revision"] != testRevision([]byte("external change\n")) {
		t.Fatalf("conflict revision = %#v", conflict)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, []byte("external change\n")) {
		t.Fatalf("stale save clobbered content: %q", content)
	}
}

func TestSaveFileRejectsSessionDirectoryChange(t *testing.T) {
	firstRoot := t.TempDir()
	currentRoot := t.TempDir()
	for _, root := range []string{firstRoot, currentRoot} {
		if err := os.WriteFile(filepath.Join(root, "edit.txt"), []byte("same content\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	handler := fileTestHandler(t, currentRoot, "")
	request := saveFileRequest{
		Session:  "work",
		Root:     firstRoot,
		Path:     "edit.txt",
		Content:  "should not write\n",
		Revision: testRevision([]byte("same content\n")),
	}
	response := serveSaveRequest(handler, request, "http://127.0.0.1")
	if response.Code != http.StatusConflict {
		t.Fatalf("PUT status = %d, want 409: %s", response.Code, response.Body.String())
	}
	var conflict map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil {
		t.Fatal(err)
	}
	if conflict["root"] != currentRoot {
		t.Fatalf("root conflict body = %#v", conflict)
	}
	content, err := os.ReadFile(filepath.Join(currentRoot, "edit.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "same content\n" {
		t.Fatalf("session root change clobbered file: %q", content)
	}
}

func TestSaveFileRejectsCrossOriginSymlinkBinaryAndOversizedWrites(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "text.txt"), []byte("text\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "linked.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "linked-dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked-dir", "nested")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	handler := fileTestHandler(t, root, "")
	validRevision := testRevision([]byte("text\n"))
	tests := []struct {
		name    string
		request saveFileRequest
		origin  string
		want    int
	}{
		{"cross-origin", saveFileRequest{Session: "work", Path: "text.txt", Content: "changed", Revision: validRevision}, "https://evil.example", http.StatusForbidden},
		{"file-symlink", saveFileRequest{Session: "work", Path: "linked.txt", Content: "changed", Revision: testRevision([]byte("secret\n"))}, "http://127.0.0.1", http.StatusBadRequest},
		{"parent-symlink", saveFileRequest{Session: "work", Path: "linked-dir/nested/secret.txt", Content: "changed", Revision: testRevision([]byte("secret\n"))}, "http://127.0.0.1", http.StatusBadRequest},
		{"binary", saveFileRequest{Session: "work", Path: "text.txt", Content: "bad\x00text", Revision: validRevision}, "http://127.0.0.1", http.StatusUnsupportedMediaType},
		{"oversized", saveFileRequest{Session: "work", Path: "text.txt", Content: strings.Repeat("x", maxPreviewBytes+1), Revision: validRevision}, "http://127.0.0.1", http.StatusRequestEntityTooLarge},
	}
	for _, test := range tests {
		response := serveSaveRequest(handler, test.request, test.origin)
		if response.Code != test.want {
			t.Errorf("%s PUT status = %d, want %d (%s)", test.name, response.Code, test.want, response.Body.String())
		}
	}
	content, err := os.ReadFile(filepath.Join(root, "text.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "text\n" {
		t.Fatalf("rejected saves changed target file: %q", content)
	}
}

func TestFileAPIsRejectTraversalAndSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outside")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	handler := fileTestHandler(t, root, "")

	for _, target := range []string{
		"/api/files?session=work&path=..",
		"/api/file?session=work&path=../secret.txt",
		"/api/file?session=work&path=outside/secret.txt",
	} {
		response := serveFileRequest(handler, target)
		if response.Code < 400 {
			t.Errorf("GET %s status = %d, want an error", target, response.Code)
		}
	}
	listing := serveFileRequest(handler, "/api/files?session=work")
	if listing.Code != http.StatusOK || strings.Contains(listing.Body.String(), "outside") {
		t.Fatalf("outside symlink should be hidden: status=%d body=%s", listing.Code, listing.Body.String())
	}
}

func TestFileAPIRejectsBinaryAndOversizedPreviews(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "binary.dat"), []byte{'a', 0, 'b'}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "large.txt"), make([]byte, maxPreviewBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := fileTestHandler(t, root, "")
	for _, test := range []struct {
		path string
		want int
	}{{"binary.dat", http.StatusUnsupportedMediaType}, {"large.txt", http.StatusRequestEntityTooLarge}} {
		response := serveFileRequest(handler, "/api/file?session=work&path="+test.path)
		if response.Code != test.want || !strings.Contains(response.Header().Get("Content-Type"), "application/json") {
			t.Errorf("preview %s = status %d, content-type %q, want %d JSON", test.path, response.Code, response.Header().Get("Content-Type"), test.want)
		}
	}
}

func TestImageEndpointServesSniffedAllowlistedFormats(t *testing.T) {
	root := t.TempDir()
	fixtures := []struct {
		name        string
		content     []byte
		contentType string
	}{
		{"picture.png", []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, "image/png"},
		{"picture.jpg", []byte{0xff, 0xd8, 0xff, 0xd9}, "image/jpeg"},
		{"picture.gif", []byte("GIF89a"), "image/gif"},
		{"picture.webp", []byte("RIFF\x00\x00\x00\x00WEBP"), "image/webp"},
		{"picture.bmp", []byte("BM"), "image/bmp"},
		{"picture.avif", []byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f', 0, 0, 0, 0}, "image/avif"},
		{"picture.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>`), "image/svg+xml"},
	}
	for _, fixture := range fixtures {
		if err := os.WriteFile(filepath.Join(root, fixture.name), fixture.content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	handler := fileTestHandler(t, root, "")
	for _, fixture := range fixtures {
		response := serveFileRequest(handler, "/api/file/image?session=work&path="+fixture.name)
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != fixture.contentType || response.Body.String() != string(fixture.content) {
			t.Errorf("image %s status/content-type/body = %d/%q/%q", fixture.name, response.Code, response.Header().Get("Content-Type"), response.Body.String())
		}
		if fixture.contentType == "image/svg+xml" && !strings.Contains(response.Header().Get("Content-Security-Policy"), "sandbox") {
			t.Error("SVG response must carry sandbox CSP")
		}
	}
	listing := serveFileRequest(handler, "/api/files?session=work")
	if !strings.Contains(listing.Body.String(), `"previewType":"image"`) {
		t.Fatalf("image candidate metadata missing from listing: %s", listing.Body.String())
	}
}

func TestImageEndpointRejectsSpoofedAndUnsafeSVGAndOversizedFiles(t *testing.T) {
	root := t.TempDir()
	files := map[string][]byte{
		"spoof.png":  []byte("not an image"),
		"unsafe.svg": []byte(`<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`),
		"large.png":  append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, make([]byte, maxImageBytes)...),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	handler := fileTestHandler(t, root, "")
	for _, test := range []struct {
		name string
		want int
	}{{"spoof.png", http.StatusUnsupportedMediaType}, {"unsafe.svg", http.StatusUnsupportedMediaType}, {"large.png", http.StatusRequestEntityTooLarge}} {
		response := serveFileRequest(handler, "/api/file/image?session=work&path="+test.name)
		if response.Code != test.want || !strings.Contains(response.Header().Get("Content-Type"), "application/json") {
			t.Errorf("image %s = %d %q, want %d JSON", test.name, response.Code, response.Header().Get("Content-Type"), test.want)
		}
	}
}

func TestFileAPIsRejectNamedPipesWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o600); err != nil {
		t.Skipf("named pipes unavailable: %v", err)
	}
	handler := fileTestHandler(t, root, "")
	for _, target := range []string{
		"/api/files?session=work&path=pipe",
		"/api/file?session=work&path=pipe",
		"/api/file/image?session=work&path=pipe",
	} {
		response := serveFileRequest(handler, target)
		if response.Code < 400 {
			t.Errorf("GET %s status = %d, want an error", target, response.Code)
		}
	}
}

func TestFileAPIFilesystemRootMapsAndConfinesHostPaths(t *testing.T) {
	hostRoot := t.TempDir()
	project := filepath.Join(hostRoot, "srv", "work")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "ok.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(hostRoot, "srv", "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	handler := fileTestHandler(t, "/srv/work", hostRoot)
	preview := serveFileRequest(handler, "/api/file?session=work&path=ok.txt")
	if preview.Code != http.StatusOK || !strings.Contains(preview.Body.String(), `"root":"/srv/work"`) {
		t.Fatalf("mapped file preview = %d %s", preview.Code, preview.Body.String())
	}
}

func TestFileAPIValidatesSessionAndRequiredPath(t *testing.T) {
	root := t.TempDir()
	handler := fileTestHandler(t, root, "")
	for _, test := range []struct {
		url  string
		want int
	}{{"/api/files", http.StatusBadRequest}, {"/api/files?session=missing", http.StatusNotFound}, {"/api/file?session=work", http.StatusBadRequest}, {"/api/files?session=work&path=%2Fetc", http.StatusBadRequest}} {
		response := serveFileRequest(handler, test.url)
		if response.Code != test.want {
			t.Errorf("GET %s status = %d, want %d (%s)", test.url, response.Code, test.want, response.Body.String())
		}
	}
}

func fileTestHandler(t *testing.T, sessionPath, filesystemRoot string) http.Handler {
	t.Helper()
	tmuxBinary := filepath.Join(t.TempDir(), "fake-tmux")
	script := fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = list-sessions ]; then printf '%%s\\n' '$7<<<tmux-webui-field>>>work<<<tmux-webui-field>>>%s<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000100'; exit 0; fi\nexit 1\n", sessionPath)
	if err := os.WriteFile(tmuxBinary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewWithFilesystemRoot(tmuxBinary, logger, filesystemRoot)
}

func serveFileRequest(handler http.Handler, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+target, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func serveSaveRequest(handler http.Handler, input saveFileRequest, origin string) *httptest.ResponseRecorder {
	body, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	request := httptest.NewRequest(http.MethodPut, "http://127.0.0.1/api/file", bytes.NewReader(body))
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func testRevision(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}
