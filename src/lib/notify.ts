/**
 * Browser notifications.
 *
 * ── What this is, precisely ──────────────────────────────────────────────────
 * Local notifications, through a service worker, fired when something is due
 * while the app is running. That is the whole capability.
 *
 * It does NOT notify you when the app is closed. That is Web Push, and it needs
 * VAPID keys, a stored subscription per user, signed requests to a push service
 * and something to schedule the send. The functions below are shaped so that
 * adding it is an extension rather than a rewrite -- the permission and the
 * registration are the same either way -- but it is not built and the UI says
 * "while the app is open" so the limit is stated where it is felt.
 *
 * ── Why permission is asked for here and not on first load ───────────────────
 * Because a permission prompt on arrival is the fastest way to get permanently
 * denied. It is asked in Notifications, where being told about something is the
 * reason to want telling about it.
 *
 * ── The dedupe that matters ──────────────────────────────────────────────────
 * Fires once per notification per day, keyed on the notification's own date
 * rather than on fetch time. Without it the app re-notifies about the same
 * overdue thing on every reload, which is how people learn to dismiss banners
 * without reading them.
 */

const REGISTRATION_SCOPE = "/";
const SERVICE_WORKER_URL = "/sw.js";

/** What the browser currently permits. `default` means "never asked". */
export type PermissionState = "granted" | "denied" | "default" | "unsupported";

/** Whether a service worker is registered and able to show notifications. */
export function isSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

export function currentPermission(): PermissionState {
  if (!isSupported()) return "unsupported";
  return Notification.permission as PermissionState;
}

/**
 * Asks for permission, if it has not been decided yet.
 *
 * Returns the resulting state rather than throwing. A denied permission is a
 * normal outcome and not an error, and the caller has to be able to render it.
 */
export async function requestPermission(): Promise<PermissionState> {
  if (!isSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission as PermissionState;
  try {
    return (await Notification.requestPermission()) as PermissionState;
  } catch {
    // Some browsers reject the call outright rather than prompting.
    return Notification.permission as PermissionState;
  }
}

/** Registers the worker. Idempotent -- registering twice is not an error. */
export async function register(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration(REGISTRATION_SCOPE);
    if (existing) return existing;
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: REGISTRATION_SCOPE });
  } catch {
    // No worker means no notification, but the app must keep working.
    return null;
  }
}

// ── Dedupe ────────────────────────────────────────────────────────────────────

const SENT_KEY = "pb.notified.v1";

function readSent(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Has this exact notification already gone out today? */
export function alreadySent(tag: string): boolean {
  return readSent()[tag] === today();
}

function markSent(tag: string): void {
  try {
    const sent = readSent();
    sent[tag] = today();
    // Pruned on write rather than growing without bound. A key per notification
    // per day is small, but "small forever" is how localStorage fills up and
    // starts throwing, which would take the read path down with it.
    const entries = Object.entries(sent).slice(-60);
    localStorage.setItem(SENT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Best effort. A duplicate notification is better than none.
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────

export interface Notice {
  /** Stable identity for dedupe and for the notification's replace-behaviour. */
  tag: string;
  title: string;
  body: string;
}

/**
 * Shows a notice, unless it has already been shown today.
 *
 * Returns whether one was actually sent, so a caller can tell the difference
 * between "nothing was due" and "it was due and already told you".
 */
export async function notify(notices: readonly Notice[]): Promise<number> {
  if (currentPermission() !== "granted") return 0;

  const registration = await register();
  if (!registration) {
    // No worker. `new Notification` is the fallback, and works on desktop.
    if (typeof Notification === "undefined") return 0;
    let sent = 0;
    for (const notice of notices) {
      if (alreadySent(notice.tag)) continue;
      try {
        new Notification(notice.title, { body: notice.body, tag: notice.tag });
        markSent(notice.tag);
        sent += 1;
      } catch {
        // Blocked on mobile. Nothing to do.
      }
    }
    return sent;
  }

  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) return 0;

  let sent = 0;
  for (const notice of notices) {
    if (alreadySent(notice.tag)) continue;
    worker.postMessage({
      type: "notify",
      title: notice.title,
      body: notice.body,
      tag: notice.tag,
      url: "/app",
      timestamp: Date.now(),
    });
    markSent(notice.tag);
    sent += 1;
  }
  return sent;
}
