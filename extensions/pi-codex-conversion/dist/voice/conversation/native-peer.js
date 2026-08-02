import { VoiceHelperClient } from "../helper.js";
const OFFER_TIMEOUT_MS = 15_000;
export class NativeCodexRealtimePeer {
    kind = "webrtc";
    helper = new VoiceHelperClient();
    onEvent(listener) {
        return this.helper.onEvent((event) => {
            const peerEvent = toPeerEvent(event);
            if (peerEvent)
                listener(peerEvent);
        });
    }
    onExit(listener) {
        return this.helper.onExit(listener);
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
        this.helper.send({
            type: "start_v3",
            ...(config.voice.inputDevice
                ? { microphone: config.voice.inputDevice }
                : {}),
            ...(config.voice.outputDevice
                ? { speaker: config.voice.outputDevice }
                : {}),
        });
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
    setInputMuted(muted) {
        this.helper.send({ type: "set_input_muted", muted });
    }
    close() {
        return this.helper.close();
    }
}
function toPeerEvent(event) {
    if (event.type === "state" || event.type === "data" || event.type === "error")
        return event;
    return undefined;
}
