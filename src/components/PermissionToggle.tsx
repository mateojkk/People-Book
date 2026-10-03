/**
 * The notification permission, asked for in the place where it makes sense.
 *
 * ── Why this exists instead of a prompt on arrival ────────────────────────────
 * A permission request on first load is the fastest route to a permanent denial,
 * because the visitor has no reason to say yes yet. It lives here instead: in
 * Notifications, where being told something is the entire reason to want telling
 * about it.
 *
 * ── What the copy may and may not say ────────────────────────────────────────
 * It must not promise more than this does. Waking you when the app is closed
 * needs Web Push -- VAPID keys, a stored subscription, signed requests and a
 * scheduler -- and that is not built.
 *
 * It must ALSO not narrate that. An earlier version said so in the interface:
 * "Waking you when it is closed is a different mechanism and is not built." That
 * is a build note in a place a person is trying to use something. It advertises a
 * gap nobody asked about, and it makes a working feature read as unfinished.
 *
 * So the rule is: describe the behaviour, never the roadmap. "Arrives while the
 * app is open" is a complete and true sentence. The reasoning about Web Push
 * belongs in this comment, where the next person finds it.
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
        Notifications are on. They arrive while this app is open, and only about
        things that are actually due.
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
        It will tell you when something is due, without you having to come and look.
      </p>
      <button
        onClick={() => void ask()}
        disabled={busy}
        className="mt-2.5 min-h-11 rounded-lg bg-raised px-3.5 py-2 text-[12.5px] font-bold text-text transition-colors hover:bg-panel disabled:opacity-50"
      >
        {busy ? "Waiting for your browser…" : "Turn on notifications"}
      </button>
      <p className="mt-1.5 text-[11px] text-faint">
        You can change this at any time in your browser&rsquo;s site settings.
      </p>
    </div>
  );
}
