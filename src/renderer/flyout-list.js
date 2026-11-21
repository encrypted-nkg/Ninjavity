/* Shared by both native flyouts and the in-panel lists. */
class FlyoutList {
  constructor(root, build, contentChanged = () => {}) {
    this.root = root;
    this.build = build;
    this.contentChanged = contentChanged;
    this.contentKey = null;
    this.selectedIndex = -1;
  }

  reset() {
    this.contentKey = null;
    this.selectedIndex = -1;
    this.root.replaceChildren();
  }

  render(payload) {
    // Selection is deliberately excluded: arrow keys must preserve DOM nodes,
    // click handlers, viewport dimensions, and the existing scroll position.
    const key = JSON.stringify([payload.entries || [], !!payload.pasteOnClick]);
    const changed = key !== this.contentKey;
    if (changed) {
      this.root.replaceChildren();
      this.build(payload);
      this.root.scrollTop = 0;
      this.contentKey = key;
    }
    this.selectedIndex = Number.isInteger(payload.selectedItemIndex) ? payload.selectedItemIndex : -1;
    this.root.querySelectorAll('.clip-flyout-item').forEach((item, index) => {
      item.classList.toggle('selected', index === this.selectedIndex);
    });
    if (changed) this.contentChanged();
    this.revealSelection();
  }

  revealSelection() {
    const selected = this.root.querySelector('.clip-flyout-item.selected');
    if (!selected || !this.root.clientHeight) return;
    const viewportTop = this.root.getBoundingClientRect().top + this.root.clientTop;
    const viewportBottom = viewportTop + this.root.clientHeight;
    const item = selected.getBoundingClientRect();
    // Scroll only this list, synchronously. Smooth scrolls can be repeatedly
    // cancelled by held arrow keys; scrollIntoView can also scroll ancestors.
    if (item.top < viewportTop || item.height > this.root.clientHeight) {
      this.root.scrollTop += item.top - viewportTop;
    } else if (item.bottom > viewportBottom) {
      this.root.scrollTop += item.bottom - viewportBottom;
    }
  }

  naturalHeight(outer) {
    // Measure the cards, not scrollHeight (which is at least the current viewport
    // height). This permits shrinking on group changes without unlocking layout.
    const children = this.root.children;
    let height = 0;
    if (children.length) {
      const first = children[0];
      const last = children[children.length - 1];
      height = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
      height += parseFloat(getComputedStyle(first).marginTop) || 0;
      height += parseFloat(getComputedStyle(last).marginBottom) || 0;
    }
    for (const element of [this.root, outer]) {
      const style = getComputedStyle(element);
      for (const property of ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']) {
        height += parseFloat(style[property]) || 0;
      }
    }
    return Math.ceil(height);
  }
}

// Keep the edit action separate from the row's click-to-paste gesture.
function addSnippetEditButton(row, label, onEdit) {
  row.classList.add('snippet-flyout-item');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'snippet-edit-button';
  button.title = 'Edit snippet';
  button.setAttribute('aria-label', `Edit snippet: ${label || 'Untitled'}`);
  button.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m14 5 5 5"/></svg>';
  button.addEventListener('click', event => {
    event.stopPropagation();
    onEdit();
  });
  button.addEventListener('dblclick', event => event.stopPropagation());
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  });
  row.appendChild(button);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { FlyoutList, addSnippetEditButton };
