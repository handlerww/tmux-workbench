import test from 'node:test';
import assert from 'node:assert/strict';
import { isDirectoryDropItem, isExternalFileDrag, uploadTargetForRow } from './file-upload-utils.js';

test('upload destinations map directory rows, file rows, and the root correctly', () => {
  assert.equal(uploadTargetForRow(null, null), '.');
  assert.equal(uploadTargetForRow('src/components', 'directory'), 'src/components');
  assert.equal(uploadTargetForRow('README.md', 'file'), '.');
  assert.equal(uploadTargetForRow('src/main.js', 'file'), 'src');
  assert.equal(uploadTargetForRow('src/components/main.js', 'file'), 'src/components');
});

test('only external file drags qualify and dropped folders can be identified', () => {
  assert.equal(isExternalFileDrag({ dataTransfer: { types: ['Files'] } }), true);
  assert.equal(isExternalFileDrag({ dataTransfer: { types: ['text/plain'] } }), false);
  assert.equal(isExternalFileDrag({ dataTransfer: null }), false);
  assert.equal(isDirectoryDropItem({ webkitGetAsEntry: () => ({ isDirectory: true }) }), true);
  assert.equal(isDirectoryDropItem({ webkitGetAsEntry: () => ({ isDirectory: false }) }), false);
});
