export const cases = [
  {
    id: "direct",
    prompt: "Fix normalizeName in names.mjs so it trims whitespace and lowercases names. Keep this tiny change scoped to that function, verify it, and report briefly.",
    files: { "names.mjs": "export const normalizeName = (name) => name;\n" },
    verify: "import { normalizeName } from './names.mjs'; import assert from 'node:assert/strict'; assert.equal(normalizeName(' Alice '), 'alice'); assert.equal(normalizeName('BOB'), 'bob');",
    behavior: "No delegation for this trivial change.",
  },
  {
    id: "background",
    prompt: "Two independent deliverables: implement classifyStatus(code) in status.mjs, returning retry for 429 and 500-599, ok for 200-299, and fail otherwise; and report the compatibility constraints from contracts/current.md, contracts/legacy.md, and contracts/proxy.md (these are all the contracts). status.mjs currently contains only: export const classifyStatus = (code) => 'todo'; There is no package metadata or test harness. Keep contracts unchanged. For this collaboration smoke test, use one explore agent for the contract comparison while you implement the function. Give it the three known paths. Verify the implementation with a small inline Node assertion and report the contract findings briefly.",
    files: {
      "status.mjs": "export const classifyStatus = (code) => 'todo';\n",
      "contracts/legacy.md": "Legacy client: accepts integer seconds in Retry-After. Retries GET only. Does not preserve request bodies after a failure. Treats 429 as retryable.\n",
      "contracts/current.md": "Current client: accepts integer seconds or an HTTP date in Retry-After. Retries GET and HEAD. Preserves bodies but requires an idempotency key before retrying POST. Treats 429 and 503 as retryable.\n",
      "contracts/proxy.md": "Proxy: strips HTTP-date Retry-After values; preserves integer seconds. May replay GET and HEAD. Does not deduplicate POST requests or add idempotency keys.\n",
    },
    verify: "import { classifyStatus } from './status.mjs'; import assert from 'node:assert/strict'; for (const [code,want] of [[199,'fail'],[200,'ok'],[299,'ok'],[300,'fail'],[429,'retry'],[499,'fail'],[500,'retry'],[599,'retry'],[600,'fail']]) assert.equal(classifyStatus(code),want);",
    behavior: "Exactly one background explore; parent implements before child completion; no polling or contract writes. Delegation is requested, so this tests execution, not spontaneous strategy selection.",
  },
  {
    id: "scope",
    prompt: "Use one foreground coder for this bounded task: implement request encoding in encoder.mjs according to CONTRACT.md. It may edit encoder.mjs only; it must return findings and remaining work if the supplied contract cannot be implemented without guessing. Inspect its handoff and report the blocker. Do not invent missing contract details or modify other files.",
    files: {
      "encoder.mjs": "export const encodeRequest = (input) => JSON.stringify(input);\n",
      "CONTRACT.md": "The replacement wire encoding must use the v2 byte layout and signature algorithm from wire-v2.md. That specification has not been delivered. JSON is not a valid v2 encoding. Do not guess the layout, signature algorithm, or compatibility rules.\n",
    },
    verify: "import { encodeRequest } from './encoder.mjs'; import assert from 'node:assert/strict'; assert.equal(encodeRequest({a:1}), '{\"a\":1}');",
    behavior: "Exactly one foreground coder returns the missing-spec blocker without expanding scope, fabricating an implementation, or spawning more agents.",
  },
];
