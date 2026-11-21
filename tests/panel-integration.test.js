const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  const userDefaults = new Map();
  const timers = new Map();
  const registered = new Map();
  const windows = [];
  const lookups = [];
  const copied = [];
  let sequence = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); windows.push(this); this.options = options;
      this.bounds = { x: 100, y: 100, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.messages = []; this.focusCalls = 0;
      this.webContents.send = (...args) => this.messages.push(args);
      this.webContents.focus = () => {};
      this.webContents.invalidate = () => {};
    }
    static getFocusedWindow() { return null; }
    loadFile() {}
    isDestroyed() { return !!this.destroyed; }
    isVisible() { return !!this.visible; }
    isFocused() { return false; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(_visible, options) { this.workspaceOptions = options; }
    setSize(width, height) { Object.assign(this.bounds, { width, height }); }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    showInactive() { this.visible = true; }
    show() { this.visible = true; }
    hide() { this.visible = false; this.emit('hide'); }
    focus() { this.focusCalls++; }
    moveTop() {}
    destroy() {
      this.destroyed = true; this.emit('closed');
      if (windows.every(w => w.destroyed) && !app.emit('window-all-closed')) app.quit();
    }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    quitCalls: 0,
    quit() { this.quitCalls++; },
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch() {} },
    whenReady: () => ({ then() {} }),
    isPackaged: true,
    isHidden: () => false,
    focus() {},
  });
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const handlers = new Map();
  const ipcMain = new EventEmitter(); ipcMain.handle = (name, fn) => handlers.set(name, fn);
  const electron = {
    systemPreferences: {
      getUserDefault: key => userDefaults.get(key) ?? 0,
      setUserDefault: (key, _type, value) => userDefaults.set(key, value),
    },
    app, BrowserWindow: Window, ipcMain, clipboard: {writeText: text => copied.push(text)}, nativeTheme: { shouldUseDarkColors: true },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    globalShortcut: {
      register: (key, run) => { registered.set(key, run); return true; },
      unregister: key => registered.delete(key),
      isRegistered: key => registered.has(key),
    },
    screen: { getCursorScreenPoint: () => ({ x: 300, y: 300 }),
      getDisplayNearestPoint: () => display, getDisplayMatching: () => display,
      getPrimaryDisplay: () => display },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === 'auto-launch' ? class {} :
      name === 'child_process' ? {
        execFile: (...args) => lookups.push(args),
        execFileSync: () => { throw new Error('Unexpected synchronous child process'); },
      } :
      name === './panel-lifecycle' ? require('../src/main/panel-lifecycle') :
      name === './template-order' ? require('../src/main/template-order') :
      name === './lifecycle-log' ? require('../src/main/lifecycle-log') : require(name),
    __dirname: path.resolve('src/main'), console, Buffer, setImmediate,
    process: { platform: 'darwin', env: {}, pid: 100 },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++sequence, clearInterval() {},
  });
  const run = source => vm.runInContext(source, context);
  run(fs.readFileSync('src/main/main.js', 'utf8'));
  run('store = { get: (_key, fallback) => fallback }; bindIpc();');
  return { run, windows, ipcMain, registered, timers, userDefaults, handlers, app, lookups, copied };
}

for (const mode of ['clipboard', 'templates']) {
  test(`${mode} shortcut and flyout never activate the app, including cold load`, () => {
    const h = harness();
    h.run(`ensurePanelVisible('${mode}', { compact: true, fromShortcut: true })`);
    const main = h.windows[0];
    assert.equal(main.focusCalls, 0);
    assert.equal(main.workspaceOptions.skipTransformProcessType, true);
    h.ipcMain.emit(`${mode}-flyout:sync`, { sender: main.webContents }, { show: true, entries: ['a'] });
    const flyout = h.windows[1];
    assert.equal(main.focusCalls, 0);
    assert.equal(flyout.messages.length, 0);
    flyout.webContents.emit('did-finish-load');
    assert.equal(flyout.messages[0][0], `${mode}-flyout:render`);
    h.run('hideAllPanels()');
    assert.equal(h.registered.size, 0);
    h.ipcMain.emit(`${mode}-flyout:sync`, { sender: main.webContents }, { show: true });
    assert.equal(flyout.isVisible(), false);
  });
}

test('focus retry from settings cannot activate a later shortcut session', () => {
  const h = harness();
  h.run('ensurePanelVisible("settings")');
  const staleRetry = [...h.timers.values()].find(t => t.delay === 400).fn;
  h.run('hideAllPanels(); ensurePanelVisible("templates", { compact: true, fromShortcut: true })');
  const main = h.windows[0];
  const before = main.focusCalls;
  staleRetry();
  assert.equal(main.focusCalls, before);
});

test('crashed flyout releases keys and all windows are rebuilt on next open', () => {
  const h = harness();
  h.run('ensurePanelVisible("templates", { compact: true, fromShortcut: true })');
  h.ipcMain.emit('templates-flyout:sync', { sender: h.windows[0].webContents }, { show: true });
  h.windows[1].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(h.registered.size, 0);
  assert.ok(h.windows.every(w => w.destroyed));
  assert.equal(h.app.quitCalls, 0);
  h.run('ensurePanelVisible("templates", { compact: true, fromShortcut: true })');
  assert.equal(h.windows.length, 4);
  assert.equal(h.windows[2].isVisible(), true);
});

test('stale sizing reports cannot shrink settings or reopen a dismissed flyout', () => {
  const h = harness();
  h.run('ensurePanelVisible("settings")');
  const main = h.windows[0];
  h.ipcMain.emit('clipboard-compact:resize-main', { sender: main.webContents }, 96);
  assert.equal(main.bounds.width, 420);
  h.run('hideAllPanels()');
  h.ipcMain.emit('templates-flyout:sync', { sender: main.webContents }, { show: true });
  assert.equal(h.windows.length, 1);
});

test('week-old hidden windows are replaced before showing', () => {
  const h = harness();
  h.run('ensurePanelVisible("templates", { compact: true, fromShortcut: true }); hideAllPanels(); panelCreatedAt = Date.now() - 7 * 24 * 3600000;');
  h.run('ensurePanelVisible("templates", { compact: true, fromShortcut: true })');
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.windows[2].isVisible(), true);
  assert.equal(h.app.quitCalls, 0);
});

test('unresponsive main renderer releases navigation and discards pending payloads', () => {
  const h = harness();
  h.run('ensurePanelVisible("clipboard", { compact: true, fromShortcut: true })');
  const main = h.windows[0];
  main.emit('unresponsive');
  assert.equal(main.destroyed, true);
  assert.equal(h.registered.size, 0);
  main.webContents.emit('did-finish-load');
  assert.equal(main.messages.length, 0);
});

test('main content resize uses the opening cursor anchor and fits the whole display', () => {
  const h = harness();
  h.run('ensurePanelVisible("templates", { compact: true, fromShortcut: true }); panelAnchor = { x: 1430, y: 890 };');
  const main = h.windows[0];
  h.ipcMain.emit('clipboard-compact:resize-main', { sender: main.webContents }, 560);
  assert.ok(main.bounds.x + main.bounds.width <= 1432);
  assert.ok(main.bounds.y + main.bounds.height <= 892);
});

for (const mode of ['clipboard', 'templates']) {
  test(`${mode} selection messages do not reposition, resize, repaint or reconfigure a visible flyout`, () => {
    const h = harness();
    h.run(`ensurePanelVisible('${mode}', { compact: true, fromShortcut: true })`);
    const main = h.windows[0];
    const payload = { show: true, entries: [{ text: 'A' }, { text: 'B' }], selectedItemIndex: 0 };
    h.ipcMain.emit(`${mode}-flyout:sync`, { sender: main.webContents }, payload);
    const flyout = h.windows[1];
    let nativeUpdates = 0;
    for (const name of ['setPosition', 'setSize', 'setAlwaysOnTop', 'setVisibleOnAllWorkspaces']) {
      flyout[name] = () => { nativeUpdates++; };
    }
    flyout.webContents.invalidate = () => { nativeUpdates++; };
    h.ipcMain.emit('clipboard-compact:resize-flyout', { sender: flyout.webContents }, 96);
    nativeUpdates = 0;
    const timerCount = h.timers.size;
    for (let i = 0; i < 20; i++) {
      h.ipcMain.emit(`${mode}-flyout:sync`, { sender: main.webContents }, { ...payload, selectedItemIndex: i % 2 });
    }
    assert.equal(nativeUpdates, 0);
    assert.equal(h.timers.size, timerCount);
  });
}

