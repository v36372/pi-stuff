import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { formatNativeBinaryError } from "../../native-binary-error.js";
import { getBundledToolBinaryPath } from "../native/binary.js";
const MAX_BRIDGE_STDERR_CHARS = 16_000;
function appendBoundedText(current, next) {
    const combined = `${current}${next}`;
    return combined.length > MAX_BRIDGE_STDERR_CHARS ? combined.slice(-MAX_BRIDGE_STDERR_CHARS) : combined;
}
export function formatExecBridgeExitError(stderr, code, signal) {
    const detail = stderr.trim();
    const status = typeof code === "number" ? `code ${code}` : signal ? `signal ${signal}` : undefined;
    const prefix = status ? `exec_bridge exited (${status})` : "exec_bridge exited";
    const message = detail ? `${prefix}: ${detail}` : prefix;
    return formatNativeBinaryError("exec_bridge", message);
}
function formatExecBridgeWriteError(error, stderr, startupWriteFailure) {
    const detail = stderr.trim();
    return formatNativeBinaryError("exec_bridge", detail ? `${error.message}: ${detail}` : error, { startupWriteFailure });
}
export function createExecBridgeClient(binaryPath = () => getBundledToolBinaryPath("exec_bridge")) {
    let bridge;
    let nextBridgeRequestId = 1;
    const pendingBridgeRequests = new Map();
    let bridgeLineBuffer = "";
    let bridgeStderr = "";
    let bridgeStdoutDecoder = new StringDecoder("utf8");
    let bridgeStderrDecoder = new StringDecoder("utf8");
    let bridgeClosing = false;
    let bridgeResponded = false;
    function rejectPending(error) {
        for (const pending of pendingBridgeRequests.values())
            pending.reject(error);
        pendingBridgeRequests.clear();
    }
    function handleStdout(data) {
        bridgeLineBuffer += bridgeStdoutDecoder.write(data);
        for (;;) {
            const newline = bridgeLineBuffer.indexOf("\n");
            if (newline === -1)
                break;
            const line = bridgeLineBuffer.slice(0, newline).trim();
            bridgeLineBuffer = bridgeLineBuffer.slice(newline + 1);
            if (!line)
                continue;
            let response;
            try {
                response = JSON.parse(line);
            }
            catch {
                continue;
            }
            const pending = pendingBridgeRequests.get(response.request_id);
            if (!pending)
                continue;
            pendingBridgeRequests.delete(response.request_id);
            bridgeResponded = true;
            pending.resolve(response);
        }
    }
    function getBridge() {
        if (bridge && !bridge.killed)
            return bridge;
        const binary = binaryPath();
        if (!binary)
            throw new Error(`exec_bridge binary is not bundled for ${process.platform}-${process.arch}`);
        bridgeClosing = false;
        bridgeLineBuffer = "";
        bridgeStderr = "";
        bridgeResponded = false;
        bridgeStdoutDecoder = new StringDecoder("utf8");
        bridgeStderrDecoder = new StringDecoder("utf8");
        bridge = spawn(binary, [], { stdio: "pipe", env: process.env });
        bridge.stdout.on("data", handleStdout);
        bridge.stderr.on("data", (data) => {
            bridgeStderr = appendBoundedText(bridgeStderr, bridgeStderrDecoder.write(data));
        });
        bridge.stdin.on("error", (error) => {
            rejectPending(new Error(formatExecBridgeWriteError(error, bridgeStderr, !bridgeResponded)));
        });
        bridge.on("close", (code, signal) => {
            bridgeLineBuffer += bridgeStdoutDecoder.end();
            bridgeStderr = appendBoundedText(bridgeStderr, bridgeStderrDecoder.end());
            rejectPending(new Error(bridgeClosing ? "exec_bridge closed" : formatExecBridgeExitError(bridgeStderr, code, signal)));
            bridge = undefined;
            bridgeLineBuffer = "";
            bridgeStderr = "";
        });
        bridge.on("error", (error) => rejectPending(new Error(formatNativeBinaryError("exec_bridge", error, { binaryPath: binary }))));
        return bridge;
    }
    return {
        async request(request) {
            const requestId = nextBridgeRequestId++;
            const child = getBridge();
            const response = await new Promise((resolve, reject) => {
                pendingBridgeRequests.set(requestId, { resolve: resolve, reject });
                child.stdin.write(`${JSON.stringify({ ...request, request_id: requestId })}\n`, (error) => {
                    if (!error)
                        return;
                    pendingBridgeRequests.delete(requestId);
                    reject(new Error(formatExecBridgeWriteError(error, bridgeStderr, !bridgeResponded)));
                });
            });
            if (!response.ok)
                throw new Error(response.error ?? "exec_bridge request failed");
            return response.result;
        },
        shutdown() {
            if (bridge && !bridge.killed) {
                bridgeClosing = true;
                bridge.kill();
            }
        },
    };
}
export function chunkToBytes(chunk) {
    return Buffer.from(chunk, "base64");
}
