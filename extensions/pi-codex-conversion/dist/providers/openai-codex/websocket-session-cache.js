import { closeWebSocketSilently, connectWebSocket, isWebSocketReusable } from "./websocket-connection.js";
const websocketSessionCache = new Map();
const websocketSseFallbackSessions = new Set();
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
export function isWebSocketSseFallbackActive(sessionId) {
    return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}
export function recordWebSocketSseFallback(sessionId) {
    if (sessionId)
        websocketSseFallbackSessions.add(sessionId);
}
function isWebSocketSessionExpired(entry) {
    return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}
function scheduleSessionWebSocketExpiry(cacheKey, entry) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
    }
    const remainingLifetimeMs = Math.max(0, SESSION_WEBSOCKET_MAX_AGE_MS - (Date.now() - entry.createdAt));
    entry.idleTimer = setTimeout(() => {
        if (entry.busy)
            return;
        closeWebSocketSilently(entry.socket, 1000, "connection_age_limit");
        websocketSessionCache.delete(cacheKey);
    }, remainingLifetimeMs);
}
function closeWebSocketSessions(sessionId) {
    const closeEntry = (entry) => {
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;
        }
        closeWebSocketSilently(entry.socket, 1000, "session_shutdown");
    };
    if (sessionId) {
        const entry = websocketSessionCache.get(sessionId);
        if (entry)
            closeEntry(entry);
        websocketSessionCache.delete(sessionId);
        return;
    }
    for (const entry of websocketSessionCache.values()) {
        closeEntry(entry);
    }
    websocketSessionCache.clear();
}
export function resetOpenAICodexWebSocketSessions(sessionId) {
    closeWebSocketSessions(sessionId);
}
export function closeOpenAICodexWebSocketSessions(sessionId) {
    closeWebSocketSessions(sessionId);
    if (sessionId) {
        websocketSseFallbackSessions.delete(sessionId);
        return;
    }
    websocketSseFallbackSessions.clear();
}
export async function acquireWebSocket(url, headers, sessionId, signal, connectTimeoutMs, env) {
    if (!sessionId) {
        const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
        return {
            socket,
            reused: false,
            release: ({ keep } = {}) => {
                if (keep === false) {
                    closeWebSocketSilently(socket);
                    return;
                }
                closeWebSocketSilently(socket);
            },
        };
    }
    const cached = websocketSessionCache.get(sessionId);
    if (cached) {
        if (cached.idleTimer) {
            clearTimeout(cached.idleTimer);
            cached.idleTimer = undefined;
        }
        if (!cached.busy && isWebSocketSessionExpired(cached)) {
            closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
            websocketSessionCache.delete(sessionId);
        }
        else if (!cached.busy && isWebSocketReusable(cached.socket)) {
            cached.busy = true;
            return {
                socket: cached.socket,
                entry: cached,
                reused: true,
                release: ({ keep } = {}) => {
                    if (!keep || !isWebSocketReusable(cached.socket)) {
                        closeWebSocketSilently(cached.socket);
                        websocketSessionCache.delete(sessionId);
                        return;
                    }
                    cached.busy = false;
                    scheduleSessionWebSocketExpiry(sessionId, cached);
                },
            };
        }
        if (cached.busy) {
            const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
            return {
                socket,
                reused: false,
                release: () => {
                    closeWebSocketSilently(socket);
                },
            };
        }
        if (!isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            websocketSessionCache.delete(sessionId);
        }
    }
    const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
    const entry = { socket, busy: true, createdAt: Date.now() };
    websocketSessionCache.set(sessionId, entry);
    return {
        socket,
        entry,
        reused: false,
        release: ({ keep } = {}) => {
            if (!keep || !isWebSocketReusable(entry.socket)) {
                closeWebSocketSilently(entry.socket);
                if (entry.idleTimer)
                    clearTimeout(entry.idleTimer);
                if (websocketSessionCache.get(sessionId) === entry) {
                    websocketSessionCache.delete(sessionId);
                }
                return;
            }
            entry.busy = false;
            scheduleSessionWebSocketExpiry(sessionId, entry);
        },
    };
}
