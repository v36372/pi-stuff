import { resolveWebSocketProxyForTarget } from "../../providers/openai-codex/websocket-connection.js";
import { MAX_REALTIME_VOICE_INPUT_BYTES, renderPiSteer } from "../prompts.js";
import { RealtimeVoiceTurnTracker } from "../turns.js";
import { MAX_REALTIME_SDP_BYTES } from "./peer.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";
const V3_MODEL = "gpt-live-1-codex";
const HANDOFF_CHUNK_BYTES = 500;
const HANDOFF_FLUSH_MS = 200;
const PEER_READY_TIMEOUT_MS = 15_000;
export class CodexRealtimeConversation {
    callbacks;
    peer;
    turnTracker = new RealtimeVoiceTurnTracker();
    state = "idle";
    activeDelegationId;
    handoffBuffer = "";
    handoffChannel = "speakable";
    handoffTimer;
    setupAbortController;
    peerReady;
    callSetup = setupRealtimeCall;
    inputMuted = false;
    constructor(callbacks, peer) {
        this.callbacks = callbacks;
        this.peer = peer;
        this.peer.onEvent((event) => this.handlePeerEvent(event));
        this.peer.onExit((error) => this.fail(error));
    }
    async start(auth, config, instructions) {
        this.state = "starting";
        const sdp = await this.peer.start(config);
        if (this.state !== "starting")
            return;
        const headers = new Headers(auth.headers);
        headers.set("openai-alpha", "quicksilver=v2");
        headers.set("content-type", "application/json");
        const endpoint = `${auth.baseUrl.replace(/\/+$/, "")}/realtime/calls?intent=quicksilver&architecture=avas`;
        const setupAbortController = new AbortController();
        this.setupAbortController = setupAbortController;
        const requestBody = JSON.stringify({ sdp, session: { model: V3_MODEL, instructions, audio: { output: { voice: config.voice.v3Voice } }, delegation: { type: "client" } } });
        let status;
        let answer;
        try {
            ({ status, answer } = await this.callSetup(endpoint, headers, setupAbortController.signal, requestBody, auth.env));
        }
        finally {
            if (this.setupAbortController === setupAbortController)
                this.setupAbortController = undefined;
        }
        if (this.state !== "starting")
            return;
        if (status !== 201)
            throw new Error(`Codex voice call failed (${status}): ${answer.slice(0, 1_000)}`);
        this.state = "active";
        const peerReady = Promise.withResolvers();
        this.peerReady = peerReady;
        this.callbacks.onStatus("connecting…");
        this.peer.applyAnswer(answer);
        let timeout;
        try {
            await Promise.race([
                peerReady.promise,
                new Promise((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error("Codex voice peer did not become ready")), PEER_READY_TIMEOUT_MS);
                }),
            ]);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (this.peerReady === peerReady)
                this.peerReady = undefined;
        }
    }
    activateDelegation(id) {
        if (this.state !== "active" || this.activeDelegationId === id)
            return;
        const previousDelegationId = this.activeDelegationId;
        this.flushHandoff();
        if (this.state !== "active")
            return;
        if (previousDelegationId)
            this.turnTracker.delegationSettled(previousDelegationId);
        this.activeDelegationId = id;
    }
    get microphoneMuted() { return this.inputMuted; }
    setInputMuted(muted) {
        if (this.state !== "active" || this.inputMuted === muted)
            return;
        this.peer.setInputMuted(muted);
        this.inputMuted = muted;
    }
    mirrorPiSteer(input) {
        const delegationId = this.activeDelegationId;
        const frame = renderPiSteer(input);
        if (this.state !== "active" || !delegationId || !frame)
            return false;
        this.flushHandoff();
        if (this.state !== "active" || this.activeDelegationId !== delegationId)
            return false;
        try {
            for (const text of utf8Chunks(frame, HANDOFF_CHUNK_BYTES)) {
                this.peer.sendData({ type: "delegation.context.append", delegation_item_id: delegationId, channel: "commentary", content: [{ type: "input_text", text }] });
            }
            return true;
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
            return false;
        }
    }
    streamAgentDelta(type, delta) {
        if (this.state !== "active" || !this.activeDelegationId || !delta)
            return;
        this.callbacks.onStatus("speaking");
        const channel = type === "thinking_delta" ? "commentary" : "speakable";
        if (this.handoffBuffer && channel !== this.handoffChannel)
            this.flushHandoff();
        this.handoffChannel = channel;
        this.handoffBuffer += delta;
        if (!this.handoffTimer)
            this.handoffTimer = setTimeout(() => this.flushHandoff(), HANDOFF_FLUSH_MS);
    }
    settleAgentTurn() {
        this.flushHandoff();
        if (this.activeDelegationId)
            this.turnTracker.delegationSettled(this.activeDelegationId);
        this.activeDelegationId = undefined;
        if (this.state === "active")
            this.callbacks.onStatus("listening");
    }
    async close() {
        if (this.state === "closed")
            return;
        this.state = "closed";
        this.abortSetup();
        this.clearHandoff();
        for (const turn of this.turnTracker.drainConversationTurns())
            this.callbacks.onTurn(turn);
        const transcriptTail = this.turnTracker.takeTranscriptTail();
        if (transcriptTail)
            this.callbacks.onTranscriptTail(transcriptTail);
        this.turnTracker.reset();
        this.activeDelegationId = undefined;
        this.inputMuted = false;
        this.peerReady?.resolve();
        this.peerReady = undefined;
        await this.peer.close();
    }
    handlePeerEvent(event) {
        if (this.state === "idle" || this.state === "closed" || this.state === "failed")
            return;
        if (event.type === "error") {
            this.fail(new Error(event.message));
            return;
        }
        if (event.type === "data")
            this.handleServerEvent(event.message);
        if (event.type === "state")
            this.handleHelperState(event.state);
    }
    handleHelperState(state) {
        const failure = realtimePeerStateFailure(state);
        if (failure) {
            this.fail(new Error(failure));
            return;
        }
        if (state === "ready" || state === "listening") {
            this.peerReady?.resolve();
            this.callbacks.onStatus("listening");
        }
        else if (state === "connecting" || state === "connected")
            this.callbacks.onStatus("connecting…");
        else if (state === "disconnected")
            this.callbacks.onStatus("reconnecting…");
    }
    handleServerEvent(value) {
        if (!value || typeof value !== "object")
            return;
        const event = value;
        if (event["type"] === "error") {
            this.fail(new Error(remoteError(event)));
            return;
        }
        if (event["type"] === "input_transcript.added") {
            const input = boundedTranscript(transcriptItemText(event["item"]));
            if (input === "oversized") {
                this.fail(new Error("Codex voice transcript was oversized"));
                return;
            }
            if (input)
                this.turnTracker.inputAdded(input);
            return;
        }
        if (event["type"] === "output_transcript.added") {
            const output = boundedAssistantTranscript(transcriptItemText(event["item"]));
            if (output)
                this.turnTracker.outputAdded(output);
            this.callbacks.onStatus("speaking");
            return;
        }
        if (event["type"] === "turn.done") {
            this.handleCompletedTurn(event["turn"]);
            return;
        }
        if (event["type"] !== "delegation.created" || this.state !== "active")
            return;
        const item = event["item"];
        if (!item || typeof item !== "object")
            return;
        const record = item;
        if (record["type"] !== "delegation" || record["target"] !== "client" || typeof record["id"] !== "string" || !Array.isArray(record["content"]))
            return;
        const input = record["content"].flatMap((part) => part && typeof part === "object" && part["type"] === "input_text" && typeof part["text"] === "string" ? [part["text"]] : []).join("").trim();
        if (!input || Buffer.byteLength(input) > MAX_REALTIME_VOICE_INPUT_BYTES) {
            this.fail(new Error("Codex voice delegation was empty or oversized"));
            return;
        }
        const delegated = this.turnTracker.delegated(input, record["id"]);
        if (!delegated)
            return;
        this.flushHandoff();
        this.callbacks.onTurn(delegated);
    }
    handleCompletedTurn(turn) {
        if (!turn || typeof turn !== "object")
            return;
        const record = turn;
        if (record["role"] === "user") {
            const input = boundedTranscript(record["transcript"]);
            if (input === "oversized") {
                this.fail(new Error("Codex voice transcript was oversized"));
                return;
            }
            if (input)
                this.turnTracker.userFinished(input);
            this.callbacks.onStatus("responding");
            return;
        }
        if (record["role"] !== "assistant")
            return;
        const completed = this.turnTracker.assistantFinished(boundedAssistantTranscript(record["transcript"]));
        this.callbacks.onStatus("listening");
        if (completed)
            this.callbacks.onTurn(completed);
    }
    flushHandoff() {
        if (this.handoffTimer)
            clearTimeout(this.handoffTimer);
        this.handoffTimer = undefined;
        if (this.state !== "active" || !this.activeDelegationId || !this.handoffBuffer)
            return;
        try {
            for (const text of utf8Chunks(this.handoffBuffer, HANDOFF_CHUNK_BYTES)) {
                this.peer.sendData({ type: "delegation.context.append", delegation_item_id: this.activeDelegationId, channel: this.handoffChannel, content: [{ type: "input_text", text }] });
            }
            this.handoffBuffer = "";
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    clearHandoff() {
        if (this.handoffTimer)
            clearTimeout(this.handoffTimer);
        this.handoffTimer = undefined;
        this.handoffBuffer = "";
    }
    abortSetup() {
        this.setupAbortController?.abort();
        this.setupAbortController = undefined;
    }
    fail(error) {
        if (this.state === "idle" || this.state === "closed" || this.state === "failed")
            return;
        this.state = "failed";
        this.abortSetup();
        this.clearHandoff();
        this.peerReady?.resolve();
        this.peerReady = undefined;
        this.callbacks.onError(error);
        void this.peer.close();
    }
}
async function setupRealtimeCall(endpoint, headers, signal, body, env) {
    const proxy = await resolveWebSocketProxyForTarget(endpoint, env);
    const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    try {
        const response = await undiciFetch(endpoint, {
            method: "POST",
            headers: Object.fromEntries(headers),
            signal,
            body,
            ...(dispatcher ? { dispatcher } : {}),
        });
        return { status: response.status, answer: await readBoundedResponseText(response, MAX_REALTIME_SDP_BYTES) };
    }
    finally {
        await dispatcher?.close();
    }
}
async function readBoundedResponseText(response, maxBytes) {
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
        throw new Error(`Codex voice response exceeded ${maxBytes} bytes`);
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const chunk = Buffer.from(value);
            bytes += chunk.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel().catch(() => { });
                throw new Error(`Codex voice response exceeded ${maxBytes} bytes`);
            }
            chunks.push(chunk);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}
