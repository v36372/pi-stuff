export function toNestedTool(tool, usage, lifecycle = {}, contract = {}) {
    const kind = contract.kind ?? "function";
    const prepareInput = (input) => contract.prepareInput ? contract.prepareInput(input) : input;
    return {
        name: tool.name,
        usage,
        description: tool.description,
        deferLoading: false,
        kind,
        ...(contract.yieldTimeMs === undefined ? {} : { yieldTimeMs: contract.yieldTimeMs }),
        ...(kind === "function" ? { inputSchema: tool.parameters } : {}),
        ...(tool.renderCall
            ? {
                renderCall: (input, theme, context) => tool.renderCall(prepareInput(input), theme, context),
            }
            : {}),
        ...(tool.renderResult
            ? {
                renderResult: (result, options, theme, context) => tool.renderResult(result, options, theme, context),
            }
            : {}),
        async invoke(input, context, signal) {
            if (signal.aborted)
                throw new Error(`${tool.name} aborted`);
            const extensionContext = requireExtensionContext(context);
            const toolInput = prepareInput(input);
            const prepared = tool.prepareArguments
                ? tool.prepareArguments(toolInput)
                : toolInput;
            if (signal.aborted)
                throw new Error(`${tool.name} aborted`);
            const toolCallId = context.toolCallId ?? `code-mode-${tool.name}`;
            lifecycle.start?.(toolCallId, prepared);
            context.refreshTrace?.();
            try {
                const result = await tool.execute(toolCallId, prepared, signal, (update) => forwardUpdate(update, context), extensionContext);
                context.captureResult?.(result);
                const resultError = contract.resultError?.(result);
                if (resultError)
                    throw new Error(resultError);
                return contract.resultValue?.(result) ?? compactNestedResult(result);
            }
            finally {
                lifecycle.end?.(toolCallId);
            }
        },
    };
}
export function codeModeImageResult(result, outputHint) {
    const image = result.content.find((item) => item.type === "image");
    if (!image || image.type !== "image")
        return compactNestedResult(result);
    const detail = "detail" in image && typeof image.detail === "string"
        ? image.detail
        : "high";
    return {
        image_url: `data:${image.mimeType};base64,${image.data}`,
        detail,
        ...(outputHint ? { output_hint: outputHint } : {}),
    };
}
function requireExtensionContext(context) {
    if (!context.extensionContext)
        throw new Error("Code-mode Pi context is unavailable");
    return context.extensionContext;
}
function forwardUpdate(update, context) {
    const content = update.content
        .filter((item) => item.type === "text" || item.type === "image")
        .map((item) => ({ ...item }));
    context.onUpdate?.({ content, details: update.details });
}
function compactNestedResult(result) {
    const images = result.content.filter((item) => item.type === "image");
    if (images.length > 0)
        return { content: result.content, details: result.details };
    if (result.details &&
        typeof result.details === "object" &&
        "output" in result.details)
        return result.details;
    const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    return text || "(no output)";
}
