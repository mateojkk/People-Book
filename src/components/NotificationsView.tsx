import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { markSeen } from "../lib/unread";

/**
 * Notifications.
 *
 * What it has said to you, and what you can do about it. Three parts, in the order
 * they matter: what it is telling you now, everything it has said this week, and
 * everything still outstanding with a Done button on it.
 *
 * The Done button is the point of the lower part. Without it the app can tell you
 * what you owe and leave you to fix that yourself somewhere else.
 *
 * Nothing here is stored. All of it is assembled from the ledger, so it cannot
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
  /** The most recent notification, also shown as the banner. */
  notice?: string;
  /** Every notification of the last seven days. */
  history?: { date: string; notice: string }[];
  /** Only what needs doing today -- the number a badge should show. */
  dueCount: number;
  staleCount: number;
  coverage: "complete" | "partial";
}

export function NotificationsView() {
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
    // Opening it is the read receipt, and it is on open rather than on scroll or
    // on reaching the end: WhatsApp clears on open, and anything cleverer is how
    // you end up with a badge nobody can get rid of.
    markSeen();
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
        <h1 className="text-lg font-bold tracking-tight text-text">Notifications</h1>
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

      {!!olderDays(data).length && <ToldYou history={data.history ?? []} today={data.notice} />}

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
      className={`flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg px-4 py-3 transition-colors ${
        stale ? "bg-transparent opacity-50" : "bg-panel hover:bg-raised"
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
          className="rounded bg-raised px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40"
        >
          {busy ? "…" : stale ? "Bring back" : "Done"}
        </button>
      </div>
    </li>
  );
}


/**
 * The last seven days of notifications.
 *
 * A record, because a notification that only existed while it was on screen is
 * not something you can check. Recomputed from the book each time it is opened,
 * which is why it is labelled as what the book supports rather than as a
 * transcript -- see api/lib/tasks.ts > noticeHistory.
 */
/** The record minus today, which is already the banner. */
function olderDays(data: Today): { date: string; notice: string }[] {
  const today = todayISODate();
  return (data.history ?? []).filter((entry) => entry.date !== today);
}

function ToldYou({ history, today }: { history: { date: string; notice: string }[]; today?: string }) {
  // The newest line is already the banner; showing it twice in one screen is
  // noise, so the record starts from yesterday.
  const older = history.slice(today ? 1 : 0);
  return (
    <section className="pt-2">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-faint">Told you · last 7 days</h2>
      <ul className="mt-3 space-y-2">
        {older.map((entry) => (
          <li key={entry.date} className="flex gap-3 text-[12.5px] leading-5">
            <span className="tabular w-[5.5rem] shrink-0 whitespace-nowrap text-faint">{dayLabel(entry.date)}</span>
            <span className="min-w-0 flex-1 text-muted">{entry.notice}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-5 text-faint">
        Recomputed from your book each time this is opened, so it reflects what the
        book supports rather than a transcript of what was on screen.
      </p>
    </section>
  );
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayLabel(iso: string): string {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(then)) return iso;
  const days = Math.round((Date.now() - then) / 86_400_000);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return iso.slice(5);
}

function Empty() {
  return (
    <div className="rounded-lg bg-panel px-5 py-8 text-center">
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