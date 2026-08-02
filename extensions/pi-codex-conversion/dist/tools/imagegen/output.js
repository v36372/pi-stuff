import { readFileSync } from "node:fs";
export function imagegenOutputFromJson(output) {
    let parsed;
    try {
        parsed = JSON.parse(output.trim());
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed["path"] !== "string")
        return undefined;
    return parsed;
}
export function imageContentsFromImagegenOutput(output) {
    return (output.images ?? []).flatMap((image) => {
        if (!image.absolute_path)
            return [];
        try {
            return [{ type: "image", mimeType: "image/png", data: readFileSync(image.absolute_path).toString("base64"), detail: "high" }];
        }
        catch {
            return [];
        }
    });
}
export function formatImagegenOutput(output) {
    return [`Generated image: ${output.path}`, ...(output.latest_path ? [`Latest: ${output.latest_path}`] : [])].join("\n");
}
