import { StringDecoder } from "node:string_decoder";
import { getCodexShellArgs } from "../../adapter/prompt/runtime-shell.js";
import { normalizePipeOutput, truncateOutput, truncateToTail } from "./output.js";
import { chunkToBytes, createExecBridgeClient } from "./bridge-client.js";
import { DEFAULT_EXEC_YIELD_TIME_MS, DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS, DEFAULT_WRITE_YIELD_TIME_MS, clampExecYieldTime, clampWriteYieldTime, normalizeMinEmptyWriteYieldTime, normalizeMinNonInteractiveExecYieldTime, resolveExecution, resolveShell, resolveWorkdir } from "./shell.js";
import { registerAbortHandler, waitForExitOrInactivity } from "./wait.js";
import { makeExecResult, makeSnapshotResult, makeSnapshotSince, snapshotSession } from "./results.js";
const MAX_COMMAND_HISTORY = 256;
const MAX_COMPLETED_SESSION_HISTORY = 32;
const MAX_COMPLETED_SESSION_OUTPUT_CHARS = 64 * 1024;
const MAX_COMPLETED_SESSION_OUTPUT_TOKENS = MAX_COMPLETED_SESSION_OUTPUT_CHARS / 4;
const DEFAULT_MAX_TTY_SESSION_BUFFER_CHARS = 1024 * 1024;
const DEFAULT_MAX_PIPE_SESSION_BUFFER_CHARS = 256 * 1024 * 1024;
const TERMINATE_ESCALATE_MS = 2_000;
const EXIT_OUTPUT_GRACE_MS = 100;
export function createExecSessionManager(options = {}) {
    let nextSessionId = 1;
    const sessions = new Map();
    const commandHistory = new Map();
    const completedResults = new Map();
    const changeListeners = new Set();
    const exitListeners = new Set();
    const bridge = createExecBridgeClient(options.bridgeBinaryPath);
    let baseEnv = { ...(options.env ?? process.env) };
    const defaultExecYieldTimeMs = options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
    const defaultWriteYieldTimeMs = options.defaultWriteYieldTimeMs ?? DEFAULT_WRITE_YIELD_TIME_MS;
    const minNonInteractiveExecYieldTimeMs = normalizeMinNonInteractiveExecYieldTime(options.minNonInteractiveExecYieldTimeMs);
    const minEmptyWriteYieldTimeMs = normalizeMinEmptyWriteYieldTime(options.minEmptyWriteYieldTimeMs);
    const maxEmptyWriteYieldTimeMs = Math.max(minEmptyWriteYieldTimeMs, options.maxEmptyWriteYieldTimeMs ?? DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS);
    const configuredMaxSessionBufferChars = options.maxSessionBufferChars === undefined ? undefined : Math.max(1024, options.maxSessionBufferChars);
    function rememberCommand(sessionId, command) {
        commandHistory.set(sessionId, command);
        if (commandHistory.size <= MAX_COMMAND_HISTORY) {
            return;
        }
        const oldest = commandHistory.keys().next().value;
        if (oldest !== undefined) {
            commandHistory.delete(oldest);
        }
    }
    function rememberCompletedResult(sessionId, result) {
        const bounded = truncateToTail(result.output, MAX_COMPLETED_SESSION_OUTPUT_CHARS);
        completedResults.set(sessionId, {
            ...result,
            output: bounded.removed > 0 ? `[Earlier completed output omitted]\n${bounded.output}` : bounded.output,
        });
        if (completedResults.size <= MAX_COMPLETED_SESSION_HISTORY)
            return;
        const oldest = completedResults.keys().next().value;
        if (oldest !== undefined)
            completedResults.delete(oldest);
    }
    function replayCompletedResult(result, maxOutputTokens) {
        const originalCharCount = result.original_token_count === undefined
            ? result.output.length
            : result.original_token_count * 4;
        return { ...result, ...truncateOutput(result.output, maxOutputTokens, originalCharCount) };
    }
    function finishResult(session, waitMs, maxOutputTokens) {
        const completed = session.exitCode !== undefined && session.exitCode !== null;
        const replaySnapshot = completed ? makeSnapshotResult(session, waitMs, MAX_COMPLETED_SESSION_OUTPUT_TOKENS, true) : undefined;
        const result = makeExecResult(session, waitMs, maxOutputTokens, exposeSession, (sessionId) => sessions.delete(sessionId));
        if (!replaySnapshot || sessions.has(session.id))
            return result;
        rememberCompletedResult(session.id, { ...replaySnapshot, chunk_id: result.chunk_id, wall_time_seconds: result.wall_time_seconds });
        return result;
    }
    function notify(session, reason = "output") {
        session.updatedAt = Date.now();
        for (const listener of session.listeners) {
            listener();
        }
        if (session.exposed)
            notifyChanged(reason);
    }
    function notifyChanged(reason) {
        for (const listener of changeListeners) {
            listener(reason);
        }
    }
    function finalizeSession(session, reason = "exit") {
        if (session.finalized)
            return;
        session.finalized = true;
        for (const listener of exitListeners) {
            listener(session.id, session.command);
        }
        notify(session, reason);
    }
    function exposeSession(session) {
        if (session.exposed || (session.exitCode !== undefined && session.exitCode !== null))
            return;
        session.exposed = true;
        notifyChanged("start");
    }
    function setClosedExitCode(session, code, signal) {
        if (session.exitCode !== undefined && session.exitCode !== null)
            return;
        if (session.terminating) {
            session.exitCode = code && code !== 0 ? code : signal ? 128 + signalNumber(signal) : 143;
            return;
        }
        session.exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
    }
    function signalNumber(signal) {
        if (signal === "SIGTERM")
            return 15;
        if (signal === "SIGKILL")
            return 9;
        if (signal === "SIGINT")
            return 2;
        const numericSignal = /^SIG(\d+)$/.exec(signal)?.[1];
        if (numericSignal)
            return Number.parseInt(numericSignal, 10);
        return 1;
    }
    function appendOutput(session, text) {
        if (text.length === 0)
            return;
        const output = session.tty ? text : normalizePipeOutput(text);
        session.buffer += output;
        session.outputVersion += 1;
        const maxSessionBufferChars = configuredMaxSessionBufferChars ?? (session.tty ? DEFAULT_MAX_TTY_SESSION_BUFFER_CHARS : DEFAULT_MAX_PIPE_SESSION_BUFFER_CHARS);
        if (session.buffer.length > maxSessionBufferChars) {
            const bounded = truncateToTail(session.buffer, maxSessionBufferChars);
            session.buffer = bounded.output;
            session.bufferStartOffset += bounded.removed;
        }
        notify(session);
    }
    function setBaseEnv(env) {
        baseEnv = { ...env };
    }
    async function pollSession(session, waitMs = 0, maxBytes) {
        const response = await bridge.request({
            op: "read",
            process_id: session.processId,
            after_seq: session.lastSeq,
            max_bytes: maxBytes,
            wait_ms: waitMs,
        });
        let receivedOutput = false;
        for (const chunk of response.chunks ?? []) {
            appendOutput(session, session.outputDecoders[chunk.stream].write(chunkToBytes(chunk.chunk)));
            session.lastSeq = Math.max(session.lastSeq, chunk.seq);
            receivedOutput = true;
        }
        session.lastSeq = Math.max(session.lastSeq, response.nextSeq - 1);
        if (response.exited) {
            session.observedExitCode = response.exitCode;
            if (session.postExitIdleSince === undefined || receivedOutput)
                session.postExitIdleSince = Date.now();
        }
        const postExitIdle = session.postExitIdleSince !== undefined
            && Date.now() - session.postExitIdleSince >= EXIT_OUTPUT_GRACE_MS;
        if (response.closed || postExitIdle) {
            if (!session.outputDecodersFlushed) {
                session.outputDecodersFlushed = true;
                for (const decoder of Object.values(session.outputDecoders))
                    appendOutput(session, decoder.end());
            }
            setClosedExitCode(session, response.exitCode ?? session.observedExitCode);
            finalizeSession(session);
        }
    }
    function createRustSession(input, workdir, shell, signal) {
        const session = {
            kind: "rust",
            id: nextSessionId++,
            processId: "",
            startup: Promise.resolve(),
            started: false,
            tty: Boolean(input.tty),
            command: input.cmd,
            buffer: "",
            bufferStartOffset: 0,
            emittedOffset: 0,
            outputVersion: 0,
            exitCode: undefined,
            listeners: new Set(),
            interactive: Boolean(input.tty),
            lastSeq: 0,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            finalized: false,
            exposed: false,
            terminating: false,
            outputDecoders: {
                stdout: new StringDecoder("utf8"),
                stderr: new StringDecoder("utf8"),
                pty: new StringDecoder("utf8"),
            },
            outputDecodersFlushed: false,
        };
        session.processId = `pi-${session.id}`;
        session.startup = (async () => {
            try {
                const login = input.login ?? true;
                const execution = resolveExecution(input.shell, input.cmd, input.env, baseEnv);
                const shellArgs = getCodexShellArgs(shell, execution.command, login);
                await bridge.request({
                    op: "exec",
                    process_id: session.processId,
                    argv: [shell, ...shellArgs],
                    cwd: workdir,
                    env: execution.env,
                    tty: Boolean(input.tty),
                    pipe_stdin: Boolean(input.tty),
                    arg0: null,
                });
                session.started = true;
                if (signal?.aborted) {
                    session.terminating = true;
                    await bridge.request({ op: "terminate", process_id: session.processId });
                }
                void pollSessionLoop(session);
            }
            catch (error) {
                appendOutput(session, `${error instanceof Error ? error.message : String(error)}\n`);
                session.exitCode = 1;
                finalizeSession(session);
            }
        })();
        return session;
    }
    async function waitForStartup(session, signal) {
        if (!signal)
            return session.startup;
        if (signal.aborted)
            throw new Error("exec_command aborted");
        let removeAbortListener = () => { };
        const aborted = new Promise((_, reject) => {
            const onAbort = () => reject(new Error("exec_command aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        });
        try {
            await Promise.race([session.startup, aborted]);
        }
        finally {
            removeAbortListener();
        }
    }
    async function pollSessionLoop(session) {
        while (sessions.has(session.id) && (session.exitCode === undefined || session.exitCode === null)) {
            try {
                await pollSession(session, 250);
            }
            catch (error) {
                appendOutput(session, `${error instanceof Error ? error.message : String(error)}\n`);
                session.exitCode = 1;
                finalizeSession(session);
                return;
            }
        }
    }
    return {
        setBaseEnv,
        exec: async (input, cwd, signal, onUpdate) => {
            const shell = resolveShell(input.shell);
            const workdir = resolveWorkdir(cwd, input.workdir);
            const session = createRustSession(input, workdir, shell, signal);
            sessions.set(session.id, session);
            rememberCommand(session.id, session.command);
            const abortCleanup = registerAbortHandler(signal, () => {
                if (session.exitCode === undefined || session.exitCode === null) {
                    void bridge.request({ op: "terminate", process_id: session.processId }).catch(() => { });
                }
            });
            try {
                onUpdate?.(makeSnapshotResult(session, 0, input.max_output_tokens, true));
                const execYieldMs = clampExecYieldTime(input.yield_time_ms, defaultExecYieldTimeMs, session.interactive, minNonInteractiveExecYieldTimeMs, input.max_yield_time_ms);
                const maxExecWaitMs = Math.max(execYieldMs, input.max_yield_time_ms ?? execYieldMs);
                const waitedMs = await waitForExitOrInactivity(session, execYieldMs, maxExecWaitMs, signal, onUpdate ? (elapsedMs) => onUpdate(makeSnapshotResult(session, elapsedMs, input.max_output_tokens)) : undefined);
                await waitForStartup(session, signal);
                if (session.started)
                    await pollSession(session, 0);
                if (session.exitCode === undefined || session.exitCode === null)
                    session.nextEmptyPollYieldMs = growEmptyPollYield(Math.max(execYieldMs, waitedMs), maxEmptyWriteYieldTimeMs);
                return finishResult(session, waitedMs, input.max_output_tokens);
            }
            catch (error) {
                if (signal?.aborted)
                    sessions.delete(session.id);
                throw error;
            }
            finally {
                abortCleanup();
            }
        },
        write: async (input, signal, onUpdate) => {
            if (signal?.aborted) {
                throw new Error("write_stdin aborted");
            }
            const session = sessions.get(input.session_id);
            if (!session) {
                const completed = completedResults.get(input.session_id);
                if (completed) {
                    if ((input.chars ?? "").length > 0) {
                        throw new Error(`Process id ${input.session_id} already exited with code ${completed.exit_code}; cannot write stdin`);
                    }
                    return replayCompletedResult(completed, input.max_output_tokens);
                }
                throw new Error(`Unknown process id ${input.session_id}`);
            }
            const updateBaseline = session.bufferStartOffset + session.buffer.length;
            const chars = input.chars ?? "";
            const isEmptyPoll = chars.length === 0;
            if (!isEmptyPoll) {
                if (!session.interactive) {
                    throw new Error("stdin is closed for this session; rerun exec_command with tty=true to keep stdin open");
                }
                await bridge.request({ op: "write", process_id: session.processId, chunk: Array.from(Buffer.from(chars, "utf8")) });
                session.nextEmptyPollYieldMs = undefined;
            }
            onUpdate?.(makeSnapshotSince(session, 0, updateBaseline, input.max_output_tokens));
            const requestedYieldMs = clampWriteYieldTime(input.yield_time_ms, defaultWriteYieldTimeMs, isEmptyPoll, minEmptyWriteYieldTimeMs, maxEmptyWriteYieldTimeMs);
            const effectiveYieldMs = isEmptyPoll
                ? Math.max(requestedYieldMs, session.nextEmptyPollYieldMs ?? 0)
                : requestedYieldMs;
            const waitedMs = session.exitCode === undefined
                ? await waitForExitOrInactivity(session, effectiveYieldMs, effectiveYieldMs, signal, onUpdate ? (elapsedMs) => onUpdate(makeSnapshotSince(session, elapsedMs, updateBaseline, input.max_output_tokens)) : undefined)
                : 0;
            await waitForStartup(session, signal);
            if (session.started)
                await pollSession(session, 0);
            if (isEmptyPoll && (session.exitCode === undefined || session.exitCode === null))
                session.nextEmptyPollYieldMs = growEmptyPollYield(effectiveYieldMs, maxEmptyWriteYieldTimeMs);
            return finishResult(session, waitedMs, input.max_output_tokens);
        },
        hasSession: (sessionId) => sessions.has(sessionId),
        getSessionCommand: (sessionId) => sessions.get(sessionId)?.command ?? commandHistory.get(sessionId),
        listSessions: (maxOutputChars) => {
            const snapshotsById = new Map();
            for (const session of sessions.values()) {
                if (!session.exposed)
                    continue;
                if (session.exitCode !== undefined && session.exitCode !== null)
                    continue;
                snapshotsById.set(session.id, snapshotSession(session, maxOutputChars));
            }
            return Array.from(snapshotsById.values()).sort((a, b) => a.id - b.id);
        },
        terminateSession: (sessionId) => {
            const session = sessions.get(sessionId);
            if (!session || session.exitCode !== undefined || session.terminating)
                return false;
            session.terminating = true;
            void bridge.request({ op: "terminate", process_id: session.processId }).catch(() => { });
            setTimeout(() => {
                if (session.exitCode === undefined || session.exitCode === null)
                    void bridge.request({ op: "terminate", process_id: session.processId }).catch(() => { });
            }, TERMINATE_ESCALATE_MS).unref?.();
            notify(session, "terminate");
            return true;
        },
        onSessionChange: (listener) => {
            changeListeners.add(listener);
            return () => changeListeners.delete(listener);
        },
        onSessionExit: (listener) => {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
        },
        shutdown: () => {
            for (const session of sessions.values()) {
                if (session.exitCode === undefined || session.exitCode === null)
                    void bridge.request({ op: "terminate", process_id: session.processId }).catch(() => { });
            }
            bridge.shutdown();
            sessions.clear();
            commandHistory.clear();
            completedResults.clear();
        },
    };
}
function growEmptyPollYield(currentMs, maximumMs) {
    return Math.min(maximumMs, currentMs * 2);
}
