import type { SubagentState } from "../shared/types.ts";
import { collectFleetSnapshot, fleetDetailLines, type FleetItem } from "./fleet.ts";

const REFRESH_MS = 750;

export interface TakeoverItem {
	id: string;
	runId: string;
	index?: number;
	title: string;
	state: string;
	source: "async" | "foreground";
	updatedAt: number;
	canSend: boolean;
	canAbort: boolean;
	detail: string[];
}

export interface TakeoverActions {
	send(runId: string, index: number | undefined, text: string): Promise<void>;
	abort(runId: string, index: number | undefined): Promise<void>;
	onError(error: unknown): void;
}

function toTakeoverItem(item: FleetItem, error?: string): TakeoverItem {
	const childActive = item.state === "running" || item.state === "queued" || item.state === "pending";
	const runActive = item.kind === "async" && (item.run.state === "running" || item.run.state === "queued");
	return {
		id: item.key,
		runId: item.runId,
		...(item.index !== undefined ? { index: item.index } : {}),
		title: item.agent,
		state: item.state,
		source: item.kind === "async" ? "async" : "foreground",
		updatedAt: item.updatedAt,
		canSend: runActive && childActive,
		canAbort: item.kind === "foreground-active" || (runActive && childActive),
		detail: fleetDetailLines(item, error),
	};
}

export class TakeoverAdapter {
	private items: TakeoverItem[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly itemListeners = new Map<string, Set<() => void>>();
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly state: SubagentState;
	private readonly actions: TakeoverActions;
	private fatalError: Error | undefined;
	private disposed = false;

	constructor(state: SubagentState, actions: TakeoverActions, options: { refreshMs?: number } = {}) {
		this.state = state;
		this.actions = actions;
		this.refresh();
		this.timer = setInterval(() => {
			try {
				this.refresh();
			} catch (error) {
				this.fatalError = error instanceof Error ? error : new Error(String(error));
				for (const listener of this.listeners) listener();
				for (const listeners of this.itemListeners.values()) for (const listener of listeners) listener();
			}
		}, options.refreshMs ?? REFRESH_MS);
		this.timer.unref?.();
	}

	list(): readonly TakeoverItem[] {
		if (this.fatalError) throw this.fatalError;
		return this.items;
	}

	get(id: string): TakeoverItem | undefined {
		if (this.fatalError) throw this.fatalError;
		return this.items.find((item) => item.id === id);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeTo(id: string, listener: () => void): () => void {
		const listeners = this.itemListeners.get(id) ?? new Set();
		listeners.add(listener);
		this.itemListeners.set(id, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.itemListeners.delete(id);
		};
	}

	requestSend(id: string, text: string): void {
		const item = this.get(id);
		if (!item?.canSend) {
			this.actions.onError(new Error("Steering is available only for active async children."));
			return;
		}
		void this.actions.send(item.runId, item.index, text).catch(this.actions.onError);
	}

	requestAbort(id: string): void {
		const item = this.get(id);
		if (!item?.canAbort) return;
		void this.actions.abort(item.runId, item.index).catch(this.actions.onError);
	}

	refresh(): void {
		if (this.disposed) return;
		const snapshot = collectFleetSnapshot(this.state);
		if (snapshot.error && snapshot.items.length === 0) throw new Error(snapshot.error);
		const previous = new Map(this.items.map((item) => [item.id, item]));
		this.items = snapshot.items.map((item) => toTakeoverItem(item, snapshot.error));
		for (const listener of this.listeners) listener();
		const currentIds = new Set(this.items.map((item) => item.id));
		for (const item of this.items) {
			const before = previous.get(item.id);
			if (JSON.stringify(before) !== JSON.stringify(item)) {
				for (const listener of this.itemListeners.get(item.id) ?? []) listener();
			}
		}
		for (const id of previous.keys()) {
			if (!currentIds.has(id)) for (const listener of this.itemListeners.get(id) ?? []) listener();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		this.listeners.clear();
		this.itemListeners.clear();
	}
}
