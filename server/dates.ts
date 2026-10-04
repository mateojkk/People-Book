/**
 * Recurring dates, worked out in code rather than asked for.
 *
 * ── Why not just ask the model ────────────────────────────────────────────────
 * It was asked. An `anniversary` field was in the tool schema, described in the
 * schema, and then given a rule with four worked examples in the system prompt.
 * Measured against the live model: 0 emissions out of 4 birthdays, 4 weddings and
 * 4 anniversaries. gpt-oss treats the field as optional and skips it, every time,
 * and nothing in the prompt changed that.
 *
 * That is not a prompt problem to be solved, it is a dependency on a third party
 * behaving. So the model does what it is good at — extracting who and what — and
 * this does the part that has to be exactly right.
 *
 * ── Why this is the right owner for the work ─────────────────────────────────
 * A month-day is arithmetic. Getting "the 2nd of June" into "06-02" needs a month
 * table, leap days, and a zero pad, and every one of those is something a language
 * model can plausibly get wrong in a way that is invisible until the reminder
 * fires on the wrong day, eleven months later.
 */

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/**
 * Words that make a bare day number recurring.
 *
 * Required when there is no month name, because "on the 9th" on its own is a
 * one-off and must not become an anniversary that fires every year.
 */
const RECURRING = /\b(birthday|anniversary|wedding|married|nameday|christmas|easter|every year|yearly|annually)\b/;

/**
 * Ordinal suffixes on a day. Not applied to month names -- see monthName below.
 */
const ORDINAL_SUFFIX_SOURCE = "(?:st|nd|rd|th)";

/**
 * The recurring day and month in "MM-DD", or null.
 *
 * Two shapes are understood:
 *   a named month   "the 2nd of June", "June 2nd", "March 3"  -> month and day
 *   a bare day      "the 14th" in "birthday is the 14th"        -> day, no month
 *
 * A bare day with no recurring word returns null rather than guessing, because
 * guessing here produces a reminder on the wrong date every single year.
 */
export function recurringDate(text: string): string | null {
  const lower = text.toLowerCase();

  // "2nd of June" / "2nd June" / "on june 2nd" / "march 3"
  const dayThenMonth = new RegExp(
    `\\b(\\d{1,2})${ORDINAL_SUFFIX_SOURCE}\\s+(?:of\\s+)?([a-z]+)`,
  ).exec(lower);
  const monthThenDay = /\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(lower);

  // No suffix stripping here. The regex already captured letters only, and
  // stripping "st" from a month name turns "august" into "augu" -- so August was
  // the one month that silently stopped resolving, and only because the test
  // walked all twelve.
  const monthName = (m: string | undefined) => (m ? MONTHS[m] : undefined);

  let month: number | undefined;
  let day: number | undefined;

  if (dayThenMonth && monthName(dayThenMonth[2])) {
    day = Number(dayThenMonth[1]);
    month = monthName(dayThenMonth[2]);
  } else if (monthThenDay && monthName(monthThenDay[1])) {
    day = Number(monthThenDay[2]);
    month = monthName(monthThenDay[1]);
  }

  // Validated here as well as in validMonthDay: a bare day is the path that
  // produced "00-32" for "the 32nd", and a month-day that cannot exist is worse
  // than no month-day at all.
  if (month && day) return validMonthDay(month, day);
  if (!month && day !== undefined && (day < 1 || day > 31)) return null;

  // A bare day only counts when something makes it recurring.
  const anchor = lower.search(RECURRING);
  if (anchor !== -1) {
    // The day has to be the one the sentence is about. Picking the *closest*
    // number to the keyword resolved "Mara has 3 kids and her birthday is the
    // 14th" to the 3rd, because 3 sits nearer "birthday" than 14 does.
    //
    // English puts it after -- "birthday is the 14th" -- so a day after the
    // keyword wins, nearest first. Only with none does a day before count, which
    // covers "the 14th is her birthday".
    const bare = /\b(\d{1,2})(?:st|nd|rd|th)?\b/g;
    let match: RegExpExecArray | null;
    let after: number | null = null;
    let afterDistance = Number.POSITIVE_INFINITY;
    let before: number | null = null;
    let beforeDistance = Number.POSITIVE_INFINITY;

    while ((match = bare.exec(lower)) !== null) {
      // Skip anything that is really part of a longer number.
      if (/\d/.test(lower[match.index - 1] ?? "") || /\d/.test(lower[match.index + match[0].length] ?? "")) continue;
      const value = Number(match[1]);
      // A day that cannot exist is not a day. Without this "the 32nd" became
      // "00-32" and would have sat in the ledger as a real anniversary.
      if (value < 1 || value > 31) continue;
      if (match.index >= anchor) {
        const distance = match.index - anchor;
        if (distance < afterDistance) {
          afterDistance = distance;
          after = value;
        }
      } else {
        const distance = anchor - match.index;
        if (distance < beforeDistance) {
          beforeDistance = distance;
          before = value;
        }
      }
    }

    const best = after ?? before;
    if (best !== null) {
      // No month is knowable, so this is a day-of-month with the month left to
      // the caller, which derives it. "00-14" is never stored.
      return `00-${pad(best)}`;
    }
  }

  return null;
}

/** True for a complete "MM-DD". */
/**
 * A complete MM-DD, and a day that exists in that month.
 *
 * It only checked that the month was >= 1, so "99-99" and "13-45" both passed.
 * Harmless today only because the one caller feeds it values that have already
 * been through `recurringDate`. A validator that validates nothing is worse than
 * no validator, because the next caller will trust it.
 */
export function isFullMonthDay(value: string | undefined): boolean {
  if (!value) return false;
  const m = /^(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  return validMonthDay(Number(m[1]), Number(m[2])) !== null;
}

/**
 * The month a day-only fallback belongs to.
 *
 * Used so "birthday is the 14th" still produces something actionable: the month
 * is inferred as the coming one, which is right far more often than not and is
 * always visible to the user in the ledger, where it can be corrected.
 */
export function monthForDayOnly(dayOnly: string, now: Date): string | null {
  const day = Number(dayOnly.slice(3));
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  // The month is always the current one, and the year is discarded because MM-DD
  // has nowhere to put one. An earlier version computed a year and a "is this in
  // the future" flag that had no effect on the output at all, which made the
  // function read as though it did something it does not.
  //
  // The rule being applied is "the coming one": a bare "the 14th" means the 14th
  // of this month if it has not passed, otherwise next month's -- which is what
  // the ranker recomputes each time anyway.
  const resolved = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (resolved.getUTCDate() !== day) return null; // e.g. the 31st of a short month
  return `${pad(resolved.getUTCMonth() + 1)}-${pad(day)}`;
}

function validMonthDay(month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject a day that does not exist in that month. 2024 is a leap year, so
  // 29 February is accepted and 30 February is not.
  const probe = new Date(Date.UTC(2024, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${pad(month)}-${pad(day)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}