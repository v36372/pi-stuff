// Tell Herdr when Pi is waiting on the user.
// herdr-agent-state.ts listens for `herdr:blocked`; nothing else emitted it,
// so ask_user_question left the pane stuck on `working` (screen detection is
// skipped while the Pi hook has authority).
// @ts-nocheck

const ASK_TOOLS = new Set(["ask_user", "ask_user_question"]);

function questionLabel(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const first = questions[0];
  const text = first?.question || first?.header || args?.question || args?.prompt || "Needs your input";
  if (questions.length > 1) {
    return `${questions.length} questions · ${text}`;
  }
  return String(text);
}

export default function (pi) {
  pi.on("tool_execution_start", (event) => {
    if (!ASK_TOOLS.has(String(event?.toolName || ""))) {
      return;
    }
    pi.events?.emit("herdr:blocked", { active: true, label: questionLabel(event.args) });
  });

  pi.on("tool_execution_end", (event) => {
    if (!ASK_TOOLS.has(String(event?.toolName || ""))) {
      return;
    }
    pi.events?.emit("herdr:blocked", { active: false });
  });
}
