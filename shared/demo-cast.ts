/**
 * The demo cast.
 *
 * These people are invented. That is a deliberate constraint, not laziness: a
 * submission that a judge can open must not mean publishing real details about
 * real people who never agreed to be in a write-up. The real app is used with
 * real contacts; the demo and the article are not.
 *
 * What makes a cast work for this product is that the nudges have to be
 * non-obvious from the prompt text alone. Every entry below is written so that
 * something is derivable only by READING SEVERAL OF THEM TOGETHER — which is
 * precisely the thing a stateless chatbot cannot do, and therefore precisely the
 * thing a judge can check in thirty seconds.
 */

import type { MakeMemoryInput } from "./memory-codec.js";

/** Dates are relative to the seed moment so the demo ages sensibly over time. */
function daysFromNow(days: number, from: Date): string {
  const d = new Date(from.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function demoCast(now: Date = new Date()): MakeMemoryInput[] {
  return [
    // ── Maya ─────────────────────────────────────────────────────────────────
    // Her birthday is in three days, AND she was told in March about a promise
    // the user has now missed twice. Neither fact alone is interesting. Together
    // they are the exact nudge the product exists to produce, and it is only
    // derivable by reading both.
    {
      person: "Maya",
      type: "trait",
      text: "Maya's birthday is on the 3rd.",
      dueAt: daysFromNow(3, now),
      confidence: "confirmed",
    },
    {
      person: "Maya",
      type: "promise",
      text: "Promised Maya to find the grey kettle she liked from the shop on Lisker Street.",
      dueAt: daysFromNow(-42, now),
      occurredAt: daysFromNow(-60, now),
      confidence: "confirmed",
    },
    {
      person: "Maya",
      type: "promise",
      text: "Said he would send Maya the photos from the coast trip.",
      dueAt: daysFromNow(-12, now),
      occurredAt: daysFromNow(-26, now),
      confidence: "confirmed",
    },
    {
      person: "Maya",
      type: "howto",
      text: "Call Maya, do not text her. She answers texts two days later.",
      confidence: "confirmed",
    },
    {
      person: "Maya",
      type: "event",
      text: "Maya moved into the new flat in Kingsland Road.",
      occurredAt: daysFromNow(-21, now),
      confidence: "confirmed",
    },
    {
      person: "Maya",
      type: "update",
      text: "Maya is working nights at the hospital now, so mornings are no good.",
      confidence: "confirmed",
    },

    // ── Ravi ─────────────────────────────────────────────────────────────────
    // A taboo that the app must honour AND announce. The announcement is the
    // single most persuasive line in the demo: the assistant attributing its own
    // restraint, from memory, with a date.
    {
      person: "Ravi",
      type: "taboo",
      text: "Never mention the divorce to Ravi. Do not raise it, do not allude to it, do not ask how he is doing with it.",
      occurredAt: daysFromNow(-150, now),
      confidence: "confirmed",
    },
    {
      person: "Ravi",
      type: "promise",
      text: "Owed Ravi a call back about the flat viewing.",
      dueAt: daysFromNow(-6, now),
      occurredAt: daysFromNow(-9, now),
      confidence: "confirmed",
    },
    {
      person: "Ravi",
      type: "event",
      text: "Ravi is moving to Lisbon in the spring.",
      dueAt: daysFromNow(9, now),
      confidence: "confirmed",
    },
    {
      person: "Ravi",
      type: "howto",
      text: "Ravi will ask about the job. Have an answer ready before you see him.",
      confidence: "confirmed",
    },
    {
      person: "Ravi",
      type: "trait",
      text: "Ravi takes the 6am train and hates being asked about his sleep.",
      confidence: "confirmed",
    },

    // ── Lena ─────────────────────────────────────────────────────────────────
    // The absence nudge. She has not been in touch since mid-summer and what was
    // unresolved then is still unresolved. The product surfaces a thread nobody
    // remembers starting.
    {
      person: "Lena",
      type: "event",
      text: "Lena's visa appointment was moved and she was worried about the reschedule.",
      occurredAt: daysFromNow(-84, now),
      confidence: "confirmed",
    },
    {
      person: "Lena",
      type: "event",
      text: "Lena asked whether it was worth appealing the visa decision.",
      occurredAt: daysFromNow(-84, now),
      confidence: "confirmed",
    },
    {
      person: "Lena",
      type: "trait",
      text: "Lena is vegetarian and will refuse food rather than ask if anything is meat-free.",
      confidence: "confirmed",
    },
    {
      person: "Lena",
      type: "howto",
      text: "Lena is the one person who will actually read the long message. Send it properly.",
      confidence: "confirmed",
    },

    // ── Nina ─────────────────────────────────────────────────────────────────
    // A date inside the horizon, plus a promise attached to it. Reading the
    // event alone gives you the date. Reading the promise alone gives you the
    // obligation. Reading both gives you what you actually need to know on the
    // morning of the day.
    {
      person: "Nina",
      type: "event",
      text: "Nina's leaving drinks are on the 12th at the Crown.",
      dueAt: daysFromNow(6, now),
      confidence: "confirmed",
    },
    {
      person: "Maya",
      type: "promise",
      text: "Said he would get Nina a card when he saw her before the drinks.",
      dueAt: daysFromNow(6, now),
      occurredAt: daysFromNow(-4, now),
      confidence: "confirmed",
    },
    {
      person: "Nina",
      type: "trait",
      text: "Nina has a standing Sunday call with her mum that she is always running late for.",
      confidence: "confirmed",
    },

    // ── Sam ──────────────────────────────────────────────────────────────────
    // Sam generates the follow-through nudge: four promises, none closed. The
    // product notices the pattern the user cannot, and rates it BELOW every
    // practical reminder so it is never the loudest thing it says.
    {
      person: "Sam",
      type: "promise",
      text: "Told Sam he would look at the photos from the trip.",
      dueAt: daysFromNow(-30, now),
      occurredAt: daysFromNow(-35, now),
      confidence: "confirmed",
    },
    {
      person: "Sam",
      type: "promise",
      text: "Said he would send Sam the address for the bookshop.",
      dueAt: daysFromNow(-21, now),
      occurredAt: daysFromNow(-25, now),
      confidence: "confirmed",
    },
    {
      person: "Sam",
      type: "promise",
      text: "Told Sam he would have a go at the climbing thing.",
      dueAt: daysFromNow(-14, now),
      occurredAt: daysFromNow(-18, now),
      confidence: "confirmed",
    },
    {
      person: "Sam",
      type: "promise",
      text: "Told Sam he would send the photos of the bike.",
      dueAt: daysFromNow(-7, now),
      occurredAt: daysFromNow(-10, now),
      confidence: "confirmed",
    },
    {
      person: "Sam",
      type: "howto",
      text: "Sam does not want advice about the job. Just ask what he needs.",
      confidence: "confirmed",
    },

    // ── You ──────────────────────────────────────────────────────────────────
    // The user is in the book like anyone else. Without this the assistant knows
    // everyone's obligations and none of your own habits, which is the most
    // useful thing it could possibly tell you and also the most uncomfortable.
    {
      person: "you",
      type: "promise",
      text: "Said you would finally book the dentist you have been putting off since March.",
      dueAt: daysFromNow(-4, now),
      occurredAt: daysFromNow(-20, now),
      confidence: "confirmed",
    },
    {
      person: "you",
      type: "trait",
      text: "You are useless at phone calls and much better at text.",
      confidence: "confirmed",
    },
  ];
}

export const DEMO_CAST_LENGTH = demoCast().length;
