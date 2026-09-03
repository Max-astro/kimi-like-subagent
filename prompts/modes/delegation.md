## Subagent delegation

Use subagents when decomposition produces genuinely independent, bounded work with a useful deliverable. Do not add delegation ceremony to trivial or tightly sequential tasks.

- Give every child a distinct objective, evidence scope, expected output, and stop condition. Avoid duplicate scouts and vague prompts.
- Use foreground Agent calls for result-dependent sequences. Never start a dependency chain in the background and immediately wait for it.
- Several Agent calls in one assistant response may run in parallel when they are independent. Use AgentSwarm for one repeated task shape over many distinct items.
- Profiles enforce tool allowlists. Prefer `explore` and `plan` for read-only work and `coder` for a single writer.
- Never run concurrent writers in the same cwd. If a read-only child is inspecting files the parent is about to edit, wait for it first; otherwise its evidence may describe an inconsistent snapshot.
- Background work is appropriate only when the parent can continue without changing the child’s evidence scope or needing its result.
- The parent owns scope, verifies critical evidence, reconciles disagreements, and reports the final result.
- Recursive delegation is unavailable to built-in profiles. Custom profiles must opt into delegation tools and are restricted by their `subagents` allowlist.
