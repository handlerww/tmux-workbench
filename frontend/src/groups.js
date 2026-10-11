export const SESSION_GROUPS_STORAGE_KEY = 'workbench.sessionGroups.v1';

export function createSessionGroups(groups = [], assignments = {}, ungroupedCollapsed = false, sessionOrder = []) {
  const normalizedGroups = groups
    .filter((group) => group && typeof group.id === 'string' && typeof group.name === 'string')
    .map((group) => ({ id: group.id, name: group.name.trim() || 'Untitled group', collapsed: Boolean(group.collapsed) }));
  const known = new Set(normalizedGroups.map((group) => group.id));
  const normalizedAssignments = {};
  for (const [sessionId, groupId] of Object.entries(assignments ?? {})) {
    if (typeof sessionId === 'string' && known.has(groupId)) normalizedAssignments[sessionId] = groupId;
  }
  const normalizedOrder = [];
  const ordered = new Set();
  for (const sessionId of Array.isArray(sessionOrder) ? sessionOrder : []) {
    if (typeof sessionId !== 'string' || !sessionId || ordered.has(sessionId)) continue;
    ordered.add(sessionId);
    normalizedOrder.push(sessionId);
  }
  const state = { groups: normalizedGroups, assignments: normalizedAssignments, ungroupedCollapsed: Boolean(ungroupedCollapsed) };
  if (normalizedOrder.length) state.sessionOrder = normalizedOrder;
  return state;
}

export function restoreSessionGroups(value, sessionIds = null) {
  const state = createSessionGroups(value?.groups, value?.assignments, value?.ungroupedCollapsed, value?.sessionOrder);
  if (!sessionIds) return state;
  const live = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
  state.assignments = Object.fromEntries(Object.entries(state.assignments).filter(([id]) => live.has(id)));
  if (state.sessionOrder) {
    state.sessionOrder = state.sessionOrder.filter((id) => live.has(id));
    if (!state.sessionOrder.length) delete state.sessionOrder;
  }
  return state;
}

export function sessionGroupsForStorage(state) {
  return {
    ...createSessionGroups(state?.groups, state?.assignments, false, state?.sessionOrder),
    ungroupedCollapsed: Boolean(state?.ungroupedCollapsed),
  };
}

export function createSessionGroup(state, name, makeId) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) return null;
  const group = { id: makeId(), name: cleanName, collapsed: false };
  state.groups.unshift(group);
  return group;
}

export function renameSessionGroup(state, groupId, name) {
  const cleanName = String(name ?? '').trim();
  const group = state.groups.find((item) => item.id === groupId);
  if (!group || !cleanName) return false;
  group.name = cleanName;
  return true;
}

export function deleteSessionGroup(state, groupId) {
  const index = state.groups.findIndex((item) => item.id === groupId);
  if (index < 0) return false;
  state.groups.splice(index, 1);
  for (const [sessionId, assignedGroup] of Object.entries(state.assignments)) {
    if (assignedGroup === groupId) delete state.assignments[sessionId];
  }
  return true;
}

export function moveSessionGroup(state, groupId, targetId = null, after = false) {
  const sourceIndex = state.groups.findIndex((group) => group.id === groupId);
  if (sourceIndex < 0) return false;
  const [group] = state.groups.splice(sourceIndex, 1);
  const targetIndex = targetId == null ? state.groups.length : state.groups.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) {
    state.groups.splice(sourceIndex, 0, group);
    return false;
  }
  const insertAt = targetIndex + (after && targetId != null ? 1 : 0);
  state.groups.splice(Math.max(0, Math.min(insertAt, state.groups.length)), 0, group);
  return true;
}

export function applySessionGroupOperation(state, operation) {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.type === 'create' || operation.type === 'create_from_search') {
    const group = operation.group;
    if (!group || typeof group.id !== 'string' || typeof group.name !== 'string') return false;
    if (!state.groups.some((item) => item.id === group.id)) {
      state.groups.unshift({ id: group.id, name: group.name.trim() || 'Untitled group', collapsed: Boolean(group.collapsed) });
    }
    if (operation.type === 'create_from_search') {
      for (const sessionId of operation.sessionIds ?? []) {
        const assignedGroup = state.assignments[sessionId];
        if (!assignedGroup || assignedGroup === group.id) state.assignments[sessionId] = group.id;
      }
    }
    return true;
  }
  if (operation.type === 'rename') {
    const group = state.groups.find((item) => item.id === operation.groupId);
    if (!group) return false;
    group.name = String(operation.name).trim() || group.name;
    return true;
  }
  if (operation.type === 'delete') {
    if (!state.groups.some((group) => group.id === operation.groupId)) return true;
    deleteSessionGroup(state, operation.groupId);
    return true;
  }
  if (operation.type === 'assign') return assignSessionGroup(state, operation.sessionId, operation.groupId ?? null);
  if (operation.type === 'assign_many') {
    const groupId = operation.groupId ?? null;
    if (groupId !== null && !state.groups.some((group) => group.id === groupId)) return false;
    for (const sessionId of operation.sessionIds ?? []) {
      if (typeof sessionId !== 'string') continue;
      if (groupId === null) delete state.assignments[sessionId];
      else state.assignments[sessionId] = groupId;
    }
    return true;
  }
  if (operation.type === 'reorder_session') return reorderSession(state, operation);
  if (operation.type === 'move_to_top') {
    const index = state.groups.findIndex((group) => group.id === operation.groupId);
    if (index < 0) return false;
    const [group] = state.groups.splice(index, 1);
    state.groups.unshift(group);
    return true;
  }
  if (operation.type === 'reorder') return moveSessionGroup(state, operation.groupId, operation.targetId ?? null, Boolean(operation.after));
  if (operation.type === 'set_collapsed') {
    if (operation.groupId == null) state.ungroupedCollapsed = Boolean(operation.collapsed);
    else {
      const group = state.groups.find((item) => item.id === operation.groupId);
      if (!group) return false;
      group.collapsed = Boolean(operation.collapsed);
    }
    return true;
  }
  return false;
}

