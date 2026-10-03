/**
 * What it says before you have said anything.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A companion that only speaks when spoken to is a database with a text box. The
 * entire argument for having one is that it brings things up: the birthday, the
 * call you did not make, the thing you said you would do. Waiting for the user to
 * type first throws that away and makes the app identical to every chatbot.
 *
 * ── Why it is deterministic ──────────────────────────────────────────────────
 * Every number here comes from the ranking engine, not from a model, and the
 * sentence is assembled from those numbers. A model asked to open a conversation
 * will invent something to say -- that is the failure this whole product is built
 * against, and it would be absurd to reintroduce it in the first thing the user
 * reads. If nothing is due, it says nothing at all, which is a real answer.
 *
 * It also never greets. "Hey! How's your day going?" is what a chatbot says when
 * it has nothing to say, and offering it as the opening line makes the one
 * message that matters look like filler.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Task } from "./NotificationsView.tsx";

interface Today {
  notice?: string;
  tasks: Task[];
  dueCount: number;
  staleCount: number;
}

/** Overdue first, then due today, because that is the order of consequence. */
function order(tasks: Task[]): Task[] {
  const rank = (t: Task) => (t.urgency === "overdue" ? 0 : t.urgency === "today" ? 1 : 2);
  return tasks.filter((t) => t.active).sort((a, b) => rank(a) - rank(b));
}

function openingFor(data: Today): string | null {
  const ranked = order(data.tasks);
  const overdue = ranked.filter((t) => t.urgency === "overdue");
  const dueToday = ranked.filter((t) => t.urgency === "today");

  // The notification sentence is already the product's own voice and already
  // grounded, so it leads when there is one.
  const lead = data.notice?.trim();
  if (!lead) return null;

  if (!overdue.length && !dueToday.length) return lead;

  const lines = [lead];
  const who = (t: Task) => (t.person === "you" ? "you" : t.person);
  const thing = (t: Task) => t.text.replace(/^(promised|said) /i, "").replace(/[.]$/, "");

  if (overdue.length === 1) {
    const t = overdue[0]!;
    lines.push(
      `The one about ${who(t)} — ${thing(t)} — is ${t.daysLate === 1 ? "a day" : `${t.daysLate} days`} overdue.`,
    );
  } else if (overdue.length > 1) {
    lines.push(`${overdue.length} things are overdue, the oldest about ${who(overdue[0]!)} since ${overdue[0]!.dueAt}.`);
  }

  if (dueToday.length === 1 && !overdue.length) {
    lines.push(`The one about ${who(dueToday[0]!)} is due today.`);
  }

  return lines.join(" ");
}

export function Opening() {
  const [line, setLine] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "done" | "failed">("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.get<Today>("/api/today");
        if (!alive) return;
        // Deliberately no model call. See the note at the top.
        setLine(openingFor(data));
        setState("done");
      } catch {
        if (alive) setState("failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state !== "done" || !line) return null;

  return (
    <div className="mx-auto w-full max-w-thread px-5 pt-6">
      <p className="text-[13px] leading-7 text-muted">{line}</p>
    </div>
  );
}
