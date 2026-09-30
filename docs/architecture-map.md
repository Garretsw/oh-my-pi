# Architecture Map

A layered map of the repo with the key execution paths. Built from a read-only exploration (grep and spot reads, not a full read of every file), so line numbers are approximate anchors and may drift. Paths under `coding-agent/` are relative to `packages/coding-agent/src` unless noted.

## Layers (bottom to top)

| Layer | Packages | Role |
| --- | --- | --- |
| Native | `crates/*`, `packages/natives` | Rust code exposed to JS through one napi crate, `pi-natives` |
| Foundation | `utils`, `omptype`, `wire`, `catalog` | Shared helpers, schema validation, wire types, model policy |
| LLM + agent | `ai`, `agent` | Provider streaming and the agent loop |
| TUI | `tui` | Differential rendering, components, input |
| Leaf apps | `stats`, `collab-web`, `browser-relay` | Dashboard, browser collab client, Chrome extension |
| Coding-agent core | `coding-agent` | Boot, config, session, system prompt |
| Modes and UI | `coding-agent/modes`, `collab`, `live`, `plan-mode` | Interactive, print, RPC, ACP |
| Tools and extensions | `coding-agent/tools`, `edit`, `task`, `mcp`, `memories` | Tool registry, edit, subagents, MCP, memory |

Dependency direction:

- `wire` has no dependencies; `omptype` has no runtime dependencies.
- `utils` depends only on `natives`.
- `catalog` depends on `omptype` and `utils`. Inversion: its `gen:models` script dev-depends on `pi-ai`.
- `ai` and `agent` depend on `catalog`, `natives`, `utils`, `wire`.
- `tui` depends on the layers below it plus `agent` and `ai` (chat and tool renderers are coupled to them).
- `stats`, `collab-web`, `browser-relay` are leaves. `coding-agent` sits on top of everything.

## 1. Native (`crates/*`, `packages/natives`)

Dependency shape: `pi-natives` -> { `pi-shell` -> `pi-builtins` -> `pi-walker`; `pi-edit` -> `pi-ast`/`pi-diff`/`pi-walker`; `pi-vcs` -> `pi-iso`; `pi-voice` }.

| Crate | Purpose |
| --- | --- |
| `pi-natives` | The only napi crate (cdylib). Module list at `crates/pi-natives/src/lib.rs:22-70` |
| `pi-walker` | Filesystem walker on `ignore`, with scan cache |
| `pi-diff` | Pure diff primitives (myers) |
| `pi-ast` | tree-sitter / ast-grep parse, match, rewrite |
| `pi-edit` | Edit engine: fuzzy matching, snapshot store, streaming JSON args, notebook edits, path policy |
| `pi-iso` | Copy-on-write filesystem isolation per platform (apfs, btrfs, zfs, overlayfs, reflink, projfs) |
| `pi-vcs` | Unified git (gix) and jj abstraction |
| `pi-builtins` | In-process builtins and uutils coreutils for the embedded shell |
| `pi-shell` | Embedded bash runtime on brush (`crates/vendor/brush-core`, patched) |
| `pi-voice` | Audio capture/playback and live WebRTC peer |

TS binding: `packages/natives` is JS plus d.ts under `native/` (no `src/`). `native/index.js` has a generated export block (do not hand-edit). `native/loader-state.js` picks the platform `.node` (`pi_natives.<platform>-<arch>[-modern|-baseline].node`), supports the embedded addon for compiled binaries, and checks a version sentinel. Build: `bun run build` (host, local Cargo/napi); Bazel for cross targets.

Key paths:

- grep: `pi-natives/src/grep.rs` (walking via `pi-walker`)
- edit: `pi-natives/src/edit.rs` -> `pi-edit`
- shell: `pi-natives/src/shell.rs` -> `pi-shell/src/shell.rs` -> `pi-builtins` + `brush-core`
- vcs: `pi-natives/src/vcs.rs` -> `pi-vcs/src/lib.rs`; `pi-iso` backs worktree isolation
- `pi-natives/src/task.rs`: blocking-task helper with cancel tokens and panic catch (panics become rejected Promises)

## 2. Foundation (`utils`, `omptype`, `wire`, `catalog`)

- `utils`: barrel `src/index.ts`; namespaces `logger`, `postmortem`, `procmgr`, `prompt`, `ptree`; subpath exports (`./*` maps to `src/*.ts`).
- `omptype`: ArkType-compatible runtime validation with lazy JIT (`compile.ts`, `interp.ts`); adapters for ark, typebox, zod.
- `wire`: dependency-free JSON types for the collab protocol (producer: `coding-agent/collab/protocol.ts`).
- `catalog`: barrel `src/index.ts`; `models.json` (generated, ~11 MB), `compat/rules.json` (compiled from KDL).

