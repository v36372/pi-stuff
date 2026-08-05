import { MAX_REALTIME_VOICE_INPUT_BYTES } from "../prompts.js";
import { RealtimeVoiceTurnTracker } from "../turns.js";
import { buildRealtimeCallRequest, setupRealtimeCall } from "./call-setup.js";
import { RealtimeDelegationHandoff } from "./handoff.js";
import {} from "./peer.js";
import { boundedAssistantTranscript, boundedTranscript, realtimePeerStateFailure, remoteError, transcriptItemText } from "./wire.js";
export { buildRealtimeCallRequest } from "./call-setup.js";
export { utf8Chunks } from "./wire.js";
const PEER_READY_TIMEOUT_MS = 15_000;
export class CodexRealtimeConversation {
    callbacks;
    peer;
    turnTracker = new RealtimeVoiceTurnTracker();
    handoff;
    state = "idle";
    setupAbortController;
    peerReady;
    callSetup = setupRealtimeCall;
    inputMuted = false;
    constructor(callbacks, peer) {
        this.callbacks = callbacks;
        this.peer = peer;
        this.handoff = new RealtimeDelegationHandoff(peer, {
            isActive: () => this.state === "active",
            onFailure: (error) => this.fail(error),
            onSettled: (id) => this.turnTracker.delegationSettled(id),
            onStatus: (status) => this.callbacks.onStatus(status),
        });
        this.peer.onEvent((event) => this.handlePeerEvent(event));
        this.peer.onExit((error) => this.fail(error));
    }
    async start(auth, config, instructions, initialItems) {
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
        const requestBody = JSON.stringify(buildRealtimeCallRequest(sdp, config, instructions, initialItems));
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
        this.handoff.activate(id);
    }
    get microphoneMuted() { return this.inputMuted; }
    setInputMuted(muted) {
        if (this.state !== "active" || this.inputMuted === muted)
            return;
        this.peer.setInputMuted(muted);
        this.inputMuted = muted;
    }
    mirrorPiSteer(input) {
        return this.handoff.mirrorPiSteer(input);
    }
    streamAgentDelta(delta) {
        this.handoff.stream(delta);
    }
    finishAgentMessage(channel) {
        this.handoff.finishMessage(channel);
    }
    settleAgentTurn() {
        this.handoff.settle();
    }
    async close() {
        if (this.state === "closed")
            return;
        this.state = "closed";
        this.abortSetup();
        this.handoff.clear();
        this.drainConversation();
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
                this.callbacks.onUserTranscript(input);
            const delegated = input ? this.turnTracker.userFinished(input) : undefined;
            this.callbacks.onStatus("responding");
            if (delegated) {
                this.callbacks.onTurn(delegated);
            }
            return;
        }
        if (record["role"] !== "assistant")
            return;
        const completed = this.turnTracker.assistantFinished(boundedAssistantTranscript(record["transcript"]));
        this.callbacks.onStatus("listening");
        if (completed)
            this.callbacks.onTurn(completed);
    }
    abortSetup() {
        this.setupAbortController?.abort();
        this.setupAbortController = undefined;
    }
    drainConversation() {
        for (const turn of this.turnTracker.drainConversationTurns())
            this.callbacks.onTurn(turn);
        const transcriptTail = this.turnTracker.takeTranscriptTail();
        if (transcriptTail)
            this.callbacks.onTranscriptTail(transcriptTail);
        this.turnTracker.reset();
    }
    fail(error) {
        if (this.state === "idle" || this.state === "closed" || this.state === "failed")
            return;
        this.state = "failed";
        this.abortSetup();
        this.handoff.clear();
        this.drainConversation();
        this.peerReady?.resolve();
        this.peerReady = undefined;
        this.callbacks.onError(error);
        void this.peer.close();
    }
}
