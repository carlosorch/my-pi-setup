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

## Integration

`pi-subagents` remains the execution authority. The workflow and takeover UI use its RPC and lifecycle machinery:

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

The installable package loads only:

- `extensions/subagents/src/extension/index.ts`
- `extensions/workflows/index.ts`
- the packaged subagent skills and prompts

The other Davis extensions and themes remain source references and are not loaded by this package.

## Installation and setup

Install a pinned release so later upstream changes cannot alter the active Pi unexpectedly:

```bash
pi install git:github.com/carlosorch/my-pi-setup@setup-v0.1.3
```

Move to a later pinned release by installing its new tag. To roll back, reinstall the previous tag. Do not keep `npm:pi-subagents` enabled at the same time because both packages register the same subagent extension.

For repository development:

```bash
pnpm install
pnpm test
pnpm run test:subagents
```

See [`SETUP.md`](./SETUP.md) for the personal Pi setup and [`extensions/subagents/README.md`](./extensions/subagents/README.md) for subagent usage.

## Upstreams

- Davis setup: https://github.com/davis7dotsh/my-pi-setup
- pi-subagents: https://github.com/nicobailon/pi-subagents
- Combined repository: https://github.com/carlosorch/my-pi-setup

## Credits

Built on work by [Ben Davis](https://github.com/davis7dotsh) and [Nico Bailon](https://github.com/nicobailon). The upstream links and original repository histories are retained to keep subsystem provenance clear.
