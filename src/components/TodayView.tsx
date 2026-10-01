import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * What to do today.
 *
 * Replaces a list of observations. A nudge is true and does not help anybody;
 * this is a list you can act on and, crucially, finish. The Done button is the
 * point of the screen -- without it the app can tell you what you owe and leave
 * you to fix that yourself somewhere else.
 *
 * Nothing here is stored. The list is assembled from the ledger, so it cannot
 * disagree with the book.
 */

export interface Task {
  memoryId: string;
  person: string;
  text: string;
  dueAt?: string;
  urgency: "overdue" | "today" | "soon" | "later";
  urgencyScore: number;
  daysLate: number;
  active: boolean;
  dueLabel: string;
}

interface Today {
  tasks: Task[];
  /** Only what needs doing today -- the number a badge should show. */
  dueCount: number;
  staleCount: number;
  coverage: "complete" | "partial";
}

export function TodayView({ onForget }: { onForget: (id: string) => void }) {
  const [data, setData] = useState<Today | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Today>("/api/today"));
      setFailed(null);
    } catch (error) {
      setFailed(await detail(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const settle = useCallback(
    async (id: string, action: "settle" | "reopen") => {
      const before = data;
      // Optimistic: the row should leave the list the moment you say it is done.
      setBusyId(id);
      setData(
        before && {
          ...before,
          tasks: before.tasks.map((t) =>
            t.memoryId === id ? { ...t, active: action === "reopen" } : t,
          ),
        },
      );
      try {
        await api.post(`/api/tasks/${id}/${action}`);
        await load();
      } catch (error) {
        setData(before);
        setFailed(await detail(error));
      } finally {
        setBusyId(null);
      }
    },
    [data, load],
  );

  if (failed && !data) return <Note text={failed} />;
  if (!data) return <Note text="Reading your book…" />;

  const active = data.tasks.filter((t) => t.active);
  const stale = data.tasks.filter((t) => !t.active);

  return (
    <div className="space-y-7 pb-10">
      <header>
        {/* Reached from the notification, not from the rail. The conversation is
            where you live; this is the receipt behind it. */}
        <button
          onClick={() => window.history.back()}
          className="mb-3 text-[11.5px] text-faint transition-colors hover:text-muted"
        >
          ← Back to talking
        </button>
        <h1 className="text-lg font-bold tracking-tight text-text">Today</h1>
        <p className="mt-1.5 text-[13px] leading-6 text-muted">
          {active.length === 0
            ? "Nothing outstanding."
            : `${active.length} thing${active.length === 1 ? "" : "s"} you have not dealt with.`}
        </p>
        {data.coverage === "partial" && (
          <p className="mt-1 text-[12px] text-warn">
            Walrus Memory is slow right now, so this may be incomplete.
          </p>
        )}
      </header>

      {failed && <Note text={failed} />}

      {active.length === 0 ? (
        <Empty />
      ) : (
        <ul className="space-y-2">
          {active.map((task) => (
            <Row key={task.memoryId} task={task} busy={busyId === task.memoryId} onSettle={settle} />
          ))}
        </ul>
      )}

      {stale.length > 0 && (
        <section>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-faint">
            Gone cold · {stale.length}
          </h2>
          <p className="mt-1.5 text-[12px] leading-5 text-faint">
            Still in your book, no longer asking for anything. Clearing one writes a
            revision — it does not delete anything.
          </p>
          <ul className="mt-3 space-y-2">
            {stale.map((task) => (
              <Row key={task.memoryId} task={task} stale busy={busyId === task.memoryId} onSettle={settle} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({
  task,
  stale,
  busy,
  onSettle,
}: {
  task: Task;
  stale?: boolean;
  busy: boolean;
  onSettle: (id: string, action: "settle" | "reopen") => void;
}) {
  const tone =
    task.urgency === "overdue"
      ? "text-stop"
      : task.urgency === "today"
        ? "text-warn"
        : "text-faint";

  return (
    <li
      className={`flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border px-4 py-3 transition-colors ${
        stale ? "border-rule-soft bg-transparent opacity-60" : "border-rule bg-panel hover:border-rule-soft"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[12px] font-bold text-accent">{task.person}</span>
          <span className={`text-[11.5px] ${tone}`}>{task.dueLabel}</span>
        </div>
        <p className="mt-1 text-[13.5px] leading-6 text-text">{task.text}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => onSettle(task.memoryId, stale ? "reopen" : "settle")}
          disabled={busy}
          className="rounded border border-rule px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-text disabled:opacity-40"
        >
          {busy ? "…" : stale ? "Bring back" : "Done"}
        </button>
      </div>
    </li>
  );
}


function Empty() {
  return (
    <div className="rounded-lg border border-rule-soft px-5 py-8 text-center">
      <p className="text-[13.5px] leading-6 text-muted">
        Nothing is outstanding. Tell it about a promise and it will show up here with a
        date on it.
      </p>
    </div>
  );
}

function Note({ text }: { text: string }) {
  return <p className="text-[13px] leading-6 text-muted">{text}</p>;
}

async function detail(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (/no_grant/.test(message)) return "This has not been given permission to read your book yet.";
  if (/revoked/.test(message)) return "You took away this app\u2019s access. Give it back to carry on.";
  if (/not_signed_in/.test(message)) return "Connect a wallet first.";
  return "That did not load. Try again in a moment.";
}