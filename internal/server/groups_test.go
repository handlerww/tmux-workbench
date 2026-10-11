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
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestGroupsStartEmptyAndPersistAcrossHandlerRestart(t *testing.T) {
	stateDir := t.TempDir()
	handler := persistentGroupHandler(t, stateDir)
	initialResponse := groupsRequest(handler, http.MethodGet, nil, "")
	if initialResponse.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", initialResponse.Code, initialResponse.Body.String())
	}
	var initial groupSnapshot
	if err := json.Unmarshal(initialResponse.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if len(initial.Groups) != 0 || len(initial.Assignments) != 0 || initial.UngroupedCollapsed || initial.Revision != emptyGroupData().revision() {
		t.Fatalf("unexpected initial state: %#v", initial)
	}

	updated := updateGroupsRequest{
		Groups:             []sessionGroup{{ID: "group-123", Name: "Platform", Collapsed: true}},
		Assignments:        map[string]string{"$7": "group-123", "$19": "group-123"},
		UngroupedCollapsed: true,
		Revision:           initial.Revision,
	}
	saveResponse := groupsRequest(handler, http.MethodPut, updated, "http://127.0.0.1")
	if saveResponse.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body = %s", saveResponse.Code, saveResponse.Body.String())
	}
	var saved groupSnapshot
	if err := json.Unmarshal(saveResponse.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Revision == initial.Revision || saved.Groups[0].Name != "Platform" || saved.Assignments["$19"] != "group-123" || !saved.UngroupedCollapsed {
		t.Fatalf("unexpected saved state: %#v", saved)
	}
	stateInfo, err := os.Stat(filepath.Join(stateDir, groupStoreFileName))
	if err != nil {
		t.Fatal(err)
	}
	if stateInfo.Mode().Perm() != 0o600 {
		t.Errorf("state file mode = %o, want 600", stateInfo.Mode().Perm())
	}

	restarted := persistentGroupHandler(t, stateDir)
	reloadedResponse := groupsRequest(restarted, http.MethodGet, nil, "")
	var reloaded groupSnapshot
	if err := json.Unmarshal(reloadedResponse.Body.Bytes(), &reloaded); err != nil {
		t.Fatal(err)
	}
	if reloadedResponse.Code != http.StatusOK || reloaded.Revision != saved.Revision || reloaded.Groups[0] != saved.Groups[0] || reloaded.Assignments["$7"] != "group-123" || !reloaded.UngroupedCollapsed {
		t.Fatalf("state did not survive handler restart: status=%d state=%#v", reloadedResponse.Code, reloaded)
	}
}

