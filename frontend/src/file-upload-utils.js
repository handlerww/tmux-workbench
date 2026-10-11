export function isExternalFileDrag(event) {
  return Array.from(event?.dataTransfer?.types || []).includes('Files');
}

export function uploadTargetForRow(path, type) {
  if (!path) return '.';
  if (type === 'directory') return path;
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '.' : path.slice(0, separator) || '.';
}

export function isDirectoryDropItem(item) {
  try {
    return Boolean(item?.webkitGetAsEntry?.()?.isDirectory);
  } catch {
    return false;
  }
}