export function applySessionGroupOperations(state, operations) {
  for (const operation of operations) applySessionGroupOperation(state, operation);
  return state;
}

export function assignSessionGroup(state, sessionId, groupId = null) {
  if (groupId && !state.groups.some((group) => group.id === groupId)) return false;
  if (groupId) state.assignments[sessionId] = groupId;
  else delete state.assignments[sessionId];
  return true;
}

export function matchingSessionIds(sessions, query) {
  const needle = String(query ?? '').trim().toLocaleLowerCase();
  if (!needle) return [];
  return sessions.filter((session) => session.name.toLocaleLowerCase().includes(needle)
    || (session.path ?? '').toLocaleLowerCase().includes(needle)).map((session) => session.id);
}

export function matchingUngroupedSessionIds(state, sessions, query) {
  const knownGroupIds = new Set(state.groups.map((group) => group.id));
  const ungrouped = sessions.filter((session) => !knownGroupIds.has(state.assignments[session.id]));
  return matchingSessionIds(ungrouped, query);
}

export function createSessionGroupFromSearch(state, sessions, query, name, makeId) {
  const sessionIds = matchingUngroupedSessionIds(state, sessions, query);
  if (sessionIds.length === 0) return null;
  const group = createSessionGroup(state, name, makeId);
  if (!group) return null;
  for (const sessionId of sessionIds) state.assignments[sessionId] = group.id;
  return { group, sessionIds };
}

export function groupedSessions(sessions, state) {
  const groups = state.groups.map((group) => ({ ...group, sessions: [] }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const ungrouped = [];
  for (const session of sessions) {
    const group = byId.get(state.assignments[session.id]);
    if (group) group.sessions.push(session);
    else ungrouped.push(session);
  }
  const order = new Map((state.sessionOrder ?? []).map((id, index) => [id, index]));
  const sortByOrder = (items) => items
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const leftOrder = order.get(left.session.id);
      const rightOrder = order.get(right.session.id);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      }
      return left.index - right.index;
    })
    .map(({ session }) => session);
  for (const group of groups) group.sessions = sortByOrder(group.sessions);
  const sortedUngrouped = sortByOrder(ungrouped);
  return { ungrouped: sortedUngrouped, groups };
}

function reorderSession(state, operation) {
  const sessionId = operation.sessionId;
  const groupId = operation.groupId ?? null;
  const targetId = operation.targetId ?? null;
  if (typeof sessionId !== 'string' || !sessionId) return false;
  if (groupId !== null && !state.groups.some((group) => group.id === groupId)) return false;
  if (targetId !== null && (typeof targetId !== 'string' || !targetId)) return false;

  const sessionOrder = Array.isArray(state.sessionOrder) ? [...state.sessionOrder] : [];
  const ordered = new Set(sessionOrder);
  for (const liveId of Array.isArray(operation.fallbackOrder) ? operation.fallbackOrder : []) {
    if (typeof liveId !== 'string' || !liveId || ordered.has(liveId)) continue;
    ordered.add(liveId);
    sessionOrder.push(liveId);
  }
  if (!ordered.has(sessionId)) sessionOrder.push(sessionId);

  if (groupId === null) delete state.assignments[sessionId];
  else state.assignments[sessionId] = groupId;

  const currentIndex = sessionOrder.indexOf(sessionId);
  if (currentIndex >= 0) sessionOrder.splice(currentIndex, 1);
  let insertAt = -1;
  const targetIndex = targetId === null ? -1 : sessionOrder.indexOf(targetId);
  if (targetIndex >= 0 && sessionGroupId(state, targetId) === groupId) {
    insertAt = targetIndex + (operation.after ? 1 : 0);
  } else {
    // An absent or cross-group anchor is stale; add the dragged session at
    // the end of its destination bucket without disturbing other buckets.
    for (let index = sessionOrder.length - 1; index >= 0; index -= 1) {
      if (sessionGroupId(state, sessionOrder[index]) === groupId) {
        insertAt = index + 1;
        break;
      }
    }
  }
  if (insertAt < 0) insertAt = sessionOrder.length;
  sessionOrder.splice(Math.max(0, Math.min(insertAt, sessionOrder.length)), 0, sessionId);
  state.sessionOrder = sessionOrder;
  return true;
}

function sessionGroupId(state, sessionId) {
  const groupId = state.assignments[sessionId];
  return state.groups.some((group) => group.id === groupId) ? groupId : null;
}
