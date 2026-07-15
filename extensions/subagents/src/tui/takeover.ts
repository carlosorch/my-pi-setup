import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { TakeoverAdapter, type TakeoverItem } from "./takeover-adapter.ts";

type Theme = ExtensionContext["ui"]["theme"];

const CONTROL_STRING_PATTERN =
	// OSC/DCS/SOS/PM/APC, including their C1 forms, through BEL or ST.
	// eslint-disable-next-line no-control-regex
	/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)|(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c)/g;
const ANSI_PATTERN =
	// eslint-disable-next-line no-control-regex
	/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;

export function sanitizeTakeoverText(text: string): string {
	return (
		text
			.replace(CONTROL_STRING_PATTERN, "")
			.replace(ANSI_PATTERN, "")
			.replaceAll("\t", "  ")
			// Preserve newlines; remove the remaining C0/C1 controls.
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
	);
}

function configuredKeys(keybindings: KeybindingsManager, binding: Parameters<KeybindingsManager["getKeys"]>[0]): string {
	return keybindings.getKeys(binding).join("/") || "unbound";
}

function glyph(item: TakeoverItem, theme: Theme): string {
	if (item.state === "running") return theme.fg("warning", "■");
	if (item.state === "queued" || item.state === "pending") return theme.fg("muted", "■");
	if (item.state === "complete" || item.state === "completed") return theme.fg("success", "■");
	if (item.state === "paused" || item.state === "stopped" || item.state === "detached") return theme.fg("warning", "■");
	return theme.fg("error", "■");
}