Compat KDL pipeline: sources in `catalog/src/compat/rules/` (`taxonomy/`, `classes/`, `providers/`, `runtime/behavior.kdl`, `auth/`). `bun run gen:compat` -> `scripts/compile-compat.ts` -> `rules.json`. `bun run gen:models` -> `scripts/generate-models.ts`. Drift tests: `compat-compile.test.ts`, `compat-parity.test.ts`.

Model resolution path:

1. `classifyModel` (`compat/taxonomy.ts:443`): memoized identity (class, family, revision, effort).
2. `resolveModelPolicy` (`compat/resolve.ts:1244`): `resolveCascade` (`compat/cascade.ts:331`) picks per-axis winners; dispatches per `spec.api` to build compat; returns identity, compat, thinking, catalog.
3. `buildModel` (`build.ts:291`): materializes a full `Model`.
4. Bundled read path: `models.ts` (`getBundledModel`). Runtime discovery: `createModelManager` (`model-manager.ts:109`) configured by `provider-models/descriptors.ts`.

## 3. LLM client and agent runtime (`ai`, `agent`)

`ai`:

- `src/stream.ts`: `streamSimple` (:1491) is the entry the agent calls; `switch (model.api)` (~:2078) dispatches to `src/providers/*` (one file per wire protocol).
- `providers/transform-messages.ts:588`: per-model history normalization; providers call it themselves.
- Auth: `auth-storage.ts`, `auth/sqlite-credential-store.ts`, `auth-broker/`, `auth-gateway/`, `registry/oauth/`.
- `dialect/`: tool calling for models without native tool calls.

`agent`:

- `src/agent.ts`: `Agent.prompt()` (:1286) -> `#runLoop` (:1442) -> `agentLoop`.
- `src/agent-loop.ts`: `agentLoop` (:592), `runLoop` (:1028), `runLoopBody` (:1119), `streamAssistantResponse` (:1764), `executeToolCalls` (:2829).
- Also: speculative execution, append-only context, compaction, pause gate, telemetry.

Agent turn: `Agent.prompt` -> `agentLoop` -> `runLoopBody` -> `streamAssistantResponse` -> `streamSimple` -> provider -> `executeToolCalls` -> tool results -> next turn; ends with `agent_end` when no tool calls and no queued steering or follow-ups. The layer is fed by coding-agent through injected hooks: `convertToLlm`, `transformContext`, `getSteeringMessages`, `getFollowUpMessages`, `streamFn`.

## 4. TUI (`tui`) and leaf apps

- `tui.ts`: `Component`, `Container`, `class TUI`. `terminal.ts`: `ProcessTerminal`, alt-screen, restore. `stdin-buffer.ts`: key and paste splitting.
- Render: `requestRender` (`tui.ts:2173`) -> `#executeRender` (:2295) -> `#doRender`; paints wrapped in synchronized output (DEC 2026).
- Input: `ProcessTerminal` -> `StdinBuffer` -> `TUI.#handleInput` (:2319) -> focused component `handleInput`.
- `PI_TUI_ALT_SCREEN`: `hostAltScreenRequested()` (`tui.ts:119`); scrollback pager `overlays/scrollback-pager.ts`; wired by `coding-agent/modes/controllers/scrollback-controller.ts` (gated on `isHostAltScreen()` and the `tui.scrollback` setting); in-place inline scrollback in `prompt/composer.ts`.
- Component dirs: `components/`, `prompt/`, `chat/`, `chrome/`, `status-line/`, `overlays/`, `tools/` (per-tool renderers), `apps/`, `theme/`.
- `stats`: local dashboard (`Bun.serve`, React client, port 3847); invoked from `cli-commands.ts`.
- `collab-web`: browser client for `/collab` sessions (depends on `pi-wire`).
- `browser-relay`: Chrome MV3 extension only; the relay server is `coding-agent/tools/browser/relay/`.

## 5. Coding-agent core

Boot path:

1. `cli.ts` -> `runCli` (:465) -> `cli-commands.ts` (lazy subcommand registry) -> `commands/launch.ts` -> `main.ts:runRootCommand` (:1635).
2. `runRootCommand`: `Settings.init`, theme, scoped models, `createSessionManager`, `buildSessionOptions`, then `createAgentSession` (`sdk.ts:1330`).
3. `sdk.ts` does the real assembly: discovery (extensions, skills, rules, MCP), tools, `buildSystemPrompt`, `new AgentSession` (:3840).
4. `main.ts` dispatches by mode: `runAcpMode`, `runRpcMode`, `runInteractiveMode` (:570), `runPrintMode`.

Other core pieces:

- Config: `config/settings.ts` (`Settings`, layered global/project/CLI), `settings-schema.ts`.
- Capability and discovery: `capability/index.ts` (`defineCapability`, `loadCapability`), `discovery/` providers (claude, codex, cursor, gemini, opencode, and others) that self-register.
- Sessions: `session/session-manager.ts` (append-only JSONL, pluggable storage), `session/agent-session.ts` (runtime wrapper: queues, compaction, retry, todos, streaming events), `registry/agent-registry.ts`.
- System prompt: `system-prompt.ts:buildSystemPrompt` (:732); templates in `prompts/system/`; `SYSTEM.md` / `APPEND_SYSTEM.md` / `PERSONALITY.md` overrides; rebuilt by `sdk.ts:rebuildSystemPrompt` (:3162).
- Not read closely: `launch/` (broker/daemon IPC).

