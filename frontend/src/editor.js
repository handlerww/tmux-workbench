import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { parseAnsiLines } from './ansi.js';
import { SessionConnection } from './connection.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const activeCaptureInterval = 850;
const backgroundCaptureInterval = 3000;

export class SessionEditor {
  constructor(tabId, session, options) {
    this.tabId = tabId;
    this.session = session;
    this.options = options;
    this.visible = false;
    this.ended = false;
    this.viewMode = 'reader';
    this.readerSubmitInFlight = false;
    this.readerPasteResults = null;
    this.connection = new SessionConnection({
      url: () => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const query = new URLSearchParams({ session: this.session.name, cols: String(this.terminal.cols), rows: String(this.terminal.rows) });
        return `${protocol}//${location.host}/ws?${query}`;
      },
      isActive: () => this.visible && !this.ended && !document.hidden,
      onState: (state, label) => this.setConnection(state, label),
      onOpen: () => this.sendResize(),
      onMessage: (event) => {
        if (event.data instanceof ArrayBuffer) this.terminal.write(decoder.decode(new Uint8Array(event.data), { stream: true }));
      },
    });
    this.readerLines = [];
    this.readerAutoFollow = options.getAutoFollow();
    this.captureInFlight = false;
    this.captureController = null;
    this.captureTimer = null;
    this.readerJumpPending = true;
    this.resizeTimer = null;
    this.readerResizeTimer = null;
    this.renameInFlight = false;

    this.panel = document.createElement('section');
    this.panel.className = 'editor-panel';
    this.panel.dataset.tabId = tabId;
    this.panel.innerHTML = editorMarkup();
    const composerHintId = `composer-hint-${tabId}`;
    this.panel.querySelector('.composer-hint').id = composerHintId;
    this.panel.querySelector('.reader-input').setAttribute('aria-describedby', composerHintId);
    this.elements = {
      toolbar: this.panel.querySelector('.editor-toolbar'),
      nameDisplay: this.panel.querySelector('.session-name-display'),
      activeName: this.panel.querySelector('.active-name'),
      renameButton: this.panel.querySelector('.rename-button'),
      renameForm: this.panel.querySelector('.rename-form'),
      renameInput: this.panel.querySelector('.rename-input'),
      renameSave: this.panel.querySelector('.rename-save'),
      renameCancel: this.panel.querySelector('.rename-cancel'),
      activePath: this.panel.querySelector('.active-path'),
      connectionDot: this.panel.querySelector('.connection-dot'),
      connectionText: this.panel.querySelector('.connection-text'),
      readerMode: this.panel.querySelector('.reader-mode-button'),
      terminalMode: this.panel.querySelector('.terminal-mode-button'),
      readerFollow: this.panel.querySelector('.reader-follow-button'),
      readerBottom: this.panel.querySelector('.reader-bottom-button'),
      copy: this.panel.querySelector('.copy-button'),
      paste: this.panel.querySelector('.paste-button'),
      reconnect: this.panel.querySelector('.reconnect-button'),
      readerView: this.panel.querySelector('.reader-view'),
      readerContent: this.panel.querySelector('.reader-content'),
      readerStatus: this.panel.querySelector('.reader-status'),
      terminalShell: this.panel.querySelector('.terminal-shell'),
      terminalContainer: this.panel.querySelector('.terminal'),
      readerComposer: this.panel.querySelector('.reader-composer'),
      readerInput: this.panel.querySelector('.reader-input'),
      readerKeys: this.panel.querySelectorAll('[data-key]'),
      terminalHint: this.panel.querySelector('.hint-bar'),
    };