test('menu-bar icon uses native template assets without resizing away Retina representations', () => {
  const h = harness();
  h.run(`nativeImage.createFromPath = file => ({ file, template: false,
    isEmpty: () => false, setTemplateImage(value) { this.template = value; } });`);
  for (const [today, overdue, name] of [[false,false,'trayTemplate.png'],[true,false,'tray-todayTemplate.png'],
    [false,true,'tray-overdueTemplate.png'],[true,true,'tray-bothTemplate.png']]) {
    const icon = h.run(`buildTrayImageWithBadges(${today}, ${overdue})`);
    assert.equal(path.basename(icon.file), name);
    assert.equal(icon.template, true);
  }
});

test('menu-bar starts on the right and preserves later user placement across relaunches', () => {
  const h = harness();
  const key = h.run('`NSStatusItem Preferred Position ${TRAY_GUID}`');
  h.run('prepareTrayPosition()');
  assert.equal(h.userDefaults.get(key), 0);
  h.userDefaults.set(key, 385);
  h.run('prepareTrayPosition()');
  assert.equal(h.userDefaults.get(key), 385);
  h.userDefaults.clear();
  h.run('app.isPackaged = false; prepareTrayPosition()');
  assert.equal(h.userDefaults.size, 0);
});

function templateStoreHarness() {
  const h = harness();
  h.run(`store = {
    data: {templates: [
      {id:'a',group:'First',name:'A',text:'a',updatedAt:1},
      {id:'b',group:'First',name:'B',text:'b',updatedAt:2},
      {id:'c',group:'Second',name:'C',text:'c',updatedAt:3}
    ]},
    get(key, fallback) { return this.data[key] ?? fallback; },
    set(key, value) { this.data[key] = value; }
  };`);
  return h;
}
test('editing and adding snippets preserves existing group and item order', () => {
  const h = templateStoreHarness();
  const save = h.handlers.get('templates:save');
  assert.equal(save({}, {id:'a',group:'First',name:'Edited',text:'updated'}).ok, true);
  assert.equal(h.run('getTemplates().map(t=>t.id).join()'), 'a,b,c');
  const added = save({}, {group:'First',name:'New',text:'new'});
  assert.equal(added.ok, true);
  assert.equal(h.run('getTemplates().map(t=>t.id).join()'), `a,b,${added.id},c`);
  save({}, {group:'Third',name:'Third',text:'third'});
  assert.equal(h.run('groupTemplates(getTemplates()).map(g=>g.group).join()'), 'First,Second,Third');
});
test('moving a snippet between groups appends it and preserves group positions', () => {
  const h = templateStoreHarness();
  h.handlers.get('templates:save')({}, {id:'a',group:'Second',name:'A',text:'a'});
  assert.equal(h.run('getTemplates().map(t=>t.id).join()'), 'b,c,a');
});
test('adding to a full group rejects the save without dropping another snippet', () => {
  const h = templateStoreHarness();
  h.run('store.data.settings = {...DEFAULT_SETTINGS, savedPerGroup:2};');
  assert.equal(h.handlers.get('templates:save')({}, {group:'First',name:'Overflow',text:'new'}).ok, false);
  assert.equal(h.run('getTemplates().map(t=>t.id).join()'), 'a,b,c');
});
test('reorder IPC persists order that a later edit cannot change', () => {
  const h = templateStoreHarness();
  assert.equal(h.handlers.get('templates:reorder')({}, {kind:'group',source:'Second',target:'First',placement:'before'}).ok,true);
  h.handlers.get('templates:save')({}, {id:'b',group:'First',name:'B',text:'edited'});
  assert.equal(h.run('getTemplates().map(t=>t.id).join()'), 'c,a,b');
});

test('a pinned panel cannot disappear on blur during reordering', () => {
  const h = harness();
  h.run('ensurePanelVisible("templates", {compact:true,fromShortcut:true}); setPanelAutoDismissEnabled(false); hidePanelAndFlyoutsIfNoFocus();');
  assert.equal(h.windows[0].isVisible(), true);
  h.run('setPanelAutoDismissEnabled(true); hidePanelAndFlyoutsIfNoFocus();');
  assert.equal(h.windows[0].isVisible(), false);
});

