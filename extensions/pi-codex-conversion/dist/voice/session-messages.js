import { renderRealtimeTranscriptTail } from "./prompts.js";
import { CODEX_VOICE_MODE_MESSAGE_TYPE, codexVoiceModeMessage, REALTIME_USER_TRANSCRIPT_MESSAGE_TYPE, REALTIME_VOICE_MESSAGE_TYPE, realtimeVoiceMessage, VOICE_CONTEXT_MESSAGE_TYPE, } from "./ui.js";
const REALTIME_VOICE_TAIL_CONTEXT_TYPE = "codex-realtime-voice-tail";
export class CodexVoiceSessionMessages {
    pi;
    callbacks;
    context;
    piTurnActive = false;
    dictationAnnounced = false;
    constructor(pi, callbacks) {
        this.pi = pi;
        this.callbacks = callbacks;
    }
    setContext(ctx) {
        this.context = ctx;
        this.piTurnActive = !ctx.isIdle();
    }
    contextSummary(summary) {
        this.pi.appendEntry(VOICE_CONTEXT_MESSAGE_TYPE, { summary });
    }
    userTranscript(transcript) {
        this.pi.appendEntry(REALTIME_USER_TRANSCRIPT_MESSAGE_TYPE, { transcript });
    }
    modeStarted(mode) {
        if (mode === "dictation") {
            if (this.dictationAnnounced)
                return;
            this.dictationAnnounced = true;
        }
        this.appendMode(mode, "started");
    }
    resetContextAnnouncements() {
        this.dictationAnnounced = false;
    }
    resetSessionContext() {
        this.context = undefined;
        this.piTurnActive = false;
    }
    conversationInputStopped() {
        this.appendMode("realtime", "ended");
    }
    voiceStopped(mode) {
        this.piTurnActive = this.context ? !this.context.isIdle() : false;
        if (mode && mode !== "dictation")
            this.appendMode(mode, "ended");
        this.context = undefined;
    }
    voiceTurn(turn) {
        if (!turn.delegationId) {
            this.pi.appendEntry(REALTIME_VOICE_MESSAGE_TYPE, {
                input: turn.input,
                route: "conversation",
            });
            return;
        }
        const ctx = this.context;
        if (!ctx)
            return;
        this.deliverDelegation(turn, !this.piTurnActive && ctx.isIdle());
    }
    retainTranscriptTail(transcriptDelta) {
        const piTurnActive = this.piTurnActive || (this.context ? !this.context.isIdle() : false);
        this.pi.sendMessage({
            customType: REALTIME_VOICE_TAIL_CONTEXT_TYPE,
            content: renderRealtimeTranscriptTail(transcriptDelta),
            display: false,
            details: {},
        }, {
            triggerTurn: false,
            deliverAs: piTurnActive ? "nextTurn" : "steer",
        });
    }
    filterContext(messages) {
        return messages.filter((message) => !isContextExcludedVoiceMessage(message));
    }
    agentStarted() {
        this.piTurnActive = true;
    }
    agentSettled() {
        this.piTurnActive = false;
    }
    appendMode(mode, state) {
        if (mode === "realtime") {
            this.pi.sendMessage(codexVoiceModeMessage(mode, state), {
                triggerTurn: false,
                deliverAs: "steer",
            });
            return;
        }
        this.pi.appendEntry(CODEX_VOICE_MODE_MESSAGE_TYPE, { mode, state });
    }
    deliverDelegation(turn, startsTurn) {
        if (!turn.delegationId || !this.callbacks.canDelegate())
            return false;
        this.callbacks.onDelegation(turn.delegationId);
        this.piTurnActive = true;
        this.callbacks.onWorking();
        this.pi.sendMessage(realtimeVoiceMessage(turn.input, "delegation", turn.transcriptDelta), startsTurn
            ? { triggerTurn: true }
            : { triggerTurn: true, deliverAs: "steer" });
        return true;
    }
}
function isContextExcludedVoiceMessage(message) {
    if (message.role !== "custom")
        return false;
    if (message.customType === REALTIME_VOICE_MESSAGE_TYPE)
        return true;
    return (message.customType === CODEX_VOICE_MODE_MESSAGE_TYPE &&
        (typeof message.content !== "string" ||
            !message.content.startsWith('<realtime_voice_session state="')));
}