## 6. Modes and UI

- Mode selection: `main.ts:1682` (`text|json|rpc|rpc-ui|acp`); piped stdin without `--mode` triggers auto-print.
- Print/JSON: `modes/print-mode.ts`. RPC: `modes/rpc/` (`rpc-mode.ts`, `rpc-types.ts` `RpcCommand` union, chunked frames; stdout is the protocol channel so notifications are off). ACP: `modes/acp/`. LSP/DAP framing: `jsonrpc/message-framing.ts`.
- Interactive event flow: `session.subscribe` -> `EventController` (`modes/controllers/event-controller.ts:592`) -> `#handlers` table. `message_update` events are coalesced; other events run serialized. Each handler requests its own render.
- Assistant text pacing: `streaming-reveal.ts`. Tool arg previews: `tool-args-reveal.ts` (`ToolArgsRevealController`, `decodeStreamedToolArgs`); live and rebuilt-transcript paths must both be updated.
- `plan-mode/`, `collab/` (host-authoritative hub, AES-256-GCM sealed frames), `live/` (voice).

## 7. Tools and execution

- Registry: `tools/index.ts` (`BUILTIN_TOOLS` :504, `HIDDEN_TOOLS` :535, `createTools` :546). Tools implement `AgentTool` (`execute(toolCallId, params, signal, onUpdate, ctx)`); rendering lives in `pi-tui/tools/<name>`.
- Edit: `edit/index.ts` `EditTool` (:341) with modes replace/patch/apply_patch/hashline/sloppy; streaming `EditSession`; write goes through `lsp/writethrough.ts` (format, diagnostics), then auto-repair on parse regression.
- Subagents: `TaskTool.execute` (`task/index.ts:671`) -> optional async via `AsyncJobManager` -> optional worktree isolation (`task/isolation-runner.ts:367`) -> `runSubprocess` (`task/executor.ts:3261`) -> `createAgentSession` (in-process). Subagents finish via the `yield` tool.
- bash: `tools/bash.ts` -> `exec/bash-executor.ts:463` (direnv, minimizer, auto-background). eval: JS/Python backends via `eval/backend.ts`. Also `lsp/`, `dap/`, `ssh/`, `web/`, `internal-urls/router.ts` (schemes: agent, artifact, memory, skill, mcp, and others).

## 8. Extensibility and intelligence

- Wiring hub is `sdk.ts` (secrets :1509, MCP :2058, extensions :2223, memory :3209, speculation :3651, autolearn :4343).
- `extensibility/`: `ExtensionRunner` (`extensions/runner.ts:442`), hooks, custom tools/commands, plugins and marketplace, legacy pi shims. `mcp/`: `MCPManager` (`manager.ts:234`), `tool-bridge.ts`, OAuth.
- Memory: `memory-backend/resolve.ts:20` picks one backend from `memory.backend`: `hindsight`, `mnemopi` (`packages/mnemopi`), `sharpshooter`, `local` (`memories/`), or off.
- Background intelligence: `autolearn/`, `autoresearch/`, `advisor/`, `judgment/`, `goals/`, `speculation/host.ts`. Safety: `secrets/` (placeholder swap), `security/` (scan pipeline).
- Packages: `snapcompact` (history rendered to PNG frames for vision models), `metaharness` (benchmark manager), `typescript-edit-benchmark`. Python: `omp-rpc` (client for `omp --mode rpc`), `robomp` (GitHub triage bot).

## Cross-layer key paths

1. **Tool call, end to end**: provider streams a tool call -> `EventController` builds a preview via `ToolArgsRevealController` -> `executeToolCalls` -> tool class in `tools/` -> native code -> result back into the loop -> render via `pi-tui/tools/*`.
2. **Edit**: `EditTool` -> `EditSession` (streaming) -> `pi-edit` (napi) -> write -> LSP writethrough -> auto-repair.
3. **Subagent**: `TaskTool` -> `runSubprocess` -> `createAgentSession` -> its own `agentLoop` -> `yield`.
4. **Model policy**: KDL rules -> `rules.json` -> `classifyModel` -> `resolveModelPolicy` -> `buildModel` -> `streamSimple` dispatch.
5. **Boot**: `cli.ts` -> `main.ts` -> `sdk.ts:createAgentSession` -> mode runner.

## Large files (read these with care)

`sdk.ts` (~4.5k lines, mostly one function), `task/executor.ts` (~4.3k), `modes/interactive-mode.ts` (~6.9k), `agent/agent-loop.ts` (~3.5k), `tui/tui.ts` (~3.8k).
