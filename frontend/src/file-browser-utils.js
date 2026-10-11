const LANGUAGE_BY_EXTENSION = new Map([
  ['c', 'c'], ['cc', 'cpp'], ['cpp', 'cpp'], ['cxx', 'cpp'], ['h', 'cpp'], ['hpp', 'cpp'],
  ['css', 'css'], ['go', 'go'], ['html', 'html'], ['htm', 'html'], ['java', 'java'],
  ['js', 'javascript'], ['jsx', 'javascript'], ['json', 'json'], ['md', 'markdown'],
  ['mdx', 'markdown'], ['py', 'python'], ['rb', 'ruby'], ['rs', 'rust'], ['sh', 'shell'],
  ['bash', 'shell'], ['sql', 'sql'], ['svg', 'xml'], ['toml', 'ini'], ['ts', 'typescript'],
  ['tsx', 'typescript'], ['xml', 'xml'], ['yaml', 'yaml'], ['yml', 'yaml'],
]);

const IMAGE_MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'],
  ['gif', 'image/gif'], ['bmp', 'image/bmp'], ['avif', 'image/avif'], ['svg', 'image/svg+xml'],
]);
const SAFE_IMAGE_MIME_TYPES = new Set(IMAGE_MIME_BY_EXTENSION.values());

export function fileLanguage(name) {
  const filename = String(name ?? '').split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION.get(extension) ?? 'plaintext';
}

export function imageMimeType(name) {
  const filename = String(name ?? '').split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  return IMAGE_MIME_BY_EXTENSION.get(extension) ?? null;
}

export function isSupportedImageMime(value) {
  return SAFE_IMAGE_MIME_TYPES.has(String(value ?? '').split(';', 1)[0].trim().toLowerCase());
}

export function isImageFile(file) {
  return file?.previewType === 'image' || Boolean(imageMimeType(file?.name || file?.path));
}

export function hasUnsavedChanges(content, savedContent) {
  return typeof savedContent === 'string' && content !== savedContent;
}

export function fileSavePayload(session, file, content, revision) {
  const payload = { session: session.id, path: file.path, content, revision };
  if (typeof file.root === 'string') payload.root = file.root;
  return payload;
}

export function formatFileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = size;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
