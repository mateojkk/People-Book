import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/** One line of the conversation. */
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
  failed?: string;
}

let seq = 0;
const nextId = () => `t${(seq += 1)}`;

export function ChatView() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const send = useCallback(async () => {
      const message = draft.trim();
      if (!message || busy) return;

      const mine: Turn = { id: nextId(), role: "you", text: message };
      const theirs: Turn = { id: nextId(), role: "assistant", text: "", pending: true };
      const undoOf = turns.flatMap((t) => t.undone ?? []);

      // The thread so far, so the next turn can resolve "her" or "what about
      // Dev?". Only real messages: a pending or failed turn has no text worth
      // conditioning on, and the server drops anything malformed regardless.
      const history = turns
        .filter((t) => !t.pending && !t.failed && t.text.trim())
        .map((t) => ({ role: t.role, text: t.text }));

      setTurns((prev) => [...prev, mine, theirs]);
      setDraft("");
      setBusy(true);

      try {
        const res = await api.post<Omit<Turn, "id" | "role">>("/api/chat", { message, undoOf, history });
        setTurns((prev) => prev.map((t) => (t.id === theirs.id ? { ...t, ...res, pending: false } : t)));
      } catch (error) {
        const detail = await apiErrorDetail(error);
        setTurns((prev) => prev.map((t) => (t.id === theirs.id ? { ...t, pending: false, failed: detail } : t)));
      } finally {
        setBusy(false);
      }
  }, [draft, busy, turns]);

  const undo = useCallback(async (turnId: string, memoryId: string) => {
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
      // Put it back. It is still in the book, and pretending otherwise would be a
      // lie the ledger does not agree with.
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, undone: (t.undone ?? []).filter((id) => id !== memoryId) } : t)),
      );
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="fade-edges min-h-0 flex-1 overflow-y-auto">
        <div className="thread px-5 py-10">
          {turns.length === 0 ? (
            <Opening />
          ) : (
            <div className="space-y-7">
              {turns.map((turn) => (
                <TurnBlock key={turn.id} turn={turn} onUndo={undo} />
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="shrink-0 px-5 pb-4">
        <div className="thread composer">
          <div className="rounded-2xl border border-line bg-ink p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] transition-colors focus-within:border-faint">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter is a newline, which is what people expect.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              aria-label="Message"
              placeholder="Tell it about the people in your life…"
              className="w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 text-bright outline-none placeholder:text-faint"
            />
            <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
              {/* Stands in for the model/mode selector this genre puts on the left.
                  It is a real disclosure, not decoration: it says out loud that
                  nothing is written until you undo it. */}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] text-quiet">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                {busy ? "Remembering…" : "Auto-saves"}
              </span>
              <button
                onClick={() => void send()}
                disabled={busy || !draft.trim()}
                aria-label="Send"
                className="grid h-8 w-8 place-items-center rounded-full bg-bright text-ink transition-opacity disabled:opacity-25"
              >
                <Arrow />
              </button>
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-faint">
            Enter to send · Shift+Enter for a new line · anything it saves can be undone
          </p>
        </div>
      </div>
    </div>
  );
}

function TurnBlock({ turn, onUndo }: { turn: Turn; onUndo: (turnId: string, memoryId: string) => void }) {
  if (turn.role === "you") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[15px] leading-6 text-bright">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="attention space-y-3">
      <div className="max-w-[46rem] text-[15px] leading-7 text-bright">
        {turn.pending ? (
          <Typing />
        ) : turn.failed ? (
          <p className="text-quiet">{turn.failed}</p>
        ) : (
          <p className="whitespace-pre-wrap">{turn.text}</p>
        )}
      </div>

      {!!turn.saved?.length && (
        <div className="space-y-1.5">
          {turn.saved.map((memory) => (
            <div
              key={memory.id}
              className="group flex items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5"
            >
              <span className="mt-0.5 w-16 shrink-0 truncate text-[11px] font-medium text-quiet">
                {memory.person}
              </span>
              <span className="flex-1 text-[13.5px] leading-5 text-quiet">{memory.text}</span>
              <button
                onClick={() => onUndo(turn.id, memory.id)}
                className="shrink-0 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-bright focus-visible:opacity-100"
              >
                Undo
              </button>
            </div>
          ))}
        </div>
      )}

      {!!turn.volunteered?.length && (
        <p className="text-[11.5px] text-faint">
          Raised on its own · {turn.volunteered.map((v) => v.text).join(" · ")}
        </p>
      )}

      {!!turn.cited?.length && (
        <details className="text-[11.5px] text-faint">
          <summary className="cursor-pointer select-none">
            Based on {turn.cited.length} memor{turn.cited.length === 1 ? "y" : "ies"}
          </summary>
          <ul className="mt-1.5 space-y-1 border-l border-line pl-3">
            {turn.cited.map((c) => (
              <li key={c.id} className="leading-5">
                <span className="text-quiet">{c.person}:</span> {c.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      {turn.captureError && <p className="text-[11.5px] text-warn">Not remembered · {turn.captureError}</p>}
    </div>
  );
}

function Opening() {
  return (
    <div className="pt-6">
      {/* Centred mark, the way this genre opens an empty thread: the interface is
          saying "ask me something" before you have typed a character. */}
      <div className="flex flex-col items-center text-center">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent text-[19px] font-bold text-ink">
          P
        </span>
        <h1 className="mt-4 text-[22px] font-semibold tracking-tight">What do you want to remember?</h1>
        <p className="mt-2 max-w-md text-[14px] leading-6 text-quiet">
          Dates, promises, how someone takes a call, who has not been in touch. Say it the way you
          would to a friend.
        </p>
      </div>

    </div>
  );
}

function Typing() {
  return (
    <span className="inline-flex gap-1.5 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint"
          style={{ animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  );
}

function Arrow() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Pulls the server's own wording out of an error, rather than showing "failed". */
async function apiErrorDetail(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (/not_signed_in/.test(message)) return "Connect your wallet to talk to it.";
  if (/no_grant/.test(message)) return "Grant People Book access to your Walrus Memory account first.";
  if (/revoked/.test(message)) return "Access to this account was revoked on chain. Re-grant it to continue.";
  if (/too many|throttl/i.test(message)) return "Walrus Memory is rate-limiting us. Give it a moment.";
  return "That did not go through. Try again in a moment.";
}