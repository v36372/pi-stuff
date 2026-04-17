import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ThinkingSelectorComponent } from "@mariozechner/pi-coding-agent";

const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export default function hotkeyThinkingSelectorExtension(pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+t", {
		description: "Open thinking level selector",
		handler: async (ctx) => {
			const availableLevels = ctx.model?.reasoning ? [...ALL_THINKING_LEVELS] : ["off"];
			const currentLevel = pi.getThinkingLevel();

			await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
				const selector = new ThinkingSelectorComponent(
					currentLevel,
					availableLevels,
					(level) => {
						pi.setThinkingLevel(level);
						ctx.ui.notify(`Thinking level: ${level}`, "info");
						done(undefined);
					},
					() => done(undefined),
				);

				const list = selector.getSelectList();

				return {
					render: (width: number) => selector.render(width),
					invalidate: () => selector.invalidate(),
					handleInput: (data: string) => list.handleInput(data),
				};
			});
		},
	});
}
