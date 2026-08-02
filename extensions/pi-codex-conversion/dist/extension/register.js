import { registerCodeModeProxyProvider } from "../providers/code-mode-proxy-provider.js";
import { registerOpenAICodexCustomProvider } from "../providers/openai-codex-custom-provider.js";
import { registerCodexCommand } from "../ui/settings/command.js";
import { registerCodexCodeMode } from "../adapter/code-mode.js";
import { registerCodexEvents } from "./events.js";
import { createCodexExtensionRuntime } from "./runtime.js";
import { registerCodexTools } from "./tools.js";
import { registerCodexUi } from "./ui.js";
import { registerCodexVoiceRenderer } from "../voice/ui.js";
import { resolveCodexRuntimePlan } from "../adapter/activation/runtime-plan.js";
import { captureActiveProviderSystemPrompt } from "../adapter/provider-request.js";
export async function registerCodexConversion(pi) {
    registerCodexVoiceRenderer(pi);
    const runtime = createCodexExtensionRuntime(pi);
    const codeMode = await registerCodexCodeMode(pi, runtime);
    let cleanupProxyProvider;
    try {
        registerOpenAICodexCustomProvider(pi, {
            getConfig: () => ({ openai: runtime.state.config.openai, beta: runtime.state.config.beta, compaction: runtime.state.config.compaction }),
            useResponsesLite: (model) => resolveCodexRuntimePlan({ model }, runtime.state.config).kind === "code",
            turnState: runtime.state.codexTurnState,
            onPreparedPayload: (payload) => {
                if (!runtime.state.pendingActiveProviderPromptCapture)
                    return;
                captureActiveProviderSystemPrompt(payload, runtime.state);
                runtime.state.pendingActiveProviderPromptCapture = false;
            },
        });
        const proxyProvider = registerCodeModeProxyProvider(pi, () => runtime.state.config);
        cleanupProxyProvider = proxyProvider;
        const tools = registerCodexTools(pi, runtime);
        const ui = registerCodexUi(pi, runtime);
        registerCodexCommand(pi, runtime.state, runtime.voice, runtime.lanVoice, (config, ctx, previousConfig) => {
            proxyProvider.applyConfig(config, ctx.modelRegistry);
            tools.applyConfig(config);
            ui.applyConfig(config);
            if (config.voiceFeaturesOnly !== previousConfig.voiceFeaturesOnly
                || config.prompt.heavySystemPromptOverwrite !== previousConfig.prompt.heavySystemPromptOverwrite
                || config.openai.harnessIdentifierHeader !== previousConfig.openai.harnessIdentifierHeader
                || config.compaction.responsesCompaction !== previousConfig.compaction.responsesCompaction) {
                runtime.resetTransport(ctx.sessionManager.getSessionId());
            }
            if (config.voiceFeaturesOnly && !previousConfig.voiceFeaturesOnly) {
                void codeMode.shutdownHost().catch((error) => {
                    ctx.ui.notify(`Could not stop Code Mode host: ${error instanceof Error ? error.message : String(error)}`, "warning");
                });
            }
        });
        registerCodexEvents(pi, runtime, tools, ui, codeMode, proxyProvider);
    }
    catch (registrationError) {
        try {
            try {
                cleanupProxyProvider?.shutdown();
            }
            finally {
                await codeMode.shutdown();
            }
        }
        catch (shutdownError) {
            throw new AggregateError([registrationError, shutdownError], "Codex conversion registration and Code Mode cleanup failed");
        }
        throw registrationError;
    }
}
