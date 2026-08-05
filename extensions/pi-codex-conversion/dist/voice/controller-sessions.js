export async function startControllerConversation(options) {
    if (options.signal?.aborted) {
        await options.peer?.close();
        return;
    }
    const { CodexRealtimeConversation } = await import("./conversation/session.js");
    if (!options.lifecycle.stillAuthorizing() || options.signal?.aborted) {
        await options.peer?.close();
        return;
    }
    const realtimePeer = options.peer ?? new (await import("./conversation/native-peer.js")).NativeCodexRealtimePeer();
    if (!options.lifecycle.stillAuthorizing() || options.signal?.aborted) {
        await realtimePeer.close();
        return;
    }
    let session;
    session = new CodexRealtimeConversation({
        onError: (error) => options.lifecycle.onError(session, error),
        onStatus: options.lifecycle.onStatus,
        onTurn: options.lifecycle.onTurn,
        onUserTranscript: options.lifecycle.onUserTranscript,
        onTranscriptTail: options.lifecycle.onTranscriptTail,
    }, realtimePeer);
    options.lifecycle.onCreated(session);
    if (options.signal?.aborted) {
        await session.close();
        return;
    }
    const closeOnAbort = () => { void session.close(); };
    options.signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
        await session.start(options.auth, options.config, options.instructions, options.initialItems);
    }
    finally {
        options.signal?.removeEventListener("abort", closeOnAbort);
    }
    if (options.lifecycle.isCurrent(session))
        options.lifecycle.onActive(session);
    else
        await session.close();
}
export async function startControllerDictation(options) {
    const { CodexDictationSession } = await import("./dictation/session.js");
    if (!options.lifecycle.stillAuthorizing())
        return;
    let session;
    session = new CodexDictationSession({
        onError: (error) => options.lifecycle.onError(session, error),
        onStatus: options.lifecycle.onStatus,
        onTranscript: options.lifecycle.onTranscript,
    });
    options.lifecycle.onCreated(session);
    await session.start(options.auth, options.config);
    if (options.lifecycle.isCurrent(session))
        options.lifecycle.onActive(session);
    else
        await session.close();
}
