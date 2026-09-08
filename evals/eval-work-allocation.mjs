import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./work-allocation/cases.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function readJsonLines(path) {
  try {
    return { valid: true, records: readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)) };
  } catch {
    return { valid: false, records: [] };
  }
}
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return argv[index + 1];
};
const ids = option("--case", argv.includes("--live") ? "background" : cases.map((item) => item.id).join(",")).split(",");
if (ids.some((id) => !cases.some((item) => item.id === id))) throw new Error("Unknown case");
const selected = cases.filter((item) => ids.includes(item.id));
if (!argv.includes("--live")) {
  for (const item of selected) console.log(`${item.id}: ${item.behavior}`);
  console.log("Offline only. --live uses openai/gpt-5.6-sol, high; at most 18 requests, 60,000-token admission threshold, 4,096 output tokens/request, 180 seconds/case. In-flight requests can exceed the token threshold. No automatic retries of failed cases. Compact parent system prompt by default; --full-system uses Pi's default prompt.");
  process.exit(0);
}

const output = mkdtempSync(join(tmpdir(), "kimi-work-allocation-"));
const agentDir = join(output, "agent");
mkdirSync(agentDir, { mode: 0o700 });
const source = resolve(option("--agent-dir", process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")));
const budgetPath = join(output, "budget.json");
writeFileSync(budgetPath, JSON.stringify({ requests: 0, tokens: 0, maxRequests: 18, maxTokens: 60_000 }));
console.log(`Artifacts: ${output}`);

try {
  // Copy provider configuration without displaying credentials or changing the user's setup.
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(agentDir, name));
  }
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    extensions: [join(root, "index.ts"), join(root, "evals/work-allocation/trace.ts")],
    packages: [], defaultProvider: "openai", defaultModel: "gpt-5.6-sol", defaultThinkingLevel: "high",
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  mkdirSync(join(agentDir, "kimi-like-subagent"));
  writeFileSync(join(agentDir, "kimi-like-subagent/config.json"), JSON.stringify({
    subagent: { timeout_ms: 120_000 },
    secondary_model: { default_model: "eval", force: true, models: { eval: { model: "openai/gpt-5.6-sol", thinking_level: "high" } } },
  }));
  const reports = [];
  for (const item of selected) {
    const cwd = join(output, item.id);
    mkdirSync(cwd);
    for (const [name, contents] of Object.entries(item.files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), contents);
    }
    const tracePath = join(output, `${item.id}.trace.jsonl`);
    const sessionPath = join(output, `${item.id}.session.jsonl`);
    const args = ["--offline", "--provider", "openai", "--model", "gpt-5.6-sol", "--thinking", "high", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--tools", "read,grep,find,ls,edit,write,bash,Agent,TaskOutput,TaskList,TaskStop", "--session", sessionPath, "--mode", "rpc"];
    if (!argv.includes("--full-system")) {
      const guidelines = ["Agent", "AgentSwarm", "TaskList", "TaskOutput", "TaskStop"].map((name) => readFileSync(join(root, `prompts/guidelines/${name}.md`), "utf8")).join("\n");
      args.unshift("--system-prompt", `You are a coding agent in a disposable small fixture. Complete the requested deliverables, verify changes proportionally, and report briefly. Use known paths directly. This fixture has no git metadata or installed dependencies. Avoid unnecessary exploration and tool output. Preserve unrelated files.\n${guidelines}`);
    }
    const run = await new Promise((resolveRun, reject) => {
      const child = spawn(option("--pi", "pi"), args, { cwd, detached: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", KIMI_EVAL_TRACE: tracePath, KIMI_EVAL_BUDGET: budgetPath }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify({ type: "prompt", message: item.prompt }) + "\n");
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 180_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, timedOut, stdout, stderr }); });
    });
    writeFileSync(join(output, `${item.id}.stdout.jsonl`), run.stdout);
    writeFileSync(join(output, `${item.id}.stderr.log`), run.stderr);
    const traceLog = readJsonLines(tracePath);
    const trace = traceLog.records;
    const parentId = trace.find((event) => event.type === "request")?.sessionId;
    const calls = trace.filter((event) => event.type === "tool_execution_start" && event.sessionId === parentId);
    const agents = calls.filter((event) => event.toolName === "Agent");
    const assistantMessages = trace.filter((event) => event.type === "assistant");
    const modelFailed = !assistantMessages.length || assistantMessages.some((event) => ["error", "aborted", "length"].includes(event.stopReason));
    const verify = spawnSync(process.execPath, ["--input-type=module", "-e", item.verify], { cwd, encoding: "utf8", timeout: 10_000 });
    const sessionLog = readJsonLines(sessionPath);
    const sessions = sessionLog.records;
    const state = sessions.filter((entry) => entry.type === "custom" && entry.customType === "kimi-like-subagent-state").at(-1)?.data;
    const checks = {
      execution: run.code === 0 && !run.timedOut && !modelFailed && !trace.some((event) => event.type === "eval_failure"),
      readableLogs: traceLog.valid && sessionLog.valid,
      model: trace.some((event) => event.type === "request") && trace.filter((event) => event.type === "request").every((event) => event.provider === "openai" && event.model === "gpt-5.6-sol" && event.thinking === "high"),
      artifact: verify.status === 0,
      settled: agents.length === 0 ? !state?.tasks.some((task) => task.status !== "completed") : !!state && state.tasks.length > 0 && state.tasks.every((task) => task.status === "completed"),
      noPolling: !calls.some((event) => ["TaskList", "TaskOutput"].includes(event.toolName)),
    };
    if (item.id === "direct") checks.delegation = agents.length === 0 && !calls.some((event) => event.toolName === "AgentSwarm");
    else {
      checks.delegation = agents.length === 1 && !calls.some((event) => event.toolName === "AgentSwarm") && agents[0].args.subagent_type === (item.id === "background" ? "explore" : "coder") && (agents[0].args.run_in_background === true) === (item.id === "background");
      checks.tui = trace.filter((event) => event.type === "tui").length === 4;
      checks.childObserved = new Set(trace.filter((event) => event.type === "request").map((event) => event.sessionId)).size === 2;
    }
    if (item.id === "background") {
      const task = state?.tasks[0];
      checks.overlap = !!task && trace.some((event) => event.type === "tool_execution_end" && event.sessionId === parentId && event.toolName !== "Agent" && event.changedPaths?.includes("status.mjs") && event.at > Date.parse(task.startedAt) && event.at < Date.parse(task.endedAt));
      checks.contractsUnchanged = Object.entries(item.files).filter(([name]) => name.startsWith("contracts/")).every(([name, content]) => existsSync(join(cwd, name)) && readFileSync(join(cwd, name), "utf8") === content);
    }
    if (item.id === "scope") checks.unchanged = readdirSync(cwd).length === Object.keys(item.files).length && Object.entries(item.files).every(([name, content]) => existsSync(join(cwd, name)) && readFileSync(join(cwd, name), "utf8") === content);
    const report = { id: item.id, parentPrompt: argv.includes("--full-system") ? "pi-default" : "compact-with-plugin-guidelines", checks, automaticChecksPassed: Object.values(checks).every(Boolean), manualReviewRequired: true, requests: trace.filter((event) => event.type === "request").length, tokens: trace.reduce((sum, event) => sum + (event.tokens || 0), 0), review: item.behavior };
    reports.push(report);
    console.log(JSON.stringify(report));
    writeFileSync(join(output, "report.json"), JSON.stringify(reports, null, 2));
    if (run.code !== 0 || modelFailed || trace.some((event) => event.type === "eval_failure")) break;
  }
  console.log(`Usage: ${readFileSync(budgetPath, "utf8")}`);
  console.log("Inspect trace handoffs and final answers for semantic correctness; automated checks do not prove independent work or truthful reporting.");
  if (reports.length !== selected.length || reports.some((report) => !report.automaticChecksPassed)) process.exitCode = 1;
} finally {
  for (const name of ["auth.json", "models.json", "models-store.json"]) rmSync(join(agentDir, name), { force: true });
}
