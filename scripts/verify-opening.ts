/**
 * What it says before you say anything.
 *
 * The opening line is the one piece of copy in the product that is not a reply to
 * anything, which makes it the easiest place for an ungrounded claim to appear.
 * So it is deterministic and these assertions are on the numbers it says.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
let checks = 0;
function section(n: string) { console.log(`\n${n}`); }
function check(label: string, ok: boolean, detail = "") {
  checks++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// exercise() runs openingFor() with a fixture by transpiling the real module.
const src = readFileSync(new URL("../src/components/Opening.tsx", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "opening-"));
// Strip the parts that need a browser: the hook, and its imports.
const pure = src
  .slice(0, src.indexOf("export function Opening"))
  .replace(/import .*from "react";\n/, "")
  .replace(/import .*from "\.\.\/lib\/api\.ts";\n/, "")
    + "\nexport { openingFor };\n";
const file = join(dir, "opening.ts");
writeFileSync(file, pure);

type Today = { notice?: string; tasks: any[]; dueCount: number; staleCount: number };
const { openingFor } = (await import(file)) as { openingFor: (d: Today) => string | null };
const task = (over: Record<string, unknown> = {}) => ({
  memoryId: "m", person: "Maya", text: "promised to ring about the invoice",
  ...{ urgency: "overdue", urgencyScore: 1, daysLate: 0, active: true, dueLabel: "today", ...over },
});

section("it says nothing when nothing is due");
{
  check("no notice, no line", openingFor({ tasks: [], dueCount: 0, staleCount: 0 }) === null);
  check("an empty notice is still nothing", openingFor({ notice: "   ", tasks: [], dueCount: 0, staleCount: 0 }) === null);
  check("only settled tasks is nothing", openingFor({ tasks: [task({ urgency: "later", active: false })], dueCount: 0, staleCount: 1 }) === null);
}

section("it leads with the notification");
{
  const line = openingFor({ notice: "Maya's birthday is tomorrow.", tasks: [], dueCount: 0, staleCount: 0 });
  check("the notice is the opening", line === "Maya's birthday is tomorrow.", String(line));
}

section("overdue is stated with how late");
{
  const line = openingFor({ notice: "Something needs you.", tasks: [task({ urgency: "overdue", daysLate: 3 })], dueCount: 1, staleCount: 0 }) ?? "";
  check("it says how many days", /3 days overdue/.test(line), line);
  const one = openingFor({ notice: "Something.", tasks: [task({ urgency: "overdue", daysLate: 1 })], dueCount: 1, staleCount: 0 }) ?? "";
  check("and singular reads as a day, not '1 days'", /\ba day\b/.test(one) && !/1 days/.test(one), one);
}

section("more than one overdue is counted, not listed");
{
  const line = openingFor({
    notice: "Two things.",
    tasks: [task({ urgency: "overdue", daysLate: 4, dueAt: "2026-09-28" }), task({ urgency: "overdue", daysLate: 1, person: "Dev" })],
    dueCount: 2, staleCount: 0,
  }) ?? "";
  check("it counts them", /2 things are overdue/.test(line), line);
  check("and dates the oldest", /since 2026-09-28/.test(line), line);
}

section("it names the person, and handles you");
{
  const maya = openingFor({ notice: "x", tasks: [task({ urgency: "overdue", daysLate: 1 })], dueCount: 1, staleCount: 0 }) ?? "";
  check("names them", /about Maya/.test(maya), maya);
  const you = openingFor({ notice: "x", tasks: [task({ urgency: "overdue", daysLate: 1, person: "you" })], dueCount: 1, staleCount: 0 }) ?? "";
  check("and says you when the subject is you", /about you/.test(you) && !/about You/.test(you), you);
}

section("never a greeting");
{
  // A greeting is what a chatbot says when it has nothing. Offering it as the
  // opening makes the one message that matters look like filler.
  for (const tasks of [[], [task({ urgency: "overdue", daysLate: 2 })]]) {
    const line = openingFor({ notice: "Maya's birthday is tomorrow.", tasks, dueCount: 1, staleCount: 0 }) ?? "";
    check(`no greeting for ${tasks.length} task(s)`, !/^(hey|hi|hello|good morning|how are you)/i.test(line.trim()), line);
  }
}

section("it strips the 'promised to' preamble");
{
  const line = openingFor({ notice: "x", tasks: [task({ urgency: "overdue", daysLate: 1, text: "promised to ring about the invoice" })], dueCount: 1, staleCount: 0 }) ?? "";
  check("it reads as a claim, not a transcript", /ring about the invoice/.test(line) && !/promised to ring about the invoice/.test(line), line);
}

console.log("");
if (failures > 0) { console.log(`${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all ${checks} checks passed`);