    this.fitAddon = new FitAddon();
    this.terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.32,
      letterSpacing: 0,
      scrollback: 20000,
      scrollOnUserInput: true,
      smoothScrollDuration: 120,
      rightClickSelectsWord: true,
      theme: options.getTerminalTheme(),
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.elements.terminalContainer);
    this.bindEvents();
    this.updateSession(session, true);
    this.updateAutoFollow();
    this.setViewMode('reader');

    this.terminalResizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.terminalResizeObserver.observe(this.elements.terminalShell);
    this.readerResizeObserver = new ResizeObserver(() => this.scheduleReaderSize());
    this.readerResizeObserver.observe(this.elements.readerView);
    this.scheduleReaderCapture(0);
  }

  bindEvents() {
    this.panel.addEventListener('pointerdown', () => this.options.onFocus(this.tabId));
    this.terminal.onData((data) => {
      const result = this.sendInput(data);
      if (this.readerPasteResults) this.readerPasteResults.push(result);
      else result.then((sent) => {
        if (!sent && this.visible && !document.hidden) this.options.onToast('Could not connect. Input was not sent');
      });
    });
    this.terminal.onSelectionChange(() => {
      this.elements.copy.disabled = !this.terminal.hasSelection();
    });
    this.terminal.attachCustomKeyEventHandler((event) => {
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && event.key.toLowerCase() === 'c' && this.terminal.hasSelection()) {
        if (event.type === 'keydown') this.copySelection();
        return false;
      }
      return true;
    });
    this.elements.readerMode.addEventListener('click', () => this.setViewMode('reader'));
    this.elements.terminalMode.addEventListener('click', () => this.setViewMode('terminal'));
    this.elements.readerFollow.addEventListener('click', () => this.options.onAutoFollowChange(!this.readerAutoFollow));
    this.elements.readerBottom.addEventListener('click', () => this.scrollReaderToBottom());
    this.elements.copy.addEventListener('click', () => this.copySelection());
    this.elements.paste.addEventListener('click', () => this.pasteClipboard());
    this.elements.reconnect.addEventListener('click', () => this.connect(true));
    this.elements.renameButton.addEventListener('click', () => this.startRename());
    this.elements.renameCancel.addEventListener('click', () => this.cancelRename(true));
    this.elements.renameForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.rename();
    });
    this.elements.renameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.renameInFlight) {
        event.preventDefault();
        this.cancelRename(true);
      }
    });
    this.elements.readerComposer.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitReaderInput();
    });
    this.elements.readerInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submitReaderInput();
      }
    });
    this.elements.readerInput.addEventListener('input', () => this.resizeReaderInput());
    for (const button of this.elements.readerKeys) {
      button.addEventListener('click', () => this.sendReaderKey(button.dataset.key));
    }
  }

  updateSession(session, live = true) {
    const renamed = this.session && this.session.name !== session.name;
    const wasEnded = this.ended;
    this.session = session;
    this.ended = !live;
    this.elements.activeName.textContent = session.name;
    this.elements.activeName.title = session.name;
    this.elements.activePath.textContent = session.path || 'Path unavailable';
    this.elements.activePath.title = session.path || '';
    this.panel.classList.toggle('session-ended', this.ended);
    if (this.ended) {
      this.disconnect();
      this.stopCapture();
      this.setConnection('ended', 'Ended');
    } else if (wasEnded) {
      if (this.visible) {
        this.readerJumpPending = true;
        this.connect(true);
      }
      this.refreshReader(this.visible);
    }
    if (renamed && this.visible && !this.ended && !wasEnded) {
      this.readerJumpPending = true;
      this.connect(true);
      this.refreshReader(true);
    }
  }

  setVisible(visible) {
    if (this.visible === visible) {
      if (visible) {
        this.scheduleSize();
      }
      return;
    }
    this.visible = visible;
    if (!visible) {
      this.disconnect();
      if (!this.captureInFlight) this.scheduleReaderCapture(backgroundCaptureInterval);
      return;
    }
    this.connect();
    if (this.readerLines.length > 0) this.scrollReaderToBottom();
    this.refreshReader(true);
    requestAnimationFrame(() => {
      this.scheduleSize();
    });
  }

  suspend() {
    const focused = document.activeElement;
    if (this.panel.contains(focused) && focused.matches('input, textarea')) focused.blur();
    this.disconnect();
    this.stopCapture();
  }

  resume() {
    if (document.hidden) return;
    this.connect();
    this.scheduleSize();
    this.refreshReader(false);
  }

  setViewMode(mode) {
    if (mode !== 'reader' && mode !== 'terminal') return;
    this.viewMode = mode;
    const reader = mode === 'reader';
    this.elements.readerView.hidden = !reader;
    this.elements.readerComposer.hidden = !reader;
    this.elements.terminalShell.hidden = reader;
    this.elements.terminalHint.hidden = reader;
    this.elements.readerMode.setAttribute('aria-pressed', String(reader));
    this.elements.terminalMode.setAttribute('aria-pressed', String(!reader));
    this.elements.readerFollow.hidden = !reader;
    this.elements.readerBottom.hidden = !reader;
    this.elements.copy.hidden = reader;
    this.elements.paste.hidden = reader;
    if (!this.visible) return;
    if (reader) {
      if (this.fitReaderTerminal()) this.sendResize();
      this.refreshReader(true);
    } else {
      clearTimeout(this.captureTimer);
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        this.sendResize();
      });
    }
  }

  updateTheme() {
    this.terminal.options.theme = this.options.getTerminalTheme();
  }

  updateAutoFollow() {
    this.readerAutoFollow = this.options.getAutoFollow();
    this.elements.readerFollow.setAttribute('aria-pressed', String(this.readerAutoFollow));
    const nextAction = this.readerAutoFollow ? 'Turn auto-follow off' : 'Turn auto-follow on';
    this.elements.readerFollow.setAttribute('aria-label', nextAction);
    this.elements.readerFollow.title = nextAction;
    if (this.readerAutoFollow && this.visible) this.scrollReaderToBottom();
  }

  connect(force = false) {
    if (!this.visible || this.ended) return;
    this.scheduleSize();
    this.connection.connect(force);
  }

  disconnect() {
    this.connection.disconnect(true);
  }

  async refreshReader(jumpToBottom = false) {
    if (jumpToBottom) this.readerJumpPending = true;
    if (this.viewMode !== 'reader' || this.ended || document.hidden || this.captureInFlight) return;
    this.captureInFlight = true;
    const sessionName = this.session.name;
    const controller = new AbortController();
    this.captureController = controller;
    clearTimeout(this.captureTimer);
    try {
      const query = new URLSearchParams({ session: sessionName });
      const response = await fetch(`/api/capture?${query}`, {
        cache: 'no-store',
        headers: { Accept: 'text/plain' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = await response.text();
      if (!this.ended && this.session.name === sessionName) {
        const shouldJumpToBottom = this.readerJumpPending;
        this.readerJumpPending = false;
        this.renderReader(content, shouldJumpToBottom);
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!this.ended && this.session.name === sessionName && this.readerLines.length === 0) {
        this.elements.readerStatus.hidden = false;
        this.elements.readerStatus.classList.remove('loading');
        this.elements.readerStatus.textContent = 'Output unavailable';
      }
    } finally {
      if (this.captureController !== controller) return;
      this.captureController = null;
      this.captureInFlight = false;
      const delay = this.session.name !== sessionName
        ? 0
        : this.visible ? activeCaptureInterval : backgroundCaptureInterval;
      this.scheduleReaderCapture(delay);
    }
  }

  renderReader(content, jumpToBottom) {
    const previousScrollTop = this.elements.readerView.scrollTop;
    const nextLines = parseAnsiLines(content);
    let prefix = 0;
    while (prefix < this.readerLines.length && prefix < nextLines.length && this.readerLines[prefix] === nextLines[prefix].key) prefix += 1;
    let suffix = 0;
    while (
      suffix < this.readerLines.length - prefix
      && suffix < nextLines.length - prefix
      && this.readerLines[this.readerLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix].key
    ) suffix += 1;

    const removeCount = this.readerLines.length - prefix - suffix;
    for (let index = 0; index < removeCount; index += 1) this.elements.readerContent.children[prefix]?.remove();
    const fragment = document.createDocumentFragment();
    for (const line of nextLines.slice(prefix, nextLines.length - suffix)) {
      const row = document.createElement('div');
      row.className = 'reader-line';
      renderAnsiLine(row, line.segments);
      fragment.append(row);
    }
    this.elements.readerContent.insertBefore(fragment, this.elements.readerContent.children[prefix] ?? null);
    this.readerLines = nextLines.map((line) => line.key);
    this.elements.readerStatus.hidden = nextLines.length > 0;
    this.elements.readerStatus.classList.remove('loading');
    if (nextLines.length === 0) this.elements.readerStatus.textContent = 'Waiting for output';
    if (this.visible && (jumpToBottom || this.readerAutoFollow)) this.scrollReaderToBottom();
    // Replacing a large changed range can temporarily clamp scrollTop to zero.
    else this.elements.readerView.scrollTo({ top: previousScrollTop, behavior: 'instant' });
  }

  scrollReaderToBottom() {
    requestAnimationFrame(() => {
      this.elements.readerView.scrollTo({ top: this.elements.readerView.scrollHeight, behavior: 'instant' });
    });
  }

  scheduleReaderCapture(delay) {
    clearTimeout(this.captureTimer);
    if (this.viewMode !== 'reader' || this.ended) return;
    this.captureTimer = setTimeout(() => this.refreshReader(false), delay);
  }

  async submitReaderInput() {
    if (this.readerSubmitInFlight) return;
    this.readerSubmitInFlight = true;
    const value = this.elements.readerInput.value;
    const sessionName = this.session.name;
    try {
      const connected = await this.connection.ensureConnected();
      if (!this.visible || this.ended || document.hidden || this.session.name !== sessionName) return;
      if (!connected) {
        this.options.onToast('Could not connect. Your message is still in the input');
        return;
      }
      // Keep xterm's paste processing (including bracketed paste) and check
      // that the text was sent before sending Enter or clearing the draft.
      const pasteResults = [];
      const generation = this.connection.generation;
      this.readerPasteResults = pasteResults;
      try {
        this.terminal.paste(value);
      } finally {
        this.readerPasteResults = null;
      }
      const sent = (await Promise.all(pasteResults)).every(Boolean);
      if (this.connection.generation !== generation) return;
      if (!sent) {
        this.options.onToast('Send failed. Your message is still in the input');
        return;
      }
      if (!await this.sendInput('\r')) {
        this.options.onToast('Send failed. Your message is still in the input');
        return;
      }
      if (this.elements.readerInput.value === value) this.elements.readerInput.value = '';
      this.resizeReaderInput();
      setTimeout(() => this.refreshReader(false), 80);
    } finally {
      this.readerSubmitInFlight = false;
    }
  }

  async sendReaderKey(key) {
    const values = { escape: '\u001b', interrupt: '\u0003', tab: '\t' };
    if (!values[key]) return;
    if (!await this.sendInput(values[key])) {
      this.options.onToast('Could not connect. Key was not sent');
      return;
    }
    setTimeout(() => this.refreshReader(false), 80);
  }

  sendInput(data) {
    return this.connection.send(encoder.encode(data));
  }

  sendResize() {
    if (this.connection.socket?.readyState !== WebSocket.OPEN) return;
    this.connection.send(JSON.stringify({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows }));
  }

  scheduleSize() {
    if (this.viewMode === 'reader') this.scheduleReaderSize();
    else this.scheduleFit();
  }

  scheduleReaderSize() {
    if (!this.visible || this.viewMode !== 'reader') return;
    clearTimeout(this.readerResizeTimer);
    this.readerResizeTimer = setTimeout(() => {
      if (!this.visible || this.viewMode !== 'reader') return;
      if (this.fitReaderTerminal()) this.sendResize();
    }, 100);
  }

  fitReaderTerminal() {
    const width = this.elements.readerView.clientWidth;
    const height = this.elements.readerView.clientHeight;
    if (!width || !height) return false;
    const contentStyle = getComputedStyle(this.elements.readerContent);
    const horizontalPadding = (Number.parseFloat(contentStyle.paddingLeft) || 0)
      + (Number.parseFloat(contentStyle.paddingRight) || 0);
    const verticalPadding = (Number.parseFloat(contentStyle.paddingTop) || 0)
      + (Number.parseFloat(contentStyle.paddingBottom) || 0);
    const fontSize = Number.parseFloat(contentStyle.fontSize) || 12;
    const font = `${contentStyle.fontStyle} ${contentStyle.fontWeight} ${contentStyle.fontSize} ${contentStyle.fontFamily}`;
    if (this.readerFont !== font) {
      const context = document.createElement('canvas').getContext('2d');
      if (context) context.font = font;
      this.readerCellWidth = context?.measureText('M'.repeat(32)).width / 32 || fontSize * 0.6;
      this.readerFont = font;
    }
    const cellWidth = this.readerCellWidth + (Number.parseFloat(contentStyle.letterSpacing) || 0);
    const lineHeight = Number.parseFloat(contentStyle.lineHeight) || fontSize * 1.5;
    const columns = Math.max(2, Math.min(500, Math.floor(Math.max(0, width - horizontalPadding) / Math.max(1, cellWidth))));
    const rows = Math.max(1, Math.min(300, Math.floor(Math.max(0, height - verticalPadding) / lineHeight)));
    if (this.terminal.cols !== columns || this.terminal.rows !== rows) this.terminal.resize(columns, rows);
    return true;
  }

  scheduleFit() {
    if (!this.visible || this.viewMode !== 'terminal') return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (!this.elements.terminalShell.clientWidth || !this.elements.terminalShell.clientHeight) return;
      this.fitAddon.fit();
      this.sendResize();
    }, 80);
  }

  resizeReaderInput() {
    this.elements.readerInput.style.height = 'auto';
    const maxHeight = Number.parseFloat(getComputedStyle(this.elements.readerInput).maxHeight) || 150;
    this.elements.readerInput.style.height = `${Math.min(this.elements.readerInput.scrollHeight, maxHeight)}px`;
  }

  startRename() {
    if (this.renameInFlight || this.ended) return;
    this.elements.renameInput.value = this.session.name;
    this.elements.nameDisplay.hidden = true;
    this.elements.renameForm.hidden = false;
    this.panel.classList.add('renaming');
    requestAnimationFrame(() => {
      this.elements.renameInput.focus();
      this.elements.renameInput.select();
    });
  }

  cancelRename(restoreFocus = false) {
    if (this.renameInFlight) return;
    this.elements.renameForm.hidden = true;
    this.elements.nameDisplay.hidden = false;
    this.panel.classList.remove('renaming');
    if (restoreFocus) this.elements.renameButton.focus();
  }

  async rename() {
    if (this.renameInFlight) return;
    const name = this.elements.renameInput.value.trim();
    if (!name) {
      this.options.onToast('Enter a session name');
      this.elements.renameInput.focus();
      return;
    }
    if (name === this.session.name) {
      this.cancelRename(true);
      return;
    }
    this.renameInFlight = true;
    this.elements.renameInput.disabled = true;
    this.elements.renameSave.disabled = true;
    this.elements.renameCancel.disabled = true;
    try {
      await this.options.onRename(this.session.id, name);
      this.elements.renameForm.hidden = true;
      this.elements.nameDisplay.hidden = false;
      this.panel.classList.remove('renaming');
    } catch (error) {
      this.options.onToast(error.message || 'Could not rename session');
      this.elements.renameInput.focus();
      this.elements.renameInput.select();
    } finally {
      this.renameInFlight = false;
      this.elements.renameInput.disabled = false;
      this.elements.renameSave.disabled = false;
      this.elements.renameCancel.disabled = false;
    }
  }

  async copySelection() {
    const selection = this.terminal.getSelection();
    if (!selection) return;
    try {
      await writeClipboard(selection);
      this.options.onToast('Copied');
    } catch {
      this.options.onToast('Copy failed');
    }
  }

  async pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.terminal.paste(text);
      this.options.onToast(text ? 'Pasted' : 'Clipboard is empty');
    } catch {
      this.options.onToast('Press Ctrl / ⌘ + V');
    }
  }

  setConnection(state, label) {
    this.elements.connectionDot.dataset.state = state;
    this.elements.connectionText.textContent = label;
    const indicator = this.elements.connectionDot.parentElement;
    indicator.dataset.state = state;
    indicator.title = `Connection: ${label}`;
  }

  stopCapture() {
    clearTimeout(this.captureTimer);
    this.captureController?.abort();
    this.captureController = null;
    this.captureInFlight = false;
  }

  destroy() {
    this.visible = false;
    this.disconnect();
    this.stopCapture();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.readerResizeTimer);
    this.terminalResizeObserver.disconnect();
    this.readerResizeObserver.disconnect();
    this.terminal.dispose();
    this.panel.remove();
  }
}

