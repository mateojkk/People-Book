/**
 * What to do today.
 *
 * ── Why this is a separate thing ─────────────────────────────────────────────
 * A nudge is an observation: "Maya's birthday is on the 14th." It is true, and
 * on its own it does not help anybody do anything.
 *
 * This module answers the only question that brings someone back to an app,
 * which is "what am I supposed to do now". Everything here is something with a
 * date and an owner that has not been dealt with, ordered by how much trouble it
 * is in, and — the part that matters — each one can be *finished*.
 *
 * ── Where it comes from ───────────────────────────────────────────────────────
 * Nothing new is stored. These are the open promises and dated events already in
 * the ledger, filtered through decay so a faded memory does not reappear as
 * urgent, and stale promises are excluded entirely so they stop nagging on their
 * own. A task list assembled this way cannot disagree with the book.
 */

import { isDecayed, isStalePromise, relevance } from "./decay.ts";
import type { PersonMemory } from "../../shared/types.ts";

export type TaskUrgency = "overdue" | "today" | "soon" | "later";

export interface Task {
  /** The memory this task comes from. Settling it settles that. */
  memoryId: string;
  person: string;
  /** The claim, verbatim. Not reworded, so it can be checked against the book. */
  text: string;
  /** ISO date. Null for something open-ended, which is still worth doing. */
  dueAt?: string;
  urgency: TaskUrgency;
  /** 0..1, deterministic. Drives the ordering and the tone of the row. */
  urgencyScore: number;
  /** Days late. Positive only when it is. */
  daysLate: number;
  /** False once it has faded or gone stale, so the UI can offer to tidy it. */
  active: boolean;
  /** For a due date, plain enough to act on. */
  dueLabel: string;
}

const DAY_MS = 86_400_000;

function todayISO(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((to - from) / DAY_MS);
}

function urgencyOf(daysUntil: number): { urgency: TaskUrgency; score: number } {
  if (daysUntil < 0) {
    // Anything late beats anything upcoming, and the longer it has been, the worse.
    const late = -daysUntil;
    return { urgency: "overdue", score: 1 - Math.min(late, 30) / 60 };
  }
  if (daysUntil === 0) return { urgency: "today", score: 0.92 };
  if (daysUntil <= 2) return { urgency: "soon", score: 0.78 - daysUntil / 40 };
  if (daysUntil <= 7) return { urgency: "soon", score: 0.6 - daysUntil / 60 };
  return { urgency: "later", score: 0.4 - Math.min(daysUntil, 60) / 300 };
}

function dueLabel(urgency: TaskUrgency, daysUntil: number, daysLate: number): string {
  switch (urgency) {
    case "overdue":
      return daysLate === 1 ? "a day late" : `${daysLate} days late`;
    case "today":
      return "today";
    case "soon":
      return daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
    default:
      return `in ${daysUntil} days`;
  }
}

/**
 * Everything on the ledger that has not been dealt with.
 *
 * Open promises are the spine of this. Dated events appear too, because "her
 * flight is on the 3rd" is something to do. Facts with no date and nothing
 * outstanding are not tasks and are left out -- they are what the conversation
 * and the nudges are for.
 *
 * Faded and stale items are marked inactive rather than dropped, so the list can
 * offer to clear them instead of silently losing them.
 */
export function tasksFor(memories: readonly PersonMemory[], now: Date): Task[] {
  const today = todayISO(now);
  // Local, not module-level. A shared map keyed by memory id would be mutated by
  // two concurrent requests and read by the other's sort, so the ordering would
  // depend on who answered first.
  const relevanceById = new Map<string, number>();
  for (const memory of memories) relevanceById.set(memory.id, relevance(memory, now));

  const tasks: Task[] = [];
  for (const memory of memories) {
    if (memory.deleted === true) continue;

    const openPromise = memory.type === "promise" && memory.status === "open";
    const datedEvent = memory.type === "event" && Boolean(memory.dueAt);
    if (!openPromise && !datedEvent) continue;

    const stale = isStalePromise(memory, now);
    const faded = isDecayed(memory, now);
    if (stale || faded) {
      // Not actionable, but still worth surfacing once so it can be retired
      // deliberately rather than lingering as a task nobody clears.
      if (!memory.dueAt) continue;
    }

    const daysUntil = memory.dueAt ? daysBetween(today, memory.dueAt) : Number.NaN;
    const dated = Number.isFinite(daysUntil);
    // Undated open promises still belong on the list -- you did say you would.
    // They rank last, because they have no pressure behind them.
    const { urgency, score } = dated ? urgencyOf(daysUntil) : { urgency: "later" as const, score: 0.3 };

    tasks.push({
      memoryId: memory.id,
      person: memory.person,
      text: memory.text,
      ...(memory.dueAt ? { dueAt: memory.dueAt } : {}),
      urgency,
      urgencyScore: score,
      daysLate: dated && daysUntil < 0 ? -daysUntil : 0,
      active: !stale && !faded,
      dueLabel: dated ? dueLabel(urgency, daysUntil, -daysUntil) : "no date",
    });
  }

  // Active work first, always. A promise 200 days past due scores as "overdue" and
  // therefore outranks something you can still act on today -- which is exactly
  // backwards, because the stale one is no longer asking for anything. It is kept,
  // not dropped, so it can be retired deliberately; but it goes to the bottom.
  return tasks.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (b.urgencyScore !== a.urgencyScore) return b.urgencyScore - a.urgencyScore;
    const ra = relevanceById.get(a.memoryId) ?? 0;
    const rb = relevanceById.get(b.memoryId) ?? 0;
    return rb - ra;
  });
}

