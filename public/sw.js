/**
 * The service worker.
 *
 * ── Why a worker at all, when Notification API works from the page ────────────
 * Because `new Notification()` is blocked on most mobile browsers, and because a
 * notification tied to a page dies with the tab. A service worker outlives the
 * page, so the message is held by the browser rather than by a document that has
 * already been discarded. It is also the only route to real Web Push later,
 * since the push event arrives here and nowhere else.
 *
 * ── Scope, stated honestly ───────────────────────────────────────────────────
 * This shows notifications while the app is running. It does NOT wake the app
 * when it is closed -- that needs Web Push, which means VAPID keys, a stored
 * subscription, signed requests to a push service and a scheduler to send them.
 * Nothing in this file pretends otherwise, and the UI says "while the app is
 * open" so nobody is misled about what they will and will not receive.
 *
 * No imports: a service worker is not bundled, it is served as-is.
 */

self.addEventListener("install", () => {
  // Take over straight away rather than waiting for every tab to close, or the
  // first permission the user grants will do nothing and look broken.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Asked to show a notification by the page.
 *
 * `tag` is what makes this a replacement rather than a stack. The tag is the
 * notification's identity: a second notification with the same tag replaces the
 * first instead of adding to it, so re-notifying about the same overdue thing all
 * week updates one row rather than producing seven.
 */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "notify") return;

  const title = String(data.title ?? "People Book");
  const options = {
    body: String(data.body ?? ""),
    // Groups by tag in the notification centre, which is the difference between
    // "one reminder" and "four identical rows".
    tag: String(data.tag ?? "people-book"),
    renotify: Boolean(data.renotify),
    icon: "/src/assets/favicon-32.png",
    badge: "/src/assets/favicon-32.png",
    // A timestamp makes several notifications of the same tag distinct again,
    // which is wanted for genuinely separate items but not for a repeat of one.
    ...(data.timestamp ? { timestamp: Number(data.timestamp) } : {}),
    data: { url: String(data.url ?? "/app") },
  };

  // showNotification can reject -- permission revoked mid-flight, or too many
  // rate. Swallowing it is correct: there is nothing useful to do and an
  // unhandled rejection would surface as an app error.
  self.registration.showNotification(title, options).catch(() => {});
});

/**
 * Clicking a notification goes to the app.
 *
 * focusWindow rather than openWindow, because the app is almost certainly already
 * open somewhere and the user expects to land in it rather than in a second copy
 * of it. If it really was closed, focusWindow returns nothing and we fall through
 * to opening one.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/app";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client && client.url !== target) {
            return client.navigate(target).then((navigated) => navigated?.focus());
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
