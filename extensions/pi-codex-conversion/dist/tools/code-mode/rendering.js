import { highlightCode, keyHint, truncateToVisualLines, } from "@earendil-works/pi-coding-agent";
import { Container, Image, Spacer, Text, } from "@earendil-works/pi-tui";
export function renderExecCall(args, theme, context, tracker, richRendering = true) {
    tracker.register(context?.toolCallId, context?.invalidate);
    const code = typeof args.code === "string" ? args.code : "";
    if (!richRendering) {
        if (!context?.executionStarted || !context.isPartial)
            return new Text("", 0, 0);
        const names = customToolNames(code);
        const suffix = names.length > 0 ? ` · ${names.join(" · ")}` : "";
        return new Text(`${theme.fg("dim", "•")} ${theme.bold(`Running code${suffix}`)}`, 0, 0);
    }
    const status = tracker.status(context?.toolCallId);
    const verb = status === "running" ? "Running" : status === "yielded" ? "Started" : "Ran";
    let text = `${theme.fg("dim", "•")} ${theme.bold(`${verb} code`)}`;
    const names = customToolNames(code);
    if (names.length > 0) {
        text += `\n${theme.fg("dim", "  └ ")}${theme.fg("accent", names.join(" · "))}`;
    }
    if (context?.expanded && code.trim()) {
        text += `\n\n${highlightCode(code, "javascript").join("\n")}`;
    }
    return new Text(text, 0, 0);
}
export function renderWaitCall(args, theme, context, tracker, richRendering = true) {
    tracker.register(context?.toolCallId, context?.invalidate);
    if (!richRendering)
        return new Text("", 0, 0);
    const done = tracker.status(context?.toolCallId) !== "running";
    const terminate = args.terminate === true;
    const title = terminate
        ? done
            ? "Terminated code cell"
            : "Terminating code cell"
        : done
            ? "Waited for code cell"
            : "Waiting for code cell";
    const cell = typeof args.cell_id === "string" ? ` #${args.cell_id}` : "";
    return new Text(`${theme.fg("dim", "•")} ${theme.bold(title)}${theme.fg("muted", cell)}`, 0, 0);
}
export function renderCodeModeResult(result, options, theme, context, tools = [], richRendering = true) {
    const details = asDetails(result.details);
    const content = details.notification || details.status === undefined
        ? result.content
        : result.content.slice(1);
    const text = content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
    const status = statusText(details);
    const outputText = [text, status].filter(Boolean).join("\n");
    const tone = context?.isError
        ? "error"
        : details.status === "yielded"
            ? "accent"
            : "dim";
    const renderedText = outputText ? theme.fg(tone, outputText) : "";
    const tracedImages = traceImages(details.traces ?? []);
    const images = content.filter((item) => item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string" &&
        !tracedImages.get(item.mimeType)?.has(item.data));
    const showOutput = richRendering ||
        Boolean(details.scriptError) ||
        details.notification === true ||
        images.length > 0;
    const output = showOutput && (options.expanded || options.isPartial)
        ? renderTextAndImages(renderedText, images, theme)
        : showOutput
            ? renderTextAndImages(previewText(renderedText, theme), images, theme)
            : new Container();
    return renderTraceAndOutput(details.traces ?? [], details.droppedTraceCount ?? 0, tools, output, showOutput && Boolean(renderedText || images.length > 0), options, theme, context);
}
function traceImages(traces) {
    const images = new Map();
    for (const trace of traces) {
        for (const item of trace.result?.content ?? []) {
            if (item.type !== "image" ||
                typeof item.data !== "string" ||
                typeof item.mimeType !== "string")
                continue;
            const data = images.get(item.mimeType) ?? new Set();
            data.add(item.data);
            images.set(item.mimeType, data);
        }
    }
    return images;
}
export function renderTrackedCodeModeResult(result, options, theme, context, tracker, tools = [], richRendering = true) {
    if (!options.isPartial && context?.toolCallId) {
        const details = asDetails(result.details);
        tracker.finish(context.toolCallId, details.status === "yielded" ? "yielded" : "done");
    }
    return renderCodeModeResult(result, options, theme, context, tools, richRendering);
}
function renderTraceAndOutput(traces, droppedTraceCount, tools, output, hasOutput, options, theme, context) {
    if (traces.length === 0 && droppedTraceCount === 0)
        return output;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const container = new Container();
    if (droppedTraceCount > 0)
        container.addChild(new Text(theme.fg("muted", `… ${droppedTraceCount} earlier nested call${droppedTraceCount === 1 ? "" : "s"} omitted`), 0, 0));
    for (const trace of traces) {
        const tool = byName.get(trace.name);
        const rendered = renderTrace(trace, tool, options, theme, context);
        for (const component of rendered)
            container.addChild(component);
    }
    if (hasOutput) {
        container.addChild(new Spacer(1));
        container.addChild(output);
    }
    return container;
}
function renderTrace(trace, tool, options, theme, context) {
    const renderContext = {
        toolCallId: trace.id,
        cwd: context?.cwd,
        expanded: options.expanded,
        isError: trace.status === "error",
        args: trace.input,
        invalidate: context?.invalidate,
    };
    const programmatic = isProgrammaticTool(tool) ? tool : undefined;
    let call;
    try {
        call = programmatic?.renderCall
            ? programmatic.renderCall(trace.input, theme, renderContext)
            : renderGenericTraceCall(trace, theme, options.expanded);
    }
    catch {
        call = renderGenericTraceCall(trace, theme, options.expanded);
    }
    const components = [call];
    if (trace.result && programmatic?.renderResult) {
        try {
            components.push(programmatic.renderResult(trace.result, {
                expanded: options.expanded,
                isPartial: trace.status === "running",
            }, theme, renderContext));
        }
        catch {
            // A stale persisted trace must not break the whole transcript.
        }
    }
    if (trace.status === "error" && trace.error) {
        components.push(new Text(theme.fg("error", trace.error), 4, 0));
    }
    else if (trace.result && !programmatic?.renderResult) {
        components.push(renderGenericTraceResult(trace, theme, options.expanded || options.isPartial));
    }
    return components;
}
function renderGenericTraceCall(trace, theme, expanded) {
    const verb = trace.status === "running"
        ? "Running"
        : trace.status === "error"
            ? "Failed"
            : "Ran";
    let text = `${theme.fg("dim", "•")} ${theme.bold(`${verb} ${trace.name}`)}`;
    if (expanded) {
        const input = typeof trace.input === "string"
            ? trace.input
            : safeRenderString(trace.input);
        if (input)
            text += `\n${theme.fg("dim", input)}`;
    }
    return new Text(text, 0, 0);
}
function renderGenericTraceResult(trace, theme, full) {
    const result = trace.result;
    if (!result)
        return new Container();
    const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    const images = result.content.filter((item) => item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string");
    const renderedText = theme.fg("dim", text);
    return renderTextAndImages(full ? renderedText : previewText(renderedText, theme), images, theme);
}
function isProgrammaticTool(tool) {
    return Boolean(tool && "invoke" in tool);
}
function safeRenderString(value) {
    try {
        return JSON.stringify(value) ?? String(value ?? "");
    }
    catch {
        return "[unavailable input]";
    }
}
function customToolNames(code) {
    const names = [];
    const seen = new Set();
    for (const match of code.matchAll(/\btools\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
        const name = match[1];
        if (seen.has(name))
            continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}
function asDetails(value) {
    return value && typeof value === "object"
        ? value
        : {};
}
function statusText(details) {
    if (details.scriptError)
        return `Script error: ${details.scriptError}`;
    if (details.status === "yielded" && details.cellId)
        return `Cell #${details.cellId} still running`;
    if (details.status === "terminated")
        return details.cellId
            ? `Cell #${details.cellId} terminated`
            : "Cell terminated";
    return "";
}
function previewText(text, theme) {
    if (!text)
        return "";
    const preview = truncateToVisualLines(text, 5, 100, 0);
    if (preview.skippedCount <= 0)
        return preview.visualLines.join("\n");
    let hint;
    try {
        hint = keyHint("app.tools.expand", "to expand");
    }
    catch {
        hint = "ctrl+o to expand";
    }
    return `${theme.fg("muted", `... (${preview.skippedCount} more lines, ${hint})`)}\n${preview.visualLines.join("\n")}`;
}
function renderTextAndImages(text, images, theme) {
    if (images.length === 0)
        return new Text(text, text ? 4 : 0, 0);
    const container = new Container();
    if (text)
        container.addChild(new Text(text, 4, 0));
    for (const [index, image] of images.entries()) {
        if (text || index > 0)
            container.addChild(new Spacer(1));
        container.addChild(new Image(image.data, image.mimeType, { fallbackColor: (value) => theme.fg("dim", value) }, { maxWidthCells: 60, maxHeightCells: 20 }));
    }
    return container;
}
