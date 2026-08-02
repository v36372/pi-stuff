const MAX_TRANSCRIPT_DELTA_BYTES = 32 * 1024;
class RealtimeTranscriptBuffer {
    entries = [];
    append(role, transcript) {
        const text = transcript.trim();
        if (!text)
            return;
        const last = this.entries.at(-1);
        if (last?.role === role)
            last.text += text;
        else
            this.entries.push({ role, text });
        this.bound();
    }
    finish(role, transcript) {
        const text = transcript.trim();
        if (!text)
            return;
        const last = this.entries.at(-1);
        if (last?.role === role)
            last.text = text;
        else
            this.entries.push({ role, text });
        this.bound();
    }
    handoff(input) {
        const normalized = input.trim();
        if (!this.entries.some((entry) => entry.role === "user" && entry.text.trim() === normalized)) {
            this.entries.push({ role: "user", text: normalized });
            this.bound();
        }
        return this.take();
    }
    take() {
        if (this.entries.length === 0)
            return undefined;
        const transcript = this.render();
        this.entries = [];
        return transcript;
    }
    reset() { this.entries = []; }
    bound() {
        this.entries = this.entries.filter((entry) => Buffer.byteLength(`${entry.role}: ${entry.text}`) <= MAX_TRANSCRIPT_DELTA_BYTES);
        while (Buffer.byteLength(this.render()) > MAX_TRANSCRIPT_DELTA_BYTES)
            this.entries.shift();
    }
    render() {
        return this.entries.map(({ role, text }) => `${role}: ${text}`).join("\n");
    }
}
/** Keeps conversational display turns separate from V3 delegation handoffs. */
export class RealtimeVoiceTurnTracker {
    transcript = new RealtimeTranscriptBuffer();
    pendingUserInputs = [];
    delegationsAwaitingUserFinish = 0;
    userTranscriptOpen = false;
    delegationIds = new Set();
    outstandingDelegations = new Map();
    outstandingInputs = new Set();
    inputAdded(input) {
        this.userTranscriptOpen = true;
        this.transcript.append("user", input);
    }
    outputAdded(output) {
        this.transcript.append("assistant", output);
    }
    userFinished(input) {
        this.transcript.finish("user", input);
        this.userTranscriptOpen = false;
        if (this.delegationsAwaitingUserFinish > 0) {
            this.delegationsAwaitingUserFinish -= 1;
            return undefined;
        }
        this.pendingUserInputs.push(input);
        return undefined;
    }
    delegated(input, delegationId) {
        if (this.delegationIds.has(delegationId))
            return undefined;
        this.delegationIds.add(delegationId);
        if (this.delegationIds.size > 128)
            this.delegationIds.delete(this.delegationIds.values().next().value);
        if (this.outstandingInputs.has(input))
            return undefined;
        this.outstandingDelegations.set(delegationId, input);
        this.outstandingInputs.add(input);
        const pendingIndex = this.userTranscriptOpen ? -1 : this.pendingUserInputs.length - 1;
        if (pendingIndex === -1)
            this.delegationsAwaitingUserFinish += 1;
        else
            this.pendingUserInputs.splice(pendingIndex, 1);
        const transcriptDelta = this.transcript.handoff(input);
        return { input, delegationId, ...(transcriptDelta ? { transcriptDelta } : {}) };
    }
    delegationSettled(delegationId) {
        const input = this.outstandingDelegations.get(delegationId);
        if (input === undefined)
            return;
        this.outstandingDelegations.delete(delegationId);
        this.outstandingInputs.delete(input);
    }
    assistantFinished(output) {
        if (output)
            this.transcript.finish("assistant", output);
        const input = this.pendingUserInputs.shift();
        return input === undefined ? undefined : { input };
    }
    takeTranscriptTail() { return this.transcript.take(); }
    drainConversationTurns() {
        const turns = this.pendingUserInputs.map((input) => ({ input }));
        this.pendingUserInputs = [];
        return turns;
    }
    reset() {
        this.transcript.reset();
        this.pendingUserInputs = [];
        this.delegationsAwaitingUserFinish = 0;
        this.userTranscriptOpen = false;
        this.delegationIds.clear();
        this.outstandingDelegations.clear();
        this.outstandingInputs.clear();
    }
}
