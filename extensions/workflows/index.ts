/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection. Results and transcript
 * availability metadata use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import { RunController } from "./controller.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  countStates,
  emptyUsage,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowAgentPrompt,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  buildWorkflowSpawnParams,
  SubagentRpcClient,
  type RpcLifecycle,
} from "./subagent-rpc.ts";

type WorkflowModel = NonNullable<ExtensionContext["model"]>;
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";
import { acquireWriterLease } from "./writer-lease.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
}

interface AgentCallOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
}

const WorkflowParams = Type.Object({
  script: Type.String({
    description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
  }),
  args: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2_147_483_647,
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.timeoutMs,
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, runId, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) {
        continue;
      }
      const agents = parsed.agents ?? [];
      summaries.push({
        runId,
        name: parsed.name,
        status:
          parsed.status === "running"
            ? "aborted"
            : (parsed.status ?? "unknown"),
        done: agents.filter((agent) => agent.state !== "running").length,
        total: agents.length,
        startedAt: parsed.startedAt ?? 0,
        active: false,
      });
    } catch {
      // Ignore unreadable artifacts because their session cannot be verified.
    }
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return buildWorkflowResultMessage(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return buildWorkflowResultMessage(parsed, runDir);
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

export default function workflows(pi: ExtensionAPI) {
  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<
    string,
    {
      details: WorkflowDetails;
      controller: RunController;
      completion?: Promise<void>;
    }
  >();
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  /** Finished counts remain visible until the dashboard acknowledges them. */
  let lastUi: ExtensionContext["ui"] | undefined;
  let completedRuns = 0;
  let failedRuns = 0;
  const updateIndicator = () => {
    const ui = lastUi;
    if (!ui) return;
    try {
      const running = activeRuns.size;
      if (running === 0 && completedRuns === 0 && failedRuns === 0) {
        ui.setStatus("workflows", undefined);
        return;
      }
      ui.setStatus(
        "workflows",
        formatActivityStatus(ui.theme, "workflows", {
          running,
          done: completedRuns,
          failed: failedRuns,
        }),
      );
    } catch {
      // UI may be unavailable.
    }
  };

  const recordSettledRun = (status: WorkflowDetails["status"]) => {
    if (status === "completed") completedRuns += 1;
    else failedRuns += 1;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) lastUi = ctx.ui;
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    const runs = [...activeRuns.values()];
    for (const run of runs) run.controller.abort("Session is shutting down");
    await Promise.all(
      runs.map((run) => run.controller.settle({ abort: true })),
    );
    const completions = runs
      .map((run) => run.completion)
      .filter(
        (completion): completion is Promise<void> => completion !== undefined,
      );
    if (completions.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 8_000);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled(completions), timeout]);
      if (timer) clearTimeout(timer);
    }
    lastUi?.setStatus("workflows", undefined);
    lastUi = undefined;
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for one run's detail)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (ctx.mode === "tui") {
        lastUi = ctx.ui;
        await showWorkflowDashboard(ctx, activeDetails, arg || undefined);
        // Opening the dashboard acknowledges finished runs.
        completedRuns = 0;
        failedRuns = 0;
        updateIndicator();
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
      );
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
        return;
      }
      if (arg) {
        const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));
        ctx.ui.notify(
          run
            ? runDetailText(run, activeDetails())
            : `No workflow run matching "${arg}".`,
          run ? "info" : "warning",
        );
        return;
      }
      const labels = runs.map(
        (r) =>
          `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`,
      );
      if (!ctx.hasUI) {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select("Workflow runs", labels);
      if (!choice) return;
      const run = runs[labels.indexOf(choice)];
      if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(params.script);
      } catch (error) {
        throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
      }

      let args: unknown;
      if (params.args !== undefined) {
        try {
          args = JSON.parse(params.args);
        } catch {
          args = params.args;
        }
      }

      const meta = prepared.meta;
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(getAgentDir(), "workflows", runId);
      const background = (params.background ?? false) && ctx.hasUI;

      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        name: meta.name,
        description: meta.description,
        background,
        status: "running",
        startedAt: Date.now(),
        phases: [...meta.phases],
        agents: [],
      };

      // Acquire before creating run artifacts so lease contention leaves no
      // orphan workflow that appears to be running.
      const writerLease = acquireWriterLease(ctx.cwd);
      let persistence: ReturnType<typeof createWorkflowPersistence>;
      try {
        writeRunFile(runDir, "script.js", params.script);
        if (params.args !== undefined)
          writeRunFile(runDir, "args.json", params.args);
        persistWorkflowJson(runDir, details);
        persistence = createWorkflowPersistence(runDir, details);
      } catch (error) {
        writerLease.release();
        throw error;
      }

      // Hold one cross-process writer lease for the whole run. Calls inside
      // the workflow are serialized because the DSL does not expose trusted
      // parallel-group identity to the parent process.
      const timeoutMs = params.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS;
      // Background runs survive Esc on the parent turn, but all runs are
      // aborted and settled during session shutdown.
      const controller = new RunController(
        background ? undefined : signal,
        1,
        timeoutMs,
      );
      details.timeoutMs = timeoutMs;
      details.deadlineAt = controller.deadlineAt;
      const rpc = new SubagentRpcClient(pi.events);
      const ownedRuns = new Set<string>();
      const stopOwned = async () => {
        await Promise.allSettled(
          [...ownedRuns].map((id) =>
            rpc.request("stop", { id }, undefined, 5_000),
          ),
        );
        const stopDeadline = Date.now() + 5_000;
        while (ownedRuns.size && Date.now() < stopDeadline) {
          await Promise.allSettled(
            [...ownedRuns].map(async (id) => {
              const status = await rpc.request(
                "status",
                { id },
                undefined,
                2_000,
              );
              if (status?.lifecycle?.result) ownedRuns.delete(id);
            }),
          );
          if (ownedRuns.size)
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };

      // Throttled progress: tool-block updates when blocking. Background
      // runs are covered by the below-editor indicator and /workflows.
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEmit = 0;
      const flush = () => {
        emitTimer = undefined;
        lastEmit = Date.now();
        if (background) return;
        onUpdate?.({
          content: [{ type: "text", text: summaryLine(details) }],
          details: compactToolDetails(details),
        });
      };
      const emit = (checkpoint = true) => {
        if (checkpoint) persistence.checkpoint();
        if (emitTimer) return;
        emitTimer = setTimeout(
          flush,
          Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
        );
      };
      const flushNow = () => {
        if (emitTimer) clearTimeout(emitTimer);
        flush();
      };

      const phaseFn = (title: unknown) => {
        const text = String(title);
        details.currentPhase = text;
        if (!details.phases.some((p) => p.title === text))
          details.phases.push({ title: text });
        emit();
      };

      let agentCounter = 0;
      const agentFn = async (
        promptValue: unknown,
        optsValue: unknown = {},
        invocationSignal?: AbortSignal,
      ): Promise<ScriptAgentResult> => {
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const label =
          typeof opts.label === "string" && opts.label.trim()
            ? opts.label.trim().slice(0, 160)
            : `agent-${index}`;

        const record: AgentRecord = {
          index,
          label,
          phase:
            typeof opts.phase === "string"
              ? opts.phase.slice(0, 160)
              : details.currentPhase,
          state: "running",
          model: ctx.model?.id,
          contextWindow: ctx.model?.contextWindow,
          startedAt: Date.now(),
          preview: "",
          usage: emptyUsage(),
          transcript: [],
        };
        details.agents.push(record);
        persistence.checkpoint({ immediate: true });
        emit(false);

        const fail = (error: string): ScriptAgentResult => {
          record.state = "error";
          record.error = error;
          record.finishedAt = Date.now();
          emit();
          return { ok: false, output: "", error };
        };

        const prompt = buildWorkflowAgentPrompt(
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? ""),
        );
        if (!prompt.trim())
          return fail("agent() requires a non-empty prompt string");
        if (controller.signal.aborted)
          return fail("Workflow was aborted before this agent started");

        return controller
          .schedule(async (runSignal) => {
            let model: WorkflowModel | undefined = ctx.model;
            if (opts.model !== undefined || opts.provider !== undefined) {
              const modelOpt =
                typeof opts.model === "string" ? opts.model : undefined;
              const providerOpt =
                typeof opts.provider === "string" ? opts.provider : undefined;
              if (!modelOpt)
                return fail(
                  `agent "${label}": \`provider\` requires \`model\` as well`,
                );
              const slash = modelOpt.indexOf("/");
              model = providerOpt
                ? ctx.modelRegistry.find(providerOpt, modelOpt)
                : slash > 0
                  ? ctx.modelRegistry.find(
                      modelOpt.slice(0, slash),
                      modelOpt.slice(slash + 1),
                    )
                  : ctx.modelRegistry
                      .getAll()
                      .find((candidate) => candidate.id === modelOpt);
              if (!model)
                return fail(
                  `agent "${label}": unknown model "${providerOpt ? `${providerOpt}/` : ""}${modelOpt}" (use provider/id)`,
                );
            }
            record.model = model?.id;
            record.contextWindow = model?.contextWindow;

            const effort =
              opts.effort === undefined ? undefined : String(opts.effort);
            if (
              effort &&
              !(THINKING_LEVELS as readonly string[]).includes(effort)
            )
              return fail(
                `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
              );
            const thinking = effort ?? pi.getThinkingLevel();

            const remainingMs = controller.remainingMs();
            if (remainingMs < 1) throw new Error("Workflow deadline exceeded");
            const spawn = await rpc.request(
              "spawn",
              buildWorkflowSpawnParams({
                prompt,
                schema: opts.schema,
                cwd: ctx.cwd,
                timeoutMs: remainingMs,
                ...(model ? { model: `${model.provider}/${model.id}` } : {}),
                ...(thinking ? { thinking } : {}),
              }),
              runSignal,
              Math.min(10_000, remainingMs),
            );
            const asyncId = spawn?.details?.asyncId;
            if (!asyncId)
              throw new Error("pi-subagents RPC spawn returned no asyncId");
            ownedRuns.add(asyncId);
            record.asyncId = asyncId;
            record.asyncDir = spawn?.details?.asyncDir;
            emit();
            const stop = () =>
              void rpc
                .request("stop", { id: asyncId }, undefined, 5_000)
                .catch(() => {});
            runSignal.addEventListener("abort", stop, { once: true });

            let terminal: RpcLifecycle | undefined;
            try {
              while (!terminal) {
                if (runSignal.aborted) throw runSignal.reason;
                const status = await rpc.request(
                  "status",
                  { id: asyncId },
                  runSignal,
                  Math.max(1, Math.min(5_000, controller.remainingMs())),
                );
                if (status?.lifecycle?.result) terminal = status.lifecycle;
                else
                  await new Promise<void>((resolve, reject) => {
                    const abort = () => {
                      clearTimeout(timer);
                      reject(runSignal.reason);
                    };
                    const timer = setTimeout(() => {
                      runSignal.removeEventListener("abort", abort);
                      resolve();
                    }, 200);
                    runSignal.addEventListener("abort", abort, { once: true });
                  });
              }
            } finally {
              runSignal.removeEventListener("abort", stop);
              if (terminal) ownedRuns.delete(asyncId);
            }

            const result = terminal.result?.results?.[0];
            if (!result)
              throw new Error("pi-subagents completed without a child result");
            const output =
              typeof result.output === "string" ? result.output : "";
            const ok = result.success === true;
            record.model =
              typeof result.model === "string" ? result.model : record.model;
            record.preview = output.slice(0, PREVIEW_LENGTH);
            if (result.totalCost) {
              record.usage = {
                input: result.totalCost.inputTokens ?? 0,
                output: result.totalCost.outputTokens ?? 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: result.totalCost.costUsd ?? 0,
                turns: 0,
              };
            }
            record.finishedAt = Date.now();
            record.state = ok ? "done" : "error";
            record.error = ok
              ? undefined
              : typeof result.error === "string"
                ? result.error
                : "Agent failed";
            emit();
            return {
              ok,
              output,
              ...(result.structuredOutput !== undefined
                ? { structured: result.structuredOutput }
                : {}),
              ...(!ok ? { error: record.error } : {}),
            };
          }, invocationSignal)
          .catch((error) => fail(errorText(error)));
      };

      const runScript = async () => {
        let status: WorkflowDetails["status"] = "completed";
        try {
          await rpc.negotiate(ctx.cwd, controller.signal);
          details.result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: ctx.cwd,
            signal: controller.signal,
            onAgent: agentFn,
            onPhase: phaseFn,
          });
        } catch (error) {
          details.error = errorText(error);
          status = controller.signal.aborted ? "aborted" : "failed";
          controller.abort("Workflow script failed");
        }

        const settled = await controller.settle({
          abort: status !== "completed",
        });
        if (status !== "completed" || !settled) await stopOwned();
        // A spawn request can outlive its caller. Do not finalize or release
        // the writer lease until any late async ID is stopped and terminal.
        await rpc.waitForPendingSpawns();
        if (ownedRuns.size) {
          status = "failed";
          details.error = details.error
            ? `${details.error}; could not confirm ${ownedRuns.size} owned run(s) stopped`
            : `Could not confirm ${ownedRuns.size} owned run(s) stopped`;
        }
        if (!settled) {
          status = "failed";
          details.error = details.error
            ? `${details.error}; agent shutdown deadline exceeded`
            : "Agent shutdown deadline exceeded";
        }
        for (const record of details.agents) {
          if (record.state !== "running") continue;
          record.state = "error";
          record.error =
            record.error ?? "Agent did not settle before run cleanup";
          record.finishedAt = Date.now();
        }
        details.status = status;
        details.finishedAt = Date.now();
        try {
          persistence.flush();
        } catch (error) {
          details.status = "failed";
          details.error = `Artifact persistence failed: ${errorText(error)}`;
          throw new Error(details.error);
        } finally {
          flushNow();
          // Fail closed: an unconfirmed child keeps the cross-process lease
          // until this process exits and stale ownership can be reclaimed.
          if (ownedRuns.size === 0) writerLease.release();
        }
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun = { details, controller } as {
        details: WorkflowDetails;
        controller: RunController;
        completion?: Promise<void>;
      };
      activeRuns.set(runId, activeRun);
      const completion = runScript();
      activeRun.completion = completion;
      if (ctx.hasUI) lastUi = ctx.ui;
      updateIndicator();

      if (background) {
        void completion
          .catch((error) => {
            details.status = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
          })
          .finally(() => {
            activeRuns.delete(runId);
            recordSettledRun(details.status);
            updateIndicator();
            try {
              pi.sendUserMessage(
                buildBackgroundWorkflowFollowUp({
                  runId,
                  status: details.status,
                  result: buildWorkflowResultMessage(details, runDir),
                }),
                { deliverAs: "followUp" },
              );
            } catch {
              // Session may be shutting down.
            }
          });
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
              }),
            },
          ],
          details: compactToolDetails(details),
        };
      }

      try {
        await completion;
      } finally {
        activeRuns.delete(runId);
        recordSettledRun(details.status);
        updateIndicator();
      }
      if (details.status !== "completed") {
        // Pi marks tool failures only when execute throws; returning isError is
        // ignored by the extension API.
        throw new Error(buildWorkflowResultMessage(details, runDir));
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(details, runDir),
          },
        ],
        details: compactToolDetails(details),
      };
    },

    renderCall(args: Partial<WorkflowInput>, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
      if (args.background) text += theme.fg("dim", " (background)");
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      const { done, failed } = countStates(details);
      const settled = done + failed;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${details.currentPhase}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
            agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
          }${theme.fg(
            "dim",
            `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg("error", `Error: ${details.error}`)}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", details.description), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage, agent.model);
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
            "dim",
            [context, formatElapsed(agent.startedAt, agent.finishedAt)]
              .filter(Boolean)
              .join(" · "),
          )}`;
          if (usage) line += ` ${theme.fg("dim", usage)}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(`  ${theme.fg("error", agent.error)}`, 0, 0),
            );
          } else if (agent.preview) {
            const preview = agent.preview.split("\n").slice(0, 2).join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("error", `Error: ${details.error}`), 0, 0),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });
}
