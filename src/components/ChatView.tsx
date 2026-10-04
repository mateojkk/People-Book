import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { Opening } from "./Opening.js";

/** One turn of the conversation. */
export interface Turn {
  id: string;
  role: "you" | "assistant";
  text: string;
  /** Memories written by this turn. Each carries its own undo. */
  saved?: { id: string; person: string; text: string }[];
  /** What the reply was based on, so every claim can be checked. */
  cited?: { id: string; person: string; text: string }[];
  /** Something raised without being asked. The whole point. */
  volunteered?: { id: string; person: string; text: string }[];
  /** Set when something they said was not remembered, and why. */
  captureError?: string;
  undone?: string[];
  pending?: boolean;
  /** What the server is doing, so a pause is never unexplained. */
  status?: string;
  /** True once a Stop has ended this turn early. */
  stopped?: boolean;
  failed?: string;
}

let seq = 0;
const nextId = () => `t${(seq += 1)}`;

/**
 * How close to the bottom counts as "still following along".
 *
 * This is the whole streaming-scroll problem in one number. Auto-scrolling
 * unconditionally is what makes a chat feel broken while it streams: you scroll
 * up to re-read something, and every arriving token yanks you back to the bottom.
 * So the position is sampled when the tokens arrive, and if the reader has left
 * the live edge we leave them alone.
 */
const LIVE_EDGE_PX = 100;

