// Run with: electron tests/render-latency.cjs [absolute path to src]
// Real Chromium layout with synthetic content, hidden windows, no clipboard,
// shortcuts, saved data, or permissions. Reports IPC-to-layout, not screen paint.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || 'src');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'clipninja-render-test-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const settings = {theme:'dark',clipboardGroups:10,clipboardPerGroup:10};
for (const [channel,value] of [['settings:get',settings],['templates:getAll',[]],['data:getStartupEnabled',false]]) {
  ipcMain.handle(channel, () => value);
}
function report(channel, win) {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { ipcMain.removeListener(channel, receive); reject(new Error(`No layout: ${channel}`)); }, 5000);
    function receive(event,height) {
      if (event.sender !== win.webContents) return;
      clearTimeout(timer); ipcMain.removeListener(channel, receive); resolve(height);
    }
    ipcMain.on(channel, receive);
  });
}
async function windowFor(file,width) {
  const win = new BrowserWindow({width,height:96,show:false,webPreferences:{
    preload:path.join(root,'main/preload.js'),contextIsolation:true,nodeIntegration:false,
    backgroundThrottling:false,offscreen:true,
  }});
  await win.loadFile(path.join(root,'renderer',file));
  return win;
}
async function measure(win, channel, payload, resizeChannel) {
  const done = report(resizeChannel,win);
  const start = performance.now();
  win.webContents.send(channel,payload);
  const height = await done;
  const elapsed = performance.now()-start;
  assert.ok(height >= 96 && height <= 560, `Invalid height ${height}`);
  win.setSize(win.getBounds().width,height);
  win.webContents.send(resizeChannel.endsWith('main') ? 'clipboard-compact:main-sized' : 'clipboard-compact:flyout-sized');
  return Number(elapsed.toFixed(1));
}
app.whenReady().then(async () => {
  try {
    const entries = Array.from({length:20},(_,i) => ({id:`s${i}`,name:`Snippet ${i}`,group:'Tests',meta:`Snippet ${i}`,copiedAt:1,text:(`Synthetic test ${i}\n`).repeat(40)}));
    const results = {};
    const main = await windowFor('index.html',208);
    for (const mode of ['clipboard','templates']) {
      const start = performance.now();
      const flyout = await windowFor(`${mode}-flyout.html`,320);
      const startupMs = Number((performance.now()-start).toFixed(1));
      const mainMs = [], flyoutMs = [];
      for (let i=0;i<10;i++) {
        mainMs.push(await measure(main,'ui:update',{mode,compact:true,pasteOnClick:true,settings,clipboardHistory:entries,templatesGrouped:[{group:'Tests',items:entries}],templatesAll:entries},'clipboard-compact:resize-main'));
        flyoutMs.push(await measure(flyout,`${mode}-flyout:render`,{entries:entries.map(e=>({...e,meta:e.meta+i})),selectedItemIndex:19,pasteOnClick:true},'clipboard-compact:resize-flyout'));
      }
      const geometry = await flyout.webContents.executeJavaScript(`(() => {
        const root = document.querySelector('[role="list"]');
        const selected = root.querySelector('.selected');
        const a = root.getBoundingClientRect(), b = selected.getBoundingClientRect();
        return {count:root.children.length,selectedVisible:b.top>=a.top && b.top<a.bottom,scrollTop:root.scrollTop};
      })()`);
      assert.equal(geometry.count,20); assert.ok(geometry.selectedVisible); assert.ok(geometry.scrollTop>0);
      results[mode] = {rendererStartupMs:startupMs,mainLayoutMs:mainMs,flyoutLayoutMs:flyoutMs,geometry};
      flyout.destroy();
    }
    main.destroy();
    console.log(JSON.stringify({source:root,results},null,2));
    app.quit();
  } catch(error) { console.error(error); app.exit(1); }
}).finally(() => fs.rmSync(profile,{recursive:true,force:true}));