/**
 * The notification, as a sentence.
 *
 * ── Why this is written here and not in the UI ────────────────────────────────
 * "2 things need you today" is a task count, and a task count on a screen is how
 * this stops being a chatbot and starts being a reminders app. The same data,
 * phrased as a sentence from something that knows you, is a different product:
 *
 *   "Maya's birthday is on the 14th — tomorrow. Also, Dev's signed contract is
 *    two days late."
 *
 * Composed deterministically from the ledger. No model call, because this runs on
 * every page load and must be identical every time -- and because every clause in
 * it is a fact the book already holds, not something worth generating.
 *
 * The claims are verbatim from the memory and the timing is computed, so both
 * halves are checkable. Nothing is paraphrased into being vaguer or firmer than
 * what was actually said.
 */
export function composeNotice(memories: readonly PersonMemory[], tasks: readonly Task[], now: Date): string {
  const today = todayISO(now);
  const clauses: string[] = [];

  // Something dated that is close. The anniversary case is the one that makes this
  // feel like memory rather than a calendar: a birthday told months ago.
  const imminent = memories
    .filter((m) => m.deleted !== true && m.confidence === "confirmed")
    .map((m) => ({ m, due: effectiveDue(m, today) }))
    .filter((x): x is { m: PersonMemory; due: string } => Boolean(x.due))
    .map((x) => ({ ...x, days: daysBetween(today, x.due) }))
    .filter((x) => x.days >= 0 && x.days <= 2 && x.m.type !== "taboo")
    .sort((a, b) => a.days - b.days)[0];

  if (imminent) {
    clauses.push(`${stripTrailingPeriod(imminent.m.text)} — ${when(imminent.days)}.`);
  }

  // The most overdue thing you said you would do.
  const late = tasks.find((t) => t.active && t.urgency === "overdue");
  if (late) {
    clauses.push(`${late.person}: ${lowerFirst(stripTrailingPeriod(late.text))} — ${late.dueLabel}.`);
  }

  if (clauses.length === 0) return "";

  const first = clauses[0] ?? "";
  const second = clauses[1];
  return second ? `${first} Also, ${second}` : first;
}

function when(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return "in two days";
}

function stripTrailingPeriod(text: string): string {
  return text.replace(/[.\u2026]+$/, "");
}

function lowerFirst(text: string): string {
  // Leave anything that starts with an acronym or a proper noun alone.
  if (/^[A-Z]{2,}/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The date this memory falls due, recurring or not. Mirrors decay's view. */
function effectiveDue(memory: PersonMemory, todayISO: string): string | null {
  if (memory.dueAt) return memory.dueAt;
  if (memory.anniversary) {
    const match = /^(\d{2})-(\d{2})$/.exec(memory.anniversary);
    if (!match) return null;
    const year = Number(todayISO.slice(0, 4));
    const month = Number(match[1]);
    const day = Number(match[2]);
    for (const candidate of [year, year + 1]) {
      const lastDay = new Date(Date.UTC(candidate, month, 0)).getUTCDate();
      const resolved = day > lastDay ? lastDay : day;
      const asISO = new Date(Date.UTC(candidate, month - 1, resolved)).toISOString().slice(0, 10);
      if (asISO >= todayISO) return asISO;
    }
  }
  return null;
}

/**
 * The follow-through record.
 *
 * Two numbers, both from what actually happened rather than from what was
 * intended: how much got done, and how much was left past its date. The second
 * one is the one worth showing, because it is the only part of this app that is
 * a judgement of the user rather than a reminder to them.
 */
export function followThrough(memories: readonly PersonMemory[]): { kept: number; missed: number; total: number } {
  let kept = 0;
  let missed = 0;
  for (const memory of memories) {
    if (memory.type !== "promise" || memory.deleted === true) continue;
    if (memory.status === "kept" || memory.status === "settled") kept += 1;
    else if (memory.status === "missed") missed += 1;
  }
  return { kept, missed, total: kept + missed };
}