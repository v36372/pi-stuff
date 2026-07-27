import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface AskConfig {
	grill: boolean;
	fold: boolean;
}

const DEFAULT_CONFIG: AskConfig = {
	grill: true,
	fold: true,
};

function askConfigPath(): string {
	return join(getAgentDir(), "ask.json");
}

export function loadAskConfig(path = askConfigPath()): AskConfig {
	if (!existsSync(path)) {
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
				"utf8",
			);
		} catch {
			// A read-only agent directory must not disable default prompt resources.
		}
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AskConfig>;
		return {
			grill: typeof raw.grill === "boolean" ? raw.grill : DEFAULT_CONFIG.grill,
			fold: typeof raw.fold === "boolean" ? raw.fold : DEFAULT_CONFIG.fold,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
