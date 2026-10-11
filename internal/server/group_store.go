package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

const (
	maxSessionGroups      = 500
	maxGroupAssignments   = 50000
	maxGroupIDLength      = 128
	maxGroupNameLength    = 100
	maxGroupAssignmentID  = 256
	maxGroupSessionOrder  = 50000
	maxGroupsRequestBytes = 2 << 20
	groupStoreFileName    = "groups.json"
)

type sessionGroup struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Collapsed bool   `json:"collapsed"`
}

type groupData struct {
	Groups             []sessionGroup    `json:"groups"`
	Assignments        map[string]string `json:"assignments"`
	UngroupedCollapsed bool              `json:"ungroupedCollapsed"`
	SessionOrder       []string          `json:"sessionOrder,omitempty"`
}

type groupSnapshot struct {
	groupData
	Revision string `json:"revision"`
	Error    string `json:"error,omitempty"`
}

type groupStore struct {
	mu      sync.RWMutex
	data    groupData
	path    string
	persist bool
}

func newMemoryGroupStore() *groupStore {
	return &groupStore{data: emptyGroupData()}
}

func newPersistentGroupStore(stateDir string) (*groupStore, error) {
	if stateDir == "" || !filepath.IsAbs(stateDir) {
		return nil, errors.New("state directory must be an absolute path")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("create state directory: %w", err)
	}
	info, err := os.Stat(stateDir)
	if err != nil {
		return nil, fmt.Errorf("inspect state directory: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("state directory is not a directory")
	}
	statePath := filepath.Join(stateDir, groupStoreFileName)
	store := &groupStore{data: emptyGroupData(), path: statePath, persist: true}
	stateInfo, err := os.Lstat(statePath)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect group state: %w", err)
	}
	if !stateInfo.Mode().IsRegular() {
		return nil, errors.New("group state must be a regular file")
	}
	if stateInfo.Size() > maxGroupsRequestBytes {
		return nil, errors.New("group state exceeds the 2 MiB limit")
	}
	stateBytes, err := os.ReadFile(statePath)
	if err != nil {
		return nil, fmt.Errorf("read group state: %w", err)
	}
	if len(stateBytes) > maxGroupsRequestBytes {
		return nil, errors.New("group state exceeds the 2 MiB limit")
	}
	if !utf8.Valid(stateBytes) {
		return nil, errors.New("group state is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(stateBytes))
	decoder.DisallowUnknownFields()
	var data groupData
	if err := decoder.Decode(&data); err != nil {
		return nil, fmt.Errorf("decode group state: %w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return nil, fmt.Errorf("decode group state: %w", err)
	}
	if err := validateGroupData(&data); err != nil {
		return nil, fmt.Errorf("validate group state: %w", err)
	}
	store.data = cloneGroupData(data)
	return store, nil
}

func emptyGroupData() groupData {
	return groupData{Groups: []sessionGroup{}, Assignments: map[string]string{}}
}

func cloneGroupData(data groupData) groupData {
	copy := groupData{
		Groups:             append([]sessionGroup(nil), data.Groups...),
		Assignments:        make(map[string]string, len(data.Assignments)),
		UngroupedCollapsed: data.UngroupedCollapsed,
		SessionOrder:       append([]string(nil), data.SessionOrder...),
	}
	if copy.Groups == nil {
		copy.Groups = []sessionGroup{}
	}
	for sessionID, groupID := range data.Assignments {
		copy.Assignments[sessionID] = groupID
	}
	return copy
}

func (data groupData) revision() string {
	encoded, _ := json.Marshal(data)
	return fileRevision(encoded)
}

func (store *groupStore) snapshot() groupSnapshot {
	store.mu.RLock()
	defer store.mu.RUnlock()
	data := cloneGroupData(store.data)
	return groupSnapshot{groupData: data, Revision: data.revision()}
}

func (store *groupStore) compareAndSwap(revision string, next groupData) (groupSnapshot, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	current := cloneGroupData(store.data)
	currentRevision := current.revision()
	if revision != currentRevision {
		return groupSnapshot{groupData: current, Revision: currentRevision}, false, nil
	}
	if store.persist {
		if err := store.persistData(next); err != nil {
			return groupSnapshot{}, false, err
		}
	}
	store.data = cloneGroupData(next)
	next = cloneGroupData(next)
	return groupSnapshot{groupData: next, Revision: next.revision()}, true, nil
}

func (store *groupStore) persistData(data groupData) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("encode group state: %w", err)
	}
	encoded = append(encoded, '\n')
	if len(encoded) > maxGroupsRequestBytes {
		return fmt.Errorf("encoded group state exceeds the %d byte limit", maxGroupsRequestBytes)
	}
	temporary, err := os.CreateTemp(filepath.Dir(store.path), ".groups-*.tmp")
	if err != nil {
		return fmt.Errorf("create group state temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	keep := true
	defer func() {
		_ = temporary.Close()
		if keep {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("set group state permissions: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		return fmt.Errorf("write group state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync group state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close group state: %w", err)
	}
	directory, err := os.Open(filepath.Dir(store.path))
	if err != nil {
		return fmt.Errorf("open state directory: %w", err)
	}
	defer directory.Close()
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("replace group state: %w", err)
	}
	keep = false
	_ = directory.Sync()
	return nil
}

func validateGroupData(data *groupData) error {
	if len(data.Groups) > maxSessionGroups {
		return fmt.Errorf("at most %d groups are allowed", maxSessionGroups)
	}
	if len(data.Assignments) > maxGroupAssignments {
		return fmt.Errorf("at most %d group assignments are allowed", maxGroupAssignments)
	}
	if len(data.SessionOrder) > maxGroupSessionOrder {
		return fmt.Errorf("at most %d ordered sessions are allowed", maxGroupSessionOrder)
	}
	ordered := make(map[string]struct{}, len(data.SessionOrder))
	for _, sessionID := range data.SessionOrder {
		if sessionID == "" || !utf8.ValidString(sessionID) || len(sessionID) > maxGroupAssignmentID || containsControl(sessionID) {
			return fmt.Errorf("session order contains an invalid tmux session id")
		}
		if _, exists := ordered[sessionID]; exists {
			return fmt.Errorf("session order contains duplicate session id %q", sessionID)
		}
		ordered[sessionID] = struct{}{}
	}
	known := make(map[string]struct{}, len(data.Groups))
	names := make([]string, 0, len(data.Groups))
	for index := range data.Groups {
		group := &data.Groups[index]
		if !validGroupID(group.ID) {
			return fmt.Errorf("group %d has an invalid id", index)
		}
		if _, exists := known[group.ID]; exists {
			return fmt.Errorf("duplicate group id %q", group.ID)
		}
		known[group.ID] = struct{}{}
		name := strings.TrimSpace(group.Name)
		if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxGroupNameLength || containsControl(name) {
			return fmt.Errorf("group %q has an invalid name", group.ID)
		}
		for _, existing := range names {
			if strings.EqualFold(existing, name) {
				return fmt.Errorf("group names must be unique")
			}
		}
		group.Name = name
		names = append(names, name)
	}
	for sessionID, groupID := range data.Assignments {
		if sessionID == "" || !utf8.ValidString(sessionID) || len(sessionID) > maxGroupAssignmentID || containsControl(sessionID) {
			return fmt.Errorf("assignment has an invalid tmux session id")
		}
		if _, exists := known[groupID]; !exists {
			return fmt.Errorf("assignment for %q refers to an unknown group", sessionID)
		}
	}
	if data.Groups == nil {
		data.Groups = []sessionGroup{}
	}
	if data.Assignments == nil {
		data.Assignments = map[string]string{}
	}
	if len(data.SessionOrder) == 0 {
		data.SessionOrder = nil
	}
	return nil
}

func validGroupID(value string) bool {
	if value == "" || len(value) > maxGroupIDLength || !utf8.ValidString(value) {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

func containsControl(value string) bool {
	for _, char := range value {
		if unicode.IsControl(char) {
			return true
		}
	}
	return false
}
