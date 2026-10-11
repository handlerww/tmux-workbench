import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySessionGroupOperation,
  applySessionGroupOperations,
  assignSessionGroup,
  createSessionGroup,
  createSessionGroupFromSearch,
  deleteSessionGroup,
  groupedSessions,
  matchingSessionIds,
  matchingUngroupedSessionIds,
  moveSessionGroup,
  restoreSessionGroups,
  sessionGroupsForStorage,
} from './groups.js';

const sessions = [
  { id: 'one', name: 'api', path: '/work/service' },
  { id: 'two', name: 'web', path: '/work/site' },
  { id: 'three', name: 'notes', path: '/home/user' },
];

test('session groups persist stable ids and prune removed sessions', () => {
  const state = restoreSessionGroups({ groups: [{ id: 'stable', name: 'Projects' }], assignments: { one: 'stable', gone: 'stable' } }, ['one', 'two']);
  assert.deepEqual(sessionGroupsForStorage(state), { groups: [{ id: 'stable', name: 'Projects', collapsed: false }], assignments: { one: 'stable' }, ungroupedCollapsed: false });
});

test('session order is optional for legacy state and filters ids for removed sessions', () => {
  const legacy = restoreSessionGroups({ groups: [], assignments: {} });
  assert.equal(Object.hasOwn(legacy, 'sessionOrder'), false);
  assert.deepEqual(sessionGroupsForStorage(legacy), { groups: [], assignments: {}, ungroupedCollapsed: false });
  const restored = restoreSessionGroups({ sessionOrder: ['three', 'gone', 'one', 'three'] }, ['one', 'three']);
  assert.deepEqual(restored.sessionOrder, ['three', 'one']);
  assert.deepEqual(sessionGroupsForStorage(restored).sessionOrder, ['three', 'one']);
});

test('group CRUD moves sessions to ungrouped when deleted', () => {
  const state = restoreSessionGroups({ groups: [{ id: 'existing', name: 'Existing' }] });
  const group = createSessionGroup(state, 'Current', () => 'g1');
  assert.deepEqual(state.groups.map(({ id }) => id), ['g1', 'existing']);
  assert.equal(assignSessionGroup(state, 'one', group.id), true);
  assert.deepEqual(groupedSessions(sessions, state).groups[0].sessions.map(({ id }) => id), ['one']);
  deleteSessionGroup(state, group.id);
  assert.deepEqual(groupedSessions(sessions, state).ungrouped.map(({ id }) => id), ['one', 'two', 'three']);
});

test('search-created groups snapshot matches by session name and path', () => {
  const state = restoreSessionGroups();
  const created = createSessionGroupFromSearch(state, sessions, 'work/', 'Work', () => 'work');
  assert.deepEqual(created.sessionIds, ['one', 'two']);
  assert.deepEqual(groupedSessions(sessions, state).groups[0].sessions.map(({ id }) => id), ['one', 'two']);
});

test('search creation only assigns matching Untagged sessions and leaves all matches searchable', () => {
  const state = restoreSessionGroups({ groups: [{ id: 'existing', name: 'Existing' }], assignments: { one: 'existing' } });
  assert.deepEqual(matchingSessionIds(sessions, 'work/'), ['one', 'two']);
  assert.deepEqual(matchingUngroupedSessionIds(state, sessions, 'work/'), ['two']);
  const created = createSessionGroupFromSearch(state, sessions, 'work/', 'New', () => 'new');
  assert.deepEqual(state.groups.map(({ id }) => id), ['new', 'existing']);
  assert.deepEqual(created.sessionIds, ['two']);
  assert.equal(state.assignments.one, 'existing');
  assert.equal(state.assignments.two, 'new');
});

test('search creation does not create an empty group when all matches are already grouped', () => {
  const state = restoreSessionGroups({
    groups: [{ id: 'existing', name: 'Existing' }],
    assignments: { one: 'existing', two: 'existing' },
  });
  const result = createSessionGroupFromSearch(state, sessions, 'work/', 'Empty', () => 'empty');
  assert.equal(result, null);
  assert.deepEqual(state.groups.map(({ id }) => id), ['existing']);
});

test('named groups can be reordered while untagged remains the final section', () => {
  const state = restoreSessionGroups({ groups: [
    { id: 'one', name: 'One' }, { id: 'two', name: 'Two' }, { id: 'three', name: 'Three' },
  ] });
  assert.equal(moveSessionGroup(state, 'three', 'one', false), true);
  assert.deepEqual(state.groups.map(({ id }) => id), ['three', 'one', 'two']);
  assert.equal(moveSessionGroup(state, 'three', 'two', true), true);
  assert.deepEqual(state.groups.map(({ id }) => id), ['one', 'two', 'three']);
  assert.equal(moveSessionGroup(state, 'one', null), true);
  assert.deepEqual(state.groups.map(({ id }) => id), ['two', 'three', 'one']);
});

test('Untagged collapse state persists and older group state restores expanded', () => {
  const oldState = restoreSessionGroups({ groups: [], assignments: {} });
  assert.equal(oldState.ungroupedCollapsed, false);
  oldState.ungroupedCollapsed = true;
  const stored = sessionGroupsForStorage(oldState);
  assert.equal(stored.ungroupedCollapsed, true);
  assert.equal(restoreSessionGroups(stored).ungroupedCollapsed, true);
});

