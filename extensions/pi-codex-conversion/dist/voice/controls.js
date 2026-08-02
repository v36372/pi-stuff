import { getCodexConversionConfigPath, readCodexConversionConfig } from "../adapter/activation/config-store.js";
import { resolveVoiceHelperBinary } from "./binary.js";
import { buildVoiceSetupInstructions, missingVoiceAudioSettings } from "./setup.js";
import { registerCodexVoiceShortcuts } from "./shortcuts.js";
import { getCodexVoiceSystemPromptPath, getProjectCodexVoiceSystemPromptPath } from "./system-prompt.js";
import { codexVoiceSetupMessage } from "./ui.js";
export function createCodexVoiceControls(options) {
    const { pi, state, voice, lanVoice } = options;
    const start = async (mode, ctx) => {
        if (voice.activeMode === mode)
            return;
        const currentConfig = readCodexConversionConfig();
        state.config = currentConfig;
        const missingAudioSettings = missingVoiceAudioSettings(currentConfig, mode);
        if (missingAudioSettings.length > 0) {
            if (mode === "realtime" && voice.prepareRealtimePrompt(ctx) === undefined)
                return;
            if (!ctx.isIdle()) {
                ctx.ui.notify("Wait for the current turn before setting up Codex voice.", "info");
                return;
            }
            state.codexTurnState.beginTurn();
            pi.sendMessage(codexVoiceSetupMessage(buildVoiceSetupInstructions({
                configPath: getCodexConversionConfigPath(),
                helperPath: resolveVoiceHelperBinary(currentConfig.tools.customRustBinariesDir),
                missing: missingAudioSettings,
                ...(ctx.isProjectTrusted() ? { projectRealtimePromptPath: getProjectCodexVoiceSystemPromptPath(ctx.cwd) } : {}),
                realtimePromptPath: getCodexVoiceSystemPromptPath(),
                retryCommand: `/codex voice ${mode}`,
            })), { triggerTurn: true });
            return;
        }
        await voice.start(ctx, currentConfig, mode);
    };
    const stop = async (_ctx) => {
        if (voice.activeMode === "dictation")
            await voice.finishDictation({ announce: true });
        else
            await voice.stop({ announce: true });
    };
    const toggle = async (mode, ctx) => {
        if (voice.activeMode === mode)
            await stop(ctx);
        else
            await start(mode, ctx);
    };
    const toggleInputMute = (ctx) => {
        const muted = !voice.inputMuted;
        if (!voice.setInputMuted(muted)) {
            ctx.ui.notify("Start realtime voice before muting the microphone", "info");
            return;
        }
        ctx.ui.notify(`Realtime microphone ${muted ? "muted" : "unmuted"}`, "info");
    };
    registerCodexVoiceShortcuts(pi, state.config, () => state.config, {
        startDictation: (ctx) => start("dictation", ctx),
        finishDictation: (ctx) => stop(ctx),
        toggleDictation: (ctx) => toggle("dictation", ctx),
        toggleRealtime: (ctx) => toggle("realtime", ctx),
        toggleInputMute,
        toggleServer: async (ctx) => {
            const enabled = !lanVoice.status().running;
            await lanVoice.setEnabled(enabled, ctx);
            if (!enabled)
                ctx.ui.notify("LAN voice server stopped", "info");
        },
    });
    return { start, stop, toggleInputMute };
}
