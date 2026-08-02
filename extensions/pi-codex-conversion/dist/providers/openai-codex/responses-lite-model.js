export function supportsResponsesLiteModel(model) {
    const modelId = typeof model === "string" ? model : model?.id;
    if (!modelId)
        return false;
    const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
    return /^gpt-5\.6-(?:luna|terra|sol)$/.test(id.toLowerCase());
}
