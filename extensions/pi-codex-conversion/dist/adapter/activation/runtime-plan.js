import { supportsNativeImageGeneration, supportsNativeWebSearch, supportsViewImageInputs } from "../tool-support.js";
import { supportsResponsesLiteModel } from "../../providers/openai-codex/responses-lite-model.js";
import { isCodexLikeModel, isOpenAICodexContext, isOpenAIResponsesContext, isResponsesContext } from "../prompt/codex-model.js";
import { APPLY_PATCH_TOOL_NAME, CODE_MODE_TOOL_NAMES, CORE_ADAPTER_TOOL_NAMES, IMAGE_GENERATION_TOOL_NAME, SHELL_ADAPTER_TOOL_NAMES, VIEW_IMAGE_TOOL_NAME, WEB_SEARCH_TOOL_NAME, } from "./tool-set.js";
const ALL_ADAPTER_TOOL_NAMES = [
    ...CORE_ADAPTER_TOOL_NAMES,
    ...CODE_MODE_TOOL_NAMES,
    WEB_SEARCH_TOOL_NAME,
    IMAGE_GENERATION_TOOL_NAME,
    VIEW_IMAGE_TOOL_NAME,
];
function configuredProvider(ctx, config) {
    const provider = ctx.model?.provider?.trim().toLowerCase();
    return Boolean(provider && isResponsesContext(ctx) && config.scope.additionalProviders.includes(provider));
}
function proxySupportsCodeMode(ctx, config) {
    if (!config.beta.responsesLite || !configuredProvider(ctx, config) || !isOpenAIResponsesContext(ctx))
        return false;
    const modelId = ctx.model?.id;
    if (!modelId)
        return false;
    const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
    return /^gpt-5\.6(?:-(?:luna|terra|sol))?$/.test(id.toLowerCase());
}
function codeModeEnabled(ctx, config) {
    if (!config.beta.codeMode)
        return false;
    return isOpenAICodexContext(ctx)
        ? supportsResponsesLiteModel(ctx.model?.id)
        : proxySupportsCodeMode(ctx, config);
}
function hasExtras(config) {
    const tools = config.tools;
    return tools.applyPatchOnly || tools.viewImageOnly || tools.webRunOnly || tools.imageGenerationOnly;
}
export function usesCodexProviderFallback(config) {
    return config.scope.allProviders !== "off";
}
function extraToolNames(ctx, config, codexBacked) {
    const names = [];
    if (config.tools.applyPatchOnly)
        names.push(APPLY_PATCH_TOOL_NAME);
    if (config.tools.viewImageOnly && (supportsViewImageInputs(ctx.model) || config.tools.viewImageFallback))
        names.push(VIEW_IMAGE_TOOL_NAME);
    if (config.tools.webRunOnly && (supportsNativeWebSearch(ctx.model) || codexBacked))
        names.push(WEB_SEARCH_TOOL_NAME);
    if (config.tools.imageGenerationOnly && (supportsNativeImageGeneration(ctx.model) || codexBacked))
        names.push(IMAGE_GENERATION_TOOL_NAME);
    return names;
}
function normalToolNames(ctx, config, codexBacked) {
    const names = [...CORE_ADAPTER_TOOL_NAMES];
    if (config.tools.webRun && (supportsNativeWebSearch(ctx.model) || codexBacked))
        names.push(WEB_SEARCH_TOOL_NAME);
    if (config.tools.imageGeneration && (supportsNativeImageGeneration(ctx.model) || codexBacked))
        names.push(IMAGE_GENERATION_TOOL_NAME);
    if (supportsViewImageInputs(ctx.model) || config.tools.viewImageFallback)
        names.push(VIEW_IMAGE_TOOL_NAME);
    return names;
}
export function resolveCodexRuntimePlan(ctx, config) {
    const isConfigured = configuredProvider(ctx, config);
    const effectiveOpenAICodex = isOpenAICodexContext(ctx) || isConfigured;
    const ownedToolNames = [
        ...SHELL_ADAPTER_TOOL_NAMES,
        ...CODE_MODE_TOOL_NAMES,
        APPLY_PATCH_TOOL_NAME,
        VIEW_IMAGE_TOOL_NAME,
        ...(config.tools.webRun ? [WEB_SEARCH_TOOL_NAME] : []),
        ...(config.tools.imageGeneration ? [IMAGE_GENERATION_TOOL_NAME] : []),
    ];
    const base = {
        ownedToolNames,
        configuredProvider: isConfigured,
        effectiveOpenAICodex,
        nativeCompaction: false,
    };
    const extras = hasExtras(config)
        && (config.scope.allProviders === "extras"
            || (config.voiceFeaturesOnly && config.scope.allProviders === "on")
            || (config.scope.allProviders === "off" && (isConfigured || isCodexLikeModel(ctx.model))));
    const codexBacked = usesCodexProviderFallback(config) || isConfigured;
    if (extras) {
        return { ...base, kind: "extras", toolNames: extraToolNames(ctx, config, codexBacked), prompt: undefined, transport: "responses" };
    }
    if (config.voiceFeaturesOnly)
        return { ...base, kind: "inactive", toolNames: [], prompt: undefined, transport: undefined };
    const active = config.scope.allProviders === "on" || isConfigured || isCodexLikeModel(ctx.model);
    if (!active)
        return { ...base, kind: "inactive", toolNames: [], prompt: undefined, transport: undefined };
    const nativeCompaction = config.compaction.responsesCompaction && effectiveOpenAICodex;
    if (codeModeEnabled(ctx, config)) {
        return { ...base, kind: "code", toolNames: [...CODE_MODE_TOOL_NAMES], prompt: "code", transport: "responses-lite", nativeCompaction };
    }
    return {
        ...base,
        kind: "normal",
        toolNames: normalToolNames(ctx, config, codexBacked),
        prompt: "normal",
        transport: "responses",
        nativeCompaction,
    };
}
export function isAdapterRuntime(plan) {
    return plan.kind === "normal" || plan.kind === "code";
}
export const ALL_CODEX_ADAPTER_TOOL_NAMES = ALL_ADAPTER_TOOL_NAMES;
