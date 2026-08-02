import { createAssistantMessageEventStream, } from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "./constrained-sampling.js";
import { resolveCodexRuntimePlan } from "../adapter/activation/runtime-plan.js";
import { buildRequestBody } from "./openai-codex/request-body.js";
import { applyResponsesLiteRequest, isResponsesLiteRequest, prepareResponsesLiteRequestImages, RESPONSES_LITE_HEADER } from "./openai-codex/responses-lite.js";
import { assertSuccessfulCodexOutput, processCodexResponsesStream } from "./openai-codex/stream-events.js";
function initialAssistantMessage(model) {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
    };
}
function mergeHeaders(...groups) {
    const headers = new Map();
    for (const group of groups) {
        for (const [name, value] of Object.entries(group ?? {})) {
            headers.set(name.toLowerCase(), { name, value });
        }
    }
    return Object.fromEntries([...headers.values()].map(({ name, value }) => [name, value]));
}
function hasHeader(headers, name) {
    const expected = name.toLowerCase();
    return Object.entries(headers ?? {}).some(([key, value]) => key.toLowerCase() === expected && value !== null && value.trim() !== "");
}
function clientAuth(provider, apiKey, headers) {
    if (apiKey)
        return { apiKey, headers };
    if (hasHeader(headers, "authorization"))
        return { apiKey: "unused", headers };
    if (hasHeader(headers, "cf-aig-authorization")) {
        return { apiKey: "unused", headers: mergeHeaders(headers, { Authorization: null }) };
    }
    throw new Error(`No API key for provider: ${provider}`);
}
async function reportErrorResponse(error, options, model, APIError) {
    if (!(error instanceof APIError) || error.status === undefined || !error.headers)
        return;
    await options?.onResponse?.({
        status: error.status,
        headers: Object.fromEntries(error.headers.entries()),
    }, model);
}
export function streamCodeModeResponsesProxy(model, context, options) {
    const stream = createAssistantMessageEventStream();
    const output = initialAssistantMessage(model);
    void (async () => {
        try {
            const { default: OpenAI, APIError } = await import("openai");
            const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, true);
            const effectiveOptions = { ...options, grammarToolInputProperties };
            let headers = mergeHeaders(model.headers, options?.headers);
            let body = buildRequestBody(model, context, effectiveOptions);
            const rewritten = await options?.onPayload?.(body, model);
            if (rewritten !== undefined)
                body = rewritten;
            body = isResponsesLiteRequest(body)
                ? { ...body, parallel_tool_calls: false }
                : applyResponsesLiteRequest(body);
            body = await prepareResponsesLiteRequestImages(body);
            headers = mergeHeaders(headers, { [RESPONSES_LITE_HEADER]: "true" });
            const auth = clientAuth(model.provider, options?.apiKey, headers);
            const client = new OpenAI({
                apiKey: auth.apiKey,
                baseURL: model.baseUrl,
                defaultHeaders: auth.headers,
            });
            let response;
            try {
                response = await client.responses.create(body, {
                    ...(options?.signal ? { signal: options.signal } : {}),
                    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
                    maxRetries: options?.maxRetries ?? 0,
                }).withResponse();
            }
            catch (error) {
                await reportErrorResponse(error, options, model, APIError);
                throw error;
            }
            await options?.onResponse?.({
                status: response.response.status,
                headers: Object.fromEntries(response.response.headers.entries()),
            }, model);
            stream.push({ type: "start", partial: output });
            await processCodexResponsesStream(response.data, output, stream, model, effectiveOptions);
            if (options?.signal?.aborted)
                throw new Error("Request was aborted");
            assertSuccessfulCodexOutput(output);
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            for (const block of output.content) {
                if (typeof block === "object" && block !== null)
                    delete block.partialJson;
            }
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = error instanceof Error ? error.message : String(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
}
function configuredProxyProviders(config) {
    return new Set(!config.voiceFeaturesOnly && config.beta.codeMode && config.beta.responsesLite
        ? config.scope.additionalProviders.filter((provider) => provider !== "openai-codex")
        : []);
}
function resolveProviderIds(configuredProviders, modelRegistry) {
    const resolved = new Set();
    for (const model of modelRegistry.getAll()) {
        if (model.api === "openai-responses" && configuredProviders.has(model.provider.trim().toLowerCase()))
            resolved.add(model.provider);
    }
    return resolved;
}
export function registerCodeModeProxyProvider(pi, getConfig) {
    const registeredProviders = new Map();
    const restoreProvider = (provider, registration) => {
        const current = registration.modelRegistry.getRegisteredProviderConfig?.(provider);
        if (!current || current.streamSimple !== registration.overlayStream)
            return;
        const restored = { ...current };
        if (registration.previous?.streamSimple)
            restored.streamSimple = registration.previous.streamSimple;
        else
            delete restored.streamSimple;
        if (registration.previous?.api)
            restored.api = registration.previous.api;
        else if (!registration.previous?.streamSimple && current.api === "openai-responses")
            delete restored.api;
        pi.unregisterProvider(provider);
        if (Object.keys(restored).length > 0)
            pi.registerProvider(provider, restored);
    };
    const shutdown = () => {
        for (const [provider, registration] of registeredProviders)
            restoreProvider(provider, registration);
        registeredProviders.clear();
    };
    const applyConfig = (config, modelRegistry) => {
        const configuredProviders = configuredProxyProviders(config);
        const desiredProviders = resolveProviderIds(configuredProviders, modelRegistry);
        for (const provider of desiredProviders) {
            if (registeredProviders.has(provider))
                continue;
            const previous = modelRegistry.getRegisteredProviderConfig(provider);
            if (previous?.streamSimple && previous.api !== "openai-responses")
                continue;
            const fallbackProvider = modelRegistry.getProvider(provider);
            if (!fallbackProvider)
                throw new Error(`Cannot overlay missing provider: ${provider}`);
            const overlayStream = (model, context, options) => resolveCodexRuntimePlan({ model }, getConfig()).kind === "code"
                ? streamCodeModeResponsesProxy(model, context, options)
                : fallbackProvider.streamSimple(model, context, options);
            pi.registerProvider(provider, {
                api: "openai-responses",
                streamSimple: overlayStream,
            });
            registeredProviders.set(provider, { previous, overlayStream, modelRegistry });
        }
        for (const [provider, registration] of registeredProviders) {
            if (desiredProviders.has(provider))
                continue;
            restoreProvider(provider, registration);
            registeredProviders.delete(provider);
        }
    };
    return { applyConfig, shutdown };
}
