import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentState } from "../../src/shared/types.ts";
import { TakeoverAdapter } from "../../src/tui/takeover-adapter.ts";
import { reconcileTakeoverSelection, sanitizeTakeoverText, TakeoverDashboard, TakeoverDetail } from "../../src/tui/takeover.ts";

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function addParallelRun(state: SubagentState): void {
	state.fleetJobs!.set("run-12345678", {
		asyncId: "run-12345678",
		asyncDir: path.join(os.tmpdir(), "missing-takeover-run"),
		sessionId: "session-current",
		status: "running",
		mode: "parallel",
		startedAt: 10,
		updatedAt: 20,
		steps: [
			{ agent: "worker", index: 0, status: "running" },
			{ agent: "reviewer", index: 1, status: "pending" },
		],
	});
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const keys = {
	matches: (data: string, binding: string) => data === binding,
	getKeys: (binding: string) => [binding],
};

function actions() {
	const sent: unknown[][] = [];
	const aborted: unknown[][] = [];
	const errors: unknown[] = [];
	return {
		sent,
		aborted,
		errors,
		value: {
			send: async (...args: unknown[]) => {
				sent.push(args);
			},
			abort: async (...args: unknown[]) => {
				aborted.push(args);
			},
			onError: (error: unknown) => {
				errors.push(error);
			},
		},
	};
}

describe("takeover fleet adapter", () => {
	it("keeps parallel children distinct and delegates exact indexed actions", async () => {
		const state = stateForTest();
		addParallelRun(state);
		state.foregroundControls.set("foreground", { runId: "foreground", mode: "single", startedAt: 1, updatedAt: 30, currentAgent: "scout" });
		const calls = actions();
		const adapter = new TakeoverAdapter(state, calls.value, { refreshMs: 60_000 });
		try {
			assert.deepEqual(
				adapter.list().map((item) => item.id),
				["foreground-active:foreground:0", "async:run-12345678:0", "async:run-12345678:1"],
			);
			assert.equal(adapter.list()[0]!.canSend, false);
			assert.equal(adapter.list()[1]!.canSend, true);
			adapter.requestSend("async:run-12345678:1", "continue");
			adapter.requestAbort("async:run-12345678:0");
			await Promise.resolve();
			assert.deepEqual(calls.sent, [["run-12345678", 1, "continue"]]);
			assert.deepEqual(calls.aborted, [["run-12345678", 0]]);
			adapter.requestSend("foreground-active:foreground:0", "not allowed");
			assert.equal(calls.errors.length, 1);
			state.fleetJobs!.get("run-12345678")!.status = "complete";
			adapter.refresh();
			assert.equal(adapter.get("async:run-12345678:1")!.canSend, false);
			assert.equal(adapter.get("async:run-12345678:1")!.canAbort, false);
		} finally {
			adapter.dispose();
		}
	});

	it("preserves selection by stable key and stops notifications after disposal", () => {
		const state = stateForTest();
		addParallelRun(state);
		const calls = actions();
		const adapter = new TakeoverAdapter(state, calls.value, { refreshMs: 60_000 });
		let changes = 0;
		let removedChanges = 0;
		adapter.subscribe(() => {
			changes++;
		});
		adapter.subscribeTo("async:run-12345678:0", () => {
			removedChanges++;
		});
		const selection = { id: "async:run-12345678:1", index: 1 };
		reconcileTakeoverSelection(selection, adapter.list());
		assert.equal(selection.index, 1);
		state.fleetJobs!.get("run-12345678")!.steps!.shift();
		adapter.refresh();
		reconcileTakeoverSelection(selection, adapter.list());
		assert.equal(selection.id, "async:run-12345678:1");
		assert.equal(selection.index, 0);
		assert.equal(changes, 1);
		assert.equal(removedChanges, 1);
		adapter.dispose();
		adapter.refresh();
		assert.equal(changes, 1);
	});
});

describe("takeover UI", () => {
	it("sanitizes untrusted metadata before dashboard and detail rendering", () => {
		const item = {
			id: "safe-id",
			runId: "\u001b]0;INJECT\u0007safe-run",
			title: "\u009d0;INJECT\u009cWorker",
			state: "\u001bP INJECT\u001b\\running",
			source: "async",
			updatedAt: 1,
			canSend: false,
			canAbort: false,
			detail: [],
		};
		const view = {
			list: () => [item],
			get: () => item,
			subscribe: () => () => {},
			subscribeTo: () => () => {},
			requestAbort() {},
			requestSend() {},
		};
		const tui = { terminal: { rows: 12, columns: 80 }, requestRender() {} };
		const dashboard = new TakeoverDashboard(tui as never, theme as never, keys as never, view as never, { index: 0 }, () => {});
		const detail = new TakeoverDetail(tui as never, theme as never, keys as never, "safe-id", view as never, () => {});
		try {
			const rendered = [...dashboard.render(80), ...detail.render(80)].join("\n");
			assert.doesNotMatch(rendered, /INJECT/);
			assert.match(rendered, /Worker/);
			assert.match(rendered, /safe-run/);
			assert.match(rendered, /running/);
		} finally {
			dashboard.dispose();
			detail.dispose();
		}
	});

	it("sanitizes terminal controls and bounds dashboard/detail rendering", async () => {
		assert.equal(sanitizeTakeoverText("\u001b[31mred\u001b[0m\tbad\u0007"), "red  bad");
		assert.equal(sanitizeTakeoverText("\u001b]0;title\u0007\u009d1;other\u009chello"), "hello");
		assert.equal(sanitizeTakeoverText("\u001bPpayload\u001b\\safe"), "safe");
		const state = stateForTest();
		addParallelRun(state);
		const calls = actions();
		const adapter = new TakeoverAdapter(state, calls.value, { refreshMs: 60_000 });
		const tui = { terminal: { rows: 12, columns: 50 }, requestRender() {} };
		let picked: string | null | undefined;
		const dashboard = new TakeoverDashboard(tui as never, theme as never, keys as never, adapter, { index: 0 }, (value) => {
			picked = value;
		});
		try {
			const lines = dashboard.render(50);
			assert.ok(lines.some((line) => line.includes("Subagents")));
			assert.ok(lines.every((line) => visibleWidth(line) <= 50));
			assert.ok(lines.length <= tui.terminal.rows);
			dashboard.handleInput("tui.select.confirm");
			assert.equal(picked, "async:run-12345678:0");
		} finally {
			dashboard.dispose();
		}

		let closed = false;
		const detail = new TakeoverDetail(tui as never, theme as never, keys as never, "async:run-12345678:0", adapter, () => {
			closed = true;
		});
		try {
			const lines = detail.render(50);
			assert.ok(lines.some((line) => line.includes("run-12345678")));
			assert.ok(lines.every((line) => visibleWidth(line) <= 50));
			assert.ok(lines.length <= tui.terminal.rows);
			tui.terminal.rows = 6;
			assert.ok(detail.render(50).length <= 6);
			tui.terminal.rows = 12;
			for (const character of "xjka") detail.handleInput(character);
			assert.ok(detail.render(50).some((line) => line.includes("xjka")));
			detail.handleInput("\r");
			await Promise.resolve();
			assert.deepEqual(calls.sent, [["run-12345678", 0, "xjka"]]);
			detail.handleInput("\u0018");
			await Promise.resolve();
			assert.deepEqual(calls.aborted, [["run-12345678", 0]]);
			detail.handleInput("tui.select.cancel");
			assert.equal(closed, true);
		} finally {
			detail.dispose();
			adapter.dispose();
		}
	});
});
