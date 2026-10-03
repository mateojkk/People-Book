/**
 * The notification permission, asked for in the place where it makes sense.
 *
 * ── Why this exists instead of a prompt on arrival ────────────────────────────
 * A permission request on first load is the fastest route to a permanent denial,
 * because the visitor has no reason to say yes yet. It lives here instead: in
 * Notifications, where being told something is the entire reason to want telling
 * about it.
 *
 * ── What is promised, and what is not ────────────────────────────────────────
 * The copy says "while the app is open", because that is exactly true. Not
 * waking you when it is closed needs Web Push -- VAPID keys, a stored
 * subscription, signed requests and a scheduler -- and that is not built. A
 * promise of "you will never miss anything" would be false, and notifications
 * that only sometimes arrive are worse than none, because they train the
 * dismissal swipe.
 */
import { useCallback, useEffect, useState } from "react";
import * as browserNotify from "../lib/notify.ts";

export function PermissionToggle({ onNotify }: { onNotify: () => Promise<number> }) {
  const [state, setState] = useState<browserNotify.PermissionState>("default");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setState(browserNotify.currentPermission());
  }, []);

  const ask = useCallback(async () => {
    setBusy(true);
    try {
      const next = await browserNotify.requestPermission();
      setState(next);
      // Granting and never showing one is the worst outcome: the user said yes
      // and saw nothing, so they conclude it is broken.
      if (next === "granted") {
        const sent = await onNotify();
        if (sent === 0) {
          await browserNotify.notify([
            { tag: "welcome", title: "People Book", body: "Notifications are on. You will hear about this when something is due." },
          ]);
        }
      }
    } finally {
      setBusy(false);
    }
  }, [onNotify]);

  if (state === "unsupported") return null;

  if (state === "granted") {
    return (
      <p className="rounded-lg bg-panel px-3.5 py-2.5 text-[11.5px] leading-5 text-faint">
        Notifications are on, and arrive <span className="text-muted">while this app is open</span>. Waking you when
        it is closed is a different mechanism and is not built.
      </p>
    );
  }

  if (state === "denied") {
    return (
      <p className="rounded-lg bg-panel px-3.5 py-2.5 text-[11.5px] leading-5 text-faint">
        Notifications are blocked in your browser settings for this site. Nothing will pop up.
      </p>
    );
  }

  return (
    <div className="rounded-lg bg-panel px-3.5 py-3">
      <p className="text-[12px] leading-5 text-muted">
        Turn on notifications and it will tell you when something is due, without you opening this.
      </p>
      <button
        onClick={() => void ask()}
        disabled={busy}
        className="mt-2.5 min-h-11 rounded-lg bg-raised px-3.5 py-2 text-[12.5px] font-bold text-text transition-colors hover:bg-panel disabled:opacity-50"
      >
        {busy ? "Waiting for your browser…" : "Turn on notifications"}
      </button>
      <p className="mt-1.5 text-[11px] text-faint">
        These arrive while the app is open. Reaching you when it is closed needs a different
        mechanism, which is not built.
      </p>
    </div>
  );
}
