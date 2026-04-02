import * as os from "node:os";
import { shortenPath } from "./subagent-core";


export function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    fg: (color: any, text: string) => string
): string {
    switch (toolName) {
        case "bash": {
            let cmd = (args.command as string) || "...";
            const home = os.homedir();
            cmd = cmd.replaceAll(home, "~");
            const firstLine = cmd.split("\n")[0];
            return fg("muted", "$ ") + fg("toolOutput", firstLine);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let text = fg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
            }
            return fg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const content = (args.content || "") as string;
            const lines = content.split("\n").length;
            let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
            if (lines > 1) text += fg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return fg("accent", toolName) + fg("dim", ` ${preview}`);
        }
    }
}

