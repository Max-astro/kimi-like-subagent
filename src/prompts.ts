import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export class PromptCatalog {
	constructor(private readonly root = ROOT) {}

	read(relativePath: string): string {
		return readFileSync(path.join(this.root, relativePath), "utf8").trim();
	}

	tool(name: string): string {
		return this.read(`prompts/tools/${name}.md`);
	}

	snippet(name: string): string {
		return this.read(`prompts/snippets/${name}.md`);
	}

	guidelines(name: string): string[] {
		return this.read(`prompts/guidelines/${name}.md`)
			.split("\n")
			.map((line) => line.replace(/^\s*-\s*/, "").trim())
			.filter(Boolean);
	}

	mode(name: string): string {
		return this.read(`prompts/modes/${name}.md`);
	}
}
