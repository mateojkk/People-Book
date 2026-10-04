/**
 * Tombstone. The OS push feature was removed, and this unregisters the worker
 * from browsers that installed it.
 *
 * Deleting the file outright would leave the old worker running: a missing sw.js
 * is not an update, so the browser keeps the installed version intercepting
 * fetches indefinitely. Serving this instead makes the next update check replace
 * the worker with one whose only act is to remove itself.
 *
 * Delete this file entirely once no installed worker can still be fetching it --
 * in practice, after the deployment that ships it has been live long enough that
 * every active browser has checked for an update (browsers check on each
 * navigation to a page in scope, so days, not months).
 */

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      // Take control so the old caches it may have populated stop being served.
      // clients.claim() without any fetch handler means subsequent requests go
      // to the network, which is exactly the pre-worker behaviour.
      await self.clients.claim();
    })(),
  );
});
