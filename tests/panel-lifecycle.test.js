const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowDelivery, clampToWorkArea } = require('../src/main/panel-lifecycle');

function windowStub() {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.messages = [];
  win.webContents.send = (...args) => win.messages.push(args);
  win.isDestroyed = () => false;
  return win;
}

test('cold flyout delivers only the newest selection after renderer load', () => {
  const delivery = createWindowDelivery();
  const win = windowStub();
  delivery.attach(win);
  delivery.send(win, 'render', 'first group');
  delivery.send(win, 'render', 'second group');
  assert.equal(win.messages.length, 0);
  win.webContents.emit('did-finish-load');
  assert.deepEqual(win.messages, [['render', 'second group']]);
});

test('dismiss during loading cancels stale content, including after reload', () => {
  const delivery = createWindowDelivery();
  const win = windowStub();
  delivery.attach(win);
  delivery.send(win, 'render', 'old');
  delivery.cancel(win);
  win.webContents.emit('did-finish-load');
  assert.equal(win.messages.length, 0);
  win.webContents.emit('did-start-loading');
  delivery.send(win, 'render', 'fresh');
  win.webContents.emit('did-finish-load');
  assert.deepEqual(win.messages, [['render', 'fresh']]);
});

test('growing panel fits fully on a display with negative coordinates', () => {
  assert.deepEqual(clampToWorkArea({ x: -200, y: 800, width: 208, height: 560 },
    { x: -1440, y: 0, width: 1440, height: 900 }),
  { x: -216, y: 332, width: 208, height: 560 });
});

test('oversized window shrinks to usable work area', () => {
  assert.deepEqual(clampToWorkArea({ x: 100, y: 100, width: 480, height: 680 },
    { x: 0, y: 0, width: 400, height: 600 }),
  { x: 8, y: 8, width: 384, height: 584 });
});
