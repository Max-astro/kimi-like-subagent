import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = JSON.parse(readFileSync(join(root, "evals", "cases.json"), "utf8"));
const delegation = readFileSync(join(root, "prompts", "modes", "delegation.md"), "utf8").trim();
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const allowed = new Set(["direct", "agent", "swarm"]);
for (const item of cases) {
  if (!item.id || !item.task || !allowed.has(item.expected)) throw new Error(`Invalid eval case: ${JSON.stringify(item)}`);
}

const judge = `Choose the best execution strategy for the user task. Return JSON only: {"choice":"direct|agent|swarm","reason":"one sentence"}. Agent means one or a few heterogeneous subagent calls. Swarm means one repeated template over many independent items.`;
if (!live) {
  console.log(`offline prompt eval: ${cases.length} valid cases`);
  console.log(`baseline system chars: ${judge.length}`);
  console.log(`treatment system chars: ${(judge + "\n\n" + delegation).length}`);
  for (const item of cases) console.log(`${item.id}\texpected=${item.expected}\t${item.reason}`);
  console.log("No model was called. Add --live to run the A/B evaluation.");
  process.exit(0);
}

const pi = option("--pi", "pi");
const model = option("--model", undefined);
const arms = [
  ["baseline", judge],
  ["treatment", `${judge}\n\n${delegation}`],
];
for (const [arm, systemPrompt] of arms) {
  let passed = 0;
  for (const item of cases) {
    const args = ["--no-session", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills", "--system-prompt", systemPrompt, "-p"];
    if (model) args.push("--model", model);
    args.push(item.task);
    const run = spawnSync(pi, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (run.status !== 0) throw new Error(`${arm}/${item.id}: ${run.stderr || run.stdout}`);
    const match = run.stdout.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : { choice: "unparseable" };
    const ok = parsed.choice === item.expected;
    if (ok) passed++;
    console.log(`${arm}\t${item.id}\texpected=${item.expected}\tactual=${parsed.choice}\t${ok ? "PASS" : "FAIL"}`);
  }
  console.log(`${arm}: ${passed}/${cases.length}`);
}
