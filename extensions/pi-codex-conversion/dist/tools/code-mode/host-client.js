import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CodeModeDelegateRuntime } from "./delegate-runtime.js";
import { DEFAULT_CODE_MODE_EXEC_YIELD_MS, executionCellId, isCustomToolDefinition, isMissingRuntimeOutcome, parseHostMessage, parseExecSource, parseRuntimeResponse, runtimeOutcome, toWireToolDefinition, } from "./host-protocol.js";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_WRITE_BYTES = 128 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
export class CodeModeHostClient {
    binary;
    tools;
    shutdownGraceMs;
    sessionId = randomUUID();
    child;
    buffer = Buffer.alloc(0);
    requestId = 0;
    ready;
    pending = new Map();
    initial = new Map();
    delegateRuntime = new CodeModeDelegateRuntime((message) => this.send(message));
    stderr = "";
    queuedWriteBytes = 0;
    constructor(options) {
        this.binary = options.binary;
        this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
        this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    }
    async start() {
        if (this.ready)
            return this.ready;
        const ready = this.startProcess();
        this.ready = ready;
        try {
            await ready;
        }
        catch (error) {
            this.failAll(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }
    async startProcess() {
        const child = spawn(this.binary, [], {
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
        });
        this.child = child;
        this.buffer = Buffer.alloc(0);
        this.stderr = "";
        child.stdout.on("data", (chunk) => {
            if (this.child === child)
                this.onData(chunk);
        });
        child.stderr.on("data", (chunk) => {
            if (this.child === child)
                this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
        });
        child.on("error", (error) => {
            if (this.child === child)
                this.failAll(error);
        });
        child.on("close", (code) => {
            if (this.child === child)
                this.failAll(new Error(`Code-mode host exited with code ${code ?? "unknown"}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
        });
        const handshake = new Promise((resolve, reject) => {
            this.pending.set(0, { resolve: () => resolve(), reject });
        });
        this.send({
            type: "connection/hello",
            supportedVersions: [1],
            requiredCapabilities: [],
            optionalCapabilities: [],
        });
        await handshake;
        await this.request({ method: "session/open", sessionId: this.sessionId });
    }
    async execute(source, context, signal, tools = [...this.tools.values()]) {
        throwIfAborted(signal);
        await this.start();
        throwIfAborted(signal);
        const { code, yieldTimeMs, maxOutputTokens } = parseExecSource(source);
        const effectiveYieldTimeMs = directToolYieldTime(code, tools) ?? yieldTimeMs ?? DEFAULT_CODE_MODE_EXEC_YIELD_MS;
        const runtimeSource = scopeAllToolsToDeferredCustom(code, tools);
        const id = ++this.requestId;
        const initial = new Promise((resolve, reject) => this.initial.set(id, { resolve, reject }));
        void initial.catch(() => undefined);
        const toolSet = new Map(tools.map((tool) => [tool.name, tool]));
        const started = this.requestWithId(id, {
            method: "session/execute",
            sessionId: this.sessionId,
            request: {
                tool_call_id: `exec-${id}`,
                enabled_tools: tools.map(toWireToolDefinition),
                source: runtimeSource,
                yield_time_ms: effectiveYieldTimeMs,
                max_output_tokens: maxOutputTokens,
            },
        }, context, toolSet);
        let cellId;
        const abort = () => {
            const error = abortError();
            try {
                this.send({ type: "operation/cancel", id });
            }
            catch {
                // Host teardown is already authoritative.
            }
            this.rejectOperation(id, error);
            if (cellId)
                void this.terminate(cellId, context).catch(() => undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const startedValue = await started;
            cellId = executionCellId(startedValue);
            if (signal?.aborted) {
                abort();
                throw abortError();
            }
            return {
                ...this.delegateRuntime.attach(parseRuntimeResponse(await initial)),
                maxOutputTokens: maxOutputTokens ?? 10_000,
            };
        }
        catch (error) {
            this.initial.delete(id);
            throw error;
        }
        finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    async wait(cellId, yieldTimeMs, context, signal) {
        throwIfAborted(signal);
        await this.start();
        throwIfAborted(signal);
        this.delegateRuntime.updateCellContext(cellId, context);
        const id = ++this.requestId;
        const abort = () => {
            const error = abortError();
            try {
                this.send({ type: "operation/cancel", id });
            }
            catch {
                // Host teardown is already authoritative.
            }
            this.rejectOperation(id, error);
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const value = await this.requestWithId(id, {
                method: "session/wait",
                sessionId: this.sessionId,
                request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
            }, context);
            const wrapped = runtimeOutcome(value);
            if (!wrapped)
                throw new Error("Code-mode host returned an invalid wait outcome");
            return {
                ...this.delegateRuntime.attach(parseRuntimeResponse(wrapped)),
                ...(isMissingRuntimeOutcome(value) ? { missingCell: true } : {}),
            };
        }
        finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    async terminate(cellId, context, signal) {
        throwIfAborted(signal);
        await this.start();
        throwIfAborted(signal);
        this.delegateRuntime.updateCellContext(cellId, context);
        const id = ++this.requestId;
        const abort = () => {
            const error = abortError();
            try {
                this.send({ type: "operation/cancel", id });
            }
            catch {
                // Host teardown is already authoritative.
            }
            this.rejectOperation(id, error);
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const value = await this.requestWithId(id, {
                method: "session/terminate",
                sessionId: this.sessionId,
                cellId,
            }, context);
            const wrapped = runtimeOutcome(value);
            if (!wrapped)
                throw new Error("Code-mode host returned an invalid termination outcome");
            return {
                ...this.delegateRuntime.attach(parseRuntimeResponse(wrapped)),
                ...(isMissingRuntimeOutcome(value) ? { missingCell: true } : {}),
            };
        }
        finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    async shutdown() {
        const child = this.child;
        if (!child)
            return;
        try {
            await Promise.race([
                this.request({
                    method: "session/shutdown",
                    sessionId: this.sessionId,
                }),
                shutdownDeadline(this.shutdownGraceMs),
            ]);
        }
        catch {
            // Process teardown below is authoritative.
        }
        child.kill();
        this.failAll(new Error("Code-mode host shut down"));
        this.delegateRuntime.clear();
        this.child = undefined;
        this.ready = undefined;
    }
    request(request, context) {
        return this.requestWithId(++this.requestId, request, context);
    }
    requestWithId(id, request, context, tools) {
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, context, tools });
            try {
                this.send({ type: "operation/request", id, request });
            }
            catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    rejectOperation(id, error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
        const initial = this.initial.get(id);
        this.initial.delete(id);
        initial?.reject(error);
    }
    send(message) {
        const child = this.child;
        if (!child?.stdin.writable)
            throw new Error("Code-mode host is not running");
        const payload = Buffer.from(JSON.stringify(message));
        if (payload.length > MAX_FRAME_BYTES)
            throw new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`);
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32LE(payload.length);
        const frame = Buffer.concat([header, payload]);
        if (this.queuedWriteBytes + frame.length > MAX_QUEUED_WRITE_BYTES)
            throw new Error(`Code-mode write queue exceeds ${MAX_QUEUED_WRITE_BYTES} bytes`);
        this.queuedWriteBytes += frame.length;
        child.stdin.write(frame, (error) => {
            this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - frame.length);
            if (error && this.child === child)
                this.failAll(error);
        });
    }
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (length > MAX_FRAME_BYTES)
                return this.failAll(new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`));
            if (this.buffer.length < length + 4)
                return;
            const payload = this.buffer.subarray(4, length + 4);
            this.buffer = this.buffer.subarray(length + 4);
            try {
                this.handleMessage(parseHostMessage(JSON.parse(payload.toString("utf8"))));
            }
            catch (error) {
                this.failAll(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
    handleMessage(message) {
        if (message.type === "connection/ready") {
            const pending = this.pending.get(0);
            this.pending.delete(0);
            pending?.resolve(undefined);
            return;
        }
        if (message.type === "connection/rejected") {
            const pending = this.pending.get(0);
            this.pending.delete(0);
            pending?.reject(new Error(`Code-mode handshake rejected: ${JSON.stringify(message.reason)}`));
            return;
        }
        if (message.type === "operation/response") {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (!pending)
                return;
            if (message.result.status === "error")
                return pending.reject(new Error(message.result.message));
            const value = message.result.value;
            const cellId = executionCellId(value);
            if (cellId && pending.context) {
                this.delegateRuntime.bindCell(cellId, pending.context, pending.tools);
            }
            pending.resolve(value);
            return;
        }
        if (message.type === "execute/initialResponse") {
            const pending = this.initial.get(message.id);
            this.initial.delete(message.id);
            if (!pending)
                return;
            if (message.result.status === "error")
                pending.reject(new Error(message.result.message));
            else
                pending.resolve(message.result.value);
            return;
        }
        if (message.type === "delegate/request") {
            this.delegateRuntime.handleRequest(message);
            return;
        }
        if (message.type === "delegate/cancel") {
            this.delegateRuntime.cancel(message.id);
            return;
        }
        if (message.type === "cell/closed")
            this.delegateRuntime.closeCell(message.cellId);
    }
    failAll(error) {
        for (const pending of [...this.pending.values(), ...this.initial.values()])
            pending.reject(error);
        this.pending.clear();
        this.initial.clear();
        this.delegateRuntime.clear();
        this.queuedWriteBytes = 0;
        const child = this.child;
        this.child = undefined;
        this.ready = undefined;
        if (child && !child.killed)
            child.kill();
    }
}
export function scopeAllToolsToDeferredCustom(source, tools) {
    const names = tools
        .filter(isCustomToolDefinition)
        .filter((tool) => tool.deferLoading)
        .map((tool) => tool.name);
    return `globalThis.ALL_TOOLS=globalThis.ALL_TOOLS.filter(({name})=>${JSON.stringify(names)}.includes(name));${source}`;
}
function directToolYieldTime(code, tools) {
    const executableCode = maskJavaScriptCommentsAndStrings(code);
    let forced;
    for (const tool of tools) {
        if (tool.yieldTimeMs === undefined)
            continue;
        const name = escapeRegExp(tool.name);
        const directReference = new RegExp(`\\btools\\s*\\.\\s*${name}(?![a-zA-Z0-9_$])\\s*\\(`);
        const bracketReference = new RegExp(`\\btools\\s*\\[\\s*(["'])${name}\\1\\s*\\]\\s*\\(`, "g");
        if (!directReference.test(executableCode) &&
            !hasExecutableBracketReference(code, executableCode, bracketReference))
            continue;
        forced = forced === undefined ? tool.yieldTimeMs : Math.max(forced, tool.yieldTimeMs);
    }
    return forced ?? null;
}
function hasExecutableBracketReference(code, executableCode, pattern) {
    for (const match of code.matchAll(pattern)) {
        if (match.index !== undefined && executableCode.slice(match.index, match.index + 5) === "tools")
            return true;
    }
    return false;
}
function maskJavaScriptCommentsAndStrings(code) {
    const output = code.split("");
    let state = "code";
    let quote = "";
    let regexClass = false;
    let templateExpressionDepth;
    const templateReturnDepths = [];
    for (let index = 0; index < code.length; index += 1) {
        const current = code[index];
        const next = code[index + 1];
        if (state === "template") {
            output[index] = current === "\n" || current === "\r" ? current : " ";
            if (current === "\\") {
                if (next !== undefined)
                    output[index + 1] = " ";
                index += 1;
            }
            else if (current === "$" && next === "{") {
                output[index + 1] = " ";
                templateExpressionDepth = 1;
                state = "code";
                index += 1;
            }
            else if (current === "`") {
                templateExpressionDepth = templateReturnDepths.pop();
                state = "code";
            }
            continue;
        }
        if (state === "code") {
            if (templateExpressionDepth !== undefined && current === "{") {
                templateExpressionDepth += 1;
            }
            else if (templateExpressionDepth !== undefined &&
                current === "}") {
                templateExpressionDepth -= 1;
                if (templateExpressionDepth === 0) {
                    output[index] = " ";
                    templateExpressionDepth = undefined;
                    state = "template";
                }
            }
            else if (current === "/" && next === "/") {
                output[index] = output[index + 1] = " ";
                state = "line-comment";
                index += 1;
            }
            else if (current === "/" && next === "*") {
                output[index] = output[index + 1] = " ";
                state = "block-comment";
                index += 1;
            }
            else if (current === "/" && isRegexLiteralStart(code, index)) {
                output[index] = " ";
                regexClass = false;
                state = "regex";
            }
            else if (current === '"' || current === "'") {
                output[index] = " ";
                quote = current;
                state = "string";
            }
            else if (current === "`") {
                output[index] = " ";
                templateReturnDepths.push(templateExpressionDepth);
                templateExpressionDepth = undefined;
                state = "template";
            }
            continue;
        }
        if (state === "line-comment") {
            if (current === "\n" || current === "\r")
                state = "code";
            else
                output[index] = " ";
            continue;
        }
        if (state === "regex") {
            output[index] = current === "\n" || current === "\r" ? current : " ";
            if (current === "\\") {
                if (next !== undefined)
                    output[index + 1] = " ";
                index += 1;
            }
            else if (current === "[")
                regexClass = true;
            else if (current === "]")
                regexClass = false;
            else if (current === "/" && !regexClass)
                state = "code";
            continue;
        }
        output[index] = current === "\n" || current === "\r" ? current : " ";
        if (state === "block-comment") {
            if (current === "*" && next === "/") {
                output[index + 1] = " ";
                state = "code";
                index += 1;
            }
            continue;
        }
        if (current === "\\") {
            if (next !== undefined)
                output[index + 1] = " ";
            index += 1;
        }
        else if (current === quote) {
            state = "code";
            quote = "";
        }
    }
    return output.join("");
}
function isRegexLiteralStart(code, index) {
    const previous = code.slice(0, index).trimEnd();
    if (!previous)
        return true;
    if ("([{:;,=!?&|+-*%^~<>".includes(previous.at(-1)))
        return true;
    return /(?:^|[^\w$])(return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(previous);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function shutdownDeadline(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
function abortError() {
    const error = new Error("Code-mode operation aborted");
    error.name = "AbortError";
    return error;
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
