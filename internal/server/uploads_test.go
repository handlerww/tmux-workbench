package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUploadFilePublishesBinaryWithoutOverwrite(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	handler := fileTestHandler(t, root, "")
	content := []byte{0, 1, 2, 0xff, 0x80, '\n'}
	response := serveUploadRequest(handler, "/api/file/upload?session=%247&root="+urlQueryEscape(root)+"&directory=assets&name=photo.bin", content, "http://127.0.0.1")
	if response.Code != http.StatusCreated {
		t.Fatalf("upload returned %d: %s", response.Code, response.Body.String())
	}
	var result fileUploadResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Root != root || result.Path != "assets/photo.bin" || result.Name != "photo.bin" || result.Size != int64(len(content)) {
		t.Fatalf("unexpected upload result: %#v", result)
	}
	stored, err := os.ReadFile(filepath.Join(root, result.Path))
	if err != nil || !bytes.Equal(stored, content) {
		t.Fatalf("stored upload = %v, err=%v", stored, err)
	}
	info, err := os.Stat(filepath.Join(root, result.Path))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Errorf("uploaded mode = %o, want 644", info.Mode().Perm())
	}

	duplicate := serveUploadRequest(handler, "/api/file/upload?session=%247&root="+urlQueryEscape(root)+"&directory=assets&name=photo.bin", []byte("replacement"), "http://127.0.0.1")
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate upload returned %d, want 409: %s", duplicate.Code, duplicate.Body.String())
	}
	stored, err = os.ReadFile(filepath.Join(root, result.Path))
	if err != nil || !bytes.Equal(stored, content) {
		t.Fatalf("duplicate upload replaced original: %v, err=%v", stored, err)
	}
	assertNoUploadTemps(t, filepath.Join(root, "assets"))
}

func TestUploadFileValidatesOriginRootDirectoryAndName(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	handler := fileTestHandler(t, root, "")
	base := "/api/file/upload?session=%247&root=" + urlQueryEscape(root)
	tests := []struct {
		name   string
		target string
		origin string
		want   int
	}{
		{"cross-origin", base + "&name=new.bin", "https://example.invalid", http.StatusForbidden},
		{"changed-root", "/api/file/upload?session=%247&root=" + urlQueryEscape(outside) + "&name=new.bin", "http://127.0.0.1", http.StatusConflict},
		{"traversal-directory", base + "&directory=..&name=new.bin", "http://127.0.0.1", http.StatusBadRequest},
		{"symlink-directory", base + "&directory=linked&name=new.bin", "http://127.0.0.1", http.StatusBadRequest},
		{"slash-name", base + "&name=..%2Fsecret", "http://127.0.0.1", http.StatusBadRequest},
		{"backslash-name", base + "&name=..%5Csecret", "http://127.0.0.1", http.StatusBadRequest},
		{"empty-name", base, "http://127.0.0.1", http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := serveUploadRequest(handler, test.target, []byte("payload"), test.origin)
			if response.Code != test.want {
				t.Errorf("upload status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
		})
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatalf("invalid upload wrote outside the session root: entries=%v err=%v", entries, err)
	}
	assertNoUploadTemps(t, root)
}

func TestUploadFileRejectsOversizeAndCleansTemporaryFile(t *testing.T) {
	root := t.TempDir()
	handler := fileTestHandler(t, root, "")
	body := bytes.Repeat([]byte("x"), maxUploadBytes+1)
	response := serveUploadRequest(handler, "/api/file/upload?session=%247&root="+urlQueryEscape(root)+"&name=large.bin", body, "http://127.0.0.1")
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload returned %d, want 413: %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "large.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("oversized upload created target: %v", err)
	}
	assertNoUploadTemps(t, root)
}

func TestUploadFileCancellationCleansTemporaryFile(t *testing.T) {
	root := t.TempDir()
	handler := fileTestHandler(t, root, "")
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/file/upload?session=%247&root="+urlQueryEscape(root)+"&name=cancelled.bin", nil).WithContext(ctx)
	request.Header.Set("Origin", "http://127.0.0.1")
	request.Body = io.NopCloser(&cancelUploadReader{cancel: cancel})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestTimeout {
		t.Fatalf("cancelled upload returned %d, want 408: %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "cancelled.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled upload created target: %v", err)
	}
	assertNoUploadTemps(t, root)
}

func TestUploadFileRejectsReplacedDestinationDirectory(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "assets")
	if err := os.Mkdir(destination, 0o755); err != nil {
		t.Fatal(err)
	}
	handler := fileTestHandler(t, root, "")
	target := "http://127.0.0.1/api/file/upload?session=%247&root=" + urlQueryEscape(root) + "&directory=assets&name=photo.bin"
	request := httptest.NewRequest(http.MethodPost, target, nil)
	request.Header.Set("Origin", "http://127.0.0.1")
	request.Body = io.NopCloser(&callbackUploadReader{callback: func() {
		if err := os.Rename(destination, filepath.Join(root, "assets-old")); err != nil {
			t.Errorf("rename upload directory: %v", err)
			return
		}
		if err := os.Mkdir(destination, 0o755); err != nil {
			t.Errorf("replace upload directory: %v", err)
		}
	}, data: []byte("payload")})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("upload into replaced destination returned %d, want 409: %s", response.Code, response.Body.String())
	}
	for _, directory := range []string{destination, filepath.Join(root, "assets-old")} {
		if _, err := os.Stat(filepath.Join(directory, "photo.bin")); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("upload published into stale/replaced directory %q: %v", directory, err)
		}
		assertNoUploadTemps(t, directory)
	}
}

type cancelUploadReader struct {
	cancel context.CancelFunc
	sent   bool
}

type callbackUploadReader struct {
	callback func()
	data     []byte
	sent     bool
}

func (reader *callbackUploadReader) Read(buffer []byte) (int, error) {
	if reader.sent {
		return 0, io.EOF
	}
	reader.sent = true
	reader.callback()
	return copy(buffer, reader.data), nil
}

func (reader *cancelUploadReader) Read(buffer []byte) (int, error) {
	if reader.sent {
		return 0, context.Canceled
	}
	reader.sent = true
	reader.cancel()
	return copy(buffer, []byte("partial")), nil
}

func serveUploadRequest(handler http.Handler, target string, body []byte, origin string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1"+target, bytes.NewReader(body))
	request.Header.Set("Origin", origin)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertNoUploadTemps(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".workbench-save-") {
			t.Errorf("temporary upload remains: %s", filepath.Join(directory, entry.Name()))
		}
	}
}

func urlQueryEscape(value string) string {
	return url.QueryEscape(value)
}
