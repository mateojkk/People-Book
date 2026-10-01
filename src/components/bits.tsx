/**
 * Small presentational pieces shared across views.
 *
 * Kept together because they exist for one reason: making the provenance of a
 * claim visible. Every nudge in this product can be traced to the memory behind
 * it, and these are the components that let a user do that tracing.
 */

import type { NudgeKind, PersonMemory } from "../types.ts";

const KIND_LABEL: Record<NudgeKind, string> = {
  date: "date",
  promise: "promise",
  absence: "gone quiet",
  loop: "unresolved",
  followthrough: "your pattern",
};

export function KindTag({ kind }: { kind: NudgeKind }) {
  return (
    <span className="mono rounded border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted">
      {KIND_LABEL[kind]}
    </span>
  );
}

/**
 * The source line under a nudge.
 *
 * Every nudge is a pointer, and this makes that literal: it shows the memory the
 * nudge was derived from, not a restatement. A user who doubts a nudge can check
 * it against a specific stored claim in one click, which is the whole difference
 * between an assistant you trust and one you have to take on faith.
 */
export function SourceTrace({
  memory,
  onForget,
}: {
  memory?: PersonMemory;
  onForget?: (id: string) => void;
}) {
  if (!memory) {
    return (
      <p className="mt-2 text-xs text-muted">
        This one is a pattern across your other promises, not a single stored fact.
      </p>
    );
  }
  return (
    <div className="mt-2 border-l-2 border-rule pl-2.5">
      <p className="text-[11px] text-muted">
        from your book
        {memory.occurredAt && <> · noted {memory.occurredAt}</>}
        {memory.dueAt && <> · due {memory.dueAt}</>}
      </p>
      <p className="mt-0.5 text-xs text-muted/90">{memory.text}</p>
      {onForget && (
        <button
          onClick={() => onForget(memory.id)}
          className="mt-1 text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-stop"
        >
          forget this
        </button>
      )}
    </div>
  );
}

/**
 * The announced elision.
 *
 * Deliberately loud and specific. The alternative — silently dropping a topic —
 * reads as the assistant ignoring you, and there is no way for a user to tell
 * whether a restriction was honoured or the model simply forgot. Naming the
 * person, the rule and the date it was set turns a quiet omission into a
 * verifiable claim about the assistant's own restraint.
 */
export function ElisionNotice({ person, since }: { person: string; since: string }) {
  return (
    <p className="mt-3 flex items-start gap-2 rounded border border-warn/25 bg-warn/5 px-2.5 py-2 text-xs text-warn">
      <span aria-hidden className="mt-0.5 select-none">
        ◑
      </span>
      <span>
        Not mentioning the thing you told me not to mention about {person}, set on {since}.
      </span>
    </p>
  );
}

/**
 * Explains, in the open, how the set on screen was chosen.
 *
 * The counts come from the server's own ranking input, so this is not a caption
 * written to flatter the demo — it is the actual basis. Including the inferred
 * count matters: a reader should be able to see how much the model guessed at
 * and know that none of it is being used.
 */
export function BasisNote({
  basis,
  computedAt,
}: {
  basis: { memoryCount: number; confirmedCount: number; inferredCount: number; horizonDays: number; memoryDisabled?: boolean };
  computedAt: string;
}) {
  return (
    <p className="text-[11px] leading-relaxed text-muted">
      {basis.memoryDisabled ? (
        <>
          Memory is <strong className="text-ink">off</strong>. Every one of these reminders is a
          recall, so with memory off there is nothing to show — not a worse version, nothing. That is
          the honest baseline.
        </>
      ) : (
        <>
          Chosen from <strong className="text-ink">{basis.confirmedCount}</strong> confirmed
          memor{basis.confirmedCount === 1 ? "y" : "ies"} out of {basis.memoryCount} in your book, by
          rules with no model involved — dates inside {basis.horizonDays} days, promises still open,
          people gone quiet, and your own unkept promises.
          {basis.inferredCount > 0 && (
            <>
              {" "}
              <span className="text-spine/80">
                {basis.inferredCount} extracted but unconfirmed memor{basis.inferredCount === 1 ? "y" : "ies"}{" "}
                {basis.inferredCount === 1 ? "is" : "are"} in your ledger and {basis.inferredCount === 1 ? "is" : "are"} not
                allowed to appear here.
              </span>
            </>
          )}
        </>
      )}
      {" · "}
      <span className="tabular">{new Date(computedAt).toLocaleTimeString()}</span>
    </p>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p className="rounded border border-stop/30 bg-stop/5 px-3 py-2 text-xs text-stop" role="alert">
      {message}
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded border border-dashed border-rule px-3 py-6 text-center text-sm text-muted">{children}</p>;
}
