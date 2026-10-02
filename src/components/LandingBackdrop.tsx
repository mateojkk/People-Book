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
      {/* The five seconds before the first frame arrives.
          This is what the page actually looks like for most of the load, and it
          was near-black: the old gradient ran panel -> base, and both of those
          are almost the same very dark grey. So the opening impression was a black
          screen with text on it, which reads as broken rather than as loading --
          that was the actual complaint, not fetch time.

          So this is designed to be the page, not a placeholder for one. Light
          enough to have visible structure and a warm accent bloom in the upper
          third, drifting slowly so it never looks frozen. Someone landing here
          before the video arrives sees something deliberate, and someone who never
          gets the video at all -- reduced motion, save-data, a failed fetch --
          still sees a finished-looking page rather than a gap. */}
      {/* Inline styles, not Tailwind arbitrary values. `bg-[radial-gradient(...-
          8%,...)]` compiles to nothing at all -- the negative percentage makes
          the arbitrary-value parser give up, silently, and you are left with a
          correctly positioned layer that paints nothing. Which is exactly what a
          black background looks like. There was no error anywhere; the class just
          was not in the stylesheet. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(105% 80% at 50% 0%, #2f353d 0%, #20242a 42%, var(--color-base) 86%)",
        }}
      />
      <div
        className="absolute inset-0 motion-safe:animate-[drift_22s_ease-in-out_infinite_alternate]"
        style={{
          background:
            "radial-gradient(40% 32% at 26% 16%, rgba(124,192,245,0.14), transparent 72%)",
        }}
      />
      {/* A faint grid, to give the dark field some structure at a glance. */}
      <div
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(227,229,232,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(227,229,232,0.5) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "radial-gradient(70% 55% at 50% 12%, #000 0%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(70% 55% at 50% 12%, #000 0%, transparent 78%)",
        }}
      />

      {armed && (
        <video
          ref={video}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${visible ? "opacity-[0.5]" : "opacity-0"}`}
          src={BACKDROP_SRC}
          autoPlay
          muted
          loop
          // Looping does delay the first playable frame on a 32MB asset -- the
          // browser pulls further ahead because it knows it must return to the
          // start. That was measured and it is a real cost, but it was also the
          // wrong diagnosis: the complaint was that the page was black while it
          // waited, not that the video arrived late. The wait is now designed for,
          // so the video can afford to loop. motion-reduce readers never get here.
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
      {visible && (
        <div className="absolute inset-0 bg-gradient-to-b from-base/45 via-base/55 to-base/85" />
      )}

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