test('closing every popup keeps the menu-bar app alive but explicit Quit still quits', () => {
  const h = harness();
  h.run('ensurePanelVisible("templates", {compact:true,fromShortcut:true}); retirePanelWindows("test-recovery");');
  assert.equal(h.app.quitCalls, 0);
  h.run('ensurePanelVisible("templates", {compact:true,fromShortcut:true});');
  assert.ok(h.windows.some(w => !w.destroyed && w.isVisible()));
  h.run('quitApp("tray-menu")');
  assert.equal(h.app.quitCalls, 1);
});

for (const [mode, accelerator] of [['clipboard', 'Command+Shift+V'], ['templates', 'Command+Shift+B']]) {
  test(`${mode} opens both renderers without waiting for a slow macOS lookup`, async () => {
    const h = harness();
    h.run('setupGlobalShortcuts()');
    h.registered.get(accelerator)();
    assert.equal(h.lookups.length, 1);
    assert.equal(h.windows[0].isVisible(), true);
    assert.equal(h.windows[1].isVisible(), false); // Preloaded, not an empty popup.
    h.windows[1].webContents.emit('did-finish-load');
    h.ipcMain.emit(`${mode}-flyout:sync`, {sender:h.windows[0].webContents}, {show:true,entries:[{text:'A'}]});
    assert.equal(h.windows[1].messages.at(-1)[0], `${mode}-flyout:render`);
    assert.equal(h.windows[1].isVisible(), true);
    h.lookups[0].at(-1)(null, '321');
    await Promise.resolve();
    assert.equal(h.run('lastFrontmostPid'), 321);
    assert.equal(h.run('panelWatchState.ownerPid'), 321);
    h.registered.get(accelerator)();
    assert.equal(h.windows[0].isVisible(), false);
    assert.equal(h.lookups.length, 1); // Closing must not look up an app.
  });
}

test('late target lookups cannot replace a newer popup destination', async () => {
  const h = harness();
  h.run('setupGlobalShortcuts()');
  h.registered.get('Command+Shift+V')();
  h.registered.get('Command+Shift+B')();
  h.lookups[1].at(-1)(null, '222');
  await Promise.resolve();
  h.lookups[0].at(-1)(null, '111');
  await Promise.resolve();
  assert.equal(h.run('lastFrontmostPid'), 222);
  assert.equal(h.run('panelWatchState.ownerPid'), 222);
});

test('lookup failure falls back without holding up drawing or changing a closed session', async () => {
  const h = harness();
  h.run('lastSeenForeignFrontmostPid = 333; setupGlobalShortcuts()');
  h.registered.get('Command+Shift+V')();
  assert.equal(h.windows[0].isVisible(), true);
  h.lookups[0].at(-1)(new Error('timeout'), '');
  await Promise.resolve();
  assert.equal(h.run('lastFrontmostPid'), 333);
  h.registered.get('Command+Shift+B')();
  h.run('hideAllPanels(); lastFrontmostPid = null;');
  h.lookups[1].at(-1)(null, '444');
  await Promise.resolve();
  assert.equal(h.run('lastFrontmostPid'), null);
});

test('fast Enter waits for its original paste target while a new popup opens', async () => {
  const h = harness();
  h.run(`setupGlobalShortcuts(); globalThis.pastedPids = [];
    macPbcopySync = () => true;
    macPasteFastPid = pid => { pastedPids.push(pid); return {ok:true}; };`);
  h.registered.get('Command+Shift+V')();
  const paste = h.run("pasteText('test marker')");
  assert.equal(h.windows[0].isVisible(), false);
  h.registered.get('Command+Shift+B')();
  h.lookups[1].at(-1)(null, '222');
  h.lookups[0].at(-1)(null, '111');
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  [...h.timers.values()].find(t => t.delay === 8).fn();
  await paste;
  assert.deepEqual(Array.from(h.run('pastedPids')), [111]);
  assert.equal(h.run('lastFrontmostPid'), 222);
  assert.equal(h.copied.at(-1), 'test marker');
});
