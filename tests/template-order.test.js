const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupTemplatesStable, limitTemplates, reorderTemplates } = require('../src/main/template-order');
const items = [
  { id:'a1', group:'A', createdAt:10 }, { id:'b1', group:'B', createdAt:30 },
  { id:'a2', group:'A', createdAt:20 }, { id:'c1', group:'C', createdAt:40 },
];
const ids = list => list.map(t => t.id);
test('group and snippet order ignores edits and timestamps', () => {
  const updated = items.map(t => ({...t, updatedAt:t.id === 'b1' ? 99999 : 1}));
  assert.deepEqual(groupTemplatesStable(updated).map(g => g.group), ['A','B','C']);
  assert.deepEqual(ids(groupTemplatesStable(updated)[0].items), ['a1','a2']);
  assert.deepEqual(ids(limitTemplates(updated, {savedGroupsMax:3,savedPerGroup:5})), ['a1','a2','b1','c1']);
});
test('moving a group persists an entire block without changing its item order', () => {
  const moved = reorderTemplates(items, {kind:'group',source:'C',target:'A',placement:'before'});
  assert.deepEqual(ids(moved), ['c1','a1','a2','b1']);
  assert.deepEqual(groupTemplatesStable(JSON.parse(JSON.stringify(moved))).map(g=>g.group), ['C','A','B']);
  assert.deepEqual(ids(items), ['a1','b1','a2','c1']);
});
test('snippet moves work upward and downward without affecting other groups', () => {
  const moved = reorderTemplates(items, {kind:'snippet',source:'a2',target:'a1',placement:'before'});
  assert.deepEqual(ids(moved), ['a2','a1','b1','c1']);
  const restored = reorderTemplates(moved, {kind:'snippet',source:'a2',target:'a1',placement:'after'});
  assert.deepEqual(ids(restored), ['a1','a2','b1','c1']);
});
test('stale and cross-group moves are rejected without losing content', () => {
  for (const move of [
    {kind:'snippet',source:'a1',target:'b1',placement:'after'},
    {kind:'group',source:'missing',target:'B',placement:'before'},
    {kind:'group',source:'A',target:'B',placement:'invalid'},
  ]) assert.throws(()=>reorderTemplates(items,move));
  assert.equal(items.length,4);
});
test('limits respect custom order instead of newest timestamps', () => {
  assert.deepEqual(ids(limitTemplates(items,{savedGroupsMax:2,savedPerGroup:1})),['a1','b1']);
});
