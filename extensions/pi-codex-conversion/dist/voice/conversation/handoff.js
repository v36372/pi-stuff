import { renderPiSteer } from "../prompts.js";
import { utf8Chunks } from "./wire.js";
const HANDOFF_CHUNK_BYTES = 500;
export function realtimeHandoffChannel(stopReason) {
    return stopReason === "toolUse" ? "commentary" : "speakable";
}
export class RealtimeDelegationHandoff {
    peer;
    callbacks;
    activeDelegationId;
    buffer = "";
    constructor(peer, callbacks) {
        this.peer = peer;
        this.callbacks = callbacks;
    }
    activate(id) {
        if (!this.callbacks.isActive() || this.activeDelegationId === id)
            return;
        const previousDelegationId = this.activeDelegationId;
        this.finishMessage("speakable");
        if (!this.callbacks.isActive())
            return;
        if (previousDelegationId)
            this.callbacks.onSettled(previousDelegationId);
        this.activeDelegationId = id;
    }
    mirrorPiSteer(input) {
        const delegationId = this.activeDelegationId;
        const frame = renderPiSteer(input);
        if (!this.callbacks.isActive() || !delegationId || !frame)
            return false;
        try {
            this.send(delegationId, "commentary", frame);
            return true;
        }
        catch (error) {
            this.callbacks.onFailure(asError(error));
            return false;
        }
    }
    stream(delta) {
        if (!this.callbacks.isActive() || !this.activeDelegationId || !delta)
            return;
        this.buffer += delta;
    }
    finishMessage(channel) {
        const delegationId = this.activeDelegationId;
        const text = this.buffer;
        this.buffer = "";
        if (!this.callbacks.isActive() || !delegationId || !text)
            return;
        if (channel === "speakable")
            this.callbacks.onStatus("speaking");
        try {
            this.send(delegationId, channel, text);
        }
        catch (error) {
            this.callbacks.onFailure(asError(error));
        }
    }
    settle() {
        this.finishMessage("speakable");
        if (this.activeDelegationId)
            this.callbacks.onSettled(this.activeDelegationId);
        this.activeDelegationId = undefined;
        if (this.callbacks.isActive())
            this.callbacks.onStatus("listening");
    }
    clear() {
        this.buffer = "";
        this.activeDelegationId = undefined;
    }
    send(delegationId, channel, content) {
        for (const text of utf8Chunks(content, HANDOFF_CHUNK_BYTES)) {
            this.peer.sendData({ type: "delegation.context.append", delegation_item_id: delegationId, channel, content: [{ type: "input_text", text }] });
        }
    }
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
