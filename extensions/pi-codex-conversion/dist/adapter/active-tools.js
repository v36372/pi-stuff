import { CODE_MODE_EXEC_CONSTRAINED_SAMPLING } from "../tools/code-mode/exec-contract.js";
export function getActiveToolsInActiveOrder(pi, codeMode = false) {
    const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    return pi.getActiveTools().flatMap((name) => {
        const tool = toolsByName.get(name);
        if (!tool)
            return [];
        return [{
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                ...(codeMode && tool.name === "exec" ? { constrainedSampling: CODE_MODE_EXEC_CONSTRAINED_SAMPLING } : {}),
            }];
    });
}
