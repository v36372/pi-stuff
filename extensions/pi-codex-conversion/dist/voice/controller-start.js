import { resolveCodexVoiceAuth } from "./auth.js";
import { CANCELLED, interruptible } from "./cancellation.js";
import { buildRealtimeInitialItems, } from "./context.js";
import { startControllerConversation, startControllerDictation, } from "./controller-sessions.js";
import { currentVoiceSession, VOICE_STATUS_KEY, } from "./controller-support.js";
export async function startControllerMode(options) {
    const { runtime, peer, signal } = options;
    if (signal?.aborted) {
        await peer?.close();
        return;
    }
    const realtimePrompt = options.mode === "realtime"
        ? options.prepareRealtimePrompt(options.ctx)
        : undefined;
    if (options.mode === "realtime" && realtimePrompt === undefined)
        return;
    if (runtime.state.type === "dictation")
        await options.finishCurrentDictation();
    else
        await options.stopCurrent();
    if (signal?.aborted) {
        await peer?.close();
        return;
    }
    const startAbortController = new AbortController();
    runtime.startAbortController = startAbortController;
    const startSignal = signal
        ? AbortSignal.any([signal, startAbortController.signal])
        : startAbortController.signal;
    const startGeneration = ++runtime.startGeneration;
    runtime.context = options.ctx;
    runtime.config = options.config;
    options.messages.setContext(options.ctx);
    runtime.state =
        options.mode === "realtime"
            ? { type: "connecting", mode: "realtime", phase: "authorizing" }
            : { type: "connecting", mode: "dictation", phase: "authorizing" };
    options.onStatus("connecting…");
    let realtimeSummary;
    try {
        const startup = await interruptible(Promise.all([
            resolveCodexVoiceAuth(options.ctx),
            options.mode === "realtime"
                ? buildRealtimeInitialItems({
                    ctx: options.ctx,
                    config: options.config,
                    onSummary: (summary) => {
                        realtimeSummary = summary;
                    },
                    signal: startSignal,
                })
                : Promise.resolve(undefined),
        ]), startSignal);
        if (startup === CANCELLED) {
            await peer?.close();
            cancelStart(runtime, startGeneration);
            return;
        }
        const [auth, initialItems] = startup;
        if (startGeneration !== runtime.startGeneration ||
            runtime.state.type !== "connecting") {
            await peer?.close();
            return;
        }
        if (options.mode === "dictation")
            await startDictation(options, auth);
        else
            await startConversation(options, auth, realtimePrompt, initialItems, startSignal);
        if (startSignal.aborted) {
            await peer?.close();
            cancelStart(runtime, startGeneration);
            return;
        }
        const activeState = snapshotState(runtime);
        if (options.mode === "realtime") {
            if (activeState.type !== "conversation") {
                await peer?.close();
                return;
            }
            if (realtimeSummary)
                options.messages.contextSummary(realtimeSummary);
            runtime.announcedMode = options.mode;
            options.messages.modeStarted(options.mode);
            return activeState.session;
        }
        if (activeState.type !== "dictation")
            return;
        runtime.announcedMode = options.mode;
        options.messages.modeStarted(options.mode);
        return undefined;
    }
    catch (error) {
        if (startSignal.aborted) {
            await peer?.close();
            cancelStart(runtime, startGeneration);
            return;
        }
        if (startGeneration !== runtime.startGeneration) {
            await peer?.close();
            return;
        }
        options.onError(error instanceof Error ? error : new Error(String(error)));
        return undefined;
    }
}
async function startConversation(options, auth, instructions, initialItems, signal) {
    const { runtime } = options;
    const connecting = runtime.state;
    if (connecting.type !== "connecting" ||
        connecting.mode !== "realtime" ||
        connecting.phase !== "authorizing")
        return;
    await startControllerConversation({
        auth,
        config: options.config,
        instructions,
        initialItems,
        peer: options.peer,
        signal,
        lifecycle: {
            stillAuthorizing: () => runtime.state === connecting,
            onCreated: (session) => {
                runtime.state = {
                    type: "connecting",
                    mode: "realtime",
                    phase: "starting",
                    session,
                };
            },
            isCurrent: (session) => currentVoiceSession(runtime.state) === session,
            onActive: (session) => {
                runtime.state = { type: "conversation", session };
            },
            onError: (session, error) => {
                if (currentVoiceSession(runtime.state) === session)
                    options.onError(error);
            },
            onStatus: options.onStatus,
            onTurn: (turn) => options.messages.voiceTurn(turn),
            onUserTranscript: (transcript) => options.messages.userTranscript(transcript),
            onTranscriptTail: (transcript) => options.messages.retainTranscriptTail(transcript),
        },
    });
}
async function startDictation(options, auth) {
    const { runtime } = options;
    const connecting = runtime.state;
    if (connecting.type !== "connecting" ||
        connecting.mode !== "dictation" ||
        connecting.phase !== "authorizing")
        return;
    await startControllerDictation({
        auth,
        config: options.config,
        lifecycle: {
            stillAuthorizing: () => runtime.state === connecting,
            onCreated: (session) => {
                runtime.state = {
                    type: "connecting",
                    mode: "dictation",
                    phase: "starting",
                    session,
                };
            },
            isCurrent: (session) => currentVoiceSession(runtime.state) === session,
            onActive: (session) => {
                runtime.state = { type: "dictation", session };
            },
            onError: (session, error) => {
                if (currentVoiceSession(runtime.state) === session)
                    options.onError(error);
            },
            onStatus: options.onStatus,
            onTranscript: (transcript) => runtime.context?.ui.pasteToEditor(transcript),
        },
    });
}
function cancelStart(runtime, startGeneration) {
    if (startGeneration !== runtime.startGeneration)
        return;
    runtime.state = { type: "idle" };
    runtime.config = undefined;
    runtime.voiceStatus = "";
    runtime.context?.ui.setStatus(VOICE_STATUS_KEY, undefined);
}
function snapshotState(runtime) {
    return runtime.state;
}
