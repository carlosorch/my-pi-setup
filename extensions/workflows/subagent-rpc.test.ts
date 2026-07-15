import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { buildWorkflowSpawnParams, SubagentRpcClient } from "./subagent-rpc.ts";

class Events {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  on(event: string, handler: (data: unknown) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
  emit(event: string, data: unknown) {
    if (event === "subagents:rpc:v1:request") {
      const request = data as { requestId: string; method: string };
      this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data:
          request.method === "ping"
            ? {
                version: 1,
                methods: ["spawn", "status", "stop"],
                session: { cwd: "/repo" },
              }
            : { details: { asyncId: "owned-run" } },
      });
      return;
    }
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
  listenerCount() {
    return [...this.handlers.values()].reduce(
      (sum, handlers) => sum + handlers.size,
      0,
    );
  }
}

test("workflow spawn mapping uses worker, remaining deadline, and structured chain", () => {
  assert.deepEqual(
    buildWorkflowSpawnParams({ prompt: "plain", cwd: "/repo", timeoutMs: 123 }),
    {
      agent: "worker",
      task: "plain",
      context: "fresh",
      cwd: "/repo",
      timeoutMs: 123,
    },
  );
  assert.deepEqual(
    buildWorkflowSpawnParams({
      prompt: "typed",
      schema: { type: "object" },
      cwd: "/repo",
      timeoutMs: 99,
      model: "p/m",
      thinking: "high",
    }),
    {
      chain: [
        { agent: "worker", task: "typed", outputSchema: { type: "object" } },
      ],
      context: "fresh",
      cwd: "/repo",
      timeoutMs: 99,
      model: "p/m",
      thinking: "high",
    },
  );
});

test("workflow RPC negotiates before dispatch and disposes reply listeners", async () => {
  const events = new Events();
  const client = new SubagentRpcClient(events);
  await client.negotiate("/repo");
  const spawn = await client.request("spawn", {
    agent: "worker",
    task: "work",
  });
  assert.equal(spawn?.details?.asyncId, "owned-run");
  assert.equal(events.listenerCount(), 0);
});

test("an aborted spawn remains owned beyond the old late-reply boundary", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const handlers = new Map<string, (data: unknown) => void>();
    let spawnReplyEvent: string | undefined;
    let stoppedId: string | undefined;
    let statusId: string | undefined;
    const events = {
      on(event: string, handler: (data: unknown) => void) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      emit(event: string, data: unknown) {
        if (event !== "subagents:rpc:v1:request") return;
        const request = data as {
          requestId: string;
          method: string;
          params?: { id?: string };
        };
        if (request.method === "stop") {
          stoppedId = request.params?.id;
          handlers.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({
            version: 1,
            requestId: request.requestId,
            success: true,
            data: {},
          });
        } else if (request.method === "status") {
          statusId = request.params?.id;
          handlers.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({
            version: 1,
            requestId: request.requestId,
            success: true,
            data: { lifecycle: { result: { success: false, results: [] } } },
          });
        } else spawnReplyEvent = `subagents:rpc:v1:reply:${request.requestId}`;
      },
    };
    const abort = new AbortController();
    const client = new SubagentRpcClient(events);
    const pending = client.request("spawn", {}, abort.signal);
    abort.abort();
    await assert.rejects(pending, /aborted/);
    let lateSettled = false;
    const lateWait = client.waitForPendingSpawns().then(() => {
      lateSettled = true;
    });
    await Promise.resolve();
    assert.equal(lateSettled, false);
    mock.timers.tick(30_001);
    assert.equal(handlers.size, 1);
    handlers.get(spawnReplyEvent!)?.({
      version: 1,
      requestId: spawnReplyEvent!.split(":").at(-1),
      success: true,
      data: { details: { asyncId: "late-owned" } },
    });
    await lateWait;
    assert.equal(stoppedId, "late-owned");
    assert.equal(statusId, "late-owned");
    assert.equal(handlers.size, 0);
  } finally {
    mock.timers.reset();
  }
});

test("a pre-aborted spawn does not retain a late-reply listener", async () => {
  const events = new Events();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    new SubagentRpcClient(events).request("spawn", {}, abort.signal),
    /aborted/,
  );
  assert.equal(events.listenerCount(), 0);
});

test("malformed replies reject without throwing or leaking listeners", async () => {
  const handlers = new Map<string, (data: unknown) => void>();
  let replyEvent: string | undefined;
  const events = {
    on(event: string, handler: (data: unknown) => void) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    emit(event: string, data: unknown) {
      if (event !== "subagents:rpc:v1:request") return;
      const request = data as { requestId: string };
      replyEvent = `subagents:rpc:v1:reply:${request.requestId}`;
    },
  };
  const pending = new SubagentRpcClient(events).request("status", {});
  assert.doesNotThrow(() => handlers.get(replyEvent!)?.(null));
  await assert.rejects(pending, /Invalid pi-subagents RPC reply/);
  assert.equal(handlers.size, 0);
});

test("workflow RPC rejects a mismatched active cwd", async () => {
  const events = new Events();
  await assert.rejects(
    new SubagentRpcClient(events).negotiate("/other"),
    /not bound/,
  );
  assert.equal(events.listenerCount(), 0);
});
