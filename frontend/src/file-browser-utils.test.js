import test from 'node:test';
import assert from 'node:assert/strict';
import { fileLanguage, fileSavePayload, formatFileSize, hasUnsavedChanges, imageMimeType, isImageFile, isSupportedImageMime } from './file-browser-utils.js';

test('fileLanguage maps common source files and defaults safely', () => {
  assert.equal(fileLanguage('src/main.ts'), 'typescript');
  assert.equal(fileLanguage('settings.json'), 'json');
  assert.equal(fileLanguage('README.md'), 'markdown');
  assert.equal(fileLanguage('Dockerfile'), 'plaintext');
});

test('formatFileSize formats bytes and larger units', () => {
  assert.equal(formatFileSize(12), '12 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1048576), '1.0 MB');
  assert.equal(formatFileSize(-1), '');
});

test('image preview accepts only the raster formats exposed by the image endpoint', () => {
  assert.equal(imageMimeType('assets/photo.JPG'), 'image/jpeg');
  assert.equal(imageMimeType('animation.gif'), 'image/gif');
  assert.equal(imageMimeType('hero.avif'), 'image/avif');
  assert.equal(imageMimeType('diagram.svg'), 'image/svg+xml');
  assert.equal(imageMimeType('notes.txt'), null);
  assert.equal(isImageFile({ name: 'photo.webp' }), true);
  assert.equal(isImageFile({ name: 'notes.txt', previewType: 'image' }), true);
  assert.equal(isImageFile({ name: 'diagram.svg' }), true);
  assert.equal(isSupportedImageMime('image/svg+xml'), true);
  assert.equal(isSupportedImageMime('image/svg+xml; charset=utf-8'), true);
  assert.equal(isSupportedImageMime('text/html'), false);
});

test('dirty state clears when content returns to the saved baseline', () => {
  assert.equal(hasUnsavedChanges('edited', 'original'), true);
  assert.equal(hasUnsavedChanges('original', 'original'), false);
  assert.equal(hasUnsavedChanges('', null), false);
});

test('file save payload carries the optimistic revision and original session root', () => {
  assert.deepEqual(fileSavePayload({ id: '$12' }, { path: 'src/main.go', root: '/srv/project' }, 'new', 'sha256'), {
    session: '$12', path: 'src/main.go', content: 'new', revision: 'sha256', root: '/srv/project',
  });
});
