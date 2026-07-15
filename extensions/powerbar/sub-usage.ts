/**
 * Subscription usage fetching used by powerbar.
 *
 * This is intentionally limited to the data powerbar renders: usage windows
 * for the provider associated with the active Pi model.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API_TIMEOUT_MS = 5_000;
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
}

export interface UsageSnapshot {
	windows: RateWindow[];
}

interface ModelLike {
	provider?: string;
	id?: string;
}

type AuthEntry = Record<string, unknown> | string;
type AuthFile = Record<string, AuthEntry | undefined>;

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function readAuthFile(): AuthFile {
	return readJson<AuthFile>(AUTH_PATH) ?? {};
}

function authValue(provider: string, key: string): string | undefined {
	const entry = readAuthFile()[provider];
	if (!entry || typeof entry === "string") return undefined;
	const value = entry[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function envValue(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

function formatReset(date: Date): string | undefined {
	if (!Number.isFinite(date.getTime())) return undefined;
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours ? `${days}d${remainingHours}h` : `${days}d`;
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function detectProvider(model: ModelLike | undefined): string | undefined {
	if (!model) return undefined;
	const provider = model.provider?.toLowerCase() ?? "";
	const id = model.id?.toLowerCase() ?? "";
	if (provider.includes("antigravity") || id.includes("antigravity")) return "antigravity";
	if (provider.includes("anthropic") || id.includes("claude")) return "anthropic";
	if (provider.includes("copilot") || provider.includes("github")) return "copilot";
	if (provider.includes("gemini") || provider.includes("google") || id.includes("gemini")) return "gemini";
	if (provider.includes("openai") || provider.includes("codex") || /gpt|o1|o3/.test(id)) return "codex";
	if (provider.includes("kiro") || provider.includes("aws")) return "kiro";
	if (provider.includes("zai") || provider.includes("z.ai") || provider.includes("xai")) return "zai";
	return undefined;
}

function snapshot(windows: RateWindow[]): UsageSnapshot {
	return { windows };
}

function loadAnthropicToken(): string | undefined {
	const token = envValue("ANTHROPIC_OAUTH_TOKEN") ?? authValue("anthropic", "access");
	if (token) return token;
	try {
		const output = execFileSync(
			"security",
			["find-generic-password", "-s", "Claude Code-credentials", "-w"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		const data = JSON.parse(output) as { claudeAiOauth?: { scopes?: string[]; accessToken?: string } };
		if (data.claudeAiOauth?.scopes?.includes("user:profile")) return data.claudeAiOauth.accessToken;
	} catch {
		return undefined;
	}
	return undefined;
}

async function fetchAnthropicUsage(): Promise<UsageSnapshot | undefined> {
	const token = loadAnthropicToken();
	if (!token) return undefined;
	const data = await fetchJson<{
		five_hour?: { utilization?: number; resets_at?: string };
		seven_day?: { utilization?: number; resets_at?: string };
		extra_usage?: { is_enabled?: boolean; used_credits?: number; monthly_limit?: number; utilization?: number };
	}>("https://api.anthropic.com/api/oauth/usage", {
		headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
	});
	if (!data) return undefined;

	const windows: RateWindow[] = [];
	const addWindow = (label: string, utilization?: number, reset?: string) => {
		if (utilization === undefined) return;
		const resetAt = reset ? new Date(reset) : undefined;
		windows.push({ label, usedPercent: utilization, resetDescription: resetAt ? formatReset(resetAt) : undefined, resetAt: resetAt?.toISOString() });
	};
	addWindow("5h", data.five_hour?.utilization, data.five_hour?.resets_at);
	addWindow("Week", data.seven_day?.utilization, data.seven_day?.resets_at);

	if (data.extra_usage?.is_enabled) {
		const used = ((data.extra_usage.used_credits ?? 0) / 100).toFixed(2);
		const limit = data.extra_usage.monthly_limit;
		const amount = limit ? `${used}/${(limit / 100).toFixed(2)}` : used;
		const active = (data.five_hour?.utilization ?? 0) >= 99;
		windows.push({
			label: `Extra [${active ? "active" : "on"}] ${amount}`,
			usedPercent: data.extra_usage.utilization ?? 0,
			resetDescription: active ? "__ACTIVE__" : undefined,
		});
	}
	return snapshot(windows);
}

function copilotToken(): string | undefined {
	const token = envValue("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_TOKEN")
		?? authValue("github-copilot", "refresh")
		?? authValue("github-copilot", "access");
	if (token) return token;

	const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	const paths = [join(configHome, "github-copilot", "hosts.json"), join(homedir(), ".github-copilot", "hosts.json")];
	for (const path of paths) {
		try {
			const hosts = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, unknown>>;
			for (const [host, entry] of Object.entries(hosts)) {
				if (!/github\.com$/i.test(host) && host !== Object.keys(hosts)[0]) continue;
				for (const key of ["oauth_token", "user_token", "github_token", "token"]) {
					if (typeof entry[key] === "string" && entry[key]) return entry[key] as string;
				}
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

async function fetchCopilotUsage(): Promise<UsageSnapshot | undefined> {
	const token = copilotToken();
	if (!token) return undefined;
	const data = await fetchJson<{
		quota_reset_date_utc?: string;
		quota_snapshots?: { premium_interactions?: { percent_remaining?: number } };
	}>("https://api.github.com/copilot_internal/user", {
		headers: {
			"Editor-Version": "vscode/1.96.2",
			"User-Agent": "GitHubCopilotChat/0.26.7",
			"X-Github-Api-Version": "2025-04-01",
			Accept: "application/json",
			Authorization: `token ${token}`,
		},
	});
	const quota = data?.quota_snapshots?.premium_interactions;
	if (!data || !quota) return undefined;
	const resetAt = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
	return snapshot([{
		label: "Month",
		usedPercent: Math.max(0, 100 - (quota.percent_remaining ?? 0)),
		resetDescription: resetAt ? formatReset(resetAt) : undefined,
		resetAt: resetAt?.toISOString(),
	}]);
}

async function fetchGeminiUsage(): Promise<UsageSnapshot | undefined> {
	const oauthCreds = readJson<{ access_token?: string }>(join(homedir(), ".gemini", "oauth_creds.json"));
	const token = envValue("GOOGLE_GEMINI_CLI_OAUTH_TOKEN", "GOOGLE_GEMINI_CLI_ACCESS_TOKEN", "GEMINI_OAUTH_TOKEN", "GOOGLE_GEMINI_OAUTH_TOKEN")
		?? authValue("google-gemini-cli", "access")
		?? oauthCreds?.access_token;
	if (!token) return undefined;
	const data = await fetchJson<{ buckets?: Array<{ modelId?: string; remainingFraction?: number }> }>(
		"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
		{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" },
	);
	if (!data) return undefined;
	let pro = 1;
	let flash = 1;
	let hasPro = false;
	let hasFlash = false;
	for (const bucket of data.buckets ?? []) {
		const model = bucket.modelId?.toLowerCase() ?? "";
		const remaining = bucket.remainingFraction ?? 1;
		if (model.includes("pro")) { hasPro = true; pro = Math.min(pro, remaining); }
		if (model.includes("flash")) { hasFlash = true; flash = Math.min(flash, remaining); }
	}
	return snapshot([
		...(hasPro ? [{ label: "Pro", usedPercent: (1 - pro) * 100 }] : []),
		...(hasFlash ? [{ label: "Flash", usedPercent: (1 - flash) * 100 }] : []),
	]);
}

interface AntigravityAuth { token?: string; projectId?: string }

function loadAntigravityAuth(): AntigravityAuth | undefined {
	const projectId = envValue("GOOGLE_ANTIGRAVITY_PROJECT_ID", "GOOGLE_ANTIGRAVITY_PROJECT");
	const token = envValue("GOOGLE_ANTIGRAVITY_OAUTH_TOKEN", "ANTIGRAVITY_OAUTH_TOKEN");
	if (token) return { token, projectId };
	const apiKey = envValue("GOOGLE_ANTIGRAVITY_API_KEY", "ANTIGRAVITY_API_KEY");
	if (apiKey) {
		try {
			const parsed = JSON.parse(apiKey) as { token?: string; projectId?: string };
			return { token: parsed.token ?? apiKey, projectId: parsed.projectId ?? projectId };
		} catch {
			return { token: apiKey, projectId };
		}
	}
	const entry = readAuthFile()["google-antigravity"];
	if (!entry) return undefined;
	if (typeof entry === "string") return { token: entry };
	return {
		token: ["access", "accessToken", "token", "key"].map((key) => entry[key]).find((value): value is string => typeof value === "string" && value.length > 0),
		projectId: typeof entry.projectId === "string" ? entry.projectId : typeof entry.project === "string" ? entry.project : undefined,
	};
}

async function fetchAntigravityUsage(): Promise<UsageSnapshot | undefined> {
	const auth = loadAntigravityAuth();
	if (!auth?.token) return undefined;
	const headers = {
		Authorization: `Bearer ${auth.token}`,
		"Content-Type": "application/json",
		"User-Agent": "antigravity/1.11.5 darwin/arm64",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({ ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }),
	};
	let data: { models?: Record<string, { displayName?: string; model?: string; isInternal?: boolean; quotaInfo?: { remainingFraction?: number; resetTime?: string } }> } | undefined;
	for (const endpoint of ["https://daily-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"]) {
		data = await fetchJson<typeof data>(`${endpoint}/v1internal:fetchAvailableModels`, {
			method: "POST", headers, body: JSON.stringify(auth.projectId ? { project: auth.projectId } : {}),
		});
		if (data) break;
	}
	if (!data) return undefined;
	const models = new Map<string, { remaining: number; resetAt?: Date }>();
	for (const [id, model] of Object.entries(data.models ?? {})) {
		if (model.isInternal || id.toLowerCase() === "tab_flash_lite_preview") continue;
		const name = model.displayName ?? model.model ?? id;
		if (!name || name.toLowerCase() === "tab_flash_lite_preview") continue;
		const remaining = model.quotaInfo?.remainingFraction ?? 1;
		const resetAt = model.quotaInfo?.resetTime ? new Date(model.quotaInfo.resetTime) : undefined;
		const previous = models.get(name);
		if (!previous || remaining < previous.remaining) models.set(name, { remaining, resetAt });
	}
	return snapshot([...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({
		label,
		usedPercent: Math.max(0, Math.min(100, (1 - value.remaining) * 100)),
		resetDescription: value.resetAt ? formatReset(value.resetAt) : undefined,
		resetAt: value.resetAt?.toISOString(),
	})));
}

async function fetchCodexUsage(): Promise<UsageSnapshot | undefined> {
	const auth = readAuthFile()["openai-codex"];
	const codexAuth = readJson<{ OPENAI_API_KEY?: string; tokens?: { access_token?: string; account_id?: string } }>(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"));
	const accessToken = envValue("OPENAI_CODEX_OAUTH_TOKEN", "OPENAI_CODEX_ACCESS_TOKEN", "CODEX_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN")
		?? (typeof auth === "object" && auth ? (typeof auth.access === "string" ? auth.access : undefined) : undefined)
		?? codexAuth?.OPENAI_API_KEY
		?? codexAuth?.tokens?.access_token;
	if (!accessToken) return undefined;
	const accountId = envValue("OPENAI_CODEX_ACCOUNT_ID", "CHATGPT_ACCOUNT_ID")
		?? (typeof auth === "object" && auth && typeof auth.accountId === "string" ? auth.accountId : undefined)
		?? codexAuth?.tokens?.account_id;
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	const data = await fetchJson<{
		rate_limit?: { primary_window?: CodexWindow; secondary_window?: CodexWindow };
		additional_rate_limits?: Array<{ limit_name?: string; metered_feature?: string; rate_limit?: { primary_window?: CodexWindow; secondary_window?: CodexWindow } }>;
	}>("https://chatgpt.com/backend-api/wham/usage", { headers });
	if (!data) return undefined;
	const windows: RateWindow[] = [];
	const add = (window: CodexWindow | undefined, prefix?: string, fallbackSeconds?: number) => {
		if (!window) return;
		const seconds = window.limit_window_seconds || fallbackSeconds;
		const hours = seconds ? Math.round(seconds / 3600) : 0;
		const label = hours >= 144 ? "Week" : hours >= 24 ? "Day" : `${hours}h`;
		const resetAt = window.reset_at ? new Date(window.reset_at * 1000) : undefined;
		windows.push({ label: prefix ? `${prefix} ${label}` : label, usedPercent: window.used_percent ?? 0, resetDescription: resetAt ? formatReset(resetAt) : undefined, resetAt: resetAt?.toISOString() });
	};
	add(data.rate_limit?.primary_window, undefined, 10_800);
	add(data.rate_limit?.secondary_window, undefined, 86_400);
	for (const entry of data.additional_rate_limits ?? []) {
		add(entry.rate_limit?.primary_window, entry.limit_name ?? entry.metered_feature ?? "Additional");
		add(entry.rate_limit?.secondary_window, entry.limit_name ?? entry.metered_feature ?? "Additional");
	}
	return snapshot(windows);
}

interface CodexWindow { reset_at?: number; limit_window_seconds?: number; used_percent?: number }

async function fetchKiroUsage(): Promise<UsageSnapshot | undefined> {
	let kiro: string;
	try {
		kiro = execFileSync("which", ["kiro-cli"], { encoding: "utf-8" }).trim();
	} catch {
		return undefined;
	}
	if (!kiro) return undefined;
	try {
		execFileSync(kiro, ["whoami"], { encoding: "utf-8", timeout: API_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
		const output = stripAnsi(execFileSync(kiro, ["chat", "--no-interactive", "/usage"], { encoding: "utf-8", timeout: 10_000, env: { ...process.env, TERM: "xterm-256color" }, stdio: ["ignore", "pipe", "pipe"] }));
		const percent = output.match(/█+\s*(\d+)%/)?.[1];
		const credits = output.match(/\((\d+\.?\d*)\s+of\s+(\d+)\s+covered/)?.slice(1).map(Number);
		const usedPercent = percent ? Number(percent) : credits && credits[1] > 0 ? (credits[0] / credits[1]) * 100 : 0;
		const reset = output.match(/resets on (\d{2}\/\d{2})/)?.[1];
		let resetAt: Date | undefined;
		if (reset) {
			const [month, day] = reset.split("/").map(Number);
			resetAt = new Date(new Date().getFullYear(), month - 1, day);
			if (resetAt < new Date()) resetAt.setFullYear(resetAt.getFullYear() + 1);
		}
		return snapshot([{ label: "Credits", usedPercent, resetDescription: resetAt ? formatReset(resetAt) : undefined, resetAt: resetAt?.toISOString() }]);
	} catch {
		return undefined;
	}
}

async function fetchZaiUsage(): Promise<UsageSnapshot | undefined> {
	const apiKey = envValue("ZAI_API_KEY", "Z_AI_API_KEY") ?? authValue("z-ai", "access") ?? authValue("z-ai", "key") ?? authValue("zai", "access") ?? authValue("zai", "key");
	if (!apiKey) return undefined;
	const data = await fetchJson<{
		success?: boolean;
		code?: number;
		data?: { limits?: Array<{ type?: string; percentage?: number; nextResetTime?: string }> };
	}>("https://api.z.ai/api/monitor/usage/quota/limit", { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
	if (!data?.success || data.code !== 200) return undefined;
	const windows: RateWindow[] = [];
	for (const limit of data.data?.limits ?? []) {
		const resetAt = limit.nextResetTime ? new Date(limit.nextResetTime) : undefined;
		if (limit.type === "TOKENS_LIMIT") windows.push({ label: "Tokens", usedPercent: limit.percentage ?? 0, resetDescription: resetAt ? formatReset(resetAt) : undefined, resetAt: resetAt?.toISOString() });
		if (limit.type === "TIME_LIMIT") windows.push({ label: "Monthly", usedPercent: limit.percentage ?? 0, resetDescription: resetAt ? formatReset(resetAt) : undefined, resetAt: resetAt?.toISOString() });
	}
	return snapshot(windows);
}

export async function fetchSubUsage(model: ModelLike | undefined): Promise<UsageSnapshot | undefined> {
	switch (detectProvider(model)) {
		case "anthropic": return fetchAnthropicUsage();
		case "copilot": return fetchCopilotUsage();
		case "gemini": return fetchGeminiUsage();
		case "antigravity": return fetchAntigravityUsage();
		case "codex": return fetchCodexUsage();
		case "kiro": return fetchKiroUsage();
		case "zai": return fetchZaiUsage();
		default: return undefined;
	}
}
