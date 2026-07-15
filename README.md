# my-pi-setup

A combined Pi setup built from:

- [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) — the setup structure, extensions, sandboxed workflow DSL, takeover UI, and native harness experiments.
- [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) — the production subagent runtime, agents, chains, parallel/background execution, worktrees, budgets, artifacts, recovery, RPC, and supervisor coordination.

This repository contains both projects rather than merely linking to them. Their Git histories are preserved in this repository.

## Repository layout

```text
extensions/
├── subagents/                  # Nico's complete pi-subagents package
├── workflows/                  # Ben's sandboxed JavaScript workflow extension
├── ask-user/
├── background-terminals/
├── copy-all/
├── firecrawl-search/
├── git-info/
├── model-info/
└── ui-customization/

reference/
└── davis-subagents/            # Ben's original Effect-based multi-backend implementation and takeover UI
```

Ben's original `extensions/subagents` implementation is retained under `reference/davis-subagents` so it does not conflict with the active `extensions/subagents` package.

## Integration direction

`pi-subagents` remains the execution authority. The integration will connect Ben's workflow and UI work to its existing RPC and lifecycle machinery:

```text
Sandboxed workflow DSL
          │
          ▼
  pi-subagents RPC v1
          │
          ▼
Agents · chains · worktrees · deadlines · artifacts · recovery
          │
          ▼
Takeover UI (primary) ── Classic UI (fallback)
```

Planned behavior:

- Dispatch workflow `agent()`, `parallel()`, and `phase()` operations through `subagents:rpc:v1`.
- Apply one absolute deadline to the workflow and every child run.
- Allow one writer by default; require isolated worktrees for concurrent writers.
- Use the takeover dashboard as the primary UI while retaining the classic UI as a configurable and automatic fallback.
- Add a native Codex harness only if OpenAI exposes useful Codex functionality unavailable through Pi providers.

## Installation and setup

See [`SETUP.md`](./SETUP.md) for the personal Pi setup and [`extensions/subagents/README.md`](./extensions/subagents/README.md) for subagent package usage.

Use `pnpm` for dependency management:

```bash
pnpm install
pnpm -r test
```

## Upstreams

- Davis setup: https://github.com/davis7dotsh/my-pi-setup
- pi-subagents: https://github.com/nicobailon/pi-subagents
- Combined repository: https://github.com/carlosorch/my-pi-setup

## Credits

Built on work by [Ben Davis](https://github.com/davis7dotsh) and [Nico Bailon](https://github.com/nicobailon). The upstream links and original repository histories are retained to keep subsystem provenance clear.