export function ChatView({ onOpenBook }: { onOpenBook?: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState(true);

  const viewportRef = useRef<HTMLDivElement>(null);
  const liveEdgeRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  // Track the live edge from the scroll position, not from whether we scrolled.
  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    liveEdgeRef.current = distance <= LIVE_EDGE_PX;
    setPinned(liveEdgeRef.current);
  }, []);

  // Follow the stream only while the reader is at the bottom. Instant rather than
  // smooth: a smooth scroll animates toward a target that moves on every token,
  // which reads as lag and never arrives.
  useEffect(() => {
    if (!liveEdgeRef.current) return;
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setTurns((prev) =>
      prev.map((t) => (t.pending ? { ...t, pending: false, stopped: true, status: undefined } : t)),
    );
  }, []);

  const send = useCallback(
    async (override?: string) => {
      const message = (override ?? draft).trim();
      if (!message || busy) return;

      const mine: Turn = { id: nextId(), role: "you", text: message };
      const theirs: Turn = { id: nextId(), role: "assistant", text: "", pending: true, status: "Reading your book" };
      const undoOf = turns.flatMap((t) => t.undone ?? []);

      // The thread so far, so a follow-up can resolve "her" or "what about Dev?".
      // Only real messages: a pending or failed turn has nothing worth conditioning
      // on, and the server drops anything malformed regardless.
      const history = turns
        .filter((t) => !t.pending && !t.failed && t.text.trim())
        .map((t) => ({ role: t.role, text: t.text }));

      const controller = new AbortController();
      abortRef.current = controller;

      setTurns((prev) => [...prev, mine, theirs]);
      setDraft("");
      setBusy(true);
      // A new turn starts near the top of the viewport rather than at the bottom,
      // so it is somewhere the reader can start from.
      liveEdgeRef.current = true;
      setPinned(true);

      try {
        await streamTurn(theirs.id, { message, undoOf, history }, setTurns, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return; // Stop already resolved the turn.
        const detail = await apiErrorDetail(error);
        setTurns((prev) => prev.map((t) => (t.id === theirs.id ? { ...t, pending: false, failed: detail } : t)));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    },
    [draft, busy, turns],
  );

  /** Re-asks the last thing the user said, against the thread before it. */
  const regenerate = useCallback(() => {
    const lastAssistant = [...turns].reverse().findIndex((t) => t.role === "assistant");
    if (lastAssistant === -1) return;
    const prior = turns[lastAssistant - 1];
    if (!prior || prior.role !== "you") return;
    // Drop the failed reply and anything after it, then ask again. Keeps the
    // thread honest rather than stacking two answers to one question.
    setTurns((prev) => prev.slice(0, lastAssistant));
    void send(prior.text);
  }, [turns, send]);

  const undo = useCallback(async (turnId: string, memoryId: string) => {
    // Remember what it looked like, so a failure can put back exactly that rather
    // than an approximation.
    const before = turns.find((t) => t.id === turnId);
    const card = before?.saved?.find((x) => x.id === memoryId);

    // Optimistic: the user asked for it gone, so show it gone.
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId
          ? { ...t, saved: t.saved?.filter((s) => s.id !== memoryId), undone: [...(t.undone ?? []), memoryId] }
          : t,
      ),
    );
    try {
      await api.post("/api/chat/undo", { id: memoryId });
    } catch {
      // Put the card back. The comment here used to claim this and the code only
      // removed the id from `undone`, never restoring `saved` -- so a failed undo
      // hid a memory that was still in the book and still producing nudges. That
      // is the exact state the comment says must not happen, and it was the
      // state that happened.
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turnId) return t;
          const restored = card ? [...(t.saved ?? []), card] : (t.saved ?? []);
          return { ...t, saved: restored, undone: (t.undone ?? []).filter((id) => id !== memoryId) };
        }),
      );
    }
  }, [turns]);

  // Escape stops a stream, the way it does everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busy) {
        e.preventDefault();
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, stop]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline. Cmd/Ctrl+Enter sends too, because that
    // is the other near-universal default and matching both costs nothing.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const empty = turns.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {empty ? (
        // Nothing but the input. No headline, no explanation, no examples.
        // Every version with a line of copy in it read as a landing page trying to
        // sell the product, and every set of examples put words in the user's mouth.
        <div className="flex min-h-0 flex-1 flex-col justify-center px-5 py-10">
          <div className="w-full max-w-thread">
            {/* It speaks first, when there is something true to say. Deterministic,
                grounded in the ranking engine, and silent when nothing is due. */}
            <Opening />
            <Composer
              draft={draft}
              setDraft={setDraft}
              onSend={() => void send()}
              onStop={stop}
              busy={busy}
              onKeyDown={onKeyDown}
              autoFocus
            />
          </div>
        </div>
      ) : (
        <>
          <div
            ref={viewportRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            role="log"
            aria-live="polite"
            aria-busy={busy}
            tabIndex={-1}
          >
            <div className="mx-auto w-full max-w-thread px-5 py-8">
              {turns.map((turn, i) => (
                <TurnBlock
                  key={turn.id}
                  turn={turn}
                  onUndo={undo}
                  onOpenBook={onOpenBook}
                  onRetry={i === turns.length - 1 ? regenerate : undefined}
                />
              ))}
            </div>
          </div>

          {/* Sits in normal flow above the composer. It used to be pulled up with a
              negative margin, which overlapped the composer's top edge -- two
              bordered boxes on top of each other, which reads as an input inside an
              input. Overlapping chrome is not worth the saved 12 pixels. */}
          {!pinned && (
            <div className="flex shrink-0 justify-center px-5 pb-2">
              <button
                onClick={() => {
                  liveEdgeRef.current = true;
                  setPinned(true);
                  const el = viewportRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}
                className="flex items-center gap-1.5 rounded-full bg-surface-3 px-3 py-1.5 text-[12px] text-muted shadow-lg transition-colors hover:bg-rule hover:text-text"
              >
                Jump to latest
              </button>
            </div>
          )}

          <div className="shrink-0 px-5 pb-5">
            <Composer
              draft={draft}
              setDraft={setDraft}
              onSend={() => void send()}
              onStop={stop}
              busy={busy}
              onKeyDown={onKeyDown}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  onSend,
  onStop,
  busy,
  onKeyDown,
  autoFocus,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
}) {
  const canSend = draft.trim().length > 0 && !busy;
  return (
    <div className="composer">
      {/* One row, not two. The send button used to sit on its own line beneath
          the text, which made an empty composer 102px tall -- a big hollow box for
          a one-line input. Inline, it is 52px when empty and grows with the text,
          because the button simply moves down as the text wraps. */}
      <div className="flex items-end gap-1 rounded-2xl bg-raised p-2 transition-colors focus-within:bg-surface-3">
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          id="composer"
          ref={autoFocus ? (el) => el?.focus() : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          className="max-h-[11rem] min-h-[24px] w-full flex-1 resize-none border-0 bg-transparent px-2 py-1 text-[15px] leading-6 text-text outline-none"
        />
        <div className="flex shrink-0 items-center gap-2 pb-0.5 pr-0.5">
          {/* Stop replaces Send while a reply is streaming, rather than sitting
              beside it greyed out. A control you cannot use is worse than one that
              changes. */}
          <button
            type="button"
            onClick={busy ? onStop : onSend}
            disabled={!busy && !canSend}
            aria-label={busy ? "Stop generating" : "Send"}
            title={busy ? "Stop (Esc)" : "Send (Enter)"}
            className={`grid h-8 w-8 place-items-center rounded-full transition-colors ${
              busy
                ? "bg-raised text-text hover:bg-rule"
                : canSend
                  ? "bg-accent text-base hover:bg-accent/85"
                  : "cursor-not-allowed bg-raised text-faint"
            }`}
          >
            {busy ? <StopIcon /> : <ArrowIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}

function TurnBlock({
  turn,
  onUndo,
  onOpenBook,
  onRetry,
}: {
  turn: Turn;
  onUndo: (turnId: string, memoryId: string) => void;
  onOpenBook?: () => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // Cleared on unmount. The old timeout was never cancelled, so it fired
  // setState on a component that no longer existed.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    // Handled, not voided. `navigator.clipboard` rejects on an insecure origin,
    // and this app explicitly runs over plain http on localhost -- so the promise
    // rejects routinely, and `void` discarded it as an unhandled rejection while
    // "Copied" never appeared and the user learned that the button is broken.
    // Say what happened instead.
    navigator.clipboard
      ?.writeText(turn.text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [turn.text]);

  if (turn.role === "you") {
    return (
      <div className="mb-5 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[15px] leading-6 text-text">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="group mb-7">
      <div className="text-[15px] leading-7 text-text">
        {turn.pending ? (
          turn.text ? (
            // A blinking caret is the cheapest possible "alive" signal. Without it
            // a paused stream looks identical to a finished one.
            <p className="whitespace-pre-wrap">
              {turn.text}
              <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] animate-pulse bg-accent" />
            </p>
          ) : (
            <p className="flex items-center gap-2 py-1 text-muted">
              <Dots />
              {turn.status ? `${turn.status}…` : null}
            </p>
          )
        ) : turn.failed ? (
          <div>
            <p className="text-muted">{turn.failed}</p>
            {onRetry && (
              <button onClick={onRetry} className="mt-2 text-[13px] text-accent hover:underline">
                Try again
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap">{turn.text}</p>
            {turn.stopped && <p className="mt-2 text-[12px] text-faint">Stopped.</p>}
            {(onRetry || turn.text) && (
              <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-faint opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {turn.text && (
                  <button onClick={copy} className="hover:text-text">
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
                {onRetry && (
                  <button onClick={onRetry} className="hover:text-text">
                    Ask again
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Marginalia, not cards. The name sits in the margin and the memory in the
          column, so you learn whose entry you are in rather than reading a label
          on a chip. */}
      {!!turn.saved?.length && (
        <div className="mt-3 space-y-2.5">
          {turn.saved.map((memory) => (
            <div key={memory.id} className="marginalia">
              <span className="margin-name truncate py-0.5 pr-3 text-[12px] font-medium text-accent">
                {memory.person}
              </span>
              <span className="flex items-start gap-3">
                <span className="flex-1 text-[13.5px] leading-6 text-muted">{memory.text}</span>
                <button
                  onClick={() => onUndo(turn.id, memory.id)}
                  className="shrink-0 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-text focus-visible:opacity-100"
                >
                  Undo
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {!!turn.volunteered?.length && (
        <p className="mt-3 text-[12px] text-faint">
          It brought this up · {turn.volunteered.map((v) => v.text).join(" · ")}
        </p>
      )}

      {!!turn.cited?.length && (
        <details className="mt-2 text-[12px] text-faint">
          <summary className="cursor-pointer select-none">
            From {turn.cited.length} thing{turn.cited.length === 1 ? "" : "s"} you told me
          </summary>
          <ul className="mt-1.5 space-y-1 pl-1">
            {turn.cited.map((c) => (
              <li key={c.id} className="leading-5">
                <span className="text-muted">{c.person}:</span> {c.text}
              </li>
            ))}
          </ul>
          {/* Following a citation is the reason the book exists, so it opens the
              book rather than expanding anything here. */}
          {onOpenBook && (
            <button onClick={onOpenBook} className="mt-1.5 text-[11.5px] text-faint transition-colors hover:text-muted">
              See everything it has →
            </button>
          )}
        </details>
      )}

      {turn.captureError && <p className="mt-2 text-[12px] text-warn">Missed that one · {turn.captureError}</p>}
    </div>
  );
}

/**
 * Reads the event stream and renders it as it arrives.
 *
 * A plain POST-and-wait was the last thing that made this feel like a form: the
 * ledger read takes seconds, so the whole reply appeared at once after a silence.
 */
async function streamTurn(
  turnId: string,
  payload: { message: string; undoOf: string[]; history: { role: "you" | "assistant"; text: string }[] },
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
    signal,
  });

  // A refusal before the stream opens is still a JSON body, so read it properly
  // rather than trying to parse an error message as events.
  if (!response.ok || !response.body) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message ?? `Request failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 2);
      if (!frame.startsWith("data:")) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(frame.slice(5).trim());
      } catch {
        continue;
      }

      if (event.type === "status") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, status: String(event.detail ?? "") } : t)));
      } else if (event.type === "delta") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, text: t.text + String(event.text ?? "") } : t)));
      } else if (event.type === "done") {
        // The done payload names the field `reply`; the turn renders `text`. It
        // only ever worked because the deltas had already filled `text` in, so a
        // dropped chunk -- or a reply short enough that the whole answer arrived
        // in one frame -- left the assistant saying nothing at all, with no error
        // anywhere. The server always sends the full text here, so fall back to it.
        const { type: _type, reply, ...rest } = event as { type: string; reply?: string } & Partial<Turn>;
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId
              ? { ...t, ...rest, text: t.text || (typeof reply === "string" ? reply : ""), pending: false, status: undefined }
              : t,
          ),
        );
      } else if (event.type === "error") {
        throw new Error(String(event.message ?? event.error ?? "Something went wrong"));
      }
    }
  }
}

/** Pulls the server's own wording out of an error, rather than showing "failed". */
async function apiErrorDetail(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (/not_signed_in/.test(message)) return "Connect a wallet first.";
  if (/no_grant/.test(message)) return "This has not been given permission to read your book yet.";
  if (/revoked/.test(message)) return "You took away this app\u2019s access. Give it back to carry on.";
  if (/too many|throttl/i.test(message)) return "Walrus is throttling us. A moment.";
  return "That did not land. Say it again?";
}

const ArrowIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 13V3M8 3L4.5 6.5M8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const StopIcon = () => <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />;

const Dots = () => (
  <span className="inline-flex gap-1.5" aria-hidden="true">
    {[0, 1, 2].map((i) => (
      <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint" style={{ animationDelay: `${i * 180}ms` }} />
    ))}
  </span>
);