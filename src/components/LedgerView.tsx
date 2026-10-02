/**
 * The ledger, the people, and the add-a-memory box.
 *
 * The ledger is the audit surface. It shows every memory including the unconfirmed
 * ones, because the promise of "it cites, it never claims" is only meaningful if
 * you can see what the model guessed at and confirm or delete it.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { Empty, ErrorNote } from "./bits.tsx";
import type { PersonMemory } from "../types.ts";

interface MemoriesResponse {
  memories: PersonMemory[];
  coverage: "complete" | "partial";
  blobCount: number | null;
  truncated: boolean;
}

const CONFIDENCE_STYLE: Record<string, string> = {
  confirmed: "bg-accent/10 text-accent",
  inferred: "bg-warn/10 text-warn",
};

export function LedgerView({ onForget }: { onForget: (id: string) => void }) {
  const [data, setData] = useState<MemoriesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInferred, setShowInferred] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<MemoriesResponse>("/api/memories"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the book.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="text-sm text-muted">Loading your book…</p>;

  const shown = showInferred ? data.memories : data.memories.filter((m) => m.confidence === "confirmed");
  const inferredCount = data.memories.filter((m) => m.confidence === "inferred").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted">
          Your book · <span className="tabular">{data.memories.length}</span>
        </h2>
        {inferredCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={showInferred}
              onChange={(e) => setShowInferred(e.target.checked)}
              className="h-3.5 w-3.5 accent-amber-300"
            />
            show {inferredCount} unconfirmed
          </label>
        )}
      </div>

      {/*
        Coverage is reported, never hidden. Walrus Memory is a vector store with
        no enumeration call, so the ledger is assembled by fanning out queries and
        unioning the hits. When the relayer's own blob count is higher than the
        list, this is a partial view — and saying so is the only honest option.
      */}
      {data.truncated && (
        <p className="rounded bg-warn/10 px-2.5 py-2 text-[11px] text-warn">
          Partial view. Walrus Memory searches by meaning rather than listing, so this is assembled
          from a fan-out of queries. The account holds{" "}
          <span className="tabular">{data.blobCount}</span> blobs and {data.memories.length} are shown
          here.
        </p>
      )}

      {shown.length === 0 ? (
        <Empty>Your book is empty.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((m) => (
            <li key={m.id} className="rounded bg-panel px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs leading-snug text-text">{m.text}</p>
                <span
                  className={`mono shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${CONFIDENCE_STYLE[m.confidence]}`}
                >
                  {m.confidence}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                <span className="text-text/70">{m.person}</span> · {m.type}
                {m.status !== "active" && <> · {m.status}</>}
                {m.dueAt && <> · due {m.dueAt}</>}
                {m.occurredAt && <> · {m.occurredAt}</>}
              </p>
              {m.verbatim && (
                <p className="mt-1 text-[11px] italic text-muted">“{m.verbatim}”</p>
              )}
              <div className="mt-1.5 flex gap-3">
                {m.type === "promise" && m.status === "open" && (
                  <button
                    onClick={async () => {
                      await api.post(`/api/memories/${m.id}/resolve`, { status: "kept" });
                      await load();
                    }}
                    className="text-[11px] text-accent underline decoration-dotted underline-offset-2"
                  >
                    I did it
                  </button>
                )}
                <button
                  onClick={() => onForget(m.id)}
                  className="text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-stop"
                >
                  forget
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
