package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateFileCreatesEmptyFileAndDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o750); err != nil {
		t.Fatal(err)
	}
	handler := fileTestHandler(t, root, "")

	fileResponse := serveCreateFileRequest(handler, createFileRequest{Session: "work", Root: root, Path: "src/new.txt", Kind: "file"}, "http://127.0.0.1")
	if fileResponse.Code != http.StatusCreated {
		t.Fatalf("create file returned %d: %s", fileResponse.Code, fileResponse.Body.String())
	}
	var fileResult createFileResponse
	if err := json.Unmarshal(fileResponse.Body.Bytes(), &fileResult); err != nil {
		t.Fatal(err)
	}
	if fileResult != (createFileResponse{Path: "src/new.txt", Kind: "file", Root: root}) {
		t.Fatalf("unexpected file response: %#v", fileResult)
	}
	content, err := os.ReadFile(filepath.Join(root, "src", "new.txt"))
	if err != nil || len(content) != 0 {
		t.Fatalf("created file content=%q err=%v", content, err)
	}
	info, err := os.Stat(filepath.Join(root, "src", "new.txt"))
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("created file info=%v err=%v", info, err)
	}

	dirResponse := serveCreateFileRequest(handler, createFileRequest{Session: "work", Root: root, Path: "src/new-dir", Kind: "directory"}, "http://127.0.0.1")
	if dirResponse.Code != http.StatusCreated {
		t.Fatalf("create directory returned %d: %s", dirResponse.Code, dirResponse.Body.String())
	}
	var dirResult createFileResponse
	if err := json.Unmarshal(dirResponse.Body.Bytes(), &dirResult); err != nil {
		t.Fatal(err)
	}
	if dirResult != (createFileResponse{Path: "src/new-dir", Kind: "directory", Root: root}) {
		t.Fatalf("unexpected directory response: %#v", dirResult)
	}
	dirInfo, err := os.Stat(filepath.Join(root, "src", "new-dir"))
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode().Perm() != 0o755 {
		t.Fatalf("created directory info=%v err=%v", dirInfo, err)
	}
}

func TestCreateFileRejectsOverwriteTraversalAndSymlinks(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "existing.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	handler := fileTestHandler(t, root, "")
	tests := []struct {
		name   string
		input  createFileRequest
		origin string
		want   int
	}{
		{"cross-origin", createFileRequest{Session: "work", Root: root, Path: "new.txt", Kind: "file"}, "https://evil.example", http.StatusForbidden},
		{"changed-root", createFileRequest{Session: "work", Root: outside, Path: "new.txt", Kind: "file"}, "http://127.0.0.1", http.StatusConflict},
		{"overwrite-file", createFileRequest{Session: "work", Root: root, Path: "existing.txt", Kind: "file"}, "http://127.0.0.1", http.StatusConflict},
		{"overwrite-directory", createFileRequest{Session: "work", Root: root, Path: "linked", Kind: "directory"}, "http://127.0.0.1", http.StatusConflict},
		{"absolute", createFileRequest{Session: "work", Root: root, Path: filepath.Join(outside, "escaped.txt"), Kind: "file"}, "http://127.0.0.1", http.StatusBadRequest},
		{"parent-traversal", createFileRequest{Session: "work", Root: root, Path: "../escaped.txt", Kind: "file"}, "http://127.0.0.1", http.StatusBadRequest},
		{"nested-traversal", createFileRequest{Session: "work", Root: root, Path: "linked/../escaped.txt", Kind: "file"}, "http://127.0.0.1", http.StatusBadRequest},
		{"symlink-parent", createFileRequest{Session: "work", Root: root, Path: "linked/secret.txt", Kind: "file"}, "http://127.0.0.1", http.StatusBadRequest},
		{"missing-parent", createFileRequest{Session: "work", Root: root, Path: "missing/new.txt", Kind: "file"}, "http://127.0.0.1", http.StatusNotFound},
		{"invalid-kind", createFileRequest{Session: "work", Root: root, Path: "new.txt", Kind: "link"}, "http://127.0.0.1", http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := serveCreateFileRequest(handler, test.input, test.origin)
			if response.Code != test.want {
				t.Fatalf("create returned %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
		})
	}
	content, err := os.ReadFile(filepath.Join(root, "existing.txt"))
	if err != nil || string(content) != "keep" {
		t.Fatalf("existing content=%q err=%v", content, err)
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 1 || entries[0].Name() != "secret.txt" {
		t.Fatalf("invalid requests wrote outside root: entries=%v err=%v", entries, err)
	}
}

func TestCreateFileCleansUpAfterParentMovesWithoutDeletingReplacement(t *testing.T) {
	root, changedRoot := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	counter := filepath.Join(t.TempDir(), "calls")
	tmuxBinary := filepath.Join(t.TempDir(), "fake-tmux")
	script := fmt.Sprintf(`#!/bin/sh
count=0
if [ -f '%s' ]; then count=$(cat '%s'); fi
count=$((count + 1))
printf '%%s' "$count" > '%s'
if [ "$count" -eq 3 ]; then
  mv '%s/src' '%s/moved'
  mkdir '%s/src'
  mv '%s/moved/new.txt' '%s/moved/original.txt'
  printf 'replacement' > '%s/moved/new.txt'
  session_path='%s'
else
  session_path='%s'
fi
if [ "$1" = list-sessions ]; then line='$7<<<tmux-webui-field>>>work<<<tmux-webui-field>>>'"$session_path"'<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000100'; printf '%%s\n' "$line"; exit 0; fi
exit 1
`, counter, counter, counter, root, root, root, root, root, root, changedRoot, root)
	if err := os.WriteFile(tmuxBinary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewWithFilesystemRoot(tmuxBinary, logger, "")
	response := serveCreateFileRequest(handler, createFileRequest{Session: "work", Root: root, Path: "src/new.txt", Kind: "file"}, "http://127.0.0.1")
	if response.Code != http.StatusConflict {
		t.Fatalf("create returned %d, want 409 after parent move: %s", response.Code, response.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(root, "moved", "new.txt"))
	if err != nil || string(content) != "replacement" {
		count, _ := os.ReadFile(counter)
		entries, _ := os.ReadDir(root)
		movedEntries, _ := os.ReadDir(filepath.Join(root, "moved"))
		t.Fatalf("replacement content=%q err=%v; calls=%q entries=%v moved=%v; cleanup must not remove a replacement inode", content, err, count, entries, movedEntries)
	}
}

func serveCreateFileRequest(handler http.Handler, input createFileRequest, origin string) *httptest.ResponseRecorder {
	body, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/file/create", bytes.NewReader(body))
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
