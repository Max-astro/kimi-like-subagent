import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelBinding, PluginConfig } from "./types.ts";

function primary(ctx: ExtensionContext, source: "inherited" | "primary"): ModelBinding {
	if (!ctx.model) throw new Error("No primary model is selected in the parent session");
	return {
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel ?? "medium",
		alias: "primary",
		source,
	};
}

function splitModel(value: string): [string, string] {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) throw new Error(`Invalid model reference: ${value}`);
	return [value.slice(0, slash), value.slice(slash + 1)];
}

export function resolveModelBinding(
	config: PluginConfig,
	ctx: ExtensionContext,
	requestedAlias?: string,
): ModelBinding {
	const pool = config.secondaryModel;
	if (!pool?.models) {
		if (requestedAlias && requestedAlias !== "primary") {
			throw new Error("The model parameter is unavailable until secondary_model.models is configured");
		}
		return primary(ctx, "inherited");
	}
	if (pool.force && requestedAlias !== undefined) {
		throw new Error("The model parameter cannot override secondary_model force mode");
	}

	const alias = pool.force ? pool.defaultModel! : requestedAlias ?? pool.defaultModel!;
	if (alias === "primary") return primary(ctx, "primary");
	const entry = pool.models[alias];
	if (!entry) throw new Error(`Unknown model alias: ${alias}. Expected one of: ${Object.keys(pool.models).join(", ")}, primary`);
	const [provider, modelId] = splitModel(entry.model);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Configured model not found: ${entry.model}`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No configured authentication for model: ${entry.model}`);
	return {
		model,
		thinkingLevel: entry.thinkingLevel ?? pool.defaultThinkingLevel ?? ctx.thinkingLevel ?? "medium",
		alias,
		source: pool.force ? "forced" : "secondary",
	};
}