test('semantic group mutations can be replayed against a newer server snapshot', () => {
  const operation = { type: 'create_from_search', group: { id: 'work', name: 'Work' }, sessionIds: ['one', 'two'] };
  const latest = restoreSessionGroups({ groups: [{ id: 'existing', name: 'Existing' }], assignments: { three: 'existing' } });
  applySessionGroupOperation(latest, operation);
  assert.equal(applySessionGroupOperation(latest, operation), true);
  assert.deepEqual(latest.groups.map(({ id }) => id), ['work', 'existing']);
  assert.deepEqual(latest.assignments, { three: 'existing', one: 'work', two: 'work' });

  const replayed = applySessionGroupOperations(restoreSessionGroups({ groups: [{ id: 'existing', name: 'Existing' }], assignments: { three: 'existing' } }), [
    operation,
    { type: 'set_collapsed', groupId: null, collapsed: true },
    { type: 'set_collapsed', groupId: 'work', collapsed: true },
  ]);
  assert.equal(replayed.ungroupedCollapsed, true);
  assert.equal(replayed.groups[0].collapsed, true);
});

test('create-from-search replay preserves concurrent assignment to another group', () => {
  const state = restoreSessionGroups({
    groups: [{ id: 'mine', name: 'Mine' }, { id: 'other', name: 'Other' }],
    assignments: { one: 'other', two: 'mine' },
  });
  const operation = { type: 'create_from_search', group: { id: 'mine', name: 'Mine' }, sessionIds: ['one', 'two', 'three'] };

  assert.equal(applySessionGroupOperation(state, operation), true);
  assert.equal(state.assignments.one, 'other');
  assert.equal(state.assignments.two, 'mine');
  assert.equal(state.assignments.three, 'mine');
});

test('assign_many validates the target atomically and supports explicit Untagged moves', () => {
  const state = restoreSessionGroups({ groups: [{ id: 'g1', name: 'One' }], assignments: { one: 'g1', two: 'g1' } });
  assert.equal(applySessionGroupOperation(state, { type: 'assign_many', sessionIds: ['one', 'two'], groupId: 'missing' }), false);
  assert.deepEqual(state.assignments, { one: 'g1', two: 'g1' });
  assert.equal(applySessionGroupOperation(state, { type: 'assign_many', sessionIds: ['one', 'two'], groupId: null }), true);
  assert.deepEqual(state.assignments, {});
  assert.equal(applySessionGroupOperation(state, { type: 'assign_many', sessionIds: ['one', 'two'], groupId: 'g1' }), true);
  assert.deepEqual(state.assignments, { one: 'g1', two: 'g1' });
});

test('session order sorts only within Untagged and named group buckets', () => {
  const state = restoreSessionGroups({
    groups: [{ id: 'g1', name: 'One' }, { id: 'g2', name: 'Two' }],
    assignments: { one: 'g1', two: 'g2', three: 'g1' },
    sessionOrder: ['three', 'two', 'one'],
  });
  const buckets = groupedSessions(sessions, state);
  assert.deepEqual(buckets.groups[0].sessions.map(({ id }) => id), ['three', 'one']);
  assert.deepEqual(buckets.groups[1].sessions.map(({ id }) => id), ['two']);
  assert.deepEqual(buckets.ungrouped, []);
});

test('reorder_session moves sessions within Untagged and named groups and across groups', () => {
  const state = restoreSessionGroups({
    groups: [{ id: 'g1', name: 'One' }, { id: 'g2', name: 'Two' }],
    assignments: { one: 'g1', two: 'g2', three: 'g1' },
    sessionOrder: ['one', 'two', 'three'],
  });
  assert.equal(applySessionGroupOperation(state, {
    type: 'reorder_session', sessionId: 'three', groupId: 'g1', targetId: 'one', after: false,
    fallbackOrder: ['one', 'two', 'three'],
  }), true);
  assert.deepEqual(groupedSessions(sessions, state).groups[0].sessions.map(({ id }) => id), ['three', 'one']);

  assert.equal(applySessionGroupOperation(state, {
    type: 'reorder_session', sessionId: 'one', groupId: 'g2', targetId: 'two', after: true,
    fallbackOrder: ['one', 'two', 'three'],
  }), true);
  const buckets = groupedSessions(sessions, state);
  assert.deepEqual(buckets.groups[0].sessions.map(({ id }) => id), ['three']);
  assert.deepEqual(buckets.groups[1].sessions.map(({ id }) => id), ['two', 'one']);

  const ungrouped = restoreSessionGroups({ groups: [], assignments: {}, sessionOrder: ['one', 'two', 'three'] });
  applySessionGroupOperation(ungrouped, {
    type: 'reorder_session', sessionId: 'three', groupId: null, targetId: 'one', after: false,
    fallbackOrder: ['one', 'two', 'three'],
  });
  assert.deepEqual(groupedSessions(sessions, ungrouped).ungrouped.map(({ id }) => id), ['three', 'one', 'two']);
});

test('reorder_session handles missing or moved anchors and CAS replay without replacing ranking', () => {
  const state = restoreSessionGroups({
    groups: [{ id: 'g1', name: 'One' }, { id: 'g2', name: 'Two' }],
    assignments: { one: 'g1', two: 'g2', three: 'g1' },
    sessionOrder: ['three', 'two', 'one'],
  });
  const operation = {
    type: 'reorder_session', sessionId: 'one', groupId: 'g2', targetId: 'three', after: false,
    fallbackOrder: ['one', 'two', 'three', 'four'],
  };
  assert.equal(applySessionGroupOperation(state, operation), true);
  assert.deepEqual(state.sessionOrder, ['three', 'two', 'one', 'four']);
  assert.equal(state.assignments.one, 'g2');
  assert.equal(applySessionGroupOperation(state, operation), true);
  assert.deepEqual(state.sessionOrder, ['three', 'two', 'one', 'four']);
});
