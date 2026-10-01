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
  /** What the server is doing right now, so a pause is never unexplained. */
  status?: string;
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

  const send = useCallback(
    async (textOverride?: string) => {
      const message = (typeof textOverride === "string" ? textOverride : draft).trim();
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
        await streamTurn(theirs.id, { message, undoOf, history }, setTurns);
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
      {turns.length === 0 ? (
        // Nothing but the input. No headline, no explanation, no examples.
        //
        // Every version of this that got a line of copy in it read as a landing
        // page trying to sell the product, and every set of examples was the app
        // putting words in the user's mouth. The user knows what they came here to
        // type. So the empty state is the box, centred, and nothing else.
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10">
          <div className="w-full max-w-[45rem]">
            <ComposerBox
              draft={draft}
              setDraft={setDraft}
              onSend={() => void send()}
              busy={busy}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="fade-edges min-h-0 flex-1 overflow-y-auto">
            <div className="thread px-5 py-10">
              <div className="space-y-7">
                {turns.map((turn) => (
                  <TurnBlock key={turn.id} turn={turn} onUndo={undo} />
                ))}
              </div>
              <div ref={endRef} />
            </div>
          </div>

          <div className="shrink-0 px-5 pb-4">
            <div className="thread">
              <ComposerBox
                draft={draft}
                setDraft={setDraft}
                onSend={() => void send()}
                busy={busy}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Sends a turn and renders it as it arrives.
 *
 * A plain POST-and-wait was the last thing that made this feel like a form: the
 * ledger read can take seconds, so the whole reply appeared at once after a
 * silence. Reading the event stream means the wait is explained and then the words
 * show up at reading speed.
 */
async function streamTurn(
  turnId: string,
  payload: { message: string; undoOf: string[]; history: { role: "you" | "assistant"; text: string }[] },
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
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
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, status: String(event.detail ?? "") } : t)),
        );
      } else if (event.type === "delta") {
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, text: t.text + String(event.text ?? "") } : t)),
        );
      } else if (event.type === "done") {
        const { type: _type, ...rest } = event as { type: string } & Partial<Turn>;
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, ...rest, pending: false } : t)));
      } else if (event.type === "error") {
        throw new Error(String(event.message ?? event.error ?? "Something went wrong"));
      }
    }
  }
}

function TurnBlock({ turn, onUndo }: { turn: Turn; onUndo: (turnId: string, memoryId: string) => void }) {
  if (turn.role === "you") {
    return (
      // Right-aligned and quiet. Your own words are context for the reply, not the
      // thing being looked at, so they sit back.
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-panel px-4 py-2.5 text-[15px] leading-6 text-muted">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="attention space-y-3">
      <div className="max-w-[46rem] text-[15px] leading-7 text-text">
        {turn.pending ? (
          turn.text ? (
            // Words are arriving: show them, with a caret, and no spinner competing.
            <p className="whitespace-pre-wrap">
              {turn.text}
              <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] animate-pulse bg-faint" />
            </p>
          ) : (
            <Typing label={turn.status} />
          )
        ) : turn.failed ? (
          <p className="text-muted">{turn.failed}</p>
        ) : (
          <p className="whitespace-pre-wrap">{turn.text}</p>
        )}
      </div>

      {!!turn.saved?.length && (
        // Marginalia, not cards. The name sits in the margin and the memory sits
        // in the column, which is how a book of people actually reads: you learn
        // whose entry you are in from the margin, not from a label on a chip.
        <div className="space-y-2 border-l border-rule-soft pl-3">
          {turn.saved.map((memory) => (
            <div key={memory.id} className="marginalia group">
              <span className="margin-name truncate pt-0.5 text-[12px] font-medium text-accent">
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
        <p className="text-[11.5px] text-faint">
          It brought this up · {turn.volunteered.map((v) => v.text).join(" · ")}
        </p>
      )}

      {!!turn.cited?.length && (
        <details className="text-[11.5px] text-faint">
          <summary className="cursor-pointer select-none">
            From {turn.cited.length} thing{turn.cited.length === 1 ? "" : "s"} you told me
          </summary>
          <ul className="mt-1.5 space-y-1 border-l border-rule pl-3">
            {turn.cited.map((c) => (
              <li key={c.id} className="leading-5">
                <span className="text-muted">{c.person}:</span> {c.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      {turn.captureError && <p className="text-[11.5px] text-warn">Missed that one · {turn.captureError}</p>}
    </div>
  );
}

function Typing({ label }: { label?: string }) {
  return (
    <span className="flex items-center gap-2 py-1.5">
      <span className="inline-flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint"
            style={{ animationDelay: `${i * 180}ms` }}
          />
        ))}
      </span>
      {label && <span className="text-[13px] text-faint">{label}…</span>}
    </span>
  );
}

function ComposerBox({
  draft,
  setDraft,
  onSend,
  busy,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  const [isRecording, setIsRecording] = useState(false);

  const toggleRecording = () => {
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition ||
      (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }).webkitSpeechRecognition;

    if (!SpeechRec) {
      alert("Voice recognition is not supported in this browser.");
      return;
    }

    try {
      const recognition = new SpeechRec();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";

      recognition.onstart = () => setIsRecording(true);
      recognition.onend = () => setIsRecording(false);
      recognition.onerror = () => setIsRecording(false);
      recognition.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) {
          setDraft(draft ? `${draft} ${transcript}` : transcript);
        }
      };

      recognition.start();
    } catch {
      setIsRecording(false);
    }
  };

  return (
    <div className="composer relative">
      <div className="rounded-2xl border border-rule bg-panel p-2 shadow-lg transition-colors focus-within:border-rule-soft">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          aria-label="Message"
                    className="w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 text-text outline-none placeholder:text-faint"
        />

        <div className="mt-1 flex items-center justify-end gap-2 px-1 pb-1">
          <div className="flex items-center gap-2">
            {/* Voice input */}
            <button
              type="button"
              onClick={toggleRecording}
              className={`grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-raised hover:text-text ${
                isRecording ? "animate-pulse bg-stop/20 text-stop" : ""
              }`}
              title="Voice input"
            >
              <MicIcon className="h-3.5 w-3.5" />
            </button>

            {/* Send */}
            <button
              type="button"
              onClick={onSend}
              disabled={busy || !draft.trim()}
              aria-label={busy ? "Working" : "Send"}
              className={`grid h-8 w-8 place-items-center rounded-full transition-all ${
                draft.trim()
                  ? "bg-text text-base shadow-md"
                  : "bg-raised text-muted opacity-50"
              }`}
            >
              {draft.trim() ? <ArrowUpIcon className="h-4 w-4" /> : <WaveformIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}





function MicIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="5.5" y="2" width="5" height="8" rx="2.5" strokeWidth="1.4" />
      <path d="M3.5 7a4.5 4.5 0 0 0 9 0M8 12.5v2.5M5.5 15h5" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function WaveformIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <path
        d="M2.5 8h1M5 5v6M7.5 3v10M10 6v4M12.5 7v2M14.5 8h.5"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArrowUpIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <path d="M8 13V3M8 3L4 7M8 3l4 4" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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