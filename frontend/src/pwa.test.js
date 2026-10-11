import assert from 'node:assert/strict';
import test from 'node:test';

import { registerServiceWorker } from './pwa.js';

test('registers the root service worker', async () => {
  let registeredPath = '';
  const registration = { scope: '/' };
  const serviceWorker = {
    register: async (path) => {
      registeredPath = path;
      return registration;
    },
  };

  assert.equal(await registerServiceWorker(serviceWorker), registration);
  assert.equal(registeredPath, '/sw.js');
});

test('does nothing when service workers are unavailable', async () => {
  assert.equal(await registerServiceWorker(null), null);
});
