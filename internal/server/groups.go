package server

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type updateGroupsRequest struct {
	Groups             []sessionGroup    `json:"groups"`
	Assignments        map[string]string `json:"assignments"`
	UngroupedCollapsed bool              `json:"ungroupedCollapsed"`
	SessionOrder       *[]string         `json:"sessionOrder,omitempty"`
	Revision           string            `json:"revision"`
}

func (s *Server) groups(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet {
		writeJSON(writer, http.StatusOK, s.groupStore.snapshot())
		return
	}
	if request.Method != http.MethodPut {
		writeError(writer, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "Request origin is not allowed")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxGroupsRequestBytes)
	body, err := io.ReadAll(request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(writer, http.StatusRequestEntityTooLarge, "Groups request is too large")
			return
		}
		writeError(writer, http.StatusBadRequest, "Invalid groups request")
		return
	}
	if !utf8.Valid(body) {
		writeError(writer, http.StatusBadRequest, "Groups request must be valid UTF-8 JSON")
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var input updateGroupsRequest
	if err := decoder.Decode(&input); err != nil || ensureJSONEnd(decoder) != nil {
		writeError(writer, http.StatusBadRequest, "Invalid groups request")
		return
	}
	revisionBytes, err := hex.DecodeString(input.Revision)
	if err != nil || len(revisionBytes) != 32 || input.Revision != strings.ToLower(input.Revision) {
		writeError(writer, http.StatusBadRequest, "A lowercase SHA-256 revision is required")
		return
	}
	next := groupData{
		Groups:             input.Groups,
		Assignments:        input.Assignments,
		UngroupedCollapsed: input.UngroupedCollapsed,
	}
	if input.SessionOrder != nil {
		next.SessionOrder = *input.SessionOrder
	} else {
		// Older clients omit sessionOrder. Preserve any order already stored so
		// a legacy writer cannot silently erase a newer client's preference.
		next.SessionOrder = s.groupStore.snapshot().SessionOrder
	}
	if err := validateGroupData(&next); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	snapshot, saved, err := s.groupStore.compareAndSwap(input.Revision, next)
	if err != nil {
		s.logger.Error("failed to persist workspace groups", "error", err)
		writeError(writer, http.StatusInternalServerError, "Unable to persist workspace groups")
		return
	}
	if !saved {
		snapshot.Error = "Groups changed elsewhere; reload and retry"
		writeJSON(writer, http.StatusConflict, snapshot)
		return
	}
	writeJSON(writer, http.StatusOK, snapshot)
}
