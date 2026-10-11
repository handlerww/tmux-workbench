// Only input waiting for a connection is buffered. Sent input is never replayed.
export class SessionConnection {
  constructor({ url, isActive, onState, onOpen, onMessage, socketFactory = (address) => new WebSocket(address) }) {
    Object.assign(this, { url, isActive, onState, onOpen, onMessage, socketFactory });
    this.socket = null;
    this.retryTimer = null;
    this.connectTimer = null;
    this.retryAttempt = 0;
    this.waiters = new Set();
    this.generation = 0;
  }

  connect(force = false) {
    if (!this.isActive()) return;
    if (!force && this.socket && this.socket.readyState <= 1) return;
    this.disconnect(force);
    this.onState('connecting', 'Connecting');
    let socket;
    try {
      socket = this.socketFactory(this.url());
    } catch {
      this.onState('disconnected', 'Connection failed');
      this.scheduleRetry();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.connectTimer = setTimeout(() => this.failed(socket), 10000);
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.retryAttempt = 0;
      this.onState('connected', 'Live');
      this.onOpen();
      if (this.socket === socket) this.resolveWaiters(true);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.onMessage(event);
    });
    socket.addEventListener('close', () => this.failed(socket));
    socket.addEventListener('error', () => this.failed(socket));
  }

  failed(socket) {
    if (this.socket !== socket) return;
    this.disconnect();
    this.onState('disconnected', 'Disconnected');
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (!this.isActive() || this.retryTimer) return;
    const delay = Math.min(1000 * (2 ** this.retryAttempt++), 15000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  ensureConnected() {
    if (!this.isActive()) return Promise.resolve(false);
    if (this.socket?.readyState === 1) return Promise.resolve(true);
    // Join an existing handshake; a user's send bypasses the retry delay.
    this.connect();
    return new Promise((resolve) => {
      const waiter = (connected) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(connected);
      };
      const timer = setTimeout(() => waiter(false), 15000);
      this.waiters.add(waiter);
    });
  }

  send(data) {
    if (this.isActive() && this.socket?.readyState === 1) {
      try {
        this.socket.send(data);
        return Promise.resolve(true);
      } catch {
        this.failed(this.socket);
        return Promise.resolve(false);
      }
    }
    const generation = this.generation;
    return this.ensureConnected().then((connected) => connected && this.generation === generation ? this.send(data) : false);
  }

  resolveWaiters(connected) {
    for (const waiter of this.waiters) waiter(connected);
  }

  disconnect(cancelPending = false) {
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    if (cancelPending) {
      this.generation += 1;
      this.retryAttempt = 0;
      this.resolveWaiters(false);
    }
  }
}
