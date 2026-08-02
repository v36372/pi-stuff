import { ALL_CODEX_ADAPTER_TOOL_NAMES, isAdapterRuntime, resolveCodexRuntimePlan } from "./runtime-plan.js";
import { DEFAULT_TOOL_NAMES, STATUS_KEY, buildExtraToolsOnlyStatusText, buildStatusText } from "./tool-set.js";
import { isResponsesContext } from "../prompt/codex-model.js";
export function syncAdapter(pi, ctx, state) {
    const plan = resolveCodexRuntimePlan(ctx, state.config);
    if (plan.kind === "extras")
        enableExtraTools(pi, ctx, state, plan);
    else if (isAdapterRuntime(plan))
        enableAdapter(pi, ctx, state, plan);
    else
        disableAdapter(pi, ctx, state, plan);
    return plan;
}
function enableExtraTools(pi, ctx, state, plan) {
    if (!state.enabled || !sameToolSet(state.adapterOwnedToolNames ?? [], plan.toolNames)) {
        state.previousToolNames = state.enabled
            ? restoreTools(state.previousToolNames?.length ? state.previousToolNames : DEFAULT_TOOL_NAMES, pi.getActiveTools(), state.adapterOwnedToolNames ?? ALL_CODEX_ADAPTER_TOOL_NAMES)
            : stripAdapterTools(pi.getActiveTools(), ALL_CODEX_ADAPTER_TOOL_NAMES);
        state.enabled = true;
    }
    state.adapterOwnedToolNames = plan.toolNames;
    pi.setActiveTools(mergeToolNames(state.previousToolNames ?? DEFAULT_TOOL_NAMES, plan.toolNames));
    if (ctx.hasUI)
        ctx.ui.setStatus(STATUS_KEY, !state.config.voiceFeaturesOnly && state.config.ui.statusLine ? buildExtraToolsOnlyStatusText(plan.toolNames, ctx.ui.theme) : undefined);
}
function enableAdapter(pi, ctx, state, plan) {
    const owned = state.enabled ? mergeToolNames(state.adapterOwnedToolNames ?? plan.ownedToolNames, plan.ownedToolNames) : plan.ownedToolNames;
    const tools = mergeAdapterTools(pi.getActiveTools(), plan.toolNames, owned);
    if (!state.enabled) {
        state.previousToolNames = stripAdapterTools(pi.getActiveTools(), owned);
        state.enabled = true;
    }
    state.adapterOwnedToolNames = plan.ownedToolNames;
    pi.setActiveTools(tools);
    setStatus(ctx, state, plan);
}
function disableAdapter(pi, ctx, state, plan) {
    const previous = state.previousToolNames?.length ? state.previousToolNames : DEFAULT_TOOL_NAMES;
    const owned = state.adapterOwnedToolNames ?? plan.ownedToolNames;
    if (state.enabled || pi.getActiveTools().some((name) => owned.includes(name))) {
        pi.setActiveTools(restoreTools(previous, pi.getActiveTools(), owned));
    }
    state.enabled = false;
    delete state.adapterOwnedToolNames;
    if (ctx.hasUI)
        ctx.ui.setStatus(STATUS_KEY, undefined);
}
function setStatus(ctx, state, plan) {
    if (!ctx.hasUI)
        return;
    if (!state.config.ui.statusLine) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
    }
    const config = state.config;
    ctx.ui.setStatus(STATUS_KEY, buildStatusText({
        mode: plan.kind,
        useOnAllModels: config.scope.allProviders === "on",
        additionalProvider: plan.configuredProvider,
        fast: plan.effectiveOpenAICodex && config.openai.fast,
        webSearch: plan.toolNames.includes("web_run"),
        imageGeneration: plan.toolNames.includes("imagegen"),
        compaction: plan.nativeCompaction,
        ...(isResponsesContext(ctx) ? { verbosity: config.openai.verbosity } : {}),
    }, ctx.ui.theme));
}
function mergeToolNames(...groups) {
    return [...new Set(groups.flat())];
}
export function mergeAdapterTools(activeTools, adapterTools, adapterOwnedTools = adapterTools) {
    const owned = new Set([...adapterTools, ...adapterOwnedTools]);
    const preserved = activeTools.filter((name) => !DEFAULT_TOOL_NAMES.includes(name) && !owned.has(name));
    return [...adapterTools, ...preserved];
}
export function restoreTools(previousTools, activeTools, adapterOwnedTools = ALL_CODEX_ADAPTER_TOOL_NAMES) {
    const restored = stripAdapterTools(previousTools, adapterOwnedTools);
    for (const name of activeTools)
        if (!adapterOwnedTools.includes(name) && !restored.includes(name))
            restored.push(name);
    return restored;
}
export function stripAdapterTools(toolNames, adapterOwnedTools = ALL_CODEX_ADAPTER_TOOL_NAMES) {
    return toolNames.filter((name) => !adapterOwnedTools.includes(name));
}
function sameToolSet(left, right) {
    return left.length === right.length && left.every((name) => right.includes(name));
}
