import { WebSocket } from "ws";
import { decodeLanVoiceAudioCommand } from "./protocol.js";
export const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_PCM_BYTES = 24_000 * 2;
const MAX_SOCKET_AUDIO_BACKLOG = 24_000 * 2;
export class LanVoiceBrowserClients {
    options;
    eventResponses = new Map();
    audioSockets = new Map();
    state = { type: "idle" };
    operation = Promise.resolve();
    constructor(options) {
        this.options = options;
    }
    connectEvents(clientId, response) {
        if (this.state.type === "closed") {
            response.end();
            return;
        }
        const previous = this.eventResponses.get(clientId);
        this.eventResponses.set(clientId, response);
        previous?.end();
        response.once("close", () => {
            if (this.eventResponses.get(clientId) === response)
                this.eventResponses.delete(clientId);
        });
    }
    connectAudio(clientId, socket) {
        if (this.state.type === "closed") {
            socket.close(1012, "server closing");
            return;
        }
        const previous = this.audioSockets.get(clientId);
        this.audioSockets.set(clientId, socket);
        if (previous)
            this.releaseStarting(clientId, previous);
        previous?.close(4001, "replaced");
        socket.send(JSON.stringify({ type: "connected" }));
        socket.on("message", (data, isBinary) => this.receive(clientId, socket, data, isBinary));
        socket.once("close", () => {
            if (this.audioSockets.get(clientId) === socket)
                this.audioSockets.delete(clientId);
            this.release(clientId, socket);
        });
    }
    sendControl(clientId, value) {
        const response = this.eventResponses.get(clientId);
        if (response && !response.writableEnded)
            response.write(`data: ${JSON.stringify(value)}\n\n`);
    }
    broadcastControl(value) {
        for (const clientId of this.eventResponses.keys())
            this.sendControl(clientId, value);
    }
    sendConversationAudio(pcm) {
        const active = this.state;
        if (active.type !== "active" || active.mode !== "conversation")
            return;
        if (active.socket.readyState !== WebSocket.OPEN || active.socket.bufferedAmount >= MAX_SOCKET_AUDIO_BACKLOG)
            return;
        active.socket.send(pcm);
    }
    release(clientId, socket) {
        this.releaseStarting(clientId, socket);
        void this.enqueue(async () => {
            const active = this.state;
            if (active.type !== "active" || active.clientId !== clientId || (socket && active.socket !== socket))
                return;
            this.state = { type: "idle" };
            if (active.mode === "conversation")
                this.options.onConversationActivity(false);
            else
                await this.options.finishDictation(clientId);
        }).catch((error) => this.sendControl(clientId, { type: "error", message: errorMessage(error) }));
    }
    heartbeat() {
        for (const response of this.eventResponses.values())
            if (!response.writableEnded)
                response.write(": keepalive\n\n");
    }
    async close() {
        const active = this.state;
        if (active.type === "closed") {
            await this.operation;
            return;
        }
        this.state = { type: "closed" };
        const failures = [];
        if (active.type === "active" && active.mode === "conversation") {
            try {
                this.options.onConversationActivity(false);
            }
            catch (error) {
                failures.push(error);
            }
        }
        if ((active.type === "starting" || active.type === "active") && active.mode === "dictation") {
            try {
                await this.options.cancelDictation(active.clientId);
            }
            catch (error) {
                failures.push(error);
            }
        }
        for (const socket of this.audioSockets.values()) {
            try {
                socket.terminate();
            }
            catch (error) {
                failures.push(error);
            }
        }
        this.audioSockets.clear();
        for (const response of this.eventResponses.values()) {
            try {
                response.end();
            }
            catch (error) {
                failures.push(error);
            }
        }
        this.eventResponses.clear();
        try {
            await this.operation;
        }
        catch (error) {
            failures.push(error);
        }
        if (failures.length === 1)
            throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(failures, "LAN browser cleanup failed");
    }
    receive(clientId, socket, data, isBinary) {
        if (this.audioSockets.get(clientId) !== socket)
            return;
        try {
            if (isBinary) {
                this.receiveAudio(clientId, socket, rawBuffer(data));
                return;
            }
            const text = rawBuffer(data).toString("utf8");
            if (Buffer.byteLength(text) > MAX_CONTROL_BYTES)
                throw new Error("LAN voice control message is too large");
            const message = decodeLanVoiceAudioCommand(JSON.parse(text));
            if (message.type === "start") {
                void this.claim(clientId, socket, message.mode).catch((error) => this.sendSocketError(socket, error));
            }
            else if (message.type === "finish") {
                void this.finish(clientId, socket, message.draft, message.revision, message.selection).catch((error) => this.sendSocketError(socket, error));
            }
            else if (message.type === "release") {
                this.release(clientId, socket);
            }
            else if (message.type === "mute") {
                this.mute(clientId, socket, message.muted);
            }
            else {
                void this.options.cancelDictation(clientId).catch((error) => this.sendSocketError(socket, error));
            }
        }
        catch {
            socket.close(1003, "invalid message");
        }
    }
    mute(clientId, socket, muted) {
        const active = this.state;
        if (active.type !== "active" || active.clientId !== clientId || active.socket !== socket || active.mode !== "conversation")
            return;
        this.options.onConversationMute(muted);
    }
    receiveAudio(clientId, socket, pcm) {
        if (pcm.byteLength === 0 || pcm.byteLength > MAX_PCM_BYTES || pcm.byteLength % 2 !== 0)
            throw new Error("Invalid LAN voice PCM frame");
        const active = this.state;
        if (active.type !== "active" || active.clientId !== clientId || active.socket !== socket)
            return;
        if (active.mode === "conversation")
            this.options.onConversationAudio(pcm);
        else
            this.options.onDictationAudio(clientId, pcm);
    }
    claim(clientId, socket, mode) {
        const starting = this.state.type === "starting" ? this.state : undefined;
        if (starting && (starting.clientId !== clientId || starting.socket !== socket || starting.mode !== mode)) {
            this.releaseStarting(starting.clientId, starting.socket);
            this.sendControl(starting.clientId, { type: "stop", reason: "replaced" });
            starting.socket.close(4001, "replaced");
        }
        return this.enqueue(async () => {
            if (this.isClosed())
                return;
            const previous = this.state.type === "active" ? this.state : undefined;
            if (previous?.clientId === clientId && previous.socket === socket && previous.mode === mode)
                return;
            this.state = { type: "idle" };
            if (previous && previous.socket !== socket) {
                this.sendControl(previous.clientId, { type: "stop", reason: "replaced" });
                previous.socket.close(4001, "replaced");
            }
            if (previous?.mode === "conversation" && mode !== "conversation")
                this.options.onConversationActivity(false);
            if (previous?.mode === "dictation")
                await this.options.finishDictation(previous.clientId);
            if (this.isClosed())
                return;
            const starting = { type: "starting", clientId, socket, mode };
            this.state = starting;
            try {
                if (mode === "conversation")
                    await this.options.ensureConversation();
                else
                    await this.options.startDictation(clientId);
            }
            catch (error) {
                if (this.state === starting)
                    this.state = { type: "idle" };
                throw error;
            }
            if (this.isClosed() || this.state !== starting || this.audioSockets.get(clientId) !== socket || socket.readyState !== WebSocket.OPEN) {
                if (mode === "dictation")
                    await this.options.cancelDictation(clientId);
                return;
            }
            this.state = { type: "active", clientId, socket, mode };
            if (mode === "conversation")
                this.options.onConversationActivity(true);
            socket.send(JSON.stringify({ type: "active", mode, ...(mode === "conversation" ? { muted: this.options.conversationMuted() } : {}) }));
        });
    }
    releaseStarting(clientId, socket) {
        const starting = this.state;
        if (starting.type !== "starting" || starting.clientId !== clientId || (socket && starting.socket !== socket))
            return;
        this.state = { type: "idle" };
        if (starting.mode === "dictation")
            void this.options.cancelDictation(clientId).catch((error) => this.sendControl(clientId, { type: "error", message: errorMessage(error) }));
    }
    finish(clientId, socket, draft, revision, selection) {
        return this.enqueue(async () => {
            const active = this.state;
            if (active.type !== "active" || active.clientId !== clientId || active.socket !== socket || active.mode !== "dictation")
                return;
            this.state = { type: "idle" };
            await this.options.finishDictation(clientId, draft, revision, selection);
            if (!this.isClosed() && socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: "dictation.complete" }));
        });
    }
    sendSocketError(socket, error) {
        if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "error", message: errorMessage(error) }));
    }
    isClosed() { return this.state.type === "closed"; }
    enqueue(action) {
        const result = this.operation.then(action, action);
        this.operation = result.then(() => undefined, () => undefined);
        return result;
    }
}
function rawBuffer(data) {
    if (Buffer.isBuffer(data))
        return data;
    if (Array.isArray(data))
        return Buffer.concat(data);
    return Buffer.from(data);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
