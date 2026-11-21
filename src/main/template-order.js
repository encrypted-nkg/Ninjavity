// The stored array is the ordering source of truth; timestamps are metadata only.
function groupName(template) { return (template.group || '').trim() || 'General'; }
function groupTemplatesStable(templates) {
  const groups = new Map();
  for (const item of templates || []) {
    const group = groupName(item);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
function limitTemplates(templates, settings) {
  return groupTemplatesStable(templates).slice(0, settings.savedGroupsMax)
    .flatMap(({ items }) => items.slice(0, settings.savedPerGroup));
}
function reorderTemplates(templates, move) {
  if (!move || !['group', 'snippet'].includes(move.kind) ||
      !['before', 'after'].includes(move.placement)) throw new Error('Invalid reorder request.');
  const groups = groupTemplatesStable(templates);
  let list, key;
  if (move.kind === 'group') {
    list = groups; key = item => item.group;
  } else {
    const sourceGroup = groups.find(g => g.items.some(item => item.id === move.source));
    if (!sourceGroup || !sourceGroup.items.some(item => item.id === move.target)) {
      throw new Error('Snippets can only be reordered within the same group.');
    }
    list = sourceGroup.items; key = item => item.id;
  }
  const from = list.findIndex(item => key(item) === move.source);
  const to = list.findIndex(item => key(item) === move.target);
  if (from < 0 || to < 0) throw new Error('The item is no longer available.');
  if (from !== to) {
    const [item] = list.splice(from, 1);
    const target = list.findIndex(item => key(item) === move.target);
    list.splice(target + (move.placement === 'after' ? 1 : 0), 0, item);
  }
  return groups.flatMap(g => g.items);
}
module.exports = { groupName, groupTemplatesStable, limitTemplates, reorderTemplates };
