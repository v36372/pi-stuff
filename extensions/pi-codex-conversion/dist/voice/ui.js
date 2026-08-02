import { Box, Text } from "@earendil-works/pi-tui";
import { renderRealtimeConversationInput, renderRealtimeDelegation } from "./prompts.js";
export const REALTIME_VOICE_MESSAGE_TYPE = "codex-realtime-voice";
export const CODEX_VOICE_MODE_MESSAGE_TYPE = "codex-voice-mode";
export const CODEX_VOICE_SETUP_MESSAGE_TYPE = "codex-voice-setup";
export function realtimeVoiceMessage(input, route) {
    return {
        customType: REALTIME_VOICE_MESSAGE_TYPE,
        content: route === "delegation" ? renderRealtimeDelegation(input) : renderRealtimeConversationInput(input),
        display: true,
        details: { input, route },
    };
}
export function codexVoiceModeMessage(mode, state) {
    return {
        customType: CODEX_VOICE_MODE_MESSAGE_TYPE,
        content: modeStateContent(mode, state),
        display: true,
        details: { mode, state },
    };
}
export function codexVoiceSetupMessage(instructions) {
    return {
        customType: CODEX_VOICE_SETUP_MESSAGE_TYPE,
        content: instructions,
        display: true,
        details: { instructions },
    };
}
export function registerCodexVoiceRenderer(pi) {
    pi.registerMessageRenderer(REALTIME_VOICE_MESSAGE_TYPE, (message, _options, theme) => {
        const input = typeof message.details?.input === "string" ? message.details.input : "Voice request";
        return voiceBox(theme, "Realtime Voice", input);
    });
    pi.registerEntryRenderer(REALTIME_VOICE_MESSAGE_TYPE, (entry, _options, theme) => {
        const input = typeof entry.data?.input === "string" ? entry.data.input : "Voice request";
        return voiceBox(theme, "Realtime Voice", input);
    });
    pi.registerMessageRenderer(CODEX_VOICE_MODE_MESSAGE_TYPE, (message, _options, theme) => {
        const mode = message.details?.mode === "dictation" ? "dictation" : "realtime";
        const state = message.details?.state === "ended" ? "ended" : "started";
        return voiceBox(theme, mode === "dictation" ? "Codex Dictation" : "Realtime Voice", modeStateDisplay(mode, state));
    });
    pi.registerEntryRenderer(CODEX_VOICE_MODE_MESSAGE_TYPE, (entry, _options, theme) => {
        const mode = entry.data?.mode === "dictation" ? "dictation" : "realtime";
        const state = entry.data?.state === "ended" ? "ended" : "started";
        return voiceBox(theme, mode === "dictation" ? "Codex Dictation" : "Realtime Voice", modeStateDisplay(mode, state));
    });
    pi.registerMessageRenderer(CODEX_VOICE_SETUP_MESSAGE_TYPE, (message, _options, theme) => {
        const instructions = typeof message.details?.instructions === "string"
            ? message.details.instructions
            : typeof message.content === "string" ? message.content : "Codex voice audio setup is required.";
        return voiceBox(theme, "Codex Voice Setup", instructions);
    });
}
function voiceBox(theme, labelText, bodyText) {
    const label = theme.bold(theme.fg("customMessageLabel", labelText));
    const body = theme.fg("customMessageText", bodyText);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${label}\n${body}`, 0, 0));
    return box;
}
function modeStateContent(mode, state) {
    if (state === "ended") {
        return mode === "dictation"
            ? "<codex_voice_mode mode=\"dictation\" state=\"ended\">Dictation ended. Subsequent user messages are ordinary typed input unless another mode marker says otherwise.</codex_voice_mode>"
            : "<codex_voice_mode mode=\"realtime\" state=\"ended\">Realtime voice ended. Subsequent user messages are ordinary typed input unless another mode marker says otherwise.</codex_voice_mode>";
    }
    return mode === "dictation"
        ? "<codex_voice_mode mode=\"dictation\" state=\"active\">Dictation is active. User messages may contain speech-recognition errors or missing punctuation. Resolve obvious errors from context and clarify only material ambiguity.</codex_voice_mode>"
        : "<codex_voice_mode mode=\"realtime\" state=\"active\">Realtime voice is active. Routed requests may contain speech-recognition errors or missing punctuation. Responses are consumed by a voice intermediary, so keep updates concise and concrete. During longer work, keep the user informed with brief assistant messages between tool calls. State what changed or what you are doing next; do not wait until the final result, but do not narrate every routine command. The user may ask about progress in this session. Answer naturally from the conversation so far; do not call tools merely to reconstruct it.</codex_voice_mode>";
}
function modeStateDisplay(mode, state) {
    if (state === "ended")
        return "Ended · Subsequent prompts are ordinary typed input.";
    return mode === "dictation"
        ? "Active · Dictated prompts may contain recognition errors or missing punctuation."
        : "Active · Routed prompts may contain recognition errors; Pi responses return for spoken delivery.";
}
