// Toast notifications. Factory per module contract: no module-level side effects.
//   const toasts = createToasts({ root });
//   toasts.show("saved");  toasts.error("boom");  toasts.success("done");

export function createToasts({ root, duration = 3500 } = {}) {
  const doc = root.ownerDocument;
  const stack = doc.createElement("div");
  stack.className = "toast-stack";
  stack.setAttribute("role", "status");
  stack.setAttribute("aria-live", "polite");
  root.appendChild(stack);

  function show(message, { kind = "info", duration: ms = duration } = {}) {
    const toast = doc.createElement("div");
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    stack.appendChild(toast);

    let timer = null;
    const dismiss = () => {
      if (timer !== null) clearTimeout(timer);
      toast.remove();
    };
    timer = setTimeout(dismiss, ms);
    toast.addEventListener("click", dismiss);
    return { dismiss, element: toast };
  }

  return {
    show,
    error: (message, opts) => show(message, { ...opts, kind: "error" }),
    success: (message, opts) => show(message, { ...opts, kind: "success" }),
    dispose() {
      stack.remove();
    },
  };
}
