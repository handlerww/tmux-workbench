import './session-hover-card.css';

const HOVER_DELAY_MS = 400;
const CLOSE_DELAY_MS = 250;
const CARD_WIDTH = 260;

/** A desktop-only, non-modal session details card for the Workspaces sidebar. */
export class SessionHoverCard {
  constructor({ getSession, getGroups, getEnabled, onMove, onBeforeOpen } = {}) {
    this.getSession = getSession || (() => null);
    this.getGroups = getGroups || (() => ({ groups: [], assignments: {} }));
    this.getEnabled = getEnabled || (() => true);
    this.onMove = onMove || (() => false);
    this.onBeforeOpen = onBeforeOpen || (() => {});
    this.rowsBySessionId = new Map();
    this.bindings = new WeakMap();
    this.sessionId = null;
    this.pinned = false;
    this.hoverTimer = 0;
    this.closeTimer = 0;
    this.renderedGroupSignature = '';
    this.destroyed = false;
    this.buildCard();

    this.onDocumentPointerDown = (event) => {
      if (!this.card || this.card.hidden) return;
      const row = this.rowsBySessionId.get(this.sessionId);
      if (this.card.contains(event.target) || row?.contains(event.target)) return;
      this.close();
    };
    this.onDocumentKeyDown = (event) => {
      if (event.key !== 'Escape' || this.card.hidden) return;
      const ownsFocus = this.pinned || this.card.contains(document.activeElement);
      if (ownsFocus) event.preventDefault();
      this.close({ restoreFocus: ownsFocus });
    };
    this.onScroll = (event) => {
      if (!this.card.contains(event.target)) this.close();
    };
    this.onResize = () => this.close();
    this.onPageHide = () => this.close();
    this.onDragStart = () => this.close();
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    document.addEventListener('scroll', this.onScroll, true);
    document.addEventListener('dragstart', this.onDragStart, true);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pagehide', this.onPageHide);
  }

  buildCard() {
    const card = document.createElement('section');
    card.className = 'session-hover-card';
    card.hidden = true;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Session details');

    const header = document.createElement('div');
    header.className = 'session-hover-card-header';
    this.name = document.createElement('strong');
    this.name.className = 'session-hover-card-name';
    this.path = document.createElement('div');
    this.path.className = 'session-hover-card-path';
    this.closeButton = document.createElement('button');
    this.closeButton.className = 'session-hover-card-close';
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', 'Close session details');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', () => this.close({ restoreFocus: true }));
    const sessionIcon = document.createElement('span');
    sessionIcon.className = 'session-hover-card-icon';
    sessionIcon.setAttribute('aria-hidden', 'true');
    sessionIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></svg>';
    header.append(sessionIcon, this.name, this.closeButton);
    const directory = document.createElement('div');
    directory.className = 'session-hover-card-directory';
    const directoryLabel = document.createElement('span');
    directoryLabel.className = 'session-hover-card-directory-label';
    directoryLabel.setAttribute('aria-hidden', 'true');
    directoryLabel.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z"/></svg>';
    directory.append(directoryLabel, this.path);

