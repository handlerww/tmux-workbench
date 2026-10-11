const FOCUSABLE = 'button:not([disabled]):not([hidden]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const MOBILE_QUERY = '(max-width: 520px)';
const EDGE_SIZE = 24;
const SWIPE_DISTANCE = 56;
const HORIZONTAL_INTENT = 1.25;

export function isHorizontalEdgeSwipe({ startX, endX, startY, endY, width, open }) {
  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * HORIZONTAL_INTENT) return false;
  if (open) return dx > 0;
  return startX >= width - EDGE_SIZE && dx < 0;
}

export class MobileFilesController {
  constructor({ panel, toggle, onOpenChange }) {
    this.panel = panel;
    this.toggleButton = toggle;
    this.onOpenChange = onOpenChange;
    this.query = window.matchMedia(MOBILE_QUERY);
    this.openState = false;
    this.touchStart = null;
    this.focusSiblings = [];
    this.backdrop = document.createElement('button');
    this.backdrop.type = 'button';
    this.backdrop.className = 'mobile-files-backdrop';
    this.backdrop.setAttribute('aria-label', 'Close files');
    this.backdrop.hidden = true;
    panel.parentElement.insertBefore(this.backdrop, panel);

    this.onToggle = () => this.toggle();
    this.onBackdropClick = () => this.setOpen(false, { restoreFocus: true });
    this.onPanelClick = (event) => {
      if (event.target.closest('[data-close-mobile-files]')) this.setOpen(false, { restoreFocus: true });
    };
    this.onKeydown = (event) => this.handleKeydown(event);
    this.onTouchStart = (event) => this.handleTouchStart(event);
    this.onTouchEnd = (event) => this.handleTouchEnd(event);
    this.onMediaChange = () => this.syncLayout();

    toggle.addEventListener('click', this.onToggle);
    this.backdrop.addEventListener('click', this.onBackdropClick);
    panel.addEventListener('click', this.onPanelClick);
    document.addEventListener('keydown', this.onKeydown);
    window.addEventListener('touchstart', this.onTouchStart, { passive: true });
    window.addEventListener('touchend', this.onTouchEnd, { passive: true });
    this.query.addEventListener('change', this.onMediaChange);
    this.syncLayout();
  }

  get isOpen() {
    return this.openState;
  }

  toggle() {
    this.setOpen(!this.openState, { restoreFocus: this.openState });
  }

  open() {
    this.setOpen(true);
  }

  close({ restoreFocus = false } = {}) {
    this.setOpen(false, { restoreFocus });
  }

  setOpen(open, { restoreFocus = false } = {}) {
    if (!this.query.matches) {
      const wasOpen = this.openState;
      this.openState = false;
      this.panel.classList.remove('mobile-open');
      this.panel.removeAttribute('role');
      this.panel.removeAttribute('aria-modal');
      this.panel.removeAttribute('aria-hidden');
      this.panel.inert = false;
      this.backdrop.hidden = true;
      this.toggleButton.setAttribute('aria-expanded', 'false');
      this.toggleButton.setAttribute('aria-label', 'Open files');
      this.toggleButton.title = 'Open files';
      document.body.classList.remove('mobile-files-open');
      this.syncSiblings(false);
      if (wasOpen) this.onOpenChange?.(false);
      return;
    }
    const wasOpen = this.openState;
    this.openState = Boolean(open);
    const isOpen = this.openState;
    this.panel.classList.toggle('mobile-open', isOpen);
    this.panel.setAttribute('aria-hidden', String(!isOpen));
    this.panel.inert = !isOpen;
    if (isOpen) {
      this.panel.setAttribute('role', 'dialog');
      this.panel.setAttribute('aria-modal', 'true');
      this.panel.setAttribute('aria-label', 'Session files');
    } else {
      this.panel.removeAttribute('role');
      this.panel.removeAttribute('aria-modal');
    }
    this.backdrop.hidden = !isOpen;
    this.toggleButton.setAttribute('aria-expanded', String(isOpen));
    this.toggleButton.setAttribute('aria-label', isOpen ? 'Close files' : 'Open files');
    this.toggleButton.title = isOpen ? 'Close files' : 'Open files';
    document.body.classList.toggle('mobile-files-open', isOpen);
    this.syncSiblings(isOpen);
    if (wasOpen !== isOpen) this.onOpenChange?.(isOpen);
    if (!isOpen && restoreFocus && this.query.matches) this.toggleButton.focus();
  }

  syncSiblings(isOpen) {
    const siblings = [
      document.querySelector('.mobile-header'),
      document.querySelector('#sidebar'),
      document.querySelector('.workspace-center'),
      document.querySelector('#files-resizer'),
    ].filter(Boolean);
    for (const element of siblings) {
      if (isOpen && !element.hasAttribute('data-mobile-files-inert')) {
        element.dataset.mobileFilesInert = element.inert ? 'true' : 'false';
        element.inert = true;
      } else if (!isOpen && element.hasAttribute('data-mobile-files-inert')) {
        element.inert = element.dataset.mobileFilesInert === 'true';
        delete element.dataset.mobileFilesInert;
      }
    }
  }

  syncLayout() {
    if (this.query.matches) {
      this.setOpen(this.openState);
      return;
    }
    this.setOpen(false);
    this.panel.removeAttribute('aria-hidden');
    this.panel.inert = false;
    this.panel.classList.remove('mobile-open');
    this.toggleButton.setAttribute('aria-expanded', 'false');
    this.backdrop.hidden = true;
  }

  handleKeydown(event) {
    if (!this.openState) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.setOpen(false, { restoreFocus: true });
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...this.panel.querySelectorAll(FOCUSABLE)].filter((element) => !element.closest('[hidden]') && !element.inert);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!this.panel.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  handleTouchStart(event) {
    if (!this.query.matches || event.touches.length !== 1) {
      this.touchStart = null;
      return;
    }
    const target = event.target;
    const selection = window.getSelection?.();
    if (target.closest?.('input, textarea, [contenteditable="true"], .xterm, .monaco-editor') || selection?.toString()) {
      this.touchStart = null;
      return;
    }
    const touch = event.touches[0];
    this.touchStart = { startX: touch.clientX, startY: touch.clientY, width: window.innerWidth };
  }

  handleTouchEnd(event) {
    if (!this.touchStart || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const gesture = {
      ...this.touchStart,
      endX: touch.clientX,
      endY: touch.clientY,
      open: this.openState,
    };
    this.touchStart = null;
    if (!isHorizontalEdgeSwipe(gesture)) return;
    this.setOpen(!gesture.open);
  }

  destroy() {
    this.toggleButton.removeEventListener('click', this.onToggle);
    this.backdrop.removeEventListener('click', this.onBackdropClick);
    this.panel.removeEventListener('click', this.onPanelClick);
    document.removeEventListener('keydown', this.onKeydown);
    window.removeEventListener('touchstart', this.onTouchStart);
    window.removeEventListener('touchend', this.onTouchEnd);
    this.query.removeEventListener('change', this.onMediaChange);
    this.setOpen(false);
    this.backdrop.remove();
  }
}
