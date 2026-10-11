export function changeVariants(change) {
  const variants = [];
  if (change?.untracked) variants.push('untracked');
  if (change?.staged) variants.push('staged');
  if (change?.unstaged) variants.push('unstaged');
  return variants.length ? variants : ['unstaged'];
}

export function checkSummary(value) {
  let rollup = value;
  if (typeof rollup === 'string') {
    try { rollup = JSON.parse(rollup); } catch { return ''; }
  }
  const items = Array.isArray(rollup) ? rollup
    : Array.isArray(rollup?.contexts?.nodes) ? rollup.contexts.nodes
      : Array.isArray(rollup?.nodes) ? rollup.nodes : [];
  if (!items.length) return '';
  let failed = 0;
  let pending = 0;
  let passed = 0;
  for (const item of items) {
    const state = String(item.conclusion || item.state || item.status || '').toUpperCase();
    if (['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state)) failed += 1;
    else if (['SUCCESS', 'SUCCEEDED', 'NEUTRAL', 'SKIPPED'].includes(state)) passed += 1;
    else pending += 1;
  }
  return [passed ? `${passed} passed` : '', failed ? `${failed} failed` : '', pending ? `${pending} pending` : ''].filter(Boolean).join(', ');
}

export function groupedChanges(changes, query = '') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [
    { kind: 'staged', label: 'Staged' },
    { kind: 'unstaged', label: 'Changes' },
    { kind: 'untracked', label: 'Untracked' },
  ].map(group => ({ ...group, changes: changes.filter(change => {
    const text = `${change.path} ${change.oldPath || ''}`.toLowerCase();
    return changeVariants(change).includes(group.kind) && words.every(word => text.includes(word));
  }) })).filter(group => group.changes.length);
}

export function buildChangesTree(changes) {
  const root = { type: 'folder', path: '', name: '', children: [], aliases: [] };
  const directories = new Map([['', root]]);
  for (const change of changes) {
    const parts = change.path.split('/');
    const name = parts.pop();
    let parent = root;
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!directories.has(path)) {
        const folder = { type: 'folder', path, name: part, children: [], aliases: [path] };
        directories.set(path, folder);
        parent.children.push(folder);
      }
      parent = directories.get(path);
    }
    parent.children.push({ type: 'file', path: change.path, name, change });
  }
  function prepare(folder) {
    folder.children.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    folder.children = folder.children.map(child => {
      if (child.type !== 'folder') return child;
      prepare(child);
      while (child.children.length === 1 && child.children[0].type === 'folder') {
        const only = child.children[0];
        child = { ...child, name: `${child.name}/${only.name}`, path: only.path, aliases: [...child.aliases, ...only.aliases], children: only.children };
      }
      return child;
    });
  }
  prepare(root);
  return root;
}

export function flattenChangesTree(root, collapsed = new Set()) {
  const rows = [];
  function walk(folder, depth) {
    for (const child of folder.children) {
      const row = { ...child, depth };
      if (child.type === 'folder') row.collapsed = child.aliases.some(path => collapsed.has(path));
      rows.push(row);
      if (child.type === 'folder' && !row.collapsed) walk(child, depth + 1);
    }
  }
  walk(root, 0);
  return rows;
}
