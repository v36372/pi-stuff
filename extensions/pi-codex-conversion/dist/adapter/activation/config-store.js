import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { migrateCodexConversionConfigIfNeeded } from "./config-migration.js";
import { DEFAULT_CODEX_CONVERSION_CONFIG, normalizeCodexConversionConfig } from "./config.js";
// Lite deliberately shares the original package's config so replacing either
// package does not require a reset or a second settings file.
export const CODEX_CONVERSION_CONFIG_BASENAME = "pi-codex-conversion.json";
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function mergeConfigDocument(existing, owned) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(owned)) {
        const previous = merged[key];
        merged[key] = isRecord(previous) && isRecord(value)
            ? mergeConfigDocument(previous, value)
            : value;
    }
    return merged;
}
function clearAbsentOwnedOptionals(document, owned) {
    const voice = isRecord(document["voice"]) ? document["voice"] : undefined;
    const ownedVoice = isRecord(owned["voice"]) ? owned["voice"] : undefined;
    if (!voice || !ownedVoice)
        return;
    for (const key of ["contextModel", "inputDevice", "outputDevice"])
        if (!(key in ownedVoice))
            delete voice[key];
}
export function getCodexConversionConfigPath(agentDir = getAgentDir()) {
    return join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
}
export function readCodexConversionConfig(configPath = getCodexConversionConfigPath()) {
    if (!existsSync(configPath))
        return structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
    try {
        const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
        const migration = migrateCodexConversionConfigIfNeeded(parsed);
        return normalizeCodexConversionConfig(migration.config);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-codex-conversion] Failed to read ${configPath}: ${message}`);
        return structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
    }
}
export function writeCodexConversionConfig(config, configPath = getCodexConversionConfigPath()) {
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        mkdirSync(dirname(configPath), { recursive: true });
        const normalized = normalizeCodexConversionConfig(config);
        let document = normalized;
        if (existsSync(configPath)) {
            try {
                const existing = JSON.parse(readFileSync(configPath, "utf-8"));
                if (isRecord(existing))
                    document = mergeConfigDocument(existing, normalized);
            }
            catch {
                // A valid explicit settings write replaces an unreadable document.
            }
        }
        clearAbsentOwnedOptionals(document, normalized);
        writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
        renameSync(temporaryPath, configPath);
        return { ok: true };
    }
    catch (error) {
        try {
            rmSync(temporaryPath, { force: true });
        }
        catch {
            // Keep the original write error.
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-codex-conversion] Failed to write ${configPath}: ${message}`);
        return { ok: false, error: message };
    }
}
