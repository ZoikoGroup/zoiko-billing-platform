import React, { useEffect, useId, useRef } from "react";

export default function ConfirmDialog({ title, message, confirmLabel = "Delete", onConfirm, onClose, busy }) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef(null);
  // Read the latest props through refs so the mount-only effect below never
  // re-runs (and never re-steals / restores focus) on a parent re-render.
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  }, [onClose, busy]);

  useEffect(() => {
    // Remember what had focus (the trigger) so it can be restored on close,
    // and move focus into the dialog -- the safe, non-destructive choice.
    const previouslyFocused = document.activeElement;
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.stopPropagation();
        onCloseRef.current?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    // Phones: an edge-to-edge bottom sheet with full-width 44px buttons
    // (it used to touch the screen edges as a centred card). From sm up it is
    // the original centred card.
    <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-[110] sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        className="bg-white rounded-t-2xl shadow-lg w-full max-w-md p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-xl sm:p-6"
      >
        <h3 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h3>
        <p id={messageId} className="mt-2 text-sm text-slate-600">{message}</p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <button
            ref={cancelRef}
            onClick={onClose}
            disabled={busy}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 sm:min-h-0"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 sm:min-h-0"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
