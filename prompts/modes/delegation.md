## Subagent delegation

Subagents run through the Agent and AgentSwarm tools; each tool's description carries its full usage contract.

- Give every child a distinct objective, evidence scope, expected output, and stop condition. Avoid duplicate scouts and vague prompts.
- Several Agent calls in one assistant response may run in parallel when they are independent.
- Never run concurrent writers in the same cwd. If a read-only child is inspecting files the parent is about to edit, wait for it first; otherwise its evidence may describe an inconsistent snapshot.
- Background work is appropriate only when the parent can continue without changing the child’s evidence scope or needing its result.
- The parent owns scope, verifies critical evidence, reconciles disagreements, and reports the final result.
- Recursive delegation is unavailable to built-in profiles. Custom profiles must opt into delegation tools and are restricted by their `subagents` allowlist.
