export function registerServiceWorker(serviceWorker = globalThis.navigator?.serviceWorker) {
  if (!serviceWorker) return Promise.resolve(null);
  return serviceWorker.register('/sw.js');
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    registerServiceWorker().catch(() => {
      // PWA support is progressive; registration failures must not affect tmux access.
    });
  });
}
