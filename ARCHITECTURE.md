# Background Agent Architecture Review

This review is the output of Trello card **01 · Repository Setup & Architecture Review** (Sprint 1, CS6510 Technical Credit Background Agent). It records how to build and launch the existing extension, where the Sprint 1 Background Agent attaches to it, which constraints apply, and a proposed module layout for cards 02–10.

Sprint 1 scope is a mock detector only, with **no live Claude calls**.

## Overview

Today the extension is **manual and construct-level**. A developer puts the cursor in a Java class, interface, method or field and runs **Analyse for TC**. The extension then makes 8 live Claude calls (one per heuristic), plus one ADR-matching call per candidate, and inserts preview annotations to accept or dismiss.

The Sprint 1 Background Agent adds an **automatic, per-file** path. It watches Java file activity, coalesces, debounces, cools down and deduplicates the triggers, checks a SHA-256 result cache that survives restarts, and only then calls a detector. In Sprint 1 that detector is a deterministic mock.

This document covers how to build and launch the extension, the commands, where the agent attaches to the five existing areas, the constraints it must follow, a proposed `src/background/` layout and contracts, a card-by-card mapping, and the known issues found during the review.

## Build & launch

### Prerequisites

| Tool              | Required                                                             | Verified on card 01      |
| ----------------- | -------------------------------------------------------------------- | ------------------------ |
| Node.js           | **20.19+**, 22.13+ or 24+ (ESLint 10's range)                        | 20.14.0 (see below)      |
| npm               | 10+                                                                  | 10.7.0                   |
| VS Code           | 1.120+ (`engines.vscode`)                                            | 1.145.2                  |
| VS Code extension | **esbuild Problem Matchers** (`connor4312.esbuild-problem-matchers`) | installed during card 01 |

**F5 needs the esbuild Problem Matchers extension.** `.vscode/tasks.json` uses `"problemMatcher": "$esbuild-watch"`, which that extension provides. It's listed in `.vscode/extensions.json` but isn't installed automatically. Without it, F5 fails with `Invalid problemMatcher reference: $esbuild-watch`. Install it with `code --install-extension connor4312.esbuild-problem-matchers`.

If F5 then seems to do nothing, a `watch` task from the failed attempt is probably still running: VS Code waits on it forever, and the task is set to `"reveal": "never"` so nothing shows. Run **Tasks: Terminate Task → All Running Tasks**, then **Developer: Reload Window**, then press F5 again.

The README says Node 18+, but ESLint 10 requires `^20.19.0 || ^22.13.0 || >=24`. On Node 20.14, `npm install` prints `EBADENGINE` warnings, yet lint still runs correctly. Use Node 20.19 or newer to avoid the warnings.

No `.env` or API key is needed to build or launch. The `Anthropic` client in `src/utils/claude.ts` is created at import time, and constructing it without a key does not throw (checked against `@anthropic-ai/sdk` 0.127.0). A missing key only surfaces when **Analyse for TC** actually makes a call. It then shows `Analyse for TC failed: Error: Could not resolve authentication method…`.

That error is raised by the SDK's header validation, which runs while the request is being built and before `fetch`, so **no request leaves the machine and nothing is billed**. Verified on card 01 by running the command on `src/test/creational/prototype/Positive.java` with no `.env`. The message doesn't say how to fix it; a friendlier "set `ANTHROPIC_API_KEY` in `.env`" message would be a small follow-up.

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
- F5 launch without `.env` (after installing the problem-matcher extension and clearing the stale task): the Extension Development Host opens. The bundle loads, and the debug console shows dotenv's `injected env (0) from <repo>\.env` line, meaning no key was loaded. No activation error came from `technicalcredit`.

  The extension-host log confirms activation: `ExtensionService#_doActivateExtension undefined_publisher.technicalcredit, startup: true, activationEvent: '*'`. **Analyse for TC** is available in the host and runs as far as context building. On an empty Java file it stops with "cursor is not inside a class or interface" before any Claude call is made.

  Check the menu in the window titled **[Extension Development Host]**, not the debugging window, where the extension isn't loaded. Use a non-empty fixture such as `src/test/creational/prototype/Positive.java`.

  The remaining debug-console noise comes from other extensions, not this one: VS Code's built-in Copilot "Sign in to GitHub to use the Cloud Agent" rejections, and Node deprecation warnings for `url.parse`, `punycode` and `Buffer()`.

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
- **Attachment**: one call, `startBackgroundAgent(context)`, from `src/background/backgroundAgent.ts`, **added on card 02** as the last statement of `register`. That function registers its own listeners, timers and storage adapter as disposables, so deactivation cleans them up the same way as the existing commands. The existing registrations are left as they are.
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

## Manual vs background responsibilities

Agreed on card 10. The two paths share building blocks but not control flow.

| Concern                | Manual "Analyse for TC"                                          | Background Agent (Sprint 1)                                   |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| Trigger                | The user runs the command                                        | File open, active-editor change, edit (card 02)               |
| Unit of analysis       | One construct at the cursor                                      | One file snapshot (`DetectorInput`)                           |
| Detector               | The existing pipeline in `analyse.ts` (live Claude)              | Any `Detector`; in Sprint 1, the mock (card 03)               |
| Cache                  | None: always bypassed                                            | SHA-256 result cache (card 04)                                |
| Scheduling             | None: runs immediately                                           | Coalesce, debounce, cooldown, in-flight dedup (cards 05–08)   |
| Result display         | `PendingAnnotation` preview, which inserts text                  | None in Sprint 1: results go to the cache and inspection only |
| Live calls in Sprint 1 | Yes, on demand (unchanged)                                       | No                                                            |
| Shared pieces (future) | `buildContextFromSource`, the prompts, `TCResult`                | The same pieces, wrapped behind a live `Detector`             |
| Never shared           | `analyseForTC()`'s UI flow; `previewAll` for unsolicited results | —                                                             |

The manual command **bypasses the background cache and all scheduling**, so running it twice on an unchanged class makes the live calls twice. It is **not changed** in Sprint 1.

A future live detector reuses `buildContextFromSource`, the heuristic prompts and the `TCResult` shape. It must not reuse `analyseForTC()` itself (which mixes in active-editor reads, progress and notifications) or call `previewAll` for results the user didn't ask to see.

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

**This is a proposal. Card 01 created none of these files. Card 10 created `background/detector/detector.ts`; card 02 created `background/events/*` and `background/backgroundAgent.ts`; card 03 created `background/detector/mockDetector.ts` and the temporary `background/events/detectorRunSink.ts`. Each comes with offline tests.** All new Background Agent code goes under `src/background/`, split by responsibility. Paths are relative to `src/`.

| path                                    | responsibility                                                                                                                                                                                                   | cards          | dependsOn                                                            | vscodeFree            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- | --------------------- |
| `background/detector/detector.ts`       | **Created on card 10.** The detector contract: input, output, result/failure types, the `Detector` interface, `isCacheable`, `failureFromAbort`                                                                  | 10             | `comment/tcResult.ts`                                                | yes                   |
| `background/detector/mockDetector.ts`   | **Created on card 03.** Deterministic async mock with configurable delay and an inspectable call counter. Reads time through `MockTimers`, a subset of the planned `Clock`                                       | 03             | `detector/detector.ts`                                               | yes                   |
| `background/events/fileEvents.ts`       | **Created on card 02.** The file-event contract (`FileSnapshot`, `FileClosedNotice`, `SnapshotSink`), `isSupported`, and the `FileEventHandler` core                                                             | 02             | none                                                                 | yes                   |
| `background/events/fileEventMonitor.ts` | **Created on card 02.** Thin adapter: subscribes open, active-editor, change, save and close events, plus the startup scan, and calls the core                                                                   | 02             | `vscode`, `events/fileEvents.ts`                                     | no (adapter)          |
| `background/events/loggingSink.ts`      | **Created on card 02.** Placeholder `SnapshotSink` that logs one line per event (never file text); replaced by the scheduler on card 05                                                                          | 02 (temporary) | `events/fileEvents.ts`                                               | yes                   |
| `background/events/detectorRunSink.ts`  | **Created on card 03.** Temporary `SnapshotSink` that runs the detector for each notification, cancels that file's previous call and logs start/end lines; replaced by the scheduler on card 05                  | 03 (temporary) | `detector/detector.ts`, `events/fileEvents.ts`                       | yes                   |
| `background/scheduler/scheduler.ts`     | Per-file state: pending snapshot, coalescing, debounce, cooldown, in-flight dedup, cache check, detector call                                                                                                    | 05, 06, 07, 08 | `detector/detector.ts`, `cache/resultCache.ts`, `scheduler/clock.ts` | yes                   |
| `background/scheduler/clock.ts`         | `Clock` interface (`now`, `setTimeout`, `clearTimeout`), plus real and fake implementations                                                                                                                      | 06, 07, 09     | none                                                                 | yes                   |
| `background/cache/resultCache.ts`       | SHA-256 content hashing and cache identity (workspace + file URI + content hash + detector version) over a `CacheStore`                                                                                          | 04             | `detector/detector.ts`, Node `crypto`                                | yes                   |
| `background/cache/vscodeCacheStore.ts`  | `CacheStore` backed by VS Code extension storage, so results survive Extension Host restarts                                                                                                                     | 04             | `vscode`, `cache/resultCache.ts`                                     | no (adapter)          |
| `background/backgroundAgent.ts`         | **Created on card 02** (monitor, logging sink, mock detector and run sink so far). Composition root: `startBackgroundAgent(context)` wires the monitor, scheduler, cache and detector, and registers disposables | 02–08, 10      | everything above                                                     | no (composition root) |
| `test/background/*.test.ts`             | Offline unit tests with a fake clock and an in-memory `CacheStore`; never imports `@/utils/claude`                                                                                                               | 09             | the vscode-free modules above                                        | yes                   |

Design notes:

- **The scheduler owns all per-file state.** Card 07 defines the earliest start as `max(lastChange + debounce, lastCompletion + cooldown)`, which needs debounce, cooldown, coalescing and in-flight state together. Separate wrappers would each repeat the same bookkeeping.
- **Time is injected.** The scheduler and mock detector read time only through `Clock`, so card 09's fake-clock tests and the scripted 0 → 1 → 2 → 2 demo are deterministic without patching globals. Until card 06 creates `Clock`, the mock takes a `MockTimers` (`setTimeout`, `clearTimeout`); keep those signatures in `Clock` so one fake drives both.
- **No new dependencies.** Hashing uses `crypto.createHash('sha256')`, and storage goes through a small `CacheStore` interface, so tests use an in-memory store (C8).
- **The dependency direction is one way**: adapters → core. Only the three "no" rows import `vscode` (C1), and nothing under `background/` imports `@/utils/claude` (C7).

## Proposed contracts

The detector contract is agreed on card 10 (pending review). The file-event hand-off is agreed on card 02.

### Detector (card 10)

**Agreed on card 10, pending the scheduler author's review.** Source: `src/background/detector/detector.ts`, covered by the offline test `src/test/background/detectorContract.test.ts`.

The scheduler talks to a detector only through this interface, so the Sprint 1 mock can be replaced by a live detector without redesigning the scheduler.

```ts
import type { TCResult } from '@/comment/tcResult';

export interface DetectorInput {
  readonly workspaceId: string;
  readonly fileUri: string; // string, not vscode.Uri (C1)
  readonly languageId: 'java';
  readonly version: number; // editor document version at capture time
  readonly contentHash: string; // SHA-256 hex of `content`, computed by the caller
  readonly content: string;
}

export interface DetectorFinding {
  readonly line: number; // 0-based class/interface declaration line
  readonly result: TCResult; // existing shape; always is_tc_candidate: true
}

export interface DetectorOutput {
  readonly detectorId: string;
  readonly detectorVersion: string; // covers code and configuration
  readonly findings: readonly DetectorFinding[]; // empty = valid, cacheable success
}

export type DetectorFailure =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

export type DetectorResult =
  | { readonly ok: true; readonly output: DetectorOutput }
  | { readonly ok: false; readonly failure: DetectorFailure };

export interface Detector {
  readonly id: string;
  readonly version: string; // known before any call, so the cache can skip calls
  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult>;
}

export function isCacheable(result: DetectorResult): boolean; // result.ok
export function failureFromAbort(signal: AbortSignal): DetectorResult; // TimeoutError → 'timeout', else 'cancelled'
```

**Failures are returned, not rejected.** Promise rejections can't be typed, and a discriminated union forces every caller to handle the failure branch. It also makes the caching rule a single `ok` check, and keeps expected outcomes like cancellation out of exception handling. The card 01 draft rejected with a plain `{ kind }` object. That would fail the repo's `no-throw-literal` lint rule if written as `throw { kind: … }` in an `async` method, though not if written as `Promise.reject(…)`.

| #   | Rule                                                                                              | Who            |
| --- | ------------------------------------------------------------------------------------------------- | -------------- |
| 1   | `analyse` resolves on a later tick and never blocks editing                                       | Every detector |
| 2   | `analyse` never rejects; problems are returned as `ok: false`                                     | Every detector |
| 3   | Never edit a document, show UI, or touch `vscode`                                                 | Every detector |
| 4   | Honour `signal`: once it aborts, resolve promptly with `failureFromAbort(signal)`                 | Every detector |
| 5   | `output.detectorId`/`detectorVersion` equal `this.id`/`this.version`                              | Every detector |
| 6   | Findings are candidates only, with the existing `TCResult` shape and a 0-based declaration `line` | Every detector |
| 7   | Depend only on this module, never on a concrete detector                                          | Every caller   |
| 8   | Own the timeout policy (`AbortSignal.timeout`, combined with cancellation via `AbortSignal.any`)  | Every caller   |
| 9   | Cache only when `isCacheable(result)` is true; empty results are cacheable, failures never are    | Card 04        |
| 10  | Treat an unexpected rejection (a defect) as `{ kind: 'failed', message }`                         | Card 05        |
| 11  | Never import `@/utils/claude` or `@anthropic-ai/sdk` in Sprint 1                                  | Every detector |

**Mock detector (card 03)**, in `src/background/detector/mockDetector.ts`:

- `id` is `'mock'`, the default `version` is `'mock-1'`, and the default delay is 2 s. A delay of 0 still answers on a later tick, and cancellation answers at once.
- Under the default behaviour, findings depend only on the content: one sample finding per `class` or `interface` declaration line, or none.
- `callCount` counts every call on entry, including cancelled and failed ones. `calls()` returns the file, document version, content hash and outcome of each call, never the file text.
- `behaviour: { kind: 'findings' }` and `{ kind: 'fail' }` change the results, so they require a `version` other than `'mock-1'`. Card 04 relies on this: old results can't hit under a new version. The delay is never part of the version.

These are extras on the concrete class. The scheduler must still depend only on `Detector`.

### File events → scheduler (cards 02 and 05)

**Agreed (card 02).** Source: `src/background/events/fileEvents.ts`.

The event monitor is the only background module that touches VS Code document events. It turns them into plain notifications for the vscode-free scheduler. **The monitor reports; the scheduler decides.**

| VS Code event                        | Forwards                     | When                                                        |
| ------------------------------------ | ---------------------------- | ----------------------------------------------------------- |
| Already-open documents at activation | `'startup'` snapshot         | each supported document, once                               |
| `workspace.onDidOpenTextDocument`    | `'open'` snapshot            | the document is supported                                   |
| `window.onDidChangeActiveTextEditor` | `'activate'` snapshot        | the newly active document is supported                      |
| `workspace.onDidChangeTextDocument`  | `'edit'` snapshot            | the document is supported and `contentChanges` is non-empty |
| `workspace.onDidSaveTextDocument`    | `'save'` snapshot            | the document is supported (manual save or any Auto Save)    |
| `workspace.onDidCloseTextDocument`   | `FileClosedNotice` (no text) | the document is supported                                   |

**Supported** means `languageId === 'java'` and `uri.scheme === 'file'`. Everything else (`untitled`, `git`, output channels, non-Java files) is ignored without an error.

```ts
export type TriggerKind = 'open' | 'activate' | 'edit' | 'startup' | 'save';

export const NO_WORKSPACE_ID = 'no-workspace'; // files outside every workspace folder

export interface FileSnapshot {
  readonly workspaceId: string; // workspace folder URI string, or NO_WORKSPACE_ID
  readonly fileUri: string;
  readonly languageId: 'java';
  readonly version: number;
  readonly content: string; // full text, read together with version
  readonly trigger: TriggerKind;
  readonly observedAt: number; // ms, from an injected `now` (Date.now in production)
}

export interface FileClosedNotice {
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly observedAt: number;
}

export interface SnapshotSink {
  submit(snapshot: FileSnapshot): void; // synchronous; records state only
  closed(notice: FileClosedNotice): void; // synchronous; records state only
}
```

`FileSnapshot` uses the same field names as `DetectorInput`, so the scheduler builds a detector input by adding `contentHash` only.

**Producer guarantees (card 02):**

1. Only supported documents reach the sink.
2. Every event that passes the filter is forwarded once, immediately and in order. The monitor never merges, delays, drops or hashes, and never calls a detector.
3. `'edit'` is only sent when the change carries at least one content change.
4. `content` and `version` are read together, synchronously, so they always match.
5. Duplicates are expected: opening a file usually gives `'open'` then `'activate'` with the same version, and a `'save'` repeats the latest edit's version and text.
6. `closed` arrives when VS Code disposes the document, which may be some time after the tab closes, or not at all (#20).
7. If the sink throws, the error is logged to the **Technical Credit (Background)** output channel and later events are still delivered.
8. After deactivation, nothing more is forwarded. All listeners are registered through `context.subscriptions` via `registry.ts`.

**Consumer obligations (card 05 onwards; agreed 2026-11-17):**

1. **Unchanged saves**: a `'save'` with the same `fileUri` and `version` as the last snapshot received for that file means no new content. It must not start an analysis or reset the debounce timer (card 06).
2. **Duplicates**: snapshots with the same `fileUri` and `version` are coalesced into one pending entry (card 05).
3. **Closes**: the scheduler decides what happens to pending or in-flight work for a closed file, for example cancelling through the detector's `AbortSignal`. The monitor only reports.
4. `submit` and `closed` stay synchronous and never throw, because they run inside editor event listeners.
5. Text inserted by the manual **Analyse for TC** preview arrives as a normal `'edit'` and is absorbed by the debounce. No special case is needed in Sprint 1.

Until card 05 lands, `backgroundAgent.ts` plugs in `detectorRunSink.ts` (card 03), which wraps `loggingSink.ts`. The logging sink writes one line per event (never file text) to the **Technical Credit (Background)** output channel. The run sink then starts a mock call for each snapshot, cancels that file's previous call, and logs `mock start #n` and `mock <outcome> #n` lines.

## Live integration outline

Written on card 10. **None of this is built in Sprint 1.** It records how background findings will reach users, and what must be true before a live detector replaces the mock.

### Delivery through the labeling UI

**Recommended.** The Background Agent never inserts text on its own:

1. When the visible document has a valid cached result with findings, and that result's `contentHash` equals the document's **current** hash, show a "TC suggestion available" CodeLens on each finding's `line`.
2. Clicking it calls the existing `PendingAnnotation.previewAll` for that file. The edit is then user-initiated, so the current Accept/Dismiss flow is reused unchanged.

**Alternatives considered:**

- **Diagnostics in the Problems panel**: makes no edits, but is a different UI from the team's labeling flow.
- **Decorations**: noisy, and offers no Accept/Dismiss.

**Gap to fix first:** `previewAll` calls `dismissAll()` across **all** files, so previewing one background suggestion would discard pending previews in other files. Scope that call to the target file before wiring this up.

### Stale-result guard (US-09)

**A prerequisite for live integration.** A result produced for one version of a file must never be shown, or cached as current, against a different version.

- The scheduler drops a result when a newer snapshot of the same file arrived while the detector was running.
- The display layer re-checks `contentHash` against the document immediately before showing a suggestion.

With the mock this is harmless. With a live detector taking seconds per call, it is the difference between a correct and a misplaced annotation.

### Construct selection

**Open decision.** The live pipeline is construct-level: `buildContextFromSource` needs an anchor line and column. The agent analyses whole files, so a live detector must choose which constructs in a file to analyse.

| Option | Approach                                                                                              | Trade-off                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| (a)    | Analyse every top-level class or interface, calling `buildContextFromSource` at each declaration line | Simplest, and reuses everything; costs 8 live calls per construct                |
| (b)    | Analyse only the constructs whose text changed since the last cached result                           | Far fewer calls; needs a per-construct hash on top of the file hash              |
| (c)    | One whole-file prompt                                                                                 | Fewest calls; needs new prompts, which conflicts with C2 (OPRO-tuned heuristics) |

**Recommendation:** (a) for the first live version, then (b) once call volume matters.

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

| #   | Issue                                                                                                                                                                                                                                                              | Status / proposed follow-up                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `compile` and `package` called `npm run lint`, which doesn't exist (the script is `lint:check`), so `npm run compile` failed after the type check.                                                                                                                 | **Fixed on this card**: both now call `lint:check`.                                                                                                     |
| 2   | F5 fails on a clean machine with `Invalid problemMatcher reference: $esbuild-watch`, because the recommended esbuild Problem Matchers extension isn't installed. After that failed attempt, the `watch` task keeps running, so the next F5 silently waits on it.   | Documented under [Build & launch](#build--launch). Optionally, have the README setup steps mention installing the recommended extensions.               |
| 17  | dotenv 17 prints `injected env (N) from …\.env` to the debug console on every activation (from `src/utils/claude.ts`).                                                                                                                                             | Not fixed. Pass `quiet: true` to `dotenv.config` if the noise matters.                                                                                  |
| 18  | `package.json` has no `publisher` field, so the extension id is `undefined_publisher.technicalcredit`. F5 works, but `vsce package` requires a publisher.                                                                                                          | Not fixed. Add a `publisher` before packaging.                                                                                                          |
| 19  | 43 of the 45 Java fixtures under `src/test/{behavioral,creational,structural}/{positive,negative}/` are empty placeholders (0 bytes, added in "TC-8 new test files created"). Only `src/test/creational/prototype/Positive.java` and `Negative.java` have content. | Not fixed. Fill them in as heuristic tests are written; until then, use the prototype fixtures for manual checks.                                       |
| 3   | The only offline test, `src/test/buildContextCore.test.ts`, reads `src/test/mockCode/MockTest.java`, which isn't tracked in git, so it fails.                                                                                                                      | Not fixed. Restore the fixture or point the test at an existing one.                                                                                    |
| 4   | The README Testing section refers to `src/test/mockCode/` and `priorityHeuristicTests/h1…h5`, neither of which exists. The live tests now live under `src/test/creational/prototype/`.                                                                             | Not fixed. Update the README.                                                                                                                           |
| 5   | There is no way to run only offline tests: `npm test` runs everything, including billed live tests.                                                                                                                                                                | Not fixed. Propose a `test:offline` script (e.g. `jest src/test/background`) and/or move live tests behind an opt-in flag.                              |
| 6   | The README says Node 18+, but ESLint 10 needs Node `^20.19.0 \|\| ^22.13.0 \|\| >=24`.                                                                                                                                                                             | Not fixed. Update the README prerequisites.                                                                                                             |
| 7   | `@types/vscode` is `^1.138.0` while `engines.vscode` is `^1.120.0`. F5 works, but `vsce package` refuses a types version newer than the engine.                                                                                                                    | Not fixed. Align the two before packaging.                                                                                                              |
| 8   | `package.json` depends on `anthropic-ai@0.0.10`, an unofficial package from a different publisher than the official `@anthropic-ai/sdk`. Nothing in `src/` or `scripts/` imports it.                                                                               | Not fixed. Propose removing it; it is a needless supply-chain exposure (C8: ask the team first).                                                        |
| 9   | `npm install` reports 31 vulnerabilities (27 moderate, 2 high, 2 critical).                                                                                                                                                                                        | Not fixed. Review `npm audit` output; Dependabot PRs cover part of this.                                                                                |
| 10  | `package-lock.json` was written by a newer npm. Running `npm install` with npm 10.7 strips its `libc` fields, which shows up as a spurious diff.                                                                                                                   | Don't commit that drift (`git checkout -- package-lock.json`). Using a current npm avoids it.                                                           |
| 11  | On Windows with `core.autocrlf=true`, `npm run format:check` flags every file (CRLF vs. Prettier's LF), and `npm run format` would rewrite every file.                                                                                                             | Not fixed. Use `git config core.autocrlf input` locally, or add a `.gitattributes` with `* text=auto eol=lf`.                                           |
| 12  | The README clone URL points at `cielbellerose/TechnicalCredit`, while this checkout's `origin` is the fork `XiaoyuZhou000/TechnicalCredit`.                                                                                                                        | Not fixed. Confirm which repository the team treats as canonical.                                                                                       |
| 13  | `resolveInsertLine` in `src/context/buildContext.ts` uses a non-null assertion (`enclosingClassStartRow!`), which goes against the repository's no-`!` convention.                                                                                                 | Not fixed. Model the type so the assertion isn't needed.                                                                                                |
| 14  | Live detection is construct-level (it needs a cursor anchor), but the agent is per-file.                                                                                                                                                                           | Outlined on card 10, not built: see [Construct selection](#construct-selection).                                                                        |
| 15  | Before showing a background result, check it still matches the document's current `contentHash` (US-09).                                                                                                                                                           | Outlined on card 10, not built; a prerequisite for live integration: see [Stale-result guard (US-09)](#stale-result-guard-us-09).                       |
| 16  | `PendingAnnotation` can't show unsolicited background results (see [Pending-annotation display](#pending-annotation-display)).                                                                                                                                     | Outlined on card 10, not built: see [Delivery through the labeling UI](#delivery-through-the-labeling-ui).                                              |
| 20  | `workspace.onDidCloseTextDocument` fires when VS Code disposes the document, which can lag behind the tab closing, and isn't guaranteed for every tab close (found on card 02).                                                                                    | Not fixed. Card 02 reports closes whenever they arrive. If card 05 or 08 needs immediate closes, add `window.tabGroups.onDidChangeTabs` to the monitor. |
| 21  | After a window reload, VS Code may restore tabs lazily, so a restored Java file can be reported as `'open'` (when first shown) instead of `'startup'` (found on card 02).                                                                                          | Not a bug. Card 09's restart test and demo should accept either trigger.                                                                                |
| 22  | Card 03's temporary run sink starts a mock call on every edit, so the call count while typing is not card 09's demo count (found on card 03).                                                                                                                      | Expected until card 05 replaces the run sink with the scheduler.                                                                                        |
