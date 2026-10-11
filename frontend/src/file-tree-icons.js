const ICONS = {
  folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h5l1.7 1.8h8.3v7.2a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z"/><path d="M2.5 7.3h15"/></svg>',
  file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.8h6l4 4v10.4H5z"/><path d="M11 2.8v4h4M7.5 10h5M7.5 13h5"/></svg>',
};

export function makeTreeIcon(kind, className = '') {
  const icon = document.createElement('span');
  icon.className = `file-icon ${kind === 'folder' ? 'folder-icon' : 'document-icon'} ${className}`.trim();
  icon.innerHTML = ICONS[kind];
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

export function makeTreeDisclosure(expanded = false, empty = false, className = '') {
  const disclosure = document.createElement('span');
  disclosure.className = `file-tree-disclosure${expanded ? ' expanded' : ''}${empty ? ' is-empty' : ''} ${className}`.trim();
  disclosure.textContent = '›';
  disclosure.setAttribute('aria-hidden', 'true');
  return disclosure;
}
