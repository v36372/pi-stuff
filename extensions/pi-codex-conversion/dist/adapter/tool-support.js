export function supportsViewImageInputs(model) {
    return Array.isArray(model?.input) && model.input.includes("image");
}
export function supportsNativeWebSearch(model) {
    return (model?.provider ?? "").toLowerCase() === "openai-codex" && Boolean(model?.api?.includes("responses"));
}
export function supportsNativeImageGeneration(model) {
    const supportsImages = !Array.isArray(model?.input) || model.input.includes("image");
    return (model?.provider ?? "").toLowerCase() === "openai-codex"
        && Boolean(model?.api?.includes("responses"))
        && supportsImages;
}
