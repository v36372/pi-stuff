import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerLlmStatsCommand } from "./llm-stats"
import { registerShowContextCommand } from "./show-context"
import { registerShowSyspromptCommand } from "./show-sysprompt"

export default function inspectDiagnosticsExtension(pi: ExtensionAPI) {
	registerShowSyspromptCommand(pi)
	registerShowContextCommand(pi)
	registerLlmStatsCommand(pi)
}
