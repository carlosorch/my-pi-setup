import { randomUUID } from "node:crypto";

const VERSION = 1;
const REQUEST = "subagents:rpc:v1:request";
const REPLY = "subagents:rpc:v1:reply:";

interface Events {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

export interface RpcResult {
  success?: boolean;
  state?: string;
  output?: string;
  error?: string;
  model?: string;
  structuredOutput?: unknown;
  totalCost?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface RpcDetails {
  asyncId?: string;
  asyncDir?: string;
}

export interface RpcLifecycle {
  runId?: string;
  state?: string;
  asyncDir?: string | null;
  result?: { success?: boolean; state?: string; results?: RpcResult[] };
}

interface RpcReply {
  version: number;
  requestId: string;
  success: boolean;
  data?: { details?: RpcDetails; text?: string; lifecycle?: RpcLifecycle };
  error?: { message?: string };
}

export function buildWorkflowSpawnParams(input: {
  prompt: string;
  schema?: unknown;
  cwd: string;
  timeoutMs: number;
  model?: string;
  thinking?: string;
}) {
  const execution =
    input.schema === undefined
      ? { agent: "worker", task: input.prompt }
      : {
          chain: [
            { agent: "worker", task: input.prompt, outputSchema: input.schema },
          ],
        };
  return {
    ...execution,
    context: "fresh" as const,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
  };
}

export class SubagentRpcClient {
  private readonly events: Events;
  private readonly pendingSpawns = new Set<Promise<void>>();

  constructor(events: Events) {
    this.events = events;
  }

  private trackPendingSpawn(promise: Promise<void>): void {
    this.pendingSpawns.add(promise);
    void promise.finally(() => this.pendingSpawns.delete(promise));
  }

  private async stopAndConfirm(asyncId: string): Promise<void> {
    await this.request("stop", { id: asyncId }, undefined, 5_000).catch(
      () => {},
    );
    while (true) {
      try {
        const status = await this.request(
          "status",
          { id: asyncId },
          undefined,
          5_000,
        );
        if (status?.lifecycle?.result) return;
      } catch {
        // Fail closed: keep the writer lease until terminal state is proven.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
      });
    }
  }

  async waitForPendingSpawns(): Promise<void> {
    while (this.pendingSpawns.size) await Promise.all([...this.pendingSpawns]);
  }

  request(
    method: "ping" | "spawn" | "status" | "stop",
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<RpcReply["data"]> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      let requestEmitted = false;
      let watchingLateSpawn = false;
      let resolveLateSpawn: (() => void) | undefined;
      const lateSpawn =
        method === "spawn"
          ? new Promise<void>((resolveLate) => {
              resolveLateSpawn = resolveLate;
            })
          : undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (typeof unsubscribe === "function") unsubscribe();
      };
      const fail = (error: Error, watchLateSpawn = false) => {
        if (settled) return;
        settled = true;
        watchingLateSpawn = method === "spawn" && watchLateSpawn;
        if (watchingLateSpawn && lateSpawn) this.trackPendingSpawn(lateSpawn);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
        if (!watchingLateSpawn) cleanup();
      };
      const finish = (value?: RpcReply["data"]) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const abort = () =>
        fail(new Error("Workflow RPC request aborted"), requestEmitted);
      const unsubscribe = this.events.on(`${REPLY}${requestId}`, (raw) => {
        const reply =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Partial<RpcReply>)
            : undefined;
        if (settled) {
          if (!watchingLateSpawn) return;
          if (
            reply?.version !== VERSION ||
            reply.requestId !== requestId ||
            typeof reply.success !== "boolean"
          )
            return;
          if (!reply.success) {
            cleanup();
            watchingLateSpawn = false;
            resolveLateSpawn?.();
            return;
          }
          const asyncId = reply.data?.details?.asyncId;
          if (!asyncId) return;
          cleanup();
          watchingLateSpawn = false;
          void this.stopAndConfirm(asyncId).then(() => resolveLateSpawn?.());
          return;
        }
        if (
          reply?.version !== VERSION ||
          reply.requestId !== requestId ||
          typeof reply.success !== "boolean"
        ) {
          fail(new Error("Invalid pi-subagents RPC reply"));
          return;
        }
        if (!reply.success)
          fail(
            new Error(
              reply.error?.message || `pi-subagents RPC ${method} failed`,
            ),
          );
        else finish(reply.data);
      });
      const timer = setTimeout(
        () => fail(new Error(`pi-subagents RPC ${method} timed out`), true),
        timeoutMs,
      );
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      requestEmitted = true;
      try {
        this.events.emit(REQUEST, {
          version: VERSION,
          requestId,
          method,
          params,
          source: { extension: "workflows" },
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async negotiate(cwd: string, signal?: AbortSignal): Promise<void> {
    const data = (await this.request("ping", {}, signal)) as
      | { version?: number; methods?: string[]; session?: { cwd?: string } }
      | undefined;
    if (
      data?.version !== VERSION ||
      !["spawn", "status", "stop"].every((method) =>
        data.methods?.includes(method),
      )
    )
      throw new Error("pi-subagents RPC v1 with spawn/status/stop is required");
    if (data.session?.cwd !== cwd)
      throw new Error("pi-subagents RPC is not bound to this workflow cwd");
  }
}
