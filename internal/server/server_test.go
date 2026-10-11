package server

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workbench/internal/tmux"
)

func TestDimensions(t *testing.T) {
	request := httptest.NewRequest("GET", "/ws?cols=160&rows=48", nil)
	columns, rows := dimensions(request.URL.Query())
	if columns != 160 || rows != 48 {
		t.Fatalf("got %dx%d", columns, rows)
	}

	request = httptest.NewRequest("GET", "/ws?cols=9999&rows=nope", nil)
	columns, rows = dimensions(request.URL.Query())
	if columns != 120 || rows != 32 {
		t.Fatalf("got fallback %dx%d", columns, rows)
	}
}

func TestPWAAssets(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := New("unused", logger)
	tests := []struct {
		path        string
		contentType string
		contains    string
	}{
		{path: "/manifest.webmanifest", contentType: "application/manifest+json", contains: `"display": "standalone"`},
		{path: "/sw.js", contentType: "text/javascript", contains: "workbench-shell"},
		{path: "/icons/tmux-192.png", contentType: "image/png"},
		{path: "/icons/tmux-512.png", contentType: "image/png"},
	}

	for _, test := range tests {
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+test.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Errorf("GET %s status = %d, want 200", test.path, response.Code)
		}
		if got := response.Header().Get("Content-Type"); !strings.HasPrefix(got, test.contentType) {
			t.Errorf("GET %s Content-Type = %q, want prefix %q", test.path, got, test.contentType)
		}
		if test.contains != "" && !strings.Contains(response.Body.String(), test.contains) {
			t.Errorf("GET %s body does not contain %q", test.path, test.contains)
		}
	}
}

func TestSameOrigin(t *testing.T) {
	request := httptest.NewRequest("GET", "http://127.0.0.1:7681/ws", nil)
	request.Host = "127.0.0.1:7681"
	request.Header.Set("Origin", "http://127.0.0.1:7681")
	if !sameOrigin(request) {
		t.Fatal("expected matching origin")
	}
	request.Header.Set("Origin", "https://example.com")
	if sameOrigin(request) {
		t.Fatal("expected cross-origin request to be rejected")
	}
}

func TestValidateSessionName(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{name: "work"},
		{name: "work tree"},
		{name: "", want: "A session name is required"},
		{name: " work", want: "Session names cannot start or end with whitespace"},
		{name: "work\nnext", want: "Session names cannot contain control characters"},
		{name: strings.Repeat("x", 101), want: "Session names must be at most 100 characters"},
	}
	for _, test := range tests {
		if got := validateSessionName(test.name); got != test.want {
			t.Errorf("validateSessionName(%q) = %q, want %q", test.name, got, test.want)
		}
	}
}

func TestValidateSessionPath(t *testing.T) {
	tests := []struct {
		value string
		want  string
	}{
		{value: "/srv/work tree"},
		{value: "/srv/../work"},
		{value: "", want: "A working directory is required"},
		{value: "relative/path", want: "Working directories must be absolute paths"},
		{value: " /srv/work", want: "Working directories cannot start or end with whitespace"},
		{value: "/srv/work\nnext", want: "Working directories cannot contain control characters"},
	}
	for _, test := range tests {
		path, got := validateSessionPath(test.value)
		if got != test.want {
			t.Errorf("validateSessionPath(%q) error = %q, want %q", test.value, got, test.want)
		}
		if got == "" && !filepath.IsAbs(path) {
			t.Errorf("validateSessionPath(%q) returned non-absolute path %q", test.value, path)
		}
	}
}

func TestNextNumericSessionNameUsesSmallestGap(t *testing.T) {
	sessions := []tmux.Session{{Name: "0"}, {Name: "2"}, {Name: "01"}, {Name: "work"}, {Name: "-1"}}
	if got := nextNumericSessionName(sessions); got != "1" {
		t.Fatalf("nextNumericSessionName() = %q, want 1", got)
	}
	if got := nextNumericSessionName(nil); got != "0" {
		t.Fatalf("nextNumericSessionName(nil) = %q, want 0", got)
	}
}