function pad(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export interface DashboardSelection {
	id?: string;
	index: number;
}

export function reconcileTakeoverSelection(selection: DashboardSelection, items: readonly Pick<TakeoverItem, "id">[]): void {
	const stable = selection.id ? items.findIndex((item) => item.id === selection.id) : -1;
	selection.index = stable >= 0 ? stable : Math.min(Math.max(0, selection.index), Math.max(0, items.length - 1));
	selection.id = items[selection.index]?.id;
}

export class TakeoverDashboard implements Component {
	private closed = false;
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly view: TakeoverAdapter;
	private readonly selection: DashboardSelection;
	private readonly done: (value: string | null) => void;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, view: TakeoverAdapter, selection: DashboardSelection, done: (value: string | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.view = view;
		this.selection = selection;
		this.done = done;
		this.unsubscribe = view.subscribe(() => tui.requestRender());
	}

	private close(value: string | null): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		this.done(value);
	}

	handleInput(data: string): void {
		const items = this.view.list();
		reconcileTakeoverSelection(this.selection, items);
		if (this.keybindings.matches(data, "tui.select.cancel")) return this.close(null);
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const item = items[this.selection.index];
			if (item) this.close(item.id);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			if (items.length) this.selection.index = (this.selection.index - 1 + items.length) % items.length;
		} else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			if (items.length) this.selection.index = (this.selection.index + 1) % items.length;
		} else if (data.toLowerCase() === "x") {
			const item = items[this.selection.index];
			if (item?.canAbort) this.view.requestAbort(item.id);
			return;
		} else {
			return;
		}
		this.selection.id = items[this.selection.index]?.id;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 32) return [truncateToWidth("Subagent takeover needs 32 columns. Esc closes.", width)];
		const items = this.view.list();
		reconcileTakeoverSelection(this.selection, items);
		const rows = this.tui.terminal?.rows ?? 30;
		if (rows < 5) return [truncateToWidth("Terminal too short for subagent takeover. Esc closes.", width)];
		const height = Math.max(1, rows - 4);
		const inner = Math.max(1, width - 2);
		let start = 0;
		if (items.length > height) start = Math.min(Math.max(0, this.selection.index - Math.floor(height / 2)), items.length - height);
		const lines = [
			truncateToWidth(
				`  ${this.theme.fg("accent", this.theme.bold("Subagents"))}${" ".repeat(Math.max(1, width - 16 - String(items.length).length))}${this.theme.fg("muted", String(items.length))}`,
				width,
			),
			this.theme.fg("border", `╭${"─".repeat(inner)}╮`),
		];
		for (let row = 0; row < height; row++) {
			const index = start + row;
			const item = items[index];
			let text = "";
			if (item) {
				const marker = index === this.selection.index ? this.theme.fg("accent", "❯") : " ";
				const child = item.index !== undefined ? `:${item.index + 1}` : "";
				const title = sanitizeTakeoverText(item.title);
				const runId = sanitizeTakeoverText(item.runId);
				const state = sanitizeTakeoverText(item.state);
				const left = ` ${marker} ${glyph(item, this.theme)} ${title} ${this.theme.fg("dim", `${runId.slice(0, 8)}${child}`)}`;
				const right = this.theme.fg("muted", `${item.source} · ${state} `);
				const leftWidth = Math.max(0, inner - visibleWidth(right) - 1);
				text = truncateToWidth(left, leftWidth) + " ".repeat(Math.max(1, inner - Math.min(leftWidth, visibleWidth(left)) - visibleWidth(right))) + right;
			} else if (items.length === 0 && row === 0) {
				text = this.theme.fg("dim", "  No tracked children");
			}
			lines.push(this.theme.fg("border", "│") + pad(text, inner) + this.theme.fg("border", "│"));
		}
		lines.push(this.theme.fg("border", `╰${"─".repeat(inner)}╯`));
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					`  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} open · x interrupt run · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
				),
				width,
			),
		);
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
	}
}

export class TakeoverDetail implements Component, Focusable {
	private readonly input = new Input();
	private scrollOffset = 0;
	private closed = false;
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly id: string;
	private readonly view: TakeoverAdapter;
	private readonly done: (value: null) => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, id: string, view: TakeoverAdapter, done: (value: null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.id = id;
		this.view = view;
		this.done = done;
		this.unsubscribe = view.subscribeTo(id, () => tui.requestRender());
		this.input.onSubmit = (value: string) => {
			const text = value.trim();
			if (!text) return;
			this.input.setValue("");
			this.view.requestSend(this.id, text);
			this.scrollOffset = 0;
			this.tui.requestRender();
		};
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		this.done(null);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) return this.close();
		if (data === "\u0018") {
			// Ctrl-X: avoid stealing printable input.
			const item = this.view.get(this.id);
			if (item?.canAbort) this.view.requestAbort(this.id);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.pageUp")) this.scrollOffset += this.viewportHeight();
		else if (this.keybindings.matches(data, "tui.editor.pageDown")) this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight());
		else {
			if (this.view.get(this.id)?.canSend) this.input.handleInput(data);
			return;
		}
		this.tui.requestRender();
	}

	private viewportHeight(): number {
		return Math.max(1, (this.tui.terminal?.rows ?? 30) - 7);
	}

	render(width: number): string[] {
		if (width < 32) return [truncateToWidth("Takeover detail needs 32 columns. Esc goes back.", width)];
		if ((this.tui.terminal?.rows ?? 30) < 9) return [truncateToWidth("Terminal too short for takeover detail. Esc goes back.", width)];
		const item = this.view.get(this.id);
		const border = this.theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		if (!item) return [border, this.theme.fg("dim", `${sanitizeTakeoverText(this.id)} is no longer tracked`), border];
		const title = sanitizeTakeoverText(item.title);
		const runId = sanitizeTakeoverText(item.runId);
		const state = sanitizeTakeoverText(item.state);
		const header = `${glyph(item, this.theme)} ${this.theme.fg("accent", this.theme.bold(title))}${this.theme.fg("muted", ` · ${runId}${item.index !== undefined ? `:${item.index + 1}` : ""} · ${state}`)}`;
		const transcript: string[] = [];
		for (const raw of item.detail) {
			const clean = sanitizeTakeoverText(raw);
			transcript.push(...(wrapTextWithAnsi(clean, Math.max(1, width)) || [""]));
		}
		const viewport = this.viewportHeight();
		const maxOffset = Math.max(0, transcript.length - viewport);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const end = transcript.length - this.scrollOffset;
		const body = transcript.slice(Math.max(0, end - viewport), end);
		while (body.length < viewport) body.push("");
		const input = item.canSend ? this.input.render(width) : [this.theme.fg("dim", "Steering unavailable: only active async children accept messages.")];
		return [
			border,
			truncateToWidth(header, width),
			border,
			...body.slice(0, viewport).map((line) => truncateToWidth(line, width)),
			border,
			...input.map((line) => truncateToWidth(line, width)),
			truncateToWidth(
				this.theme.fg(
					"dim",
					`${item.canSend ? `${configuredKeys(this.keybindings, "tui.input.submit")} send · ` : ""}Ctrl-X interrupt run · ${configuredKeys(this.keybindings, "tui.select.cancel")} back · PgUp/PgDn scroll`,
				),
				width,
			),
			border,
		];
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
	}
}

export async function openSubagentTakeover(ctx: ExtensionContext, view: TakeoverAdapter): Promise<void> {
	const selection: DashboardSelection = { index: 0 };
	while (true) {
		const picked = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => new TakeoverDashboard(tui, theme, keybindings, view, selection, done), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
		});
		if (!picked) return;
		if (!view.get(picked)) continue;
		await ctx.ui.custom<null>((tui, theme, keybindings, done) => new TakeoverDetail(tui, theme, keybindings, picked, view, done), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
		});
	}
}
