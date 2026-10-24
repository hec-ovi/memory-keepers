// Tiny event bus. Cross-module communication goes through this plus the shared
// state object owned by main.js; modules never import each other directly.

export function createBus() {
  const handlers = new Map(); // event -> Set<fn>

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = handlers.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) handlers.delete(event);
  }

  function emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }

  return { on, off, emit };
}
