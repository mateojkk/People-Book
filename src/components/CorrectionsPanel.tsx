/**
 * "What do I keep saying?"
 *
 * Shown in the book rather than only on request, because the whole point is that
 * a pattern is invisible from the inside: nobody can see that they have said the
 * same thing four times. Finding it has to be something the book does for you.
 *
 * Every line carries its own dates, because the evidence is the finding. A
 * conclusion you cannot check is a claim, and this product does not make claims.
 */
export function PatternsPanel() {
  const [patterns, setPatterns] = useState<Pattern[] | null>(null);

  useEffect(() => {
    void api
      .get<{ patterns: Pattern[] }>("/api/patterns")
      .then((r) => setPatterns(r.patterns))
      // A missing panel must never take the book down with it.
      .catch(() => setPatterns([]));
  }, []);

  if (!patterns?.length) return null;

  return (
    <div className="rounded-xl bg-panel p-4">
      <p className="text-xs font-bold text-text">What you keep saying</p>
      <p className="mt-1.5 text-[11px] leading-5 text-faint">
        Worked out from your book, not guessed. Each one is the same promise, more
        than once.
      </p>
      <ul className="mt-3 space-y-2.5">
        {patterns.slice(0, 5).map((p) => (
          <li key={`${p.person}:${p.claim}`} className="text-[12px] leading-6">
            <span className="text-text">{p.claim}</span>
            <span className="text-muted">
              {p.kind === "slipped"
                ? ` — said ${p.count} times, and the due date moved later each time.`
                : ` — said ${p.count} times, ${p.first === p.last ? `on ${p.first}` : `between ${p.first} and ${p.last}`}, still open.`}
            </span>
            <span className="ml-1 text-faint">
              {p.person === "you" ? "" : `(${p.person})`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The corrections the user has given, with the reasons.
 *
 * This exists because a stored correction nobody can see has changed nothing. The
 * whole point is that the instruction AND the reason are both legible, because
 * the reason is what makes the rule survive being reintroduced in a different
 * situation: "do not use Inter" is easy to violate six weeks later, "do not use
 * Inter, it is a wide face and the measure breaks" is recognisably the same
 * problem when it turns up again as a type that is too wide.
 *
 * The revision chain is one click away, because the chain is the actual claim
 * being made: nothing is overwritten. What it believed in March is still there and
 * is still retrievable, and this is where that is demonstrated rather than
 * asserted.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { ErrorNote } from "./bits.tsx";
import type { PersonMemory } from "../types.ts";
import type { Pattern } from "../types.ts";

interface CorrectionsResponse {
  corrections: PersonMemory[];
}
interface HistoryResponse {
  id: string;
  revisions: PersonMemory[];
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function CorrectionsPanel() {
  const [data, setData] = useState<CorrectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, PersonMemory[]>>({});

  const load = useCallback(async () => {
    try {
      setData(await api.get<CorrectionsResponse>("/api/corrections"));
      // Cleared on success, so one failure does not permanently replace the panel.
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your corrections.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only fetched when asked. A book with thirty corrections should not fire thirty
  // history requests on open, and most are never opened.
  const toggle = useCallback(async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    if (history[id]) return;
    try {
      const res = await api.get<HistoryResponse>(`/api/memories/${encodeURIComponent(id)}/history`);
      setHistory((h) => ({ ...h, [id]: res.revisions }));
      setError(null);
    } catch (e) {
      // Scoped to the panel, but the panel is replaced wholesale by ErrorNote, so
      // a single failed "what it changed" click destroyed the corrections list
      // until reload -- even though the list itself had loaded fine.
      setError(e instanceof Error ? e.message : "Could not load that history.");
    }
  }, [open, history]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  if (!data.corrections.length) {
    return (
      <div className="rounded-xl bg-panel p-4">
        <p className="text-xs font-bold text-text">What you have told it not to do</p>
        <p className="mt-2 text-[12px] leading-6 text-muted">
          Nothing yet. Correct it in conversation — “no, not like that”, “never do
          X”, “remember I said Y” — and it is kept here with your reason, and held
          to afterwards.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-panel p-4">
      <p className="text-xs font-bold text-text">
        What you have told it not to do · <span className="tabular">{data.corrections.length}</span>
      </p>
      <p className="mt-1.5 text-[11px] leading-5 text-faint">
        Held to in every conversation after this, including ones you have not had
        yet. Nothing here is overwritten — open one to see what it changed from.
      </p>

      <ul className="mt-3 space-y-2">
        {data.corrections.map((c) => {
          const chain = history[c.id];
          const isOpen = open === c.id;
          const changed = chain ? chain.length > 1 : false;
          return (
            <li key={c.id} className="rounded-lg bg-raised p-3">
              <p className="text-[12.5px] leading-6 text-text">{c.text}</p>
              {c.reason && (
                <p className="mt-1.5 text-[11.5px] leading-5 text-muted">
                  <span className="text-faint">Because</span> — {c.reason}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-[11px] text-faint">{shortDate(c.createdAt)}</span>
                <button
                  onClick={() => void toggle(c.id)}
                  aria-expanded={isOpen}
                  className="text-[11px] text-accent underline decoration-dotted underline-offset-2"
                >
                  {isOpen ? "hide what it changed" : "what it changed"}
                </button>
              </div>

              {isOpen && (
                <div className="mt-2 border-l border-rule pl-3">
                  {!chain && <p className="text-[11px] text-faint">Loading…</p>}
                  {chain && (
                    <ol className="space-y-2">
                      {chain.map((r) => (
                        <li key={`${r.id}:${r.rev}`}>
                          <p className="text-[11px] text-faint">
                            rev {r.rev} · {shortDate(r.updatedAt)}
                            {r.rev === chain[chain.length - 1]!.rev && " · now"}
                          </p>
                          <p className="text-[11.5px] leading-5 text-muted">{r.text}</p>
                          {r.reason && (
                            <p className="mt-0.5 text-[11px] leading-5 text-faint">Because — {r.reason}</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                  {chain && !changed && (
                    <p className="mt-1 text-[11px] text-faint">This has not changed since it was first said.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
