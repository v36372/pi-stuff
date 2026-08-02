import { mergeAdapterTools, restoreTools, stripAdapterTools } from "./adapter/activation/activation.js";
import { getCodexSkillPaths } from "./adapter/prompt/skills.js";
import { registerCodexConversion } from "./extension/register.js";
export default async function codexConversion(pi) {
    await registerCodexConversion(pi);
}
export { getCodexSkillPaths, mergeAdapterTools, restoreTools, stripAdapterTools };
