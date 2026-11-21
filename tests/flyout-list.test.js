const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FlyoutList } = require('../src/renderer/flyout-list');

function harness() {
  let builds = 0, measurements = 0;
  const root = {
    children: [], scrollTop: 0, clientTop: 1, clientHeight: 200,
    getBoundingClientRect: () => ({ top: 20 }),
    replaceChildren() { this.children = []; },
    querySelectorAll() { return this.children; },
    querySelector() { return this.children.find(c => c.selected); },
  };
  const view = new FlyoutList(root, payload => {
    builds++;
    root.children = payload.entries.map((entry, i) => {
      const item = { selected: false, entry };
      item.classList = { toggle: (_name, enabled) => { item.selected = enabled; } };
      item.getBoundingClientRect = () => ({ top: 21 + i * 100 - root.scrollTop,
        bottom: 121 + i * 100 - root.scrollTop, height: 100 });
      return item;
    });
  }, () => measurements++);
  return { root, view, counts: () => ({ builds, measurements }) };
}
const entries = Array.from({ length: 20 }, (_, i) => ({ text: `Card ${i}` }));

test('rapid keyboard navigation reuses cards and scrolls last selection into view', () => {
  const h = harness();
  h.view.render({ entries, selectedItemIndex: 0 });
  const nodes = [...h.root.children];
  for (let i = 1; i < entries.length; i++) {
    // IPC produces new objects, even for unchanged content.
    h.view.render({ entries: structuredClone(entries), selectedItemIndex: i });
  }
  assert.deepEqual(h.counts(), { builds: 1, measurements: 1 });
  assert.ok(h.root.children.every((node, i) => node === nodes[i]));
  assert.equal(h.root.scrollTop, 1800);
  assert.equal(h.root.querySelector().entry.text, 'Card 19');
  h.view.render({ entries, selectedItemIndex: 0 });
  assert.equal(h.root.scrollTop, 0);
});

test('selection is revealed again after a viewport resize acknowledgement', () => {
  const h = harness(); h.root.clientHeight = 2000;
  h.view.render({ entries, selectedItemIndex: 19 });
  assert.equal(h.root.scrollTop, 0);
  h.root.clientHeight = 200;
  h.view.revealSelection();
  assert.equal(h.root.scrollTop, 1800);
});

test('group changes, edits, and click behavior changes rebuild; selection alone does not', () => {
  const h = harness();
  h.view.render({ entries, selectedItemIndex: 0 });
  h.view.render({ entries, selectedItemIndex: -1 });
  assert.equal(h.root.querySelector(), undefined);
  assert.deepEqual(h.counts(), { builds: 1, measurements: 1 });
  h.view.render({ entries: [{ text: 'Edited' }], selectedItemIndex: 0 });
  assert.equal(h.root.scrollTop, 0);
  h.view.render({ entries: [{ text: 'Edited' }], pasteOnClick: true, selectedItemIndex: 0 });
  assert.deepEqual(h.counts(), { builds: 3, measurements: 3 });
  h.view.render({ entries: [], selectedItemIndex: -1 });
  assert.equal(h.root.children.length, 0);
});

test('natural height can shrink below the current viewport without changing layout', () => {
  const h = harness();
  const prior = global.getComputedStyle;
  global.getComputedStyle = () => ({ paddingTop:'8px',paddingBottom:'8px',borderTopWidth:'1px',borderBottomWidth:'1px',marginTop:'0px',marginBottom:'0px' });
  try {
    h.view.render({ entries: entries.slice(0, 1), selectedItemIndex: 0 });
    h.root.clientHeight = 560;
    assert.equal(h.view.naturalHeight({}), 136);
    assert.equal(h.root.clientHeight, 560);
  } finally { global.getComputedStyle = prior; }
});
