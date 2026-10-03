/**
 * The extraction prompt, asserted structurally.
 *
 * Every rule here has been lost at least once. The prompt was trimmed 42% for
 * token cost, and the first trim turned "remember I hate emoji" into a trait
 * instead of a correction -- which means the assistant keeps a preference as a
 * fact about the user and never treats it as a rule it must follow. A prompt is
 * code and it degrades exactly like code does, silently.
 *
 * So the parts that matter are asserted, rather than trusting a careful edit.
 */
import { readFileSync } from "node:fs";

let failures = 0;
function section(n: string) { console.log(`\n${n}`); }
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const src = readFileSync(new URL("../api/lib/capture.ts", import.meta.url), "utf8");
const system = /const SYSTEM = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";

section("size");
{
  // 5069 bytes before the trim. The ceiling is here so the next person cannot
  // quietly add a paragraph back and reintroduce the rate limiting.
  const bytes = system.length;
  check("the prompt is under 3200 bytes", bytes < 3200, `${bytes} bytes`);
  check("and still a real prompt, not a stub", bytes > 1500, `${bytes} bytes`);
}

section("every type is offered to the model");
for (const t of ["promise", "event", "trait", "taboo", "howto", "update", "correction"]) {
  check(`"${t}" is in the prompt`, system.includes(`"${t}"`));
}

section("the rules that were lost and had to be put back");
{
  // Pronoun resolution across turns. Asserted against the request rather than the
  // prompt, because that is where it actually lives: the prompt has never
  // mentioned history, the user turn carries "Conversation so far". Checking the
  // prompt for it was checking for something that was never true.
  check(
    "the conversation so far is sent with the message",
    /Conversation so far/.test(src) && /slice\(-6\)|slice\(-8\)/.test(src),
  );
  // Lost in trim 1: the taboo's subject must not also be stored as news.
  check("a taboo is not also stored as news", /taboo is one candidate/i.test(system));
  // Lost in trim 1: recurring dates must never go in dueAt.
  check("recurring dates never use dueAt", /anniversary/i.test(system) && /never.*dueAt|not.*dueAt/i.test(system));
  check("and MM-DD is zero padded", /zero padded|MM-DD/i.test(system));
  // Lost in trim 2: "remember I hate emoji" became a trait, so the preference was
  // filed as a fact about the user and never obeyed as a rule.
  check('"remember <preference>" is a correction, not a trait', /remember I hate emoji/.test(system));
  // The reason is the whole point of the correction type.
  check("corrections carry the writer's reason", /"reason"/.test(system));
  check("and are told never to invent one", /[Nn]ever invent one/.test(system));
  // The bar that keeps a bad extraction harmless.
  check("low confidence is discarded", /0\.55/.test(system));
  check("banter is allowed to yield nothing", /empty array/i.test(system));
}

section("the tool schema matches what the prompt promises");
{
  // The prompt asks for a field the schema omits and Groq 400s the whole request.
  // That killed every correction for a week.
  const schema = src.slice(src.indexOf("tools: ["));
  check("reason is declared in the schema", /reason:\s*\{/.test(schema));
  check("and accepts null, because the model emits null for 'no reason'", /type:\s*\["string",\s*"null"\]/.test(schema));
  check("anniversary is declared", /anniversary:\s*\{/.test(schema));
}

console.log("");
if (failures > 0) { console.log(`${failures} check(s) FAILED`); process.exit(1); }
console.log("all checks passed");
