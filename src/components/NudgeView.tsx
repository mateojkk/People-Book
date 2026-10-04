/**
 * The main view: what came to you.
 *
 * Three things are on this screen and they are the three claims the product
 * makes, each made checkable rather than asserted:
 *
 *   - the nudges, each traceable to the memory it came from
 *   - the elision notice, naming the rule and the date it was set
 *   - the A/B toggle, which is the before/after in one control
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { BasisNote, ElisionNotice, Empty, ErrorNote, KindTag, SourceTrace } from "./bits.js";
import type { LedgerEntry, NudgeSet, PersonMemory } from "../types.js";

interface NudgeResponse extends NudgeSet {
  elisionNotices: string[];
}

interface MemoriesResponse {
  memories: PersonMemory[];
  coverage: "complete" | "partial";
  blobCount: number | null;
  truncated: boolean;
}

export function NudgeView({ onForget }: { onForget: (id: string) => void }) {
  const [memoryOn, setMemoryOn] = useState(true);
  const [data, setData] = useState<NudgeResponse | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [blobCount, setBlobCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nudgeData = await api.get<NudgeResponse>(`/api/nudges${memoryOn ? "" : "?memory=off"}`);
      setData(nudgeData);

      // The ledger is fetched regardless of the toggle: with memory off the
      // nudges are empty, but the book is still there and still visible. Hiding
      // it would make the toggle look like it deleted the user's data.
      const mem = await api.get<MemoriesResponse>("/api/memories");
      setLedger(mem.memories.map((m) => ({ memory: m })));
      setBlobCount(mem.blobCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    } finally {
      setLoading(false);
    }
  }, [memoryOn]);

  useEffect(() => {
    void load();
  }, [load]);

  const byId = useMemo(() => {
    const map = new Map<string, PersonMemory>();
    for (const entry of ledger) map.set(entry.memory.id, entry.memory);
    return map;
  }, [ledger]);

  const dismiss = async (id: string) => {
    try {
      await api.post("/api/nudges/dismiss", { id });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not dismiss.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted">What came to you</h2>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={memoryOn}
            onChange={(e) => setMemoryOn(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-300"
          />
          <span>
            memory <span className="tabular font-medium text-text">{memoryOn ? "on" : "off"}</span>
          </span>
        </label>
      </div>

      {error && <ErrorNote message={error} />}

      {loading ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-panel" />
          ))}
        </div>
      ) : !data || data.nudges.length === 0 ? (
        <Empty>
          {data?.basis.memoryDisabled
            ? "Nothing. With memory off there is no recall, so there is nothing to bring you — the same question asked of a chatbot that has never heard of you."
            : "Nothing is due. No dates coming up, no open promises, nobody gone quiet."}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {data.nudges.map((nudge) => (
            <li key={nudge.id} className="rounded bg-panel p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm leading-snug text-text">{nudge.text}</p>
                <KindTag kind={nudge.kind} />
              </div>
              <SourceTrace memory={byId.get(nudge.sourceMemoryId)} onForget={onForget} />
              <button
                onClick={() => void dismiss(nudge.id)}
                className="mt-2 text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text"
              >
                not now
              </button>
            </li>
          ))}
        </ul>
      )}

      {data && data.elisionNotices.length > 0 && (
        <div className="space-y-1.5">
          {data.elisions.map((e) => (
            <ElisionNotice key={e.person + e.sourceMemoryId} person={e.person} since={e.since} />
          ))}
        </div>
      )}

      {data && (
        <div className="pt-3">
          <BasisNote basis={data.basis} computedAt={data.computedAt} />
          {blobCount !== null && (
            <p className="mt-1 text-[11px] text-muted">
              <span className="tabular">{blobCount}</span> blob{blobCount === 1 ? "" : "s"} written to
              your Walrus Memory account.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