func TestGroupsPersistSessionOrderAndLegacyWritersPreserveIt(t *testing.T) {
	stateDir := t.TempDir()
	handler := persistentGroupHandler(t, stateDir)
	initialResponse := groupsRequest(handler, http.MethodGet, nil, "")
	var initial groupSnapshot
	if err := json.Unmarshal(initialResponse.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	firstOrder := []string{"$3", "$1", "$2"}
	firstUpdate := updateGroupsRequest{Groups: []sessionGroup{}, Assignments: map[string]string{}, SessionOrder: &firstOrder, Revision: initial.Revision}
	savedResponse := groupsRequest(handler, http.MethodPut, firstUpdate, "http://127.0.0.1")
	if savedResponse.Code != http.StatusOK {
		t.Fatalf("save session order returned %d: %s", savedResponse.Code, savedResponse.Body.String())
	}
	var saved groupSnapshot
	if err := json.Unmarshal(savedResponse.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if strings.Join(saved.SessionOrder, ",") != strings.Join(firstOrder, ",") {
		t.Fatalf("saved order = %v, want %v", saved.SessionOrder, firstOrder)
	}

	// Simulate an older frontend that knows nothing about sessionOrder.
	legacyUpdate := updateGroupsRequest{Groups: []sessionGroup{}, Assignments: map[string]string{}, Revision: saved.Revision}
	legacyResponse := groupsRequest(handler, http.MethodPut, legacyUpdate, "http://127.0.0.1")
	if legacyResponse.Code != http.StatusOK {
		t.Fatalf("legacy PUT returned %d: %s", legacyResponse.Code, legacyResponse.Body.String())
	}
	var legacySaved groupSnapshot
	if err := json.Unmarshal(legacyResponse.Body.Bytes(), &legacySaved); err != nil {
		t.Fatal(err)
	}
	if strings.Join(legacySaved.SessionOrder, ",") != strings.Join(firstOrder, ",") {
		t.Fatalf("legacy PUT erased session order: %v", legacySaved.SessionOrder)
	}

	restarted := persistentGroupHandler(t, stateDir)
	reloadedResponse := groupsRequest(restarted, http.MethodGet, nil, "")
	var reloaded groupSnapshot
	if err := json.Unmarshal(reloadedResponse.Body.Bytes(), &reloaded); err != nil {
		t.Fatal(err)
	}
	if reloaded.Revision != legacySaved.Revision || strings.Join(reloaded.SessionOrder, ",") != strings.Join(firstOrder, ",") {
		t.Fatalf("session order did not survive restart: %#v", reloaded)
	}
}

func TestGroupsRejectInvalidSessionOrder(t *testing.T) {
	handler := persistentGroupHandler(t, t.TempDir())
	initialResponse := groupsRequest(handler, http.MethodGet, nil, "")
	var initial groupSnapshot
	if err := json.Unmarshal(initialResponse.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		order []string
	}{
		{"duplicate-id", []string{"$1", "$1"}},
		{"control-character", []string{"bad\nname"}},
		{"too-many", func() []string {
			values := make([]string, maxGroupSessionOrder+1)
			for index := range values {
				values[index] = "$" + strconv.Itoa(index)
			}
			return values
		}()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			order := test.order
			input := updateGroupsRequest{Groups: []sessionGroup{}, Assignments: map[string]string{}, SessionOrder: &order, Revision: initial.Revision}
			response := groupsRequest(handler, http.MethodPut, input, "http://127.0.0.1")
			if response.Code != http.StatusBadRequest {
				t.Fatalf("invalid order returned %d, want 400: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestGroupsCASReturnsCurrentStateOnConflict(t *testing.T) {
	handler := persistentGroupHandler(t, t.TempDir())
	initialResponse := groupsRequest(handler, http.MethodGet, nil, "")
	var initial groupSnapshot
	if err := json.Unmarshal(initialResponse.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	first := updateGroupsRequest{Groups: []sessionGroup{{ID: "one", Name: "One"}}, Assignments: map[string]string{}, Revision: initial.Revision}
	second := updateGroupsRequest{Groups: []sessionGroup{{ID: "two", Name: "Two"}}, Assignments: map[string]string{"$2": "two"}, Revision: initial.Revision}
	type result struct {
		status int
		body   groupSnapshot
	}
	results := make(chan result, 2)
	var wait sync.WaitGroup
	for _, input := range []updateGroupsRequest{first, second} {
		wait.Add(1)
		go func(input updateGroupsRequest) {
			defer wait.Done()
			response := groupsRequest(handler, http.MethodPut, input, "http://127.0.0.1")
			var body groupSnapshot
			_ = json.Unmarshal(response.Body.Bytes(), &body)
			results <- result{status: response.Code, body: body}
		}(input)
	}
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for result := range results {
		switch result.status {
		case http.StatusOK:
			successes++
		case http.StatusConflict:
			conflicts++
			if result.body.Error == "" || len(result.body.Groups) != 1 || result.body.Revision == initial.Revision {
				t.Errorf("conflict did not return current state and revision: %#v", result.body)
			}
		default:
			t.Errorf("unexpected response status %d: %#v", result.status, result.body)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("CAS results: %d successes, %d conflicts", successes, conflicts)
	}
}

func TestGroupsRejectInvalidStateAndCrossOriginWrites(t *testing.T) {
	handler := persistentGroupHandler(t, t.TempDir())
	initialResponse := groupsRequest(handler, http.MethodGet, nil, "")
	var initial groupSnapshot
	if err := json.Unmarshal(initialResponse.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		input  updateGroupsRequest
		origin string
		want   int
	}{
		{"duplicate-id", updateGroupsRequest{Groups: []sessionGroup{{ID: "same", Name: "One"}, {ID: "same", Name: "Two"}}, Revision: initial.Revision}, "http://127.0.0.1", http.StatusBadRequest},
		{"duplicate-name", updateGroupsRequest{Groups: []sessionGroup{{ID: "one", Name: "Project"}, {ID: "two", Name: "project"}}, Revision: initial.Revision}, "http://127.0.0.1", http.StatusBadRequest},
		{"unknown-assignment", updateGroupsRequest{Groups: []sessionGroup{{ID: "one", Name: "One"}}, Assignments: map[string]string{"$4": "missing"}, Revision: initial.Revision}, "http://127.0.0.1", http.StatusBadRequest},
		{"invalid-id", updateGroupsRequest{Groups: []sessionGroup{{ID: "../etc", Name: "One"}}, Revision: initial.Revision}, "http://127.0.0.1", http.StatusBadRequest},
		{"missing-revision", updateGroupsRequest{Groups: []sessionGroup{}, Assignments: map[string]string{}}, "http://127.0.0.1", http.StatusBadRequest},
		{"cross-origin", updateGroupsRequest{Groups: []sessionGroup{{ID: "one", Name: "One"}}, Revision: initial.Revision}, "https://evil.example", http.StatusForbidden},
	}
	for _, test := range tests {
		response := groupsRequest(handler, http.MethodPut, test.input, test.origin)
		if response.Code != test.want {
			t.Errorf("%s status = %d, want %d (%s)", test.name, response.Code, test.want, response.Body.String())
		}
	}
	stateResponse := groupsRequest(handler, http.MethodGet, nil, "")
	var current groupSnapshot
	if err := json.Unmarshal(stateResponse.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if len(current.Groups) != 0 || current.Revision != initial.Revision {
		t.Fatalf("invalid requests changed state: %#v", current)
	}
}

func TestGroupsRejectInvalidPersistedStateAtInitialization(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, groupStoreFileName), []byte(`{"groups":[{"id":"../bad","name":"Bad"}],"assignments":{},"ungroupedCollapsed":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := NewWithOptions("unused", logger, "", stateDir); err == nil {
		t.Fatal("invalid persisted groups should fail server initialization")
	}
}

func TestGroupsRejectInvalidPersistedSessionOrderAtInitialization(t *testing.T) {
	stateDir := t.TempDir()
	state := `{"groups":[],"assignments":{},"ungroupedCollapsed":false,"sessionOrder":["$1","$1"]}`
	if err := os.WriteFile(filepath.Join(stateDir, groupStoreFileName), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := NewWithOptions("unused", logger, "", stateDir); err == nil {
		t.Fatal("duplicate persisted session order should fail initialization")
	}
}

func TestGroupStoreCompactPersistenceStaysWithinStartupLimit(t *testing.T) {
	stateDir := t.TempDir()
	store, err := newPersistentGroupStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}

	data := groupData{
		Groups:      []sessionGroup{{ID: "g", Name: "Group"}},
		Assignments: make(map[string]string, 30000),
	}
	for index := 0; index < 30000; index++ {
		data.Assignments[fmt.Sprintf("$%05d%s", index, strings.Repeat("x", 55))] = "g"
	}
	compact, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	pretty, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if len(compact)+1 > maxGroupsRequestBytes || len(pretty)+1 <= maxGroupsRequestBytes {
		t.Fatalf("fixture must fit compact persistence but exceed indented limit: compact=%d pretty=%d limit=%d", len(compact)+1, len(pretty)+1, maxGroupsRequestBytes)
	}

	initial := store.snapshot()
	saved, ok, err := store.compareAndSwap(initial.Revision, data)
	if err != nil || !ok {
		t.Fatalf("save large valid group state: ok=%v err=%v", ok, err)
	}

	restarted, err := newPersistentGroupStore(stateDir)
	if err != nil {
		t.Fatalf("restart from saved state: %v", err)
	}
	reloaded := restarted.snapshot()
	if reloaded.Revision != saved.Revision || len(reloaded.Assignments) != len(data.Assignments) {
		t.Fatalf("persisted state did not round-trip: revision=%q assignments=%d", reloaded.Revision, len(reloaded.Assignments))
	}
}

func persistentGroupHandler(t *testing.T, stateDir string) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, err := NewWithOptions("unused", logger, "", stateDir)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func groupsRequest(handler http.Handler, method string, input any, origin string) *httptest.ResponseRecorder {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			panic(err)
		}
		body = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, "http://127.0.0.1/api/groups", body)
	if origin != "" {
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
