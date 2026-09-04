/**
 * Dumps pi's fully-chained system prompt to ./pi-system-prompt.md on agent start.
 * Loaded ad-hoc via `pi -e`, not part of the package's registered extensions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", (_event, ctx) => {
		writeFileSync(join(process.cwd(), "pi-system-prompt.md"), ctx.getSystemPrompt());
	});
}
