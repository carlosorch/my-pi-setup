import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import workflows from "./index.ts";

test("workflow dispatches through RPC and returns the owned child result", async () => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflow-rpc-integration-"),
  );
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflow-agent-dir-"),
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let tool: any;
  let spawnParams: any;
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    on(event: string, handler: (data: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit(event: string, data: unknown) {
      if (event !== "subagents:rpc:v1:request") {
        for (const handler of handlers.get(event) ?? []) handler(data);
        return;
      }
      const request = data as {
        requestId: string;
        method: string;
        params: any;
      };
      let reply: unknown;
      if (request.method === "ping") {
        reply = {
          version: 1,
          methods: ["spawn", "status", "stop"],
          session: { cwd },
        };
      } else if (request.method === "spawn") {
        spawnParams = request.params;
        reply = {
          details: { asyncId: "owned-1", asyncDir: path.join(cwd, "owned-1") },
        };
      } else if (request.method === "status") {
        reply = {
          lifecycle: {
            runId: "owned-1",
            state: "complete",
            result: {
              success: true,
              state: "complete",
              results: [
                { success: true, output: "child done", model: "test/model" },
              ],
            },
          },
        };
      } else reply = {};
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: reply,
      });
    },
  };
  const pi = {
    events,
    getThinkingLevel: () => "medium",
    on() {},
    registerCommand() {},
    registerTool(value: unknown) {
      tool = value;
    },
    sendUserMessage() {},
  };
  workflows(pi as any);
  const ctx = {
    cwd,
    hasUI: false,
    model: undefined,
    modelRegistry: {
      getAll: () => [],
      find: (provider: string, model: string) => ({
        provider,
        id: model,
        contextWindow: 100_000,
      }),
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => null,
    },
  };

  const result = await tool.execute(
    "call-1",
    {
      script:
        "return await agent('do work', { model: 'openrouter/anthropic/claude' })",
      timeoutMs: 10_000,
    },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(spawnParams.agent, "worker");
  assert.equal(spawnParams.context, "fresh");
  assert.equal(spawnParams.cwd, cwd);
  assert.equal(spawnParams.model, "openrouter/anthropic/claude");
  assert.equal(spawnParams.thinking, "medium");
  assert.ok(spawnParams.timeoutMs > 0 && spawnParams.timeoutMs <= 10_000);
  assert.match(result.content[0].text, /child done/);
  assert.equal(result.details.agents[0].asyncId, "owned-1");
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});
