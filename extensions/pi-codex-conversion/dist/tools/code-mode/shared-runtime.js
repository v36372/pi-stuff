import { ensureCodeModeHostBinary } from "./binary.js";
import { CodeModeHostClient } from "./host-client.js";
export class SharedCodeModeRuntime {
    providers = new Map();
    clientPromise;
    clientStartupAbort;
    customPromptToolsSnapshot;
    promptSectionSnapshot;
    addProvider(provider) {
        const id = {};
        this.providers.set(id, provider);
        return id;
    }
    removeProvider(id) {
        this.providers.delete(id);
    }
    activeProviders(ctx) {
        return [...this.providers.values()].filter((provider) => !provider.isActive || provider.isActive(ctx));
    }
    collectTools(ctx) {
        const tools = collectUniqueTools(this.activeProviders(ctx), ctx);
        return this.customPromptToolsSnapshot
            ? applyCustomPromptState(tools, this.customPromptToolsSnapshot)
            : tools;
    }
    refreshPromptTools(ctx) {
        const tools = collectUniqueTools(this.activeProviders(ctx), ctx);
        this.customPromptToolsSnapshot = tools.filter(isCustomTool);
        return tools;
    }
    resetPromptTools(ctx) {
        this.promptSectionSnapshot = undefined;
        return this.refreshPromptTools(ctx);
    }
    collectPromptTools(ctx) {
        if (!this.customPromptToolsSnapshot)
            return this.refreshPromptTools(ctx);
        const liveProgrammaticTools = collectUniqueTools(this.activeProviders(ctx), ctx).filter((tool) => !isCustomTool(tool));
        return [...liveProgrammaticTools, ...this.customPromptToolsSnapshot];
    }
    setPromptSection(section) {
        this.promptSectionSnapshot = section;
    }
    getPromptSection() {
        return this.promptSectionSnapshot;
    }
    collectRenderTools() {
        return collectUniqueTools([...this.providers.values()].filter((provider) => provider.providesRenderers));
    }
    useRichRendering() {
        return [...this.providers.values()].find((provider) => provider.richRendering)
            ?.richRendering?.() ?? true;
    }
    async getClient() {
        if (!this.clientPromise) {
            const startupAbort = new AbortController();
            const pending = ensureCodeModeHostBinary(startupAbort.signal).then((binary) => new CodeModeHostClient({ binary, tools: [] }));
            this.clientPromise = pending;
            this.clientStartupAbort = startupAbort;
            void pending.then(() => {
                if (this.clientPromise === pending)
                    this.clientStartupAbort = undefined;
            }, () => {
                if (this.clientPromise !== pending)
                    return;
                this.clientPromise = undefined;
                this.clientStartupAbort = undefined;
            });
        }
        return this.clientPromise;
    }
    prepare(ctx) {
        if (this.activeProviders(ctx).length === 0)
            return undefined;
        return this.getClient().then(() => undefined);
    }
    async shutdownHost() {
        while (this.clientPromise) {
            const pending = this.clientPromise;
            this.clientPromise = undefined;
            this.clientStartupAbort?.abort();
            this.clientStartupAbort = undefined;
            try {
                await (await pending).shutdown();
            }
            catch {
                // Startup failure already reached the caller.
            }
        }
    }
}
function isCustomTool(tool) {
    return "command" in tool;
}
function applyCustomPromptState(tools, customPromptTools) {
    const customPromptState = new Map(customPromptTools.map((tool) => [tool.name, tool.deferLoading]));
    return tools.map((tool) => isCustomTool(tool)
        ? {
            ...tool,
            deferLoading: customPromptState.get(tool.name) ?? true,
        }
        : tool);
}
function collectUniqueTools(providers, ctx) {
    const tools = providers.flatMap((provider) => provider.getTools(ctx));
    const byName = new Map();
    const unique = [];
    for (const tool of tools) {
        const previous = byName.get(tool.name);
        if (previous) {
            if ("sourcePath" in previous &&
                "sourcePath" in tool &&
                previous.sourcePath === tool.sourcePath)
                continue;
            throw new Error(`Duplicate code-mode tool: ${tool.name}`);
        }
        byName.set(tool.name, tool);
        unique.push(tool);
    }
    return unique;
}
