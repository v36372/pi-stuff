import type {
  ExtensionAPI,
  ExtensionContext,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

const RUNCAT_INDICATOR: WorkingIndicatorOptions = {
  // RunCat icon font Private Use Area glyphs:
  // U+E900..U+E904 = cat running right
  // U+E905..U+E909 = cat running left (horizontally mirrored)
  // Each frame is padded to a 6-cell window; the cat physically runs from
  // one side to the other, turns around, and runs back like a spinner. The
  // trailing cell ensures the cat never bumps against the working message.
  frames: [
    "     ", "     ", "     ", "     ", "     ",
    "     ", "     ", "     ", "     ", "     ",
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
