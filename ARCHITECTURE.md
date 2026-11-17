# Background Agent Architecture Review

This review is the output of Trello card **01 · Repository Setup & Architecture Review** (Sprint 1, CS6510 Technical Credit Background Agent). It records how to build and launch the existing extension, where the Sprint 1 Background Agent attaches to it, which constraints apply, and a proposed module layout for cards 02–10.

Sprint 1 scope is a mock detector only, with **no live Claude calls**.

## Overview

Today the extension is **manual and construct-level**. A developer puts the cursor in a Java class, interface, method or field and runs **Analyse for TC**. The extension then makes 8 live Claude calls (one per heuristic), plus one ADR-matching call per candidate, and inserts preview annotations to accept or dismiss.

The Sprint 1 Background Agent adds an **automatic, per-file** path. It watches Java file activity, coalesces, debounces, cools down and deduplicates the triggers, checks a SHA-256 result cache that survives restarts, and only then calls a detector. In Sprint 1 that detector is a deterministic mock.

This document covers how to build and launch the extension, the commands, where the agent attaches to the five existing areas, the constraints it must follow, a proposed `src/background/` layout and contracts, a card-by-card mapping, and the known issues found during the review.

## Build & launch

### Prerequisites

| Tool    | Required                                      | Verified on card 01 |
| ------- | --------------------------------------------- | ------------------- |
| Node.js | **20.19+**, 22.13+ or 24+ (ESLint 10's range) | 20.14.0 (see below) |
| npm     | 10+                                           | 10.7.0              |
| VS Code | 1.120+ (`engines.vscode`)                     | 1.145.2             |

The README says Node 18+, but ESLint 10 requires `^20.19.0 || ^22.13.0 || >=24`. On Node 20.14, `npm install` prints `EBADENGINE` warnings, yet lint still runs correctly. Use Node 20.19 or newer to avoid the warnings.

No `.env` or API key is needed to build or launch. The `Anthropic` client in `src/utils/claude.ts` is created at import time, and constructing it without a key does not throw (checked against `@anthropic-ai/sdk` 0.127.0). A missing key only surfaces when **Analyse for TC** actually makes a call.

### Steps

From the repository root, the same on Windows, macOS and Linux:

1. `npm install`
2. `npm run compile`
3. Open the folder in VS Code and press **F5** ("Run Extension").

### What happens

- **`npm run compile`** runs `tsc --noEmit`, then `eslint src --max-warnings=0`, then `node esbuild.js`. esbuild bundles `src/extension.ts` into `dist/extension.js` (CommonJS, `vscode` external, `@/` alias resolved) and copies `web-tree-sitter.wasm` and `tree-sitter-java.wasm` into `dist/`.
- **F5** runs the `.vscode/launch.json` "Run Extension" configuration. Its `preLaunchTask` is the default build task `watch`, which runs `watch:tsc` and `watch:esbuild` in parallel, and then it opens an Extension Development Host with `--extensionDevelopmentPath` set to the repository.
- **Activation**: `activationEvents` is `"*"`, so the extension activates at startup, not when the first command runs. The Background Agent therefore starts with the window.
- **Java parser**: `setExtensionPath()` loads the tree-sitter WASM from `<extension>/dist`. If nothing has been built, analysis fails at call time, not at activation.

### Verification on card 01

- `npm run compile` exits 0 and produces `dist/extension.js`, `dist/extension.js.map` and both `.wasm` files.
- `npm run tsc:check` and `npm run lint:check` exit 0.
- `npm run format:check` passes on CI (Linux). On Windows with `core.autocrlf=true`, every file is checked out with CRLF line endings and Prettier (`endOfLine: lf` by default) flags all of them. This is a line-ending artefact, not a formatting problem: `npx prettier --check . --end-of-line auto` passes. To make the local check match CI, use `git config core.autocrlf input`.
- F5 launch without `.env`: see [Known issues & follow-ups](#known-issues--follow-ups) for the manual check result.

## Command reference

Run every command from the repository root. **Billed** commands make live Claude calls, cost money, and need `ANTHROPIC_API_KEY` in `.env`. Run them only when asked (C3).

| command                | purpose                                                                                            | when                                                      | cost       |
| ---------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------- |
| `npm install`          | Install dependencies from `package-lock.json`                                                      | First setup, or after the lockfile changes                | free       |
| `npm run compile`      | Type-check, lint (zero warnings), then bundle to `dist/`                                           | Before a manual launch or a PR                            | free       |
| `npm run watch`        | `watch:tsc` and `watch:esbuild` in parallel                                                        | While developing; F5 starts it automatically              | free       |
| F5 "Run Extension"     | Run the `watch` task and open an Extension Development Host                                        | To try the extension by hand                              | free¹      |
| `npm run tsc:check`    | Type-check only (`tsc --noEmit`)                                                                   | Any time; CI job `tsc-check`                              | free       |
| `npm run lint:check`   | `eslint src --max-warnings=0`                                                                      | Any time; CI job `lint-check`                             | free       |
| `npm run lint:fix`     | Auto-fix lint issues                                                                               | When `lint:check` fails on fixable rules                  | free       |
| `npm run format`       | `prettier --write .`                                                                               | Before pushing (see the Windows line-ending note above)   | free       |
| `npm run format:check` | `prettier --check .`                                                                               | Any time; CI job `format-check`                           | free       |
| `npx jest <path>`      | Run only the Jest tests under `<path>`, e.g. `npx jest src/test/background`                        | Offline unit tests for the Background Agent               | free²      |
| `npm test`             | Run **every** `src/**/*.test.ts`, including the live heuristic tests; `dotenv/config` loads `.env` | Only when explicitly asked                                | **billed** |
| `npm run package`      | Production build (minified, no sourcemaps)                                                         | Release builds                                            | free       |
| `npm run opro`         | Bundle and run `scripts/opro.ts`, which regenerates the heuristic prompts using Claude             | Only when explicitly asked; it rewrites the tuned prompts | **billed** |

¹ Launching is free. Clicking **Analyse for TC** in the host makes 8 or more live calls, which are billed.
² Free only when `<path>` holds offline tests alone. `src/test/creational/prototype/*.test.ts` are live tests, so never point `npx jest` at `src/test` as a whole.

CI runs three checks on every PR, and all must pass: `tsc-check`, `lint-check` and `format-check`.

## Integration points

The five areas named on card 01, as they stand on `tc-bg-task01-repo-setup`. "Attachment" says how the Background Agent connects to each one. Constraint ids refer to [Constraints](#constraints).

### Activation entry point

- **Location**: `src/extension.ts`
- **Owns**: `activate()` calls `setExtensionPath(context.extensionPath)`, which starts loading the Java parser's WASM from `dist/`, and then `register(context)`. `deactivate()` is empty, because everything is disposed through `context.subscriptions`.
- **Attachment**: none. All wiring belongs in the command registry, so this file stays two lines of logic.
- **Constraints**: C1
- **Serves cards**: none, since nothing attaches here.

### Command registry

- **Location**: `src/registry.ts`
- **Owns**: creates the single `PendingAnnotation` controller, registers it as a CodeLens provider for `file:` documents, and registers the `technicalcredit.analyseForTC`, `technicalcredit.acceptTCComment` and `technicalcredit.dismissTCComment` commands. Every disposable goes into `context.subscriptions`.
- **Attachment**: add one call, `startBackgroundAgent(context)`, from `src/background/backgroundAgent.ts`. That function registers its own listeners, timers and storage adapter as disposables, so deactivation cleans them up the same way as the existing commands. The existing registrations are left as they are.
- **Constraints**: C1, C7
- **Serves cards**: 02, 04, 10

### Analysis flow

- **Location**: `src/analyse.ts`
- **Owns**: the manual **Analyse for TC** command, `analyseForTC(controller)`:
  1. reads `window.activeTextEditor`, then `buildContext(editor)`;
  2. `findAdrs(workspaceRoot)`, then `createUserPrompt(context)`;
  3. inside `withProgress`, makes one `callClaude` per entry in `HEURISTIC_CATEGORIES` in parallel (8 live calls);
  4. for each candidate, when ADRs exist, makes one more ADR-matching `callClaude`;
  5. `formatTCComment`, then `controller.previewAll(...)`.

  Errors surface as VS Code notifications.

- **Attachment**: none in Sprint 1. The background path must **not** call `analyseForTC`. It mixes UI (active editor, progress, notifications, preview) with the pipeline, and it makes live calls. The manual command bypasses the background cache and scheduler, and keeps its current behaviour. A future live detector would reuse the pipeline pieces (`buildContextFromSource`, `createUserPrompt`, the heuristic prompts, and `TCResult`), not this function.
- **Constraints**: C2, C5, C6, C7
- **Serves cards**: 10 (splitting manual and background responsibilities)

### Context building

- **Location**: `src/context/buildContext.ts`
- **Owns**:
  - `buildContextFromSource(source, anchorLine, anchorCol, languageId, fileName)` is pure and vscode-free. It extracts imports and the package line, gets Java construct metrics from the tree-sitter parser, and resolves the insert line and indent. It returns `TcContext`, or `null` when the anchor is not inside a supported construct or the language isn't Java.
  - `buildContext(editor)` is a thin VS Code wrapper that supplies the cursor anchor.
- **Attachment**: the future live detector reuses `buildContextFromSource` unchanged. The pipeline is **construct-level** (it needs an anchor line and column), while the Background Agent works **per file**, so a live detector has to decide which constructs in a file to analyse. That open item belongs to card 10. The Sprint 1 mock detector doesn't need this module.
- **Constraints**: C1
- **Serves cards**: 03, 10

### Pending-annotation display

- **Location**: `src/comment/pendingAnnotation.ts`
- **Owns**: `PendingAnnotation` (a CodeLens provider and disposable).
  - `previewAll(editor, texts, insertLine)` first calls `dismissAll()` across **all** files, then inserts real comment text above `insertLine` in the given visible editor and dims it with a decoration.
  - The Accept and Dismiss CodeLenses then keep or delete that text and shift the ranges of the items below.
- **Attachment**: none in Sprint 1. It is unsuitable for unsolicited background results:
  - it edits the document the user may be typing in;
  - it wipes every other pending preview;
  - it needs a visible editor;
  - its own insertions fire `onDidChangeTextDocument`, which would retrigger the agent.

  Card 10 outlines result delivery through the labeling UI before any live integration.

- **Constraints**: C1, C6
- **Serves cards**: 10

## Constraints

Every rule below applies to all Background Agent work. The integration points and proposed modules refer to these ids.

| id  | statement                                                                                                                                                                                                    | source         | affects                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------- |
| C1  | Core logic (context building, detection, scheduling, caching) must be importable without `vscode`. Only adapters and the composition root may import it. Check: Jest (node environment) can load the module. | `CLAUDE.md`    | All integration points; all proposed modules                    |
| C2  | `src/prompts/heuristics/` is tuned by OPRO and must not be hand-edited. Propose prompt changes and wait for agreement.                                                                                       | `CLAUDE.md`    | Analysis flow                                                   |
| C3  | `npm test` includes live heuristic tests that call Claude and are billed. Run it only when explicitly asked, and run offline tests by path instead.                                                          | `CLAUDE.md`    | Command reference; `test/background/*`                          |
| C4  | Lint tolerates zero warnings (`eslint src --max-warnings=0`), and `eslint-disable` comments are not allowed. Fix the code instead.                                                                           | `CLAUDE.md`    | All proposed modules                                            |
| C5  | Never commit `.env`, and never print `ANTHROPIC_API_KEY` to output or logs.                                                                                                                                  | `CLAUDE.md`    | Analysis flow; `utils/claude.ts`                                |
| C6  | Sprint 1 makes no live Claude calls. Detection uses the mock detector only.                                                                                                                                  | `sprint-scope` | Analysis flow; Pending-annotation display; all proposed modules |
| C7  | Background modules must never import `@/utils/claude` or `@anthropic-ai/sdk`. Check: `grep -rn "utils/claude\|anthropic-ai" src/background` returns nothing.                                                 | `code`         | Command registry; all proposed modules                          |
| C8  | Do not add any npm dependency without asking the team first. Hashing uses Node's built-in `crypto`, and the fake clock is hand-written.                                                                      | `CLAUDE.md`    | Cache and scheduler modules                                     |

## Proposed modules

**This is a proposal: card 01 creates none of these files.** All new Background Agent code goes under `src/background/`, split by responsibility. Paths are relative to `src/`.

| path                                    | responsibility                                                                                                                | cards          | dependsOn                                                            | vscodeFree            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- | --------------------- |
| `background/detector/detector.ts`       | The detector contract: input, output, error types and the `Detector` interface                                                | 10             | `comment/tcResult.ts`                                                | yes                   |
| `background/detector/mockDetector.ts`   | Deterministic async mock with configurable delay and an inspectable call counter                                              | 03             | `detector/detector.ts`, `scheduler/clock.ts`                         | yes                   |
| `background/events/fileEventMonitor.ts` | Turns VS Code open, active-editor and change events for supported Java files into `FileSnapshot`s                             | 02             | `vscode`, scheduler's `SnapshotSink`                                 | no (adapter)          |
| `background/scheduler/scheduler.ts`     | Per-file state: pending snapshot, coalescing, debounce, cooldown, in-flight dedup, cache check, detector call                 | 05, 06, 07, 08 | `detector/detector.ts`, `cache/resultCache.ts`, `scheduler/clock.ts` | yes                   |
| `background/scheduler/clock.ts`         | `Clock` interface (`now`, `setTimeout`, `clearTimeout`), plus real and fake implementations                                   | 06, 07, 09     | none                                                                 | yes                   |
| `background/cache/resultCache.ts`       | SHA-256 content hashing and cache identity (workspace + file URI + content hash + detector version) over a `CacheStore`       | 04             | `detector/detector.ts`, Node `crypto`                                | yes                   |
| `background/cache/vscodeCacheStore.ts`  | `CacheStore` backed by VS Code extension storage, so results survive Extension Host restarts                                  | 04             | `vscode`, `cache/resultCache.ts`                                     | no (adapter)          |
| `background/backgroundAgent.ts`         | Composition root: `startBackgroundAgent(context)` wires the monitor, scheduler, cache and detector, and registers disposables | 02–08, 10      | everything above                                                     | no (composition root) |
| `test/background/*.test.ts`             | Offline unit tests with a fake clock and an in-memory `CacheStore`; never imports `@/utils/claude`                            | 09             | the vscode-free modules above                                        | yes                   |

Design notes:

- **The scheduler owns all per-file state.** Card 07 defines the earliest start as `max(lastChange + debounce, lastCompletion + cooldown)`, which needs debounce, cooldown, coalescing and in-flight state together. Separate wrappers would each repeat the same bookkeeping.
- **Time is injected.** The scheduler and mock detector read time only through `Clock`, so card 09's fake-clock tests and the scripted 0 → 1 → 2 → 2 demo are deterministic without patching globals.
- **No new dependencies.** Hashing uses `crypto.createHash('sha256')`, and storage goes through a small `CacheStore` interface, so tests use an in-memory store (C8).
- **The dependency direction is one way**: adapters → core. Only the three "no" rows import `vscode` (C1), and nothing under `background/` imports `@/utils/claude` (C7).

## Proposed contracts

These are proposals from this review. **Card 10 finalises the detector contract, and cards 02 and 05 finalise the event hand-off.**

### Detector (card 10)

The scheduler talks to a detector only through this interface, so the Sprint 1 mock can be replaced by a live detector without redesigning the scheduler.

```ts
import type { TCResult } from '@/comment/tcResult';

/** One immutable snapshot of a supported file, as captured by the event monitor. */
export interface DetectorInput {
  workspaceId: string; // stable id of the workspace folder
  fileUri: string; // document URI as a string
  languageId: 'java';
  version: number; // editor document version at capture time
  contentHash: string; // SHA-256 hex of `content`
  content: string;
}

/** A single finding located in the file. */
export interface DetectorFinding {
  result: TCResult; // reuse the existing finding shape
  line: number; // 0-based insertion/anchor line
}

export interface DetectorOutput {
  detectorId: string; // e.g. "mock", later "claude"
  detectorVersion: string; // part of the cache identity (card 04)
  findings: DetectorFinding[]; // empty array is a valid, cacheable result
}

export type DetectorError =
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export interface Detector {
  readonly id: string;
  readonly version: string;
  /** Must not block the editor; must honour `signal`. Rejects with DetectorError. */
  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorOutput>;
}
```

Rules:

1. **Asynchronous and non-blocking.** `analyse` resolves on a later tick, and editing continues while it runs (card 03).
2. **No side effects on documents.** A detector never edits text; delivery happens elsewhere.
3. **Failures are not cached.** Only a resolved `DetectorOutput` is cacheable (card 04).
4. **Versioned.** Changing `detectorVersion` invalidates cached results (card 04).
5. **Cancellable.** When the signal is aborted, `analyse` rejects with `{ kind: 'cancelled' }`. The scheduler aborts a request when its file is closed or its result would be superseded and discarded.

The mock detector (card 03) must have a configurable delay, an inspectable call counter, and deterministic findings for a given `contentHash`. It must never import `@/utils/claude` or `@anthropic-ai/sdk`.

### File events → scheduler (cards 02 and 05)

The event monitor is the only background module that touches VS Code document events. It turns them into plain snapshots for the vscode-free scheduler.

| VS Code event                        | Emits a snapshot when                                       |
| ------------------------------------ | ----------------------------------------------------------- |
| `workspace.onDidOpenTextDocument`    | the document is supported                                   |
| `window.onDidChangeActiveTextEditor` | the newly active document is supported                      |
| `workspace.onDidChangeTextDocument`  | the document is supported and `contentChanges` is non-empty |
| Already-open documents at activation | each supported document, once                               |

**Supported** means `languageId === 'java'` and `uri.scheme === 'file'`. Everything else (`untitled`, `git`, output channels, non-Java files) is ignored without an error.

```ts
export type TriggerKind = 'open' | 'activate' | 'edit' | 'startup';

export interface FileSnapshot {
  workspaceId: string;
  fileUri: string;
  languageId: 'java';
  version: number;
  content: string;
  trigger: TriggerKind;
  observedAt: number; // from the injected Clock, not Date.now()
}

export interface SnapshotSink {
  submit(snapshot: FileSnapshot): void; // synchronous, never throws, never calls a detector
}
```

Rules:

1. `submit` only records state. Hashing, coalescing, debounce, cooldown and dedup all happen in the scheduler.
2. Two snapshots with the same `fileUri` and `version` count as duplicates and are coalesced into one pending entry (card 05).
3. All listeners are registered through `context.subscriptions`, via `registry.ts`.
4. Text inserted by the manual **Analyse for TC** preview also fires `onDidChangeTextDocument`. It is treated as a normal edit and absorbed by the debounce, so no special case is needed in Sprint 1.

## Card mapping

Every Sprint 1 card from 02 to 10 maps to at least one integration point and at least one proposed module.

| Card                                  | Integration points                                                    | Proposed modules                                    |
| ------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| 02 · Java File Event Monitoring       | Command registry (listeners registered as disposables)                | `events/fileEventMonitor.ts`, `backgroundAgent.ts`  |
| 03 · Asynchronous Mock Detector       | Context building (shape it must stay compatible with)                 | `detector/mockDetector.ts`                          |
| 04 · SHA-256 Persistent Result Cache  | Command registry (extension storage from `context`)                   | `cache/resultCache.ts`, `cache/vscodeCacheStore.ts` |
| 05 · Event Coalescing                 | Command registry (via the composition root)                           | `scheduler/scheduler.ts`                            |
| 06 · Per-file Debounce                | Command registry (timers disposed on deactivation)                    | `scheduler/scheduler.ts`, `scheduler/clock.ts`      |
| 07 · Per-file Cooldown                | Command registry (timers disposed on deactivation)                    | `scheduler/scheduler.ts`, `scheduler/clock.ts`      |
| 08 · In-flight Deduplication          | Command registry (via the composition root)                           | `scheduler/scheduler.ts`                            |
| 09 · Auto Save / Restart Tests & Demo | Command registry (agent is re-created on each Extension Host restart) | `test/background/*.test.ts`, `scheduler/clock.ts`   |
| 10 · Shared Detector Interface        | Analysis flow; Context building; Pending-annotation display           | `detector/detector.ts`, `backgroundAgent.ts`        |

## Known issues & follow-ups

Found during the card 01 review. Only item 1 was fixed on this card; the rest are recorded for follow-up tickets.

| #   | Issue                                                                                                                                                                                  | Status / proposed follow-up                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `compile` and `package` called `npm run lint`, which doesn't exist (the script is `lint:check`), so `npm run compile` failed after the type check.                                     | **Fixed on this card**: both now call `lint:check`.                                                                        |
| 2   | F5 launch without `.env`.                                                                                                                                                              | **Pending**: the manual check (task T007) result goes here.                                                                |
| 3   | The only offline test, `src/test/buildContextCore.test.ts`, reads `src/test/mockCode/MockTest.java`, which isn't tracked in git, so it fails.                                          | Not fixed. Restore the fixture or point the test at an existing one.                                                       |
| 4   | The README Testing section refers to `src/test/mockCode/` and `priorityHeuristicTests/h1…h5`, neither of which exists. The live tests now live under `src/test/creational/prototype/`. | Not fixed. Update the README.                                                                                              |
| 5   | There is no way to run only offline tests: `npm test` runs everything, including billed live tests.                                                                                    | Not fixed. Propose a `test:offline` script (e.g. `jest src/test/background`) and/or move live tests behind an opt-in flag. |
| 6   | The README says Node 18+, but ESLint 10 needs Node `^20.19.0 \|\| ^22.13.0 \|\| >=24`.                                                                                                 | Not fixed. Update the README prerequisites.                                                                                |
| 7   | `@types/vscode` is `^1.138.0` while `engines.vscode` is `^1.120.0`. F5 works, but `vsce package` refuses a types version newer than the engine.                                        | Not fixed. Align the two before packaging.                                                                                 |
| 8   | `package.json` depends on `anthropic-ai@0.0.10`, an unofficial package from a different publisher than the official `@anthropic-ai/sdk`. Nothing in `src/` or `scripts/` imports it.   | Not fixed. Propose removing it; it is a needless supply-chain exposure (C8: ask the team first).                           |
| 9   | `npm install` reports 31 vulnerabilities (27 moderate, 2 high, 2 critical).                                                                                                            | Not fixed. Review `npm audit` output; Dependabot PRs cover part of this.                                                   |
| 10  | `package-lock.json` was written by a newer npm. Running `npm install` with npm 10.7 strips its `libc` fields, which shows up as a spurious diff.                                       | Don't commit that drift (`git checkout -- package-lock.json`). Using a current npm avoids it.                              |
| 11  | On Windows with `core.autocrlf=true`, `npm run format:check` flags every file (CRLF vs. Prettier's LF), and `npm run format` would rewrite every file.                                 | Not fixed. Use `git config core.autocrlf input` locally, or add a `.gitattributes` with `* text=auto eol=lf`.              |
| 12  | The README clone URL points at `cielbellerose/TechnicalCredit`, while this checkout's `origin` is the fork `XiaoyuZhou000/TechnicalCredit`.                                            | Not fixed. Confirm which repository the team treats as canonical.                                                          |
| 13  | `resolveInsertLine` in `src/context/buildContext.ts` uses a non-null assertion (`enclosingClassStartRow!`), which goes against the repository's no-`!` convention.                     | Not fixed. Model the type so the assertion isn't needed.                                                                   |
| 14  | Live detection is construct-level (it needs a cursor anchor), but the agent is per-file.                                                                                               | Card 10: decide how a live detector picks constructs in a file.                                                            |
| 15  | Before showing a background result, check it still matches the document's current `contentHash` (US-09).                                                                               | Card 10 follow-up, before any live integration.                                                                            |
| 16  | `PendingAnnotation` can't show unsolicited background results (see [Pending-annotation display](#pending-annotation-display)).                                                         | Card 10: outline delivery through the labeling UI.                                                                         |
