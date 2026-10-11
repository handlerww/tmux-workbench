import test from 'node:test';
import assert from 'node:assert/strict';
import { isHorizontalEdgeSwipe } from './mobile-files.js';

const edge = { startX: 390, startY: 120, endX: 300, endY: 125, width: 400 };

test('mobile files drawer opens on a deliberate left swipe from the right edge', () => {
  assert.equal(isHorizontalEdgeSwipe({ ...edge, open: false }), true);
  assert.equal(isHorizontalEdgeSwipe({ ...edge, open: true }), false);
});

test('mobile files drawer closes on a deliberate right swipe from the right edge', () => {
  assert.equal(isHorizontalEdgeSwipe({ ...edge, startX: 300, endX: 380, open: true }), true);
  assert.equal(isHorizontalEdgeSwipe({ ...edge, startX: 300, endX: 380, open: false }), false);
});

test('edge gestures ignore vertical scrolling, short movement, and non-edge opens', () => {
  assert.equal(isHorizontalEdgeSwipe({ ...edge, endX: 386, endY: 180, open: false }), false);
  assert.equal(isHorizontalEdgeSwipe({ ...edge, endX: 345, open: false }), false);
  assert.equal(isHorizontalEdgeSwipe({ ...edge, startX: 340, open: false }), false);
  assert.equal(isHorizontalEdgeSwipe({ ...edge, startX: 200, endX: 280, open: true }), true);
});
