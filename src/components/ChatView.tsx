import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/** One line of the conversation. */
interface Turn {
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

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;

    const mine: Turn = { id: nextId(), role: "you", text: message };
    const theirs: Turn = { id: nextId(), role: "assistant", text: "", pending: true };
    setTurns((prev) => [...prev, mine, theirs]);
    setDraft("");
    setBusy(true);

    try {
      // Ids undone earlier in this conversation, so repeating yourself does not
      // silently undo your own undo.
      const undoOf = turns.flatMap((t) => t.undone ?? []);
      const res = await api.post<Omit<Turn, "id" | "role">>("/api/chat", { message, undoOf });
      setTurns((prev) => prev.map((t) => (t.id === theirs.id ? { ...t, ...res, pending: false } : t)));
    } catch (error) {
      const detail = await apiErrorDetail(error);
      setTurns((prev) =>
        prev.map((t) => (t.id === theirs.id ? { ...t, pending: false, failed: detail } : t)),
      );
    } finally {
      setBusy(false);
    }
  }, [draft, busy, turns]);

  const undo = useCallback(async (turnId: string, memoryId: string) => {
    // Optimistic: the user asked for it to be gone, so show it gone.
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId
          ? { ...t, saved: t.saved?.filter((s) => s.id !== memoryId), undone: [...(t.undone ?? []), memoryId] }
          : t,
      ),
    );
    try {
      await api.post("/api/chat/undo", { id: memoryId });
    } catch (error) {
      // Put it back, because it is still in the book and pretending otherwise
      // would be a lie the ledger does not agree with.
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId ? { ...t, undone: (t.undone ?? []).filter((id) => id !== memoryId) } : t,
        ),
      );
    }
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a newline, which is what people expect.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-2xl">
          {turns.length === 0 && <Opening />}

          <div className="space-y-5">
            {turns.map((turn) => (
              <TurnBlock key={turn.id} turn={turn} onUndo={undo} />
            ))}
          </div>
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-stone-200 bg-white px-4 py-3">
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Tell it something about the people in your life…"
              className="flex-1 resize-none rounded-xl border border-stone-300 px-4 py-3 text-[15px] leading-6 outline-none focus:border-stone-500"
            />
            <button
              onClick={() => void send()}
              disabled={busy || !draft.trim()}
              className="rounded-xl bg-stone-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-stone-400">
            Whatever you say is remembered. Anything it files can be undone.
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
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-stone-900 px-4 py-2.5 text-[15px] leading-6 text-white">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="max-w-[92%] text-[15px] leading-7 text-stone-800">
        {turn.pending ? (
          <Typing />
        ) : turn.failed ? (
          <p className="text-stone-500">
            {turn.failed}
          </p>
        ) : (
          <p className="whitespace-pre-wrap">{turn.text}</p>
        )}
      </div>

      {!!turn.saved?.length && (
        <div className="space-y-1.5">
          {turn.saved.map((memory) => (
            <div
              key={memory.id}
              className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2"
            >
              <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                {memory.person}
              </span>
              <span className="flex-1 text-[13px] leading-5 text-stone-700">{memory.text}</span>
              <button
                onClick={() => onUndo(turn.id, memory.id)}
                className="shrink-0 text-[11px] text-stone-400 underline-offset-2 hover:text-stone-700 hover:underline"
              >
                Undo
              </button>
            </div>
          ))}
        </div>
      )}

      {!!turn.volunteered?.length && (
        <p className="text-[11px] text-stone-400">
          Raised on its own: {turn.volunteered.map((v) => v.text).join(" · ")}
        </p>
      )}

      {!!turn.cited?.length && (
        <details className="text-[11px] text-stone-400">
          <summary className="cursor-pointer">Based on {turn.cited.length} memor{turn.cited.length === 1 ? "y" : "ies"}</summary>
          <ul className="mt-1 space-y-0.5 border-l border-stone-200 pl-3">
            {turn.cited.map((c) => (
              <li key={c.id} className="leading-5">
                <span className="text-stone-500">{c.person}:</span> {c.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      {turn.captureError && (
        <p className="text-[11px] text-amber-700">Not remembered: {turn.captureError}</p>
      )}
    </div>
  );
}

function Typing() {
  return (
    <span className="inline-flex gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-stone-400"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

function Opening() {
  return (
    <div className="mx-auto max-w-2xl py-10">
      <h2 className="text-lg font-medium text-stone-900">Tell it about the people in your life.</h2>
      <p className="mt-2 text-[14px] leading-6 text-stone-500">
        Dates, promises, how someone takes a phone call, who has not been in touch. Say it the way you
        would say it to a friend. It files what matters, cites where it got things, and brings up
        what you would otherwise forget — and you can undo anything it keeps.
      </p>
    </div>
  );
}

/** Pulls the server's own wording out of an error, rather than showing "failed". */
async function apiErrorDetail(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (/not_signed_in/.test(message)) return "Connect your wallet to talk to it.";
  if (/no_grant/.test(message)) return "Grant People Book access to your Walrus Memory account first.";
  if (/revoked/.test(message)) return "Access to this account was revoked on chain. Re-grant it to continue.";
  return "That did not go through. Try again in a moment.";
}