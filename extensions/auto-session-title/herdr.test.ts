import { describe, expect, test } from "bun:test";
import {
	chooseHerdrTarget,
	herdrContextFromEnv,
	normalizeHerdrLabel,
	syncTitleToHerdr,
	type HerdrRequest,
} from "./herdr";

const herdrEnv = {
	HERDR_ENV: "1",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
	HERDR_PANE_ID: "w1:p1",
	HERDR_TAB_ID: "w1:t1",
} as const;

function isMetadataCall(call: { method: string; params: Record<string, unknown> }) {
	return call.method === "pane.report_metadata";
}

describe("auto-session-title herdr sync", () => {
	test("requires herdr env, socket, pane, and tab ids", () => {
		expect(herdrContextFromEnv({})).toBeUndefined();
		expect(herdrContextFromEnv({
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
			HERDR_PANE_ID: "w1:p1",
		})).toBeUndefined();
		expect(herdrContextFromEnv(herdrEnv)).toEqual({
			socketPath: "/tmp/herdr.sock",
			paneId: "w1:p1",
			tabId: "w1:t1",
		});
	});

	test("renames the tab for a sole pane and the pane when split", () => {
		expect(chooseHerdrTarget(1)).toBe("tab");
		expect(chooseHerdrTarget(0)).toBe("tab");
		expect(chooseHerdrTarget(2)).toBe("pane");
	});

	test("normalizes blank and overlong labels", () => {
		expect(normalizeHerdrLabel("  Compact Pi Footer  ")).toBe("Compact Pi Footer");
		expect(normalizeHerdrLabel("   ")).toBeUndefined();
		expect(normalizeHerdrLabel("x".repeat(100))).toHaveLength(80);
	});

	test("syncs sole-pane titles to the tab label and agents sidebar", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const request: HerdrRequest = async (method, params) => {
			calls.push({ method, params });
			if (method === "tab.get") {
				return { tab: { tab_id: "w1:t1", pane_count: 1 } };
			}
			return { type: "ok" };
		};

		await expect(syncTitleToHerdr("Compact Pi Footer", {
			env: herdrEnv,
			request,
		})).resolves.toBe("tab");

		const metadata = calls.find(isMetadataCall);
		expect(metadata?.params).toMatchObject({
			pane_id: "w1:p1",
			source: "auto-session-title",
			agent: "pi",
			applies_to_source: "herdr:pi",
			display_agent: "Compact Pi Footer",
			title: "Compact Pi Footer",
			tokens: { kind: "pi" },
		});
		expect(typeof metadata?.params.seq).toBe("number");
		expect(calls).toContainEqual({
			method: "tab.get",
			params: { tab_id: "w1:t1" },
		});
		expect(calls).toContainEqual({
			method: "tab.rename",
			params: { tab_id: "w1:t1", label: "Compact Pi Footer" },
		});
	});

	test("syncs multi-pane titles to the pane label and agents sidebar", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const request: HerdrRequest = async (method, params) => {
			calls.push({ method, params });
			if (method === "tab.get") {
				return { tab: { tab_id: "w1:t1", pane_count: 3 } };
			}
			return { type: "ok" };
		};

		await expect(syncTitleToHerdr("API Auth Refactor", {
			env: {
				...herdrEnv,
				HERDR_PANE_ID: "w1:p2",
			},
			request,
		})).resolves.toBe("pane");

		expect(calls.find(isMetadataCall)?.params).toMatchObject({
			pane_id: "w1:p2",
			display_agent: "API Auth Refactor",
			title: "API Auth Refactor",
			tokens: { kind: "pi" },
		});
		expect(calls).toContainEqual({
			method: "pane.rename",
			params: { pane_id: "w1:p2", label: "API Auth Refactor" },
		});
	});

	test("still reports sidebar metadata when layout rename fails", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const request: HerdrRequest = async (method, params) => {
			calls.push({ method, params });
			if (method === "tab.get") throw new Error("layout unavailable");
			return { type: "ok" };
		};

		await expect(syncTitleToHerdr("Sidebar Only", {
			env: herdrEnv,
			request,
		})).resolves.toBeUndefined();

		expect(calls.find(isMetadataCall)?.params).toMatchObject({
			display_agent: "Sidebar Only",
			title: "Sidebar Only",
			tokens: { kind: "pi" },
		});
	});

	test("skips sync outside herdr and ignores request failures", async () => {
		await expect(syncTitleToHerdr("Outside Herdr", {
			env: {},
			request: async () => {
				throw new Error("should not run");
			},
		})).resolves.toBeUndefined();

		await expect(syncTitleToHerdr("Broken Socket", {
			env: herdrEnv,
			request: async () => {
				throw new Error("socket down");
			},
		})).resolves.toBeUndefined();
	});
});
