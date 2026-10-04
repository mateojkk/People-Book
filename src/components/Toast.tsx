/**
 * Toasts. Bottom right, the way a confirmation should arrive.
 *
 * ── Why not the top ──────────────────────────────────────────────────────────
 * WhatsApp puts them bottom-left, Slack bottom-right, and both chose it for the
 * same reason: the bottom corner is where an interruption is least likely to
 * cover the thing you were reading. Top-centre is where a toast sits directly
 * over the first line of a reply.
 *
 * ── The rules that actually matter ───────────────────────────────────────────
 * An announced toast and a silent one are not the same thing. This is a polite,
 * live region, so a screen reader hears it without stealing focus -- a toast that
 * moves focus would interrupt whatever the user was typing, which is a worse
 * bug than the one it replaced.
 *
 * Errors persist until dismissed. A success that vanished before it was read is
 * not a confirmation, and an error that auto-dismissed is worse than no error.
 */
import { useCallback, useEffect, useState } from "react";

export interface Toast {
  id: string;
  /** `info` dismisses itself. `error` stays until it is clicked. */
  tone: "info" | "error";
  title: string;
  detail?: string;
}

const DISMISS_AFTER_MS = 4_000;

/** Polite: it waits for a pause rather than interrupting what is being read. */
export function ToastStack({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-4 bottom-[4.5rem] z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 lg:bottom-4"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (toast.tone === "error") return; // persists
    const t = window.setTimeout(() => onDismiss(toast.id), DISMISS_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.tone, onDismiss]);

  return (
    <div
      className={`pointer-events-auto rounded-lg bg-panel px-3.5 py-3 shadow-lg ${
        toast.tone === "error" ? "outline outline-1 outline-stop/50" : "outline outline-1 outline-rule"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={`text-[12.5px] font-bold ${toast.tone === "error" ? "text-stop" : "text-text"}`}>{toast.title}</p>
          {toast.detail && <p className="mt-1 text-[11.5px] leading-5 text-muted">{toast.detail}</p>}
        </div>
        <button
          onClick={() => onDismiss(toast.id)}
          aria-label={`Dismiss: ${toast.title}`}
          className="-mr-1 -mt-1 shrink-0 rounded px-1.5 py-1 text-[13px] leading-none text-faint transition-colors hover:text-text"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * Holds toasts. Deliberately its own hook rather than context, because there is
 * exactly one stack in the app and threading a provider through to reach it would
 * be more structure than the feature needs.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  const push = useCallback((toast: Omit<Toast, "id"> & { id?: string }) => {
    const id = toast.id ?? `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.filter((t) => t.id !== id), { ...toast, id }].slice(-3));
  }, []);
  return { toasts, push, dismiss };
}