function boundedTranscript(value) {
    if (typeof value !== "string")
        return undefined;
    const input = value.trim();
    if (!input)
        return undefined;
    return Buffer.byteLength(input) > MAX_REALTIME_VOICE_INPUT_BYTES ? "oversized" : input;
}
function transcriptItemText(value) {
    return value && typeof value === "object" ? value["text"] : undefined;
}
function boundedAssistantTranscript(value) {
    if (typeof value !== "string")
        return undefined;
    const output = value.trim();
    if (!output)
        return undefined;
    return utf8Tail(output, MAX_REALTIME_VOICE_INPUT_BYTES - 32);
}
function utf8Tail(value, maxBytes) {
    if (Buffer.byteLength(value) <= maxBytes)
        return value;
    let start = value.length;
    let bytes = 0;
    while (start > 0) {
        let characterStart = start - 1;
        const lastUnit = value.charCodeAt(characterStart);
        if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff && characterStart > 0)
            characterStart--;
        const characterBytes = Buffer.byteLength(value.slice(characterStart, start));
        if (bytes + characterBytes > maxBytes)
            break;
        bytes += characterBytes;
        start = characterStart;
    }
    return value.slice(start);
}
function remoteError(event) {
    if (typeof event["message"] === "string")
        return event["message"];
    const error = event["error"];
    return error && typeof error === "object" && typeof error["message"] === "string" ? error["message"] : "Codex realtime error";
}
export function utf8Chunks(input, maxBytes) {
    const chunks = [];
    let current = "";
    for (const character of input) {
        if (Buffer.byteLength(current + character) > maxBytes && current) {
            chunks.push(current);
            current = character;
        }
        else
            current += character;
    }
    if (current)
        chunks.push(current);
    return chunks;
}
function realtimePeerStateFailure(state) {
    if (state === "failed")
        return "Codex realtime connection failed";
    if (state === "closed")
        return "Codex realtime connection closed";
    return undefined;
}