func TestRenameSession(t *testing.T) {
	temporaryDirectory := t.TempDir()
	logPath := filepath.Join(temporaryDirectory, "arguments")
	tmuxBinary := filepath.Join(temporaryDirectory, "fake-tmux")
	script := fmt.Sprintf(`#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf '%%s\n' '$7<<<tmux-webui-field>>>old name<<<tmux-webui-field>>>/srv/work<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000100'
  exit 0
fi
if [ "$1" = "rename-session" ]; then
  printf '%%s\n' "$2|$3|$4" > %q
  exit 0
fi
exit 1
`, logPath)
	if err := os.WriteFile(tmuxBinary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := New(tmuxBinary, logger)
	request := httptest.NewRequest(http.MethodPatch, "http://127.0.0.1/api/sessions/rename", bytes.NewBufferString(`{"id":"$7","name":"new work"}`))
	request.Header.Set("Origin", "http://127.0.0.1")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("got status %d with body %s", response.Code, response.Body.String())
	}
	arguments, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.TrimSpace(string(arguments)), "-t|$7|new work"; got != want {
		t.Fatalf("rename arguments = %q, want %q", got, want)
	}
}

func TestCreateSession(t *testing.T) {
	temporaryDirectory := t.TempDir()
	logPath := filepath.Join(temporaryDirectory, "arguments")
	tmuxBinary := filepath.Join(temporaryDirectory, "fake-tmux")
	script := fmt.Sprintf(`#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf '%%s\n' '$1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>/srv/zero<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000000'
  printf '%%s\n' '$3<<<tmux-webui-field>>>2<<<tmux-webui-field>>>/srv/two<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000000'
  exit 0
fi
if [ "$1" = "new-session" ]; then
  printf '%%s\n' "$@" > %q
  printf '%%s\n' '$9<<<tmux-webui-field>>>1<<<tmux-webui-field>>>/srv/work tree<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000000'
  exit 0
fi
exit 1
`, logPath)
	if err := os.WriteFile(tmuxBinary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := New(tmuxBinary, logger)
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/sessions", bytes.NewBufferString(`{"path":"/srv/work tree"}`))
	request.Header.Set("Origin", "http://127.0.0.1")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("got status %d with body %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"id":"$9"`) || !strings.Contains(response.Body.String(), `"name":"1"`) {
		t.Fatalf("unexpected response body %s", response.Body.String())
	}
	arguments, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSpace(string(arguments)), "\n")
	if len(got) != 9 || got[0] != "new-session" || got[1] != "-d" || got[2] != "-P" || got[3] != "-F" || got[5] != "-s" || got[6] != "1" || got[7] != "-c" || got[8] != "/srv/work tree" {
		t.Fatalf("unexpected create arguments: %#v", got)
	}
}

func TestCreateSessionRetriesAfterNumericNameRace(t *testing.T) {
	temporaryDirectory := t.TempDir()
	racePath := filepath.Join(temporaryDirectory, "race-won")
	tmuxBinary := filepath.Join(temporaryDirectory, "fake-tmux")
	script := fmt.Sprintf(`#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  if [ -f %q ]; then
    printf '%%s\n' '$1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>/srv/external<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000000'
  fi
  exit 0
fi
if [ "$1" = "new-session" ] && [ "$7" = "0" ]; then
  touch %q
  printf '%%s\n' 'duplicate session: 0' >&2
  exit 1
fi
if [ "$1" = "new-session" ] && [ "$7" = "1" ]; then
  printf '%%s\n' '$2<<<tmux-webui-field>>>1<<<tmux-webui-field>>>/srv/work<<<tmux-webui-field>>>1<<<tmux-webui-field>>>0<<<tmux-webui-field>>>1723000000<<<tmux-webui-field>>>1723000000'
  exit 0
fi
exit 1
`, racePath, racePath)
	if err := os.WriteFile(tmuxBinary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := New(tmuxBinary, logger)
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/sessions", bytes.NewBufferString(`{"path":"/srv/work"}`))
	request.Header.Set("Origin", "http://127.0.0.1")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"name":"1"`) {
		t.Fatalf("got status %d with body %s", response.Code, response.Body.String())
	}
}

func TestRenameSessionRejectsCrossOriginRequest(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := New("unused", logger)
	request := httptest.NewRequest(http.MethodPatch, "http://127.0.0.1/api/sessions/rename", bytes.NewBufferString(`{"id":"$7","name":"new work"}`))
	request.Header.Set("Origin", "https://example.com")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("got status %d, want %d", response.Code, http.StatusForbidden)
	}
}
