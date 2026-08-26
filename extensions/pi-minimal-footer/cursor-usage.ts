import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface CursorPlanUsage {
  billingCycleEnd?: string;
  totalPercentUsed?: number;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
}

interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
}

const execFileAsync = promisify(execFile);
const failedRefreshes = new Map<string, number>();

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function dateString(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime()) ? value : undefined;
}

/** Parse Cursor's native GetCurrentPeriodUsage response. */
export function parseCursorPeriodUsage(value: unknown): CursorPlanUsage | undefined {
  const data = record(value);
  const plan = record(data?.planUsage);
  if (!data || !plan) return undefined;
  return {
    billingCycleEnd: timestamp(data.billingCycleEnd),
    totalPercentUsed: number(plan.totalPercentUsed),
    autoPercentUsed: number(plan.autoPercentUsed),
    apiPercentUsed: number(plan.apiPercentUsed),
  };
}

/** Parse the browser-session usage-summary fallback response. */
export function parseCursorUsageSummary(value: unknown): CursorPlanUsage | undefined {
  const data = record(value);
  const plan = record(record(data?.individualUsage)?.plan);
  if (!data || !plan) return undefined;
  return {
    billingCycleEnd: dateString(data.billingCycleEnd),
    totalPercentUsed: number(plan.totalPercentUsed),
    autoPercentUsed: number(plan.autoPercentUsed),
    apiPercentUsed: number(plan.apiPercentUsed),
  };
}

function cursorEnv(name: string): string | undefined {
  return (
    process.env[`PI_CURSOR_${name}`] ||
    process.env[`CURSOR_${name}`] ||
    process.env[`PI_CURSOR_PROVIDER_${name}`]
  )?.trim() || undefined;
}

function systemCredentialsAllowed(): boolean {
  const value = cursorEnv("SYSTEM_CREDENTIALS")?.toLowerCase();
  return !["0", "false", "off", "deny", "no"].includes(value || "");
}

function tokenExpiresAt(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
    if (typeof payload?.exp === "number") return payload.exp * 1000 - 5 * 60_000;
  } catch {}
  return Date.now() + 60 * 60_000;
}

function usableToken(token: string | undefined): token is string {
  return Boolean(token && Date.now() < tokenExpiresAt(token));
}

async function readKeychainTokens(): Promise<StoredTokens> {
  if (platform() !== "darwin") return {};
  const read = (service: string) => execFileAsync(
    "security",
    ["find-generic-password", "-s", service, "-a", "cursor-user", "-w"],
    { encoding: "utf8", timeout: 2000 },
  );
  const [access, refresh] = await Promise.allSettled([
    read("cursor-access-token"),
    read("cursor-refresh-token"),
  ]);
  return {
    accessToken: access.status === "fulfilled" ? access.value.stdout.trim() || undefined : undefined,
    refreshToken: refresh.status === "fulfilled" ? refresh.value.stdout.trim() || undefined : undefined,
  };
}

async function readVscdbTokens(): Promise<StoredTokens> {
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return {};
  }

  const home = homedir();
  const paths = platform() === "darwin"
    ? [join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")]
    : platform() === "win32"
      ? process.env.APPDATA ? [join(process.env.APPDATA, "Cursor/User/globalStorage/state.vscdb")] : []
      : [join(home, ".config/Cursor/User/globalStorage/state.vscdb")];

  if (platform() !== "win32" && existsSync("/mnt/c/Users")) {
    try {
      for (const user of readdirSync("/mnt/c/Users")) {
        if (!["Public", "Default"].includes(user) && !user.startsWith(".")) {
          paths.push(join("/mnt/c/Users", user, "AppData/Roaming/Cursor/User/globalStorage/state.vscdb"));
        }
      }
    } catch {}
  }

  const fallback: StoredTokens = {};
  for (const path of paths) {
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      let accessToken: string | undefined;
      let refreshToken: string | undefined;
      try {
        accessToken = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get()?.value?.trim();
        refreshToken = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'").get()?.value?.trim();
      } finally {
        db.close();
      }
      if (usableToken(accessToken)) return { accessToken, refreshToken };
      fallback.accessToken ||= accessToken;
      fallback.refreshToken ||= refreshToken;
    } catch {}
  }
  return fallback;
}

function readPiTokens(): StoredTokens {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const cursor = record(auth.cursor);
    return { accessToken: cursor?.access, refreshToken: cursor?.refresh };
  } catch {
    return {};
  }
}

async function refreshAccessToken(token: string | undefined): Promise<string | undefined> {
  if (!token || (failedRefreshes.get(token) || 0) > Date.now()) return undefined;
  try {
    const response = await fetch("https://api2.cursor.sh/auth/exchange_user_api_key", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const accessToken = record(await response.json())?.accessToken;
    if (typeof accessToken !== "string" || !accessToken) throw new Error("missing access token");
    failedRefreshes.delete(token);
    return accessToken;
  } catch {
    // Match pi-cursor's refresh-failure backoff and avoid retrying every footer refresh.
    failedRefreshes.set(token, Date.now() + 10 * 60_000);
    return undefined;
  }
}

async function getCursorAccessToken(): Promise<string | undefined> {
  const envToken = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (envToken) return envToken;

  if (systemCredentialsAllowed()) {
    const [keychain, vscdb] = await Promise.all([readKeychainTokens(), readVscdbTokens()]);
    if (usableToken(keychain.accessToken)) return keychain.accessToken;
    if (usableToken(vscdb.accessToken)) return vscdb.accessToken;
    const refreshed = await refreshAccessToken(keychain.refreshToken) ||
      (vscdb.refreshToken !== keychain.refreshToken ? await refreshAccessToken(vscdb.refreshToken) : undefined);
    if (refreshed) return refreshed;
  }

  const pi = readPiTokens();
  return usableToken(pi.accessToken) ? pi.accessToken : refreshAccessToken(pi.refreshToken);
}

export async function fetchCursorPlanUsage(): Promise<CursorPlanUsage | undefined> {
  const accessToken = await getCursorAccessToken();
  if (accessToken) {
    try {
      const response = await fetch(
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.ok) {
        const usage = parseCursorPeriodUsage(await response.json());
        if (usage) return usage;
      }
    } catch {}
  }

  const sessionToken = cursorEnv("USAGE_SESSION_TOKEN");
  if (!sessionToken) return undefined;
  try {
    const response = await fetch("https://cursor.com/api/usage-summary", {
      headers: { Cookie: `WorkosCursorSessionToken=${sessionToken}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? parseCursorUsageSummary(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}
