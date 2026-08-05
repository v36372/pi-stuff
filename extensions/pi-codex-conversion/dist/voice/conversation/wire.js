import { MAX_REALTIME_VOICE_INPUT_BYTES } from "../prompts.js";
export function boundedTranscript(value) {
    if (typeof value !== "string")
        return undefined;
    const input = value.trim();
    if (!input)
        return undefined;
    return Buffer.byteLength(input) > MAX_REALTIME_VOICE_INPUT_BYTES ? "oversized" : input;
}
export function transcriptItemText(value) {
    return value && typeof value === "object" ? value["text"] : undefined;
}
export function boundedAssistantTranscript(value) {
    if (typeof value !== "string")
        return undefined;
    const output = value.trim();
    if (!output)
        return undefined;
    return utf8Tail(output, MAX_REALTIME_VOICE_INPUT_BYTES - 32);
}
export function remoteError(event) {
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
export function realtimePeerStateFailure(state) {
    if (state === "failed")
        return "Codex realtime connection failed";
    if (state === "closed")
        return "Codex realtime connection closed";
    return undefined;
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
