import { buildAdapterSettings } from "./config-items-adapter.js";
import { buildDisplaySettings } from "./config-items-display.js";
import { buildOpenAISettings } from "./config-items-openai.js";
import { buildToolsSettings } from "./config-items-tools.js";
import { buildVoiceSettings } from "./config-items-voice.js";
export function buildConfigSettings(tab, config, theme, availableContextModels = []) {
    if (tab === "adapter")
        return buildAdapterSettings(config, theme);
    if (tab === "tools")
        return buildToolsSettings(config, theme);
    if (tab === "openai")
        return buildOpenAISettings(config, theme);
    if (tab === "display")
        return buildDisplaySettings(config);
    if (tab === "voice")
        return buildVoiceSettings(config, availableContextModels);
    return [];
}
