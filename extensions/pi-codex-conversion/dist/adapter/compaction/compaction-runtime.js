export const DEFAULT_SUPPORTED_PROVIDERS = ["openai", "openai-codex"];
export const DEFAULT_SUPPORTED_APIS = ["openai-responses", "openai-codex-responses"];
function normalizeConfiguredSet(values, defaults) {
    const source = values && values.length > 0 ? values : defaults;
    return new Set(source.map((value) => value.trim()).filter((value) => value.length > 0));
}
function normalizeConfiguredProviderSet(values) {
    return new Set([...normalizeConfiguredSet(values, DEFAULT_SUPPORTED_PROVIDERS)].map((value) => value.toLowerCase()));
}
export function normalizeBaseUrl(baseUrl) {
    const normalized = baseUrl?.trim().replace(/\/+$/, "");
    return normalized ? normalized : undefined;
}
async function resolveRequestAuth(ctx, model) {
    const modelRegistry = ctx.modelRegistry;
    if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
        return {};
    }
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    return auth && auth.ok ? { apiKey: auth.apiKey, headers: auth.headers } : {};
}
export function isSupportedApi(api) {
    return DEFAULT_SUPPORTED_APIS.includes(api);
}
export function isResponsesCompatiblePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return false;
    }
    const candidate = payload;
    return typeof candidate["model"] === "string" && Array.isArray(candidate["input"]);
}
export function getRuntimeModelDescriptor(model) {
    if (!model) {
        return {};
    }
    return {
        provider: model.provider,
        api: model.api,
        model: model.id,
        baseUrl: normalizeBaseUrl(model.baseUrl),
    };
}
export async function resolveNativeCompactionEnvironment(ctx, options = {}, payload) {
    if (options.enabled === false) {
        return {
            ok: false,
            reason: "disabled",
        };
    }
    const currentModel = ctx.model;
    const descriptor = getRuntimeModelDescriptor(currentModel);
    if (!currentModel || !descriptor.provider || !descriptor.api || !descriptor.model) {
        return {
            ok: false,
            reason: "missing-model",
            ...descriptor,
        };
    }
    const supportedProviders = normalizeConfiguredProviderSet(options.supportedProviders);
    if (!supportedProviders.has(descriptor.provider.trim().toLowerCase())) {
        return {
            ok: false,
            reason: "unsupported-provider",
            ...descriptor,
        };
    }
    const supportedApis = normalizeConfiguredSet(options.supportedApis, DEFAULT_SUPPORTED_APIS);
    if (!supportedApis.has(descriptor.api)) {
        return {
            ok: false,
            reason: "unsupported-api",
            ...descriptor,
        };
    }
    if (!isSupportedApi(descriptor.api)) {
        return {
            ok: false,
            reason: "unsupported-api",
            ...descriptor,
        };
    }
    if (!descriptor.baseUrl) {
        return {
            ok: false,
            reason: "missing-base-url",
            ...descriptor,
        };
    }
    let requestPayload;
    if (payload !== undefined) {
        if (!isResponsesCompatiblePayload(payload)) {
            return {
                ok: false,
                reason: "unsupported-payload",
                ...descriptor,
            };
        }
        if (payload.model !== descriptor.model) {
            return {
                ok: false,
                reason: "payload-model-mismatch",
                ...descriptor,
            };
        }
        requestPayload = payload;
    }
    const { apiKey, headers } = await resolveRequestAuth(ctx, currentModel);
    const hasAuthorizationHeader = Object.entries(headers ?? {}).some(([key, value]) => key.toLowerCase() === "authorization" && value.trim().length > 0);
    if (!apiKey && !hasAuthorizationHeader) {
        return {
            ok: false,
            reason: "missing-api-key",
            ...descriptor,
        };
    }
    return {
        ok: true,
        runtime: {
            provider: descriptor.provider,
            api: descriptor.api,
            apiFamily: descriptor.api,
            model: descriptor.model,
            baseUrl: descriptor.baseUrl,
            apiKey,
            headers,
            payload: requestPayload,
            currentModel,
        },
    };
}
export async function getNativeCompactionRuntime(ctx, options = {}, payload) {
    const resolution = await resolveNativeCompactionEnvironment(ctx, options, payload);
    return resolution.ok ? resolution.runtime : undefined;
}
