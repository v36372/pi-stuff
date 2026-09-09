import type {
  ExtensionAPI,
  ExtensionContext,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

// RunCat frames live in cat.ttf at U+ECB4..U+ECBD. Omarchy's icon font already
// owns the original IcoMoon range U+E900..U+E907 (Omarchy/Pi/OpenCode/omp/Grok/
// Codex/LM Studio/Ollama), so fontconfig served those logos instead of cats.
const RIGHT = ["\uECB4", "\uECB5", "\uECB6", "\uECB7", "\uECB8"] as const;
const LEFT = ["\uECB9", "\uECBA", "\uECBB", "\uECBC", "\uECBD"] as const;

const RUNCAT_INDICATOR: WorkingIndicatorOptions = {
  // Each frame is padded to a 6-cell window; the cat physically runs from
  // one side to the other, turns around, and runs back like a spinner. The
  // trailing cell ensures the cat never bumps against the working message.
  frames: [
    `${RIGHT[0]}     `,
    ` ${RIGHT[1]}    `,
    `  ${RIGHT[2]}   `,
    `   ${RIGHT[3]}  `,
    `    ${RIGHT[4]} `,
    `    ${LEFT[4]} `,
    `   ${LEFT[3]}  `,
    `  ${LEFT[2]}   `,
    ` ${LEFT[1]}    `,
    `${LEFT[0]}     `,
  ],
  intervalMs: 120,
};

function applyRunCatIndicator(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingIndicator(RUNCAT_INDICATOR);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    applyRunCatIndicator(ctx);
  });
}
