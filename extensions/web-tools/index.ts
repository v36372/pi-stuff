import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { syncWebToolScope } from "./model-scope.ts";
import { createWebFetchTool } from "./webfetch.ts";
import { createWebSearchTool } from "./websearch.ts";

export default function webToolsExtension(pi: ExtensionAPI) {
	pi.registerTool(createWebFetchTool());
	pi.registerTool(createWebSearchTool());

	const suppressedTools = new Set<string>();
	const sync = (provider: string | undefined) => syncWebToolScope(pi, provider, suppressedTools);
	pi.on("session_start", (_event, ctx) => sync(ctx.model?.provider));
	pi.on("model_select", (event) => sync(event.model.provider));
	pi.on("before_agent_start", (_event, ctx) => sync(ctx.model?.provider));
}
