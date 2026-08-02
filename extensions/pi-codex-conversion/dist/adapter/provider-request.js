import { isResponsesContext } from "./prompt/codex-model.js";
import { applyCodexRequestOptions } from "./request-options.js";
import { isAdapterRuntime, resolveCodexRuntimePlan } from "./activation/runtime-plan.js";
import { injectPendingNativeWindowIntoPiCompactionRequest, rewriteCodexCompactedProviderRequest } from "./compaction/compaction.js";
import { applyResponsesLiteRequest } from "../providers/openai-codex/responses-lite.js";
function prepareCodexProviderRequest(payload, ctx, state) {
    if (state.config.voiceFeaturesOnly)
        return undefined;
    const plan = resolveCodexRuntimePlan(ctx, state.config);
    if (!isAdapterRuntime(plan) || (!plan.effectiveOpenAICodex && !isResponsesContext(ctx))) {
        return undefined;
    }
    return {
        plan,
        configuredPayload: applyCodexRequestOptions(payload, state.config, {
            serviceTier: plan.effectiveOpenAICodex,
            verbosity: true,
        }),
    };
}
function applyCodexRuntimePayload(payload, codeMode) {
    return codeMode && isCodeModeCompatibleBody(payload) ? applyResponsesLiteRequest(payload) : payload;
}
export function captureActiveProviderSystemPrompt(payload, state) {
    if (!isRecord(payload))
        return;
    const instructions = providerSystemPrompt(payload);
    if (instructions !== undefined)
        state.activeProviderSystemPrompt = instructions;
}
export async function rewriteCodexProviderRequest(payload, ctx, state) {
    const prepared = prepareCodexProviderRequest(payload, ctx, state);
    if (!prepared)
        return undefined;
    const { plan, configuredPayload } = prepared;
    let rewrittenPayload = configuredPayload;
    if (plan.nativeCompaction || state.pendingPiCompactionNativeWindow) {
        const piCompactionPayload = await injectPendingNativeWindowIntoPiCompactionRequest(configuredPayload, ctx, state);
        rewrittenPayload = piCompactionPayload ?? (await rewriteCodexCompactedProviderRequest(configuredPayload, ctx, state)) ?? configuredPayload;
    }
    return applyCodexRuntimePayload(rewrittenPayload, plan.kind === "code");
}
export function rewriteCodexPrewarmProviderRequest(payload, ctx, state) {
    const prepared = prepareCodexProviderRequest(payload, ctx, state);
    return prepared ? applyCodexRuntimePayload(prepared.configuredPayload, prepared.plan.kind === "code") : undefined;
}
function isCodeModeCompatibleBody(value) {
    return typeof value === "object" && value !== null
        && typeof value.model === "string"
        && Array.isArray(value.input);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function providerSystemPrompt(payload) {
    if (typeof payload["instructions"] === "string")
        return payload["instructions"];
    if (!Array.isArray(payload["input"]))
        return undefined;
    for (const item of payload["input"]) {
        if (!isRecord(item) || item["role"] !== "developer" || !Array.isArray(item["content"]))
            continue;
        const text = item["content"]
            .filter((part) => isRecord(part) && part["type"] === "input_text" && typeof part["text"] === "string")
            .map((part) => part["text"])
            .join("\n");
        if (text !== "")
            return text;
    }
    return undefined;
}
