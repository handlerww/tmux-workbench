package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	gitAssociationFileName = "git-associations.json"
	maxGitAssociationBytes = 2 << 20
	maxRecentRepositories  = 50
)

type gitAssociationState struct {
	Version      int               `json:"version"`
	Associations map[string]string `json:"associations"`
	Recent       []string          `json:"recent"`
}

type gitAssociation struct {
	Path     *string `json:"path"`
	Manual   bool    `json:"manual"`
	Revision string  `json:"revision"`
}

type gitAssociationStore struct {
	mu      sync.RWMutex
	state   gitAssociationState
	path    string
	persist bool
}

func newMemoryGitAssociationStore() *gitAssociationStore {
	return &gitAssociationStore{state: emptyGitAssociationState()}
}

func newPersistentGitAssociationStore(stateDir string) (*gitAssociationStore, error) {
	if stateDir == "" || !filepath.IsAbs(stateDir) {
		return nil, errors.New("state directory must be an absolute path")
	}
	statePath := filepath.Join(stateDir, gitAssociationFileName)
	store := &gitAssociationStore{state: emptyGitAssociationState(), path: statePath, persist: true}
	info, err := os.Lstat(statePath)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect Git association state: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("Git association state must be a regular file")
	}
	if info.Size() > maxGitAssociationBytes {
		return nil, errors.New("Git association state exceeds the 2 MiB limit")
	}
	content, err := os.ReadFile(statePath)
	if err != nil {
		return nil, fmt.Errorf("read Git association state: %w", err)
	}
	if len(content) > maxGitAssociationBytes {
		return nil, errors.New("Git association state exceeds the 2 MiB limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var state gitAssociationState
	if err := decoder.Decode(&state); err != nil {
		return nil, fmt.Errorf("decode Git association state: %w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return nil, fmt.Errorf("decode Git association state: %w", err)
	}
	if err := validateGitAssociationState(&state); err != nil {
		return nil, fmt.Errorf("validate Git association state: %w", err)
	}
	store.state = cloneGitAssociationState(state)
	return store, nil
}

func emptyGitAssociationState() gitAssociationState {
	return gitAssociationState{Version: 1, Associations: map[string]string{}, Recent: []string{}}
}

func cloneGitAssociationState(state gitAssociationState) gitAssociationState {
	copy := gitAssociationState{
		Version:      state.Version,
		Associations: make(map[string]string, len(state.Associations)),
		Recent:       append([]string(nil), state.Recent...),
	}
	if copy.Recent == nil {
		copy.Recent = []string{}
	}
	for sessionID, repository := range state.Associations {
		copy.Associations[sessionID] = repository
	}
	if copy.Associations == nil {
		copy.Associations = map[string]string{}
	}
	return copy
}

func validateGitAssociationState(state *gitAssociationState) error {
	if state.Version != 1 {
		return errors.New("unsupported Git association state version")
	}
	if len(state.Associations) > maxGroupAssignments {
		return fmt.Errorf("at most %d manual Git associations are allowed", maxGroupAssignments)
	}
	for sessionID, repository := range state.Associations {
		if !validStableSessionID(sessionID) {
			return fmt.Errorf("invalid tmux session id %q in Git associations", sessionID)
		}
		if err := validateLogicalRepositoryPath(repository); err != nil {
			return fmt.Errorf("invalid Git repository path for %q", sessionID)
		}
	}
	if len(state.Recent) > maxRecentRepositories {
		return fmt.Errorf("at most %d recent repositories are allowed", maxRecentRepositories)
	}
	seen := make(map[string]struct{}, len(state.Recent))
	for _, repository := range state.Recent {
		if err := validateLogicalRepositoryPath(repository); err != nil {
			return errors.New("invalid recent Git repository path")
		}
		if _, exists := seen[repository]; exists {
			return errors.New("duplicate recent Git repository path")
		}
		seen[repository] = struct{}{}
	}
	if state.Associations == nil {
		state.Associations = map[string]string{}
	}
	if state.Recent == nil {
		state.Recent = []string{}
	}
	return nil
}

func validStableSessionID(value string) bool {
	if len(value) < 2 || len(value) > maxGroupAssignmentID || value[0] != '$' {
		return false
	}
	for _, char := range value[1:] {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func validateLogicalRepositoryPath(value string) error {
	if !filepath.IsAbs(value) || filepath.Clean(value) != value || len(value) > 4096 || strings.ContainsRune(value, '\x00') {
		return errors.New("repository path must be a clean absolute path")
	}
	return nil
}

func (store *gitAssociationStore) get(sessionID string) gitAssociation {
	store.mu.RLock()
	defer store.mu.RUnlock()
	path, exists := store.state.Associations[sessionID]
	if !exists {
		return gitAssociation{Manual: false, Revision: gitAssociationRevision(nil)}
	}
	return gitAssociation{Path: stringPointer(path), Manual: true, Revision: gitAssociationRevision(&path)}
}

func (store *gitAssociationStore) recent() []string {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return append([]string(nil), store.state.Recent...)
}

func (store *gitAssociationStore) set(sessionID, revision string, repository *string) (gitAssociation, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	currentPath, exists := store.state.Associations[sessionID]
	var current *string
	if exists {
		current = stringPointer(currentPath)
	}
	if revision != gitAssociationRevision(current) {
		return gitAssociation{Path: current, Manual: exists, Revision: gitAssociationRevision(current)}, false, nil
	}
	next := cloneGitAssociationState(store.state)
	if repository == nil {
		delete(next.Associations, sessionID)
	} else {
		next.Associations[sessionID] = *repository
		next.Recent = prependUniqueRepository(next.Recent, *repository)
	}
	if store.persist {
		if err := store.persistState(next); err != nil {
			return gitAssociation{}, false, err
		}
	}
	store.state = next
	return store.getUnlocked(sessionID), true, nil
}

func (store *gitAssociationStore) getUnlocked(sessionID string) gitAssociation {
	path, exists := store.state.Associations[sessionID]
	if !exists {
		return gitAssociation{Revision: gitAssociationRevision(nil)}
	}
	return gitAssociation{Path: stringPointer(path), Manual: true, Revision: gitAssociationRevision(&path)}
}

func (store *gitAssociationStore) persistState(state gitAssociationState) error {
	encoded, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode Git association state: %w", err)
	}
	encoded = append(encoded, '\n')
	if len(encoded) > maxGitAssociationBytes {
		return errors.New("Git association state exceeds the 2 MiB limit")
	}
	temporary, err := os.CreateTemp(filepath.Dir(store.path), ".git-associations-*.tmp")
	if err != nil {
		return fmt.Errorf("create Git association state temporary file: %w", err)
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
		return fmt.Errorf("set Git association state permissions: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		return fmt.Errorf("write Git association state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync Git association state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Git association state: %w", err)
	}
	directory, err := os.Open(filepath.Dir(store.path))
	if err != nil {
		return fmt.Errorf("open Git association state directory: %w", err)
	}
	defer directory.Close()
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("replace Git association state: %w", err)
	}
	keep = false
	_ = directory.Sync()
	return nil
}

func prependUniqueRepository(recent []string, repository string) []string {
	next := make([]string, 0, min(len(recent)+1, maxRecentRepositories))
	next = append(next, repository)
	for _, existing := range recent {
		if existing == repository {
			continue
		}
		if len(next) == maxRecentRepositories {
			break
		}
		next = append(next, existing)
	}
	return next
}

func gitAssociationRevision(repository *string) string {
	encoded, _ := json.Marshal(repository)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func stringPointer(value string) *string { return &value }
