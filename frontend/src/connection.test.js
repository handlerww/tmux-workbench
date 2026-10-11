import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionConnection } from './connection.js';

class FakeSocket extends EventTarget {
  readyState = 0;
  sent = [];

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  send(data) {
    assert.equal(this.readyState, 1);
    this.sent.push(data);
  }
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  const states = [];
  let active = true;
  const connection = new SessionConnection({
    url: () => 'ws://example/ws?session=main',
    isActive: () => active,
    onState: (...state) => states.push(state),
    onOpen: () => {},
    onMessage: () => {},
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  t.after(() => connection.disconnect(true));
  return { connection, sockets, states, setActive: (value) => { active = value; } };
}

test('first input reconnects and waits for the handshake; queued input keeps its order', async (t) => {
  const { connection, sockets } = setup(t);
  const text = connection.send('hello');
  const enter = connection.send('\r');
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].sent, []);
  sockets[0].open();
  assert.deepEqual(await Promise.all([text, enter]), [true, true]);
  assert.deepEqual(sockets[0].sent, ['hello', '\r']);
});

test('an unexpected close retries automatically and never replays sent input', async (t) => {
  const { connection, sockets } = setup(t);
  connection.connect();
  sockets[0].open();
  assert.equal(await connection.send('once'), true);
  sockets[0].close();
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, []);
});

test('a user send bypasses retry backoff without opening duplicate sockets', async (t) => {
  const { connection, sockets } = setup(t);
  connection.connect();
  sockets[0].close();
  const result = connection.send('first after sleep');
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(await result, true);
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
});

test('suspending cancels pending input and resume replaces even an apparently open socket', async (t) => {
  const { connection, sockets, setActive } = setup(t);
  const result = connection.send('unsent');
  setActive(false);
  connection.disconnect(true);
  assert.equal(await result, false);
  t.mock.timers.tick(20000);
  assert.equal(sockets.length, 1);
  setActive(true);
  connection.connect();
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, []);
  connection.disconnect(true);
  connection.connect();
  assert.equal(sockets.length, 3);
  assert.equal(sockets[1].readyState, 3);
});

test('connection failures retry with backoff and successful opens reset it', (t) => {
  const { connection, sockets } = setup(t);
  connection.connect();
  sockets[0].close();
  t.mock.timers.tick(999);
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(1);
  sockets[1].close();
  t.mock.timers.tick(1999);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1);
  sockets[2].open();
  sockets[2].close();
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 4);
});

test('handshakes and sends time out without sending input on a later recovery', async (t) => {
  const { connection, sockets } = setup(t);
  const result = connection.send('keep draft');
  t.mock.timers.tick(10000);
  assert.equal(sockets[0].readyState, 3);
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(4000);
  assert.equal(await result, false);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, []);
});

test('late events from replaced sockets cannot affect the new connection', (t) => {
  const { connection, sockets, states } = setup(t);
  connection.connect();
  connection.connect(true);
  sockets[1].open();
  const count = states.length;
  sockets[0].dispatchEvent(new Event('error'));
  sockets[0].open();
  assert.equal(connection.socket, sockets[1]);
  assert.equal(states.length, count);
});

test('switching sessions or hiding a tab cancels input even just after the open event', async (t) => {
  const { connection, sockets } = setup(t);
  const result = connection.send('old session');
  sockets[0].open();
  connection.disconnect(true);
  connection.connect();
  sockets[1].open();
  assert.equal(await result, false);
  assert.deepEqual(sockets[1].sent, []);
});

test('inactive and ended editors never reconnect or send', async (t) => {
  const { connection, sockets, setActive } = setup(t);
  setActive(false);
  connection.connect(true);
  assert.equal(await connection.send('no'), false);
  t.mock.timers.tick(20000);
  assert.equal(sockets.length, 0);
});

test('send errors return failure without replaying the input on reconnect', async (t) => {
  const { connection, sockets } = setup(t);
  connection.connect();
  sockets[0].open();
  sockets[0].send = () => { throw new Error('network failure'); };
  assert.equal(await connection.send('not replayed'), false);
  t.mock.timers.tick(1000);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, []);
});

test('socket creation failure retries and keeps first input waiting', async (t) => {
  const { connection, sockets } = setup(t);
  const factory = connection.socketFactory;
  connection.socketFactory = () => { throw new Error('offline'); };
  const result = connection.send('first');
  assert.equal(sockets.length, 0);
  connection.socketFactory = factory;
  t.mock.timers.tick(1000);
  sockets[0].open();
  assert.equal(await result, true);
  assert.deepEqual(sockets[0].sent, ['first']);
});