function renderAnsiLine(row, segments) {
  if (segments.length === 0) {
    row.textContent = '\u00a0';
    return;
  }
  for (const segment of segments) {
    if (!segment.href && Object.keys(segment.style).length === 0) {
      row.append(document.createTextNode(segment.text));
      continue;
    }
    const element = document.createElement(segment.href ? 'a' : 'span');
    element.textContent = segment.text;
    Object.assign(element.style, segment.style);
    if (segment.href) {
      element.className = 'reader-link';
      element.href = segment.href;
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
    }
    row.append(element);
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function editorMarkup() {
  return `
    <header class="editor-toolbar">
      <div class="session-identity">
        <div class="session-icon" aria-hidden="true">›_</div>
        <div class="session-details">
          <div class="session-title-row">
          <div class="session-name-display">
            <h1 class="active-name">Session</h1>
            <button class="rename-button" type="button" title="Rename session" aria-label="Rename session">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"/><path d="m13.8 7.2 3 3"/></svg>
            </button>
          </div>
          <form class="rename-form" hidden>
            <input class="rename-input" type="text" maxlength="100" autocomplete="off" spellcheck="false" aria-label="New session name" />
            <button class="rename-save" type="submit">Save</button>
            <button class="rename-cancel" type="button">Cancel</button>
          </form>
          <div class="connection-line" role="status" aria-live="polite" data-state="connecting" title="Connection: Connecting"><span class="connection-dot" aria-hidden="true"></span><span class="connection-text">Connecting</span></div>
          </div>
          <div class="session-context">
            <div class="active-path"></div>
          </div>
        </div>
      </div>
      <div class="toolbar-actions">
        <div class="view-switch" role="group" aria-label="View">
          <button class="reader-mode-button" type="button" aria-pressed="true">Reader</button>
          <button class="terminal-mode-button" type="button" aria-pressed="false">Terminal</button>
        </div>
        <button class="action-button reader-follow-button" type="button" aria-pressed="false" aria-label="Turn auto-follow on" title="Turn auto-follow on">
          <svg class="reader-follow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h9M5 9h7M5 13h5M16 4v13m-4-4 4 4 4-4M5 20h15"/></svg>
        </button>
        <button class="action-button reader-bottom-button" type="button" aria-label="Scroll to bottom" title="Scroll to bottom">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v13m-5-5 5 5 5-5M5 21h14"/></svg>
        </button>
        <button class="action-button copy-button" type="button" disabled hidden title="Copy selection" aria-label="Copy selection">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span class="action-label">Copy</span>
        </button>
        <button class="action-button paste-button" type="button" hidden title="Paste" aria-label="Paste">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h6M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2H9V4Z"/><path d="M16 5h2a2 2 0 0 1 2 2v13H4V7a2 2 0 0 1 2-2h2"/></svg><span class="action-label">Paste</span>
        </button>
        <button class="action-button quiet reconnect-button" type="button" title="Reconnect" aria-label="Reconnect session">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M18.7 9A7 7 0 0 0 6.4 6.4L4 9m16 6-2.4 2.6A7 7 0 0 1 5.3 15"/></svg>
        </button>
      </div>
    </header>
    <div class="reader-view" tabindex="0" aria-label="Session output">
      <div class="reader-content"></div>
      <div class="reader-status loading">Loading output</div>
    </div>
    <div class="terminal-shell" hidden><div class="terminal" aria-label="tmux session"></div></div>
    <form class="reader-composer">
      <div class="composer-row">
        <textarea class="reader-input" rows="1" placeholder="Send to session…" aria-label="Session input" spellcheck="true"></textarea>
        <div class="composer-actions">
          <div class="reader-shortcuts" role="group" aria-label="Keys">
            <button type="button" data-key="escape" title="Send Escape">Esc</button>
            <button type="button" data-key="interrupt" title="Send Ctrl+C">Ctrl C</button>
            <button type="button" data-key="tab" title="Send Tab">Tab</button>
          </div>
          <span class="composer-hint">Enter to send <span aria-hidden="true">·</span> Shift+Enter for newline</span>
          <button class="send-button" type="submit" aria-label="Send" title="Send (Enter)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
        </div>
      </div>
    </form>
    <footer class="hint-bar" hidden>
      <span>Type to interact</span><span class="hint-separator"></span><span><kbd>Shift</kbd> + drag to select</span>
    </footer>`;
}