    const groupLabel = document.createElement('label');
    groupLabel.className = 'session-hover-card-group-label';
    groupLabel.textContent = 'Group';
    this.groupSelect = document.createElement('select');
    this.groupSelect.className = 'session-hover-group-select';
    this.groupSelect.setAttribute('aria-label', 'Move session to group');
    groupLabel.append(this.groupSelect);
    this.status = document.createElement('div');
    this.status.className = 'session-hover-card-status';
    this.status.setAttribute('aria-live', 'polite');
    card.append(header, directory, groupLabel, this.status);
    card.addEventListener('pointerenter', () => this.cancelClose());
    card.addEventListener('pointerleave', () => this.scheduleClose());
    card.addEventListener('focusin', () => this.cancelClose());
    card.addEventListener('focusout', (event) => {
      if (!card.contains(event.relatedTarget)) this.scheduleClose();
    });
    this.groupSelect.addEventListener('change', () => void this.moveToSelectedGroup());
    document.body.append(card);
    this.card = card;
  }

  attach(row, sessionId) {
    if (this.destroyed || !row || !sessionId) return;
    const previous = this.rowsBySessionId.get(sessionId);
    if (previous && previous !== row) this.unbind(previous);
    this.rowsBySessionId.set(sessionId, row);
    if (this.bindings.has(row)) return;
    const enter = () => {
      if (!this.isAvailable()) return;
      if (this.pinned && !this.card.hidden && this.sessionId !== sessionId) return;
      this.cancelClose();
      if (this.sessionId === sessionId && !this.card.hidden) return;
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => {
        this.hoverTimer = 0;
        this.open(sessionId, { focus: false, pinned: false });
      }, HOVER_DELAY_MS);
    };
    const leave = () => {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = 0;
      this.scheduleClose();
    };
    const drag = () => this.close();
    row.addEventListener('pointerenter', enter);
    row.addEventListener('pointerleave', leave);
    row.addEventListener('dragstart', drag);
    this.bindings.set(row, { enter, leave, drag, sessionId });
  }

  unbind(row) {
    const binding = this.bindings.get(row);
    if (!binding) return;
    row.removeEventListener('pointerenter', binding.enter);
    row.removeEventListener('pointerleave', binding.leave);
    row.removeEventListener('dragstart', binding.drag);
    this.bindings.delete(row);
  }

  sync() {
    if (this.destroyed) return;
    for (const [sessionId, row] of this.rowsBySessionId) {
      if (row.isConnected) continue;
      this.unbind(row);
      this.rowsBySessionId.delete(sessionId);
    }
    if (this.sessionId && !this.card.hidden) {
      if (!this.isAvailable() || !this.getSession(this.sessionId)) {
        this.close();
        return;
      }
      const row = this.rowsBySessionId.get(this.sessionId);
      if (!row?.isConnected) {
        this.close();
        return;
      }
      this.updateCard();
      this.positionCard();
    }
  }

  open(sessionId, { focus = false, pinned = false } = {}) {
    if (this.destroyed || !this.isAvailable() || !this.getSession(sessionId)) return false;
    const row = this.rowsBySessionId.get(sessionId);
    if (!row?.isConnected) return false;
    if (this.sessionId !== sessionId || this.card.hidden) this.onBeforeOpen();
    this.cancelClose();
    window.clearTimeout(this.hoverTimer);
    this.hoverTimer = 0;
    this.sessionId = sessionId;
    this.pinned = Boolean(pinned);
    this.updateCard();
    this.card.hidden = false;
    this.positionCard();
    if (focus) this.groupSelect.focus({ preventScroll: true });
    return true;
  }

  close({ restoreFocus = false } = {}) {
    window.clearTimeout(this.hoverTimer);
    window.clearTimeout(this.closeTimer);
    this.hoverTimer = 0;
    this.closeTimer = 0;
    if (this.card.hidden) return;
    const sessionId = this.sessionId;
    this.card.hidden = true;
    this.pinned = false;
    this.sessionId = null;
    this.status.textContent = '';
    if (restoreFocus && sessionId) this.getCurrentSessionButton(sessionId)?.focus({ preventScroll: true });
  }

  destroy() {
    if (this.destroyed) return;
    this.close();
    this.destroyed = true;
    for (const row of this.rowsBySessionId.values()) this.unbind(row);
    this.rowsBySessionId.clear();
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    document.removeEventListener('scroll', this.onScroll, true);
    document.removeEventListener('dragstart', this.onDragStart, true);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pagehide', this.onPageHide);
    this.card.remove();
  }

  isAvailable() {
    if (!this.getEnabled()) return false;
    return !window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  }

  updateCard() {
    const session = this.getSession(this.sessionId);
    if (!session) return;
    this.name.textContent = session.name || this.sessionId;
    this.name.title = session.name || this.sessionId;
    this.path.textContent = session.path || 'Path unavailable';
    this.path.title = session.path || '';
    const state = this.getGroups() || {};
    const groups = Array.isArray(state.groups) ? state.groups : [];
    const assignments = state.assignments || {};
    const selected = groups.some((group) => group.id === assignments[this.sessionId]) ? assignments[this.sessionId] : '';
    const signature = JSON.stringify([groups.map(({ id, name }) => [id, name]), selected]);
    if (signature !== this.renderedGroupSignature) {
      this.groupSelect.replaceChildren();
      const ungrouped = document.createElement('option');
      ungrouped.value = '';
      ungrouped.textContent = 'Untagged';
      for (const group of groups) {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        this.groupSelect.append(option);
      }
      this.groupSelect.append(ungrouped);
      this.groupSelect.value = selected;
      this.renderedGroupSignature = signature;
    } else {
      this.groupSelect.value = selected;
    }
  }

  async moveToSelectedGroup() {
    if (!this.sessionId || this.groupSelect.disabled) return;
    const sessionId = this.sessionId;
    const state = this.getGroups() || {};
    const currentGroupId = state.assignments?.[sessionId] || '';
    const requestedGroupId = this.groupSelect.value || null;
    if (requestedGroupId === (currentGroupId || null)) return;
    this.groupSelect.disabled = true;
    this.status.textContent = 'Moving…';
    try {
      const success = await this.onMove(sessionId, requestedGroupId);
      if (success) this.close({ restoreFocus: true });
      else {
        if (this.sessionId === sessionId) {
          this.groupSelect.value = currentGroupId;
          this.status.textContent = 'Could not move session';
        }
      }
    } catch {
      if (this.sessionId === sessionId) {
        this.groupSelect.value = currentGroupId;
        this.status.textContent = 'Could not move session';
      }
    } finally {
      this.groupSelect.disabled = false;
    }
  }

  getCurrentSessionButton(sessionId) {
    const row = this.rowsBySessionId.get(sessionId);
    const liveRow = row?.isConnected ? row : [...document.querySelectorAll('.session-card-row')]
      .find((item) => item.querySelector(`.session-card[data-session-id="${CSS.escape(sessionId)}"]`));
    if (liveRow) this.rowsBySessionId.set(sessionId, liveRow);
    return liveRow?.querySelector('.session-card') || null;
  }

  positionCard() {
    const row = this.rowsBySessionId.get(this.sessionId);
    if (!row?.isConnected) return;
    const rect = row.getBoundingClientRect();
    const margin = 10;
    const gap = 8;
    const width = Math.min(CARD_WIDTH, window.innerWidth - margin * 2);
    this.card.style.width = `${width}px`;
    const rightLeft = rect.right + gap;
    const leftLeft = rect.left - width - gap;
    const left = rightLeft + width <= window.innerWidth - margin
      ? rightLeft
      : leftLeft >= margin ? leftLeft : Math.max(margin, Math.min(window.innerWidth - width - margin, rightLeft));
    const height = this.card.getBoundingClientRect().height;
    const top = Math.max(margin, Math.min(window.innerHeight - height - margin, rect.top));
    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(top)}px`;
  }

  cancelClose() {
    window.clearTimeout(this.closeTimer);
    this.closeTimer = 0;
  }

  scheduleClose() {
    this.cancelClose();
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = 0;
      if (this.pinned || this.card.matches(':focus-within')) return;
      this.close();
    }, CLOSE_DELAY_MS);
  }
}
