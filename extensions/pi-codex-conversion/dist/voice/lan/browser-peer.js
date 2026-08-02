import { VoiceHelperClient } from "../helper.js";
const OFFER_TIMEOUT_MS = 15_000;
export class LanHostRealtimePeer {
    kind = "webrtc";
    helper = new VoiceHelperClient();
    onAudio;
    onFailure;
    failed = false;
    closing = false;
    constructor(options) {
        this.onAudio = options.onAudio;
        this.onFailure = options.onFailure;
    }
    onEvent(listener) {
        return this.helper.onEvent((event) => {
            if (event.type === "pcm") {
                this.onAudio(Buffer.from(event.audio, "base64"));
                return;
            }
            const peerEvent = toPeerEvent(event);
            if (peerEvent)
                listener(peerEvent);
            if (event.type === "error")
                this.fail(new Error(event.message));
        });
    }
    onExit(listener) {
        const remove = this.helper.onExit(listener);
        const removeFailure = this.helper.onExit((error) => { if (!this.closing)
            this.fail(error); });
        return () => { remove(); removeFailure(); };
    }
    async start(config) {
        await this.helper.start(config.tools.customRustBinariesDir);
        if (this.helper.protocolVersion !== 5) {
            const actualVersion = this.helper.protocolVersion ?? "unknown";
            await this.helper.close();
            throw new Error(`Incompatible Codex voice helper protocol ${actualVersion}; expected 5`);
        }
        const offer = Promise.withResolvers();
        const removeEvent = this.helper.onEvent((event) => {
            if (event.type === "offer")
                offer.resolve(event.sdp);
            else if (event.type === "error")
                offer.reject(new Error(event.message));
        });
        const removeExit = this.helper.onExit((error) => offer.reject(error));
        const timeout = setTimeout(() => offer.reject(new Error("Codex voice helper did not create an offer")), OFFER_TIMEOUT_MS);
        this.helper.send({ type: "start_v3_bridge" });
        return offer.promise.finally(() => {
            clearTimeout(timeout);
            removeEvent();
            removeExit();
        });
    }
    applyAnswer(sdp) {
        this.helper.send({ type: "apply_answer", sdp });
    }
    sendData(message) {
        this.helper.send({ type: "send_data", message });
    }
    sendAudio(pcm) {
        this.helper.send({ type: "send_pcm", audio: pcm.toString("base64"), sample_rate: 24_000, num_channels: 1 });
    }
    setInputMuted(muted) {
        this.helper.send({ type: "set_input_muted", muted });
    }
    close() {
        this.closing = true;
        return this.helper.close();
    }
    fail(error) {
        if (this.failed)
            return;
        this.failed = true;
        this.onFailure(error);
    }
}
function toPeerEvent(event) {
    if (event.type === "state" || event.type === "data" || event.type === "error")
        return event;
    return undefined;
}
