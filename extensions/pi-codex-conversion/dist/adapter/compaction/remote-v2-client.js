import { resolveNativeCompactionRequestBudget, shrinkNativeCompactionRequestForEndpoint } from "./request-shrink.js";
import { canonicalCompactionOutput, normalizeRemoteCompactionV2PromptInput } from "./remote-v2-history.js";
import { withRemoteCompactionV2Feature } from "../../providers/openai-responses/compaction-v2-feature.js";
import { sleep } from "../../providers/openai-codex/sse.js";
import { isWebSocketSseFallbackActive } from "../../providers/openai-codex/websocket.js";
const MAX_STREAM_RETRIES = 2;
function resolveStream(options) {
    const registration = options.modelRegistry.getRegisteredProviderConfig(options.runtime.provider);
    if (options.runtime.provider === "openai-codex") {
        return registration?.api === "openai-codex-responses" && registration.streamSimple
            ? registration.streamSimple
            : undefined;
    }
    return options.runtime.api === "openai-responses"
        && registration?.api === "openai-responses"
        && registration.streamSimple
        ? registration.streamSimple
        : undefined;
}
function isAborted(signal, message) {
    return signal?.aborted === true || /request was aborted|\baborted\b/i.test(message);
}
function shouldRetry(result) {
    if (result.status === 429)
        return false;
    return !/\b(?:401|403)\b|unauthori[sz]ed|forbidden|usage limit|quota|not included|invalid request|context window|unsupported parameter/i.test(result.errorMessage);
}
function compactionUsage(message) {
    const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    const cachedInputTokens = message.usage.cacheRead;
    const cacheWriteInputTokens = message.usage.cacheWrite;
    const outputTokens = message.usage.output;
    if (![inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens].every((value) => Number.isFinite(value) && value >= 0))
        return undefined;
    if (inputTokens + outputTokens === 0)
        return undefined;
    return { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens };
}
async function runAttempt(options, streamSimple) {
    const outputItems = [];
    let responseStatus;
    const streamOptions = {
        ...(options.runtime.apiKey ? { apiKey: options.runtime.apiKey } : {}),
        headers: withRemoteCompactionV2Feature(options.runtime.headers),
        sessionId: options.sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.transport ? { transport: options.transport } : {}),
        maxRetries: options.runtime.provider === "openai-codex" ? MAX_STREAM_RETRIES : 0,
        ...(typeof options.requestOptions.service_tier === "string" ? { serviceTier: options.requestOptions.service_tier } : {}),
        ...(options.requestOptions.text?.verbosity ? { textVerbosity: options.requestOptions.text.verbosity } : {}),
        onOutputItemDone: (item) => outputItems.push(item),
        onResponse: (response) => { responseStatus = response.status; },
        onPayload: async (payload) => {
            const body = payload;
            const promptInput = normalizeRemoteCompactionV2PromptInput(options.promptInput);
            const request = await shrinkNativeCompactionRequestForEndpoint({
                model: body.model,
                input: promptInput,
                ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
            }, { budgetTokens: resolveNativeCompactionRequestBudget({
                    provider: options.runtime.provider,
                    model: options.runtime.model,
                    contextWindow: options.runtime.currentModel.contextWindow,
                }), tokensBefore: options.tokensBefore });
            return {
                ...body,
                input: [...request.request.input, { type: "compaction_trigger" }],
                ...(options.requestOptions.reasoning ? { reasoning: structuredClone(options.requestOptions.reasoning) } : {}),
            };
        },
    };
    let completed;
    let completedNormally = false;
    for await (const rawEvent of streamSimple(options.runtime.currentModel, options.context, streamOptions)) {
        const event = rawEvent;
        if (event.type === "done") {
            completed = event.message;
            completedNormally = event.reason === "stop" && event.message?.stopReason === "stop";
        }
        if (event.type === "error") {
            const message = event.error?.errorMessage || "Responses compaction v2 stream failed";
            return {
                ok: false,
                reason: isAborted(options.signal, message) ? "aborted" : "stream-error",
                errorMessage: message,
                ...(responseStatus !== undefined ? { status: responseStatus } : {}),
            };
        }
    }
    if (!completed?.responseId || !completedNormally) {
        return { ok: false, reason: "stream-error", errorMessage: "Responses compaction v2 stream did not complete normally" };
    }
    const compactions = outputItems.map(canonicalCompactionOutput).filter((item) => item !== undefined);
    if (compactions.length !== 1) {
        return { ok: false, reason: "invalid-output", errorMessage: `Responses compaction v2 expected exactly one compaction output item, got ${compactions.length} from ${outputItems.length} output items` };
    }
    return { ok: true, compaction: compactions[0], responseId: completed.responseId, createdAt: new Date().toISOString(), usage: compactionUsage(completed) };
}
export async function executeRemoteCompactionV2(options) {
    const streamSimple = resolveStream(options);
    if (!streamSimple)
        return { ok: false, reason: "unavailable", errorMessage: "No compatible Responses stream is registered for this provider" };
    const initialTransport = options.runtime.provider === "openai-codex" && isWebSocketSseFallbackActive(options.sessionId)
        ? "sse"
        : options.transport ?? (options.runtime.provider === "openai-codex" ? "websocket-cached" : "sse");
    if (options.runtime.provider === "openai-codex") {
        return runAttempt({ ...options, transport: initialTransport }, streamSimple);
    }
    const transports = [initialTransport];
    const delayMs = Math.max(0, options.retryDelayMs ?? 500);
    let lastFailure;
    for (const transport of transports) {
        for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
            const result = await runAttempt({ ...options, transport }, streamSimple);
            if (result.ok)
                return result;
            if (result.reason === "aborted" || result.reason === "unavailable" || result.reason === "invalid-output" || !shouldRetry(result))
                return result;
            lastFailure = result;
            if (attempt < MAX_STREAM_RETRIES) {
                try {
                    await sleep(delayMs * 2 ** attempt, options.signal);
                }
                catch {
                    return { ok: false, reason: "aborted", errorMessage: "Request was aborted" };
                }
            }
        }
    }
    return lastFailure ?? { ok: false, reason: "stream-error", errorMessage: "Responses compaction v2 failed without a transport attempt" };
}
