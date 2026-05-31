import type {
  ExtensionAPI,
  ExtensionContext,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

const RUNCAT_INDICATOR: WorkingIndicatorOptions = {
  // These are Unicode Private Use Area code points from the RunCat icon font:
  // U+E900 U+E901 U+E902 U+E903 U+E904. They render as animation frames when the correct FONT is loaded.
  frames: [" ", " ", " ", " ", " "],
  intervalMs: 167,
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
