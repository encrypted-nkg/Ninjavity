/* Pointer-based dragging works in the non-activating macOS flyout as well as the main panel. */
class ListReorder {
  constructor(root, selector, onMove, onState = () => {}) {
    this.root = root;
    this.selector = selector;
    this.onMove = onMove;
    this.onState = onState;
    this.active = null;
    this.busy = false;
    this.suppressUntil = 0;
    root.addEventListener('pointermove', event => this.move(event));
    root.addEventListener('pointerup', event => this.finish(event));
    root.addEventListener('pointercancel', () => this.cancel());
    root.addEventListener('lostpointercapture', () => { if (this.active) this.cancel(); });
    root.addEventListener('click', event => {
      if (Date.now() < this.suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    document.addEventListener('keydown', event => {
      if (this.active && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); this.cancel();
      }
    }, true);
    window.addEventListener('blur', () => this.cancel());
  }
  get dragging() { return !!this.active || this.busy; }
  addHandle(row, key, label, container = row) {
    row.dataset.reorderKey = key;
    const handle = document.createElement('button');
    handle.type = 'button'; handle.className = 'reorder-handle';
    handle.title = 'Drag to reorder · Option+↑/↓ to move';
    handle.setAttribute('aria-label', `Reorder ${label}`);
    handle.innerHTML = '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="7" cy="8" r="1"/><circle cx="3" cy="13" r="1"/><circle cx="7" cy="13" r="1"/></svg>';
    handle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
    handle.addEventListener('dblclick', event => event.stopPropagation());
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.dragging) return;
      event.preventDefault(); event.stopPropagation();
      this.active = { row, key, pointer: event.pointerId, startY: event.clientY, x: event.clientX, y: event.clientY };
      this.root.setPointerCapture(event.pointerId);
      row.dispatchEvent(new Event('reorder-start'));
      this.onState(true);
    });
    handle.addEventListener('keydown', async event => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (this.dragging) return;
      const rows = this.rows(), index = rows.indexOf(row), up = event.key === 'ArrowUp';
      const target = rows[index + (up ? -1 : 1)];
      if (!target) return;
      await this.commit({ source: key, target: target.dataset.reorderKey, placement: up ? 'before' : 'after' });
      this.rows().find(item => item.dataset.reorderKey === key)?.querySelector('.reorder-handle')?.focus();
    });
    container.prepend(handle);
  }
  rows() { return [...this.root.querySelectorAll(this.selector)]; }
  clearMarks() {
    this.rows().forEach(row => row.classList.remove('reorder-source', 'drop-before', 'drop-after'));
  }
  move(event) {
    const drag = this.active;
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.moved && Math.abs(drag.y - drag.startY) < 4) return;
    event.preventDefault();
    drag.moved = true;
    this.root.classList.add('is-reordering');
    this.markTarget();
    if (!this.frame) this.tick();
  }
  markTarget() {
    const drag = this.active;
    this.clearMarks();
    drag.row.classList.add('reorder-source');
    const bounds = this.root.getBoundingClientRect();
    drag.target = null;
    if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) return;
    const rows = this.rows();
    const target = rows.find(row => row.getBoundingClientRect().bottom > drag.y) || rows.at(-1);
    if (!target || target === drag.row) return;
    const rect = target.getBoundingClientRect();
    drag.placement = drag.y < rect.top + rect.height / 2 ? 'before' : 'after';
    drag.target = target.dataset.reorderKey;
    target.classList.add(`drop-${drag.placement}`);
  }
  tick() {
    if (!this.active?.moved) { this.frame = null; return; }
    const bounds = this.root.getBoundingClientRect(), y = this.active.y;
    const delta = y < bounds.top + 28 ? -6 : y > bounds.bottom - 28 ? 6 : 0;
    if (delta) { this.root.scrollTop += delta; this.markTarget(); }
    this.frame = requestAnimationFrame(() => this.tick());
  }
  release() {
    const drag = this.active;
    this.active = null;
    cancelAnimationFrame(this.frame); this.frame = null;
    this.clearMarks(); this.root.classList.remove('is-reordering');
    if (drag && this.root.hasPointerCapture(drag.pointer)) this.root.releasePointerCapture(drag.pointer);
    this.suppressUntil = Date.now() + 400;
    return drag;
  }
  async finish(event) {
    if (!this.active || event.pointerId !== this.active.pointer) return;
    const drag = this.release();
    if (drag.moved && drag.target) {
      await this.commit({ source: drag.key, target: drag.target, placement: drag.placement });
    } else this.onState(false);
  }
  cancel() { if (this.active) { this.release(); this.onState(false); } }
  async commit(move) {
    this.busy = true; this.onState(true);
    this.root.classList.add('reorder-busy');
    try {
      const result = await this.onMove(move);
      if (!result?.ok) throw new Error(result?.error || 'Unable to save order.');
      this.root.removeAttribute('aria-description');
      this.root.parentElement.querySelector('.reorder-status')?.remove();
    } catch (error) {
      this.root.setAttribute('aria-description', error.message);
      // A failed save leaves the original order intact and displays an actionable message.
      let status = this.root.parentElement.querySelector('.reorder-status');
      if (!status) {
        status = document.createElement('div'); status.className = 'reorder-status';
        status.setAttribute('role', 'alert'); this.root.after(status);
      }
      status.textContent = error.message;
    } finally {
      this.busy = false; this.root.classList.remove('reorder-busy'); this.onState(false);
    }
  }
}
