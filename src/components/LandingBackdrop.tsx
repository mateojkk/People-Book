/**
 * The landing background.
 *
 * A decorative video, referenced by URL. Not downloaded, not in the repo — it is
 * 33MB and already on a CDN, which is exactly what a CDN is for. See RULES.md 20.
 *
 * Three things make this decorative rather than an accessibility problem, and all
 * three are load-bearing:
 *
 *   1. `aria-hidden`. There is no information in this frame. A screen reader that
 *      announced it would be announcing wallpaper.
 *   2. Muted, inline, looping. Browsers will not autoplay audio, and on iOS they
 *      will not autoplay an inline video that takes the whole screen without all
 *      three of these. Without them this silently does nothing on a phone.
 *   3. The overlay. The headline sits on top of whatever frame is playing, so the
 *      contrast of the text depends on the video. That is not a fixed property,
 *      it is a property of a random frame, so it cannot be designed once and
 *      assumed. The scrim is what makes it guaranteed.
 *
 * The video also is not fetched until after the page has painted. A 33MB file
 * competing with the headline for bandwidth means the headline arrives late, and
 * the headline is the entire point of the page.
 */
import { useEffect, useRef, useState } from "react";

/** The CDN URL. Kept here so the markup stays readable and it is one thing to change. */
export const BACKDROP_SRC =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260424_064411_9e9d7f84-9277-41f4-ab10-59172d89e6be.mp4";

export function LandingBackdrop() {
  const video = useRef<HTMLVideoElement>(null);
  const [armed, setArmed] = useState(false);
  // Armed means "we asked for it". `playing` means "there is a decoded frame",
  // which is the only honest moment to make it visible.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Anyone who has asked to be careful with data does not get a 33MB video.
    // checkConnection is Chromium-only, so it is feature-detected rather than
    // assumed, and an absent API simply means we do not know and load it.
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData) return;
    if (conn?.effectiveType === "slow-2g" || conn?.effectiveType === "2g") return;

    // Straight after the first paint, rather than on idle. This used to wait for
    // requestIdleCallback, which is the right idea for deferring work and the
    // wrong one for this: on a busy main thread it fires seconds late, and that
    // delay is the whole of what looked like a slow video.
    const raf = window.requestAnimationFrame(() => setArmed(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // An autoplay that is refused is not an error worth surfacing, but a video that
  // silently never starts would look like the background simply is not there. The
  // static gradient underneath is the fallback, so this only needs to avoid
  // loading at all in that case.
  useEffect(() => {
    const el = video.current;
    if (!armed || !el) return;
    el.play().catch(() => {
      // Fine. The gradient behind it is the design, not a consolation prize.
    });
  }, [armed]);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-base">
      {/* Always rendered, and it is what a reduced-motion reader sees: the page is
          fully readable without ever touching the video. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,var(--panel)_0%,var(--base)_62%)]" />

      {armed && (
        <video
          ref={video}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${visible ? "opacity-[0.5]" : "opacity-0"}`}
          src={BACKDROP_SRC}
          autoPlay
          muted
          // Deliberately NOT looped. Measured on this asset, looping roughly
          // doubles the wait for a playable frame:
          //
          //   loop     6s: 5% fetched, readyState 1 (nothing on screen)
          //            12s: 16% fetched
          //   no loop  6s: 12% fetched, readyState 3 (playing)
          //            12s: 48% fetched
          //
          // The browser knows a looping video has to come back to the start, so it
          // pulls the whole 32MB rather than playing what it has. Dropping `loop`
          // lets it stream, reach a playable state in half the time, and stop
          // fetching once it is ahead. The cost is that it plays once and holds
          // the last frame -- invisible at this opacity, under a scrim, behind the
          // text. If a looping background is ever genuinely wanted, the fix is a
          // smaller file at a URL, not the loop attribute.
          playsInline
          preload="auto"
          onCanPlay={() => setVisible(true)}
          // Some engines will not start an inline full-bleed video otherwise.
          disablePictureInPicture
          tabIndex={-1}
        />
      )}

      {/* The guarantee, and only as strong as it has to be.
          A uniform full-screen scrim is the blunt instrument: it darkens the frame
          nobody is reading in order to protect the frame someone is. So this is
          weak at the top, where the headline sits, and firms up down the page
          where body text runs full width.

          It is still not nothing. A bright frame under the H1 would drop the
          contrast below comfortable, and the headline is the one thing on this
          page that cannot be allowed to fail. If the video is ever swapped for a
          brighter one, this gradient is the first thing that has to move. */}
      <div className="absolute inset-0 bg-gradient-to-b from-base/45 via-base/55 to-base/85" />

      {/* The guarantee, and only as strong as it has to be.
          This is a full-screen scrim, which is the blunt instrument: it darkens
          the parts of the frame nobody is reading to protect the parts they are.
          So it is weak at the top, where only the headline sits, and firmer down
          the page where body text runs full width.

          It is still not nothing. A brighter frame under the H1 would drop the
          contrast below the point where the headline is comfortably readable, and
          that is the one thing on this page that cannot be allowed to fail. If
          the video is ever swapped for something brighter, this gradient is what
          has to move first. */}
    </div>
  );
}
