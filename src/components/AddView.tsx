/**
 * Adding to the book.
 *
 * The flow is: say something → the model proposes what is worth keeping → you
 * confirm each one. Nothing is written on the model's say-so alone, which is the
 * only reason a wrong extraction costs you a card you can delete rather than a
 * false claim about your sister.
 */

import { useState } from "react";
import { api } from "../lib/api.ts";
import { ErrorNote } from "./bits.tsx";
import type { CaptureResult, MemoryCandidate } from "../types.ts";

export function AddView({ onSaved }: { onSaved: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  async function extract() {
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setSaved(new Set());
    try {
      setResult(await api.post<CaptureResult>("/api/capture", { message }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(candidate: MemoryCandidate) {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/memories", {
        person: candidate.person,
        type: candidate.type,
        text: candidate.text,
        occurredAt: candidate.occurredAt,
        dueAt: candidate.dueAt,
      });
      setSaved((prev) => new Set(prev).add(candidate.text));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-muted">Add something</h2>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        placeholder="Tell it something. “I said I'd send Maya the photos, she's going on a trip on the 12th” — it will propose what is worth keeping, and you decide."
        className="w-full resize-y rounded border border-rule bg-paper p-2.5 text-sm text-ink outline-none placeholder:text-muted/60 focus:border-spine/50"
      />

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void extract()}
          disabled={busy || !message.trim()}
          className="rounded bg-spine px-3 py-1.5 text-xs font-medium text-paper disabled:opacity-40"
        >
          {busy ? "reading…" : "What is worth keeping?"}
        </button>
        <button
          onClick={() => {
            setMessage("");
            setResult(null);
            setError(null);
          }}
          className="rounded border border-rule px-3 py-1.5 text-xs text-muted hover:text-ink"
        >
          clear
        </button>
      </div>

      {error && <ErrorNote message={error} />}

      {result?.error && <ErrorNote message={result.error} />}

      {result && result.candidates.length === 0 && !result.error && (
        <p className="rounded border border-rule bg-paper px-3 py-3 text-xs text-muted">
          Nothing worth keeping in that. Silence is a correct and common answer — the alternative is
          storing things you did not mean to store.
        </p>
      )}

      {result && result.candidates.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted">
            Extracted. None of this is stored yet — confirm the ones you want.
          </p>
          {result.candidates.map((c) => {
            const isSaved = saved.has(c.text);
            return (
              <div key={c.text} className="rounded border border-rule bg-paper p-2.5">
                <p className="text-xs leading-snug text-ink">{c.text}</p>
                <p className="mt-1 text-[11px] text-muted">
                  <span className="text-ink/70">{c.person}</span> · {c.type}
                  {c.dueAt && <> · due {c.dueAt}</>} ·{" "}
                  <span className="tabular">{(c.confidence * 100).toFixed(0)}%</span> confident
                </p>
                {c.reasoning && <p className="mt-1 text-[11px] italic text-muted">{c.reasoning}</p>}
                <button
                  onClick={() => void confirm(c)}
                  disabled={isSaved || busy}
                  className="mt-1.5 rounded border border-spine/40 px-2 py-1 text-[11px] text-spine disabled:opacity-50"
                >
                  {isSaved ? "kept" : "keep this"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
