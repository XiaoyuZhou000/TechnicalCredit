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

### Sprint 1 demo smoke check (card 09)

This manual check covers visibility only. The offline suite (`npx jest src/test/background`) proves the timing, call counts and restart behaviour (constitution IV); don't use the page to prove those.

1. Press **F5**. In the **[Extension Development Host]** window, the extension activates as above.
2. Open a Java file, for example `src/test/creational/prototype/Positive.java`. Run **Technical Credit: Show Background Status** from the command palette. One tab titled **Technical Credit: Background Status** opens beside the editor. Inside the page, a badge reads "Sprint 1 mock detector".
3. Run the command again. The same tab is revealed, and no second tab appears.
4. Type in the Java file, then stop. The row shows waiting work, `quiet until …`. About 3 s later it shows running, then `current · analysed` with a finding count, and **Analyses** goes up.
5. Type again straight away, then stop. The row shows `cooldown until …` at once, about 30 s after the first analysis finished, with no `quiet until …` first: the cooldown ends later than the quiet period, so it sets the time. While the first analysis is still running, the row can show `after running request` instead. The next analysis starts at the cooldown time.
6. Close the tab. Background analysis continues: the **Technical Credit (Background)** output channel keeps logging.

For the presentation, capture a screenshot or short recording of steps 4 and 5 beside the Java file. Also save the output of `npx jest src/test/background --verbose`. It shows the functional suite's call-sequence, waiting-hash, timer-state and restart cache-hit tests.

## Command reference

Run every command from the repository root. **Billed** commands make live Claude calls, cost money, and need `ANTHROPIC_API_KEY` in `.env`. Run them only when asked (C3).

| command                                      | purpose                                                                                            | when                                                              | cost       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------- |
| `npm install`                                | Install dependencies from `package-lock.json`                                                      | First setup, or after the lockfile changes                        | free       |
| `npm run compile`                            | Type-check, lint (zero warnings), then bundle to `dist/`                                           | Before a manual launch or a PR                                    | free       |
| `npm run watch`                              | `watch:tsc` and `watch:esbuild` in parallel                                                        | While developing; F5 starts it automatically                      | free       |
| F5 "Run Extension"                           | Run the `watch` task and open an Extension Development Host                                        | To try the extension by hand                                      | free¹      |
| `npm run tsc:check`                          | Type-check only (`tsc --noEmit`)                                                                   | Any time; CI job `tsc-check`                                      | free       |
| `npm run lint:check`                         | `eslint src --max-warnings=0`                                                                      | Any time; CI job `lint-check`                                     | free       |
| `npm run lint:fix`                           | Auto-fix lint issues                                                                               | When `lint:check` fails on fixable rules                          | free       |
| `npm run format`                             | `prettier --write .`                                                                               | Before pushing (see the Windows line-ending note above)           | free       |
| `npm run format:check`                       | `prettier --check .`                                                                               | Any time; CI job `format-check`                                   | free       |
| `npx jest <path>`                            | Run only the Jest tests under `<path>`, e.g. `npx jest src/test/background`                        | Offline unit tests for the Background Agent                       | free²      |
| `npm test`                                   | Run **every** `src/**/*.test.ts`, including the live heuristic tests; `dotenv/config` loads `.env` | Only when explicitly asked                                        | **billed** |
| `npm run package`                            | Production build (minified, no sourcemaps)                                                         | Release builds                                                    | free       |
| **Technical Credit: Show Background Status** | Open or reveal the read-only Background Agent status page (card 09)                                | During a demo or a manual check in the Extension Development Host | free       |
| `npm run opro`                               | Bundle and run `scripts/opro.ts`, which regenerates the heuristic prompts using Claude             | Only when explicitly asked; it rewrites the tuned prompts         | **billed** |

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
- **Attachment**: one call, `startBackgroundAgent(context)`, from `src/background/backgroundAgent.ts`, **added on card 02** as the last statement of `register`. That function registers its own listeners, timers, storage adapter and, since card 09, the `technicalcredit.showBackgroundStatus` command and its status panel as disposables, so deactivation cleans them up the same way as the existing commands. The existing registrations are left as they are.
- **Constraints**: C1, C7
- **Serves cards**: 02, 04, 10

### Analysis flow

- **Location**: `src/analyse.ts` (the adapter), over `src/detection/detectTechnicalCredit.ts` (the shared core, card 13)
- **Owns**: the manual **Analyse for TC** command, `analyseForTC(controller, client)`. Since card 13 it is a thin adapter:
  1. reads `window.activeTextEditor`, then `buildContext(editor)`;
  2. `findAdrs(workspaceRoot)`;
  3. inside `withProgress`, calls `detectTechnicalCredit({ context, adrs }, client, signal)`. The signal never aborts, because the command has no cancel button. The service makes one call per entry in `HEURISTIC_CATEGORIES` in parallel (8 live calls), then one ADR-matching call per candidate when ADRs exist;
  4. `formatTCComment` for each finding, then `controller.previewAll(...)`.

  `registry.ts` passes the real `callClaude` as `client`. Failures surface as VS Code notifications.

- **Attachment**: the background path must **not** call `analyseForTC`, which owns the editor, progress, notifications and preview. A live background detector (Task 14) wraps `detectTechnicalCredit` behind the `Detector` interface instead (see [Shared detection service (card 13)](#shared-detection-service-card-13)). The manual command bypasses the background cache and scheduler.
- **Constraints**: C2, C5, C6, C7
- **Serves cards**: 10 (splitting manual and background responsibilities), 13 (the shared detection service)

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

| Concern                | Manual "Analyse for TC"                                                                                  | Background Agent (Sprint 1)                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Trigger                | The user runs the command                                                                                | File open, active-editor change, edit (card 02)                           |
| Unit of analysis       | One construct at the cursor                                                                              | One file snapshot (`DetectorInput`)                                       |
| Detector               | The shared detection service, `detectTechnicalCredit` (live Claude; card 13)                             | Any `Detector`; the mock (card 03) until Task 14 wraps the shared service |
| Cache                  | None: always bypassed                                                                                    | SHA-256 result cache (card 04)                                            |
| Scheduling             | None: runs immediately                                                                                   | Coalesce, debounce, cooldown, in-flight dedup (cards 05–08)               |
| Result display         | `PendingAnnotation` preview, which inserts text                                                          | None in Sprint 1: results go to the cache and inspection only             |
| Live calls in Sprint 1 | Yes, on demand (unchanged)                                                                               | No                                                                        |
| Shared pieces          | `detectTechnicalCredit` (prompts, calls, ADR matching, validation), `buildContextFromSource`, `TCResult` | The same service, wrapped behind a live `Detector` (Task 14)              |
| Never shared           | `analyseForTC()`'s UI flow; `previewAll` for unsolicited results                                         | —                                                                         |

The manual command **bypasses the background cache and all scheduling**, so running it twice on an unchanged class makes the live calls twice. It is **not changed** in Sprint 1.

**Card 13 (proposed)** moved its detection into the shared service and kept the command's behaviour. `src/test/detection/manualAnalyse.test.ts` proves this with snapshots taken before the refactor. Four differences are intended:

1. Previews follow `HEURISTIC_CATEGORIES` order instead of the order the calls finish in.
2. The text after `Analyse for TC failed: ` names the failed step, for example `heuristic "modularity": …`.
3. An answer that fails validation fails the run. Most malformed answers already failed, in `formatTCComment` or `createAdrUserPrompt`.
4. After one call fails, the error shows at once and the calls still in flight are aborted.

A live background detector reuses `detectTechnicalCredit`, which builds on the heuristic prompts and the `TCResult` shape, with a context from `buildContextFromSource` or construct enumeration (card 12). It must not reuse `analyseForTC()` itself (which mixes in active-editor reads, progress and notifications) or call `previewAll` for results the user didn't ask to see.

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

**This is a proposal. Card 01 created none of these files. Card 10 created `background/detector/detector.ts`; card 02 created `background/events/*` and `background/backgroundAgent.ts`; card 03 created `background/detector/mockDetector.ts` and the temporary `background/events/detectorRunSink.ts`; card 04 created `background/cache/resultCache.ts`; card 08 created `background/scheduler/scheduler.ts` and retired the run sink; card 06 created `background/scheduler/clock.ts`; card 09 created `background/status/*`; card 11 created `background/detector/versionTracker.ts` and extended the detector contract, mock, file events, monitor, scheduler and status modules; card 12 created `context/enumerateConstructs.ts`, outside `src/background/` because it is context building; card 13 created `detection/*`, outside `src/background/`, because the manual command and the background share it. Each comes with offline tests.** All new Background Agent code goes under `src/background/`, split by responsibility. Paths are relative to `src/`.

| path                                    | responsibility                                                                                                                                                                                                                                                                                                                                                                                                                       | cards          | dependsOn                                                                                                 | vscodeFree                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `background/detector/detector.ts`       | **Created on card 10.** The detector contract: input, output, result/failure types, the `Detector` interface, `isCacheable`, `failureFromAbort`                                                                                                                                                                                                                                                                                      | 10             | `comment/tcResult.ts`                                                                                     | yes                                              |
| `background/detector/mockDetector.ts`   | **Created on card 03.** Deterministic async mock with configurable delay and an inspectable call counter. Reads time through `MockTimers`, a subset of the planned `Clock`. Card 11 added `setVersion` and `onVersionChange`                                                                                                                                                                                                         | 03, 11         | `detector/detector.ts`                                                                                    | yes                                              |
| `background/detector/versionTracker.ts` | **Created on card 11.** `DetectorVersionTracker`: compares the detector identity with the one recorded at the last successful start, records it, handles runtime announcements through an injected `rescan`, and keeps the session's last `VersionChange` for the status page                                                                                                                                                        | 11             | `detector/detector.ts`, `cache/resultCache.ts` (the `CacheStore` type), `scheduler/clock.ts`              | yes                                              |
| `background/events/fileEvents.ts`       | **Created on card 02.** The file-event contract (`FileSnapshot`, `FileClosedNotice`, `SnapshotSink`), `isSupported`, and the `FileEventHandler` core                                                                                                                                                                                                                                                                                 | 02             | none                                                                                                      | yes                                              |
| `background/events/fileEventMonitor.ts` | **Created on card 02.** Thin adapter: subscribes open, active-editor, change, save and close events, plus the startup scan, and calls the core                                                                                                                                                                                                                                                                                       | 02             | `vscode`, `events/fileEvents.ts`                                                                          | no (adapter)                                     |
| `background/events/loggingSink.ts`      | **Created on card 02.** `SnapshotSink` that logs one line per event (never file text); since card 08 it is the scheduler's inner sink, called before the scheduler's own lines                                                                                                                                                                                                                                                       | 02             | `events/fileEvents.ts`                                                                                    | yes                                              |
| `background/scheduler/scheduler.ts`     | **Created on card 08.** `Scheduler`, the single owner of per-file state: in-flight deduplication (one active request and one latest pending snapshot per file), the cache check before a call, storing after it, and current/stale classification. Card 05 added coalescing; cards 06–07 add debounce and cooldown to the same class                                                                                                 | 05, 06, 07, 08 | `detector/detector.ts`, `cache/resultCache.ts`, `events/fileEvents.ts`; `scheduler/clock.ts` from card 06 | yes                                              |
| `background/scheduler/clock.ts`         | **Created on card 06.** `Clock` interface only (`now`, plus `MockTimers`' `setTimeout`, `clearTimeout`). The real clock is bound in `backgroundAgent.ts`; the fake is `test/background/fakeTimers.ts`                                                                                                                                                                                                                                | 06, 07, 09     | none                                                                                                      | yes                                              |
| `background/cache/resultCache.ts`       | **Created on card 04.** `sha256Hex`, the `CacheStore` interface, `ResultCache` (`lookup`, `store`, `stats`) keyed by workspace + file URI + detector id + detector version, with the content hash compared on lookup; every stored value is validated on read                                                                                                                                                                        | 04             | `detector/detector.ts`, `comment/tcResult.ts`, Node `crypto`                                              | yes                                              |
| `background/backgroundAgent.ts`         | **Created on card 02** (monitor, logging sink, mock detector, result cache over `context.globalState` and the scheduler so far). Composition root: `startBackgroundAgent(context)` wires the monitor, scheduler, cache and detector, and registers disposables                                                                                                                                                                       | 02–08, 10      | everything above                                                                                          | no (composition root)                            |
| `background/status/backgroundStatus.ts` | **Created on card 09.** `BackgroundStatus`: read-only `snapshot()` (label, detector, session counts, `scheduler.files()`, `nextChangeAt`) and `subscribe()` over the scheduler and cache                                                                                                                                                                                                                                             | 09             | `scheduler/scheduler.ts`, `cache/resultCache.ts`                                                          | yes                                              |
| `background/status/statusView.ts`       | **Created on card 09.** Pure `renderStatusHtml(snapshot, { nonce })` and `escapeHtml`: strict CSP, no scripts, forms or inputs                                                                                                                                                                                                                                                                                                       | 09             | `status/backgroundStatus.ts`                                                                              | yes                                              |
| `background/status/statusFeed.ts`       | **Created on card 09.** `StatusFeed`: renders on open, throttled to one per 200 ms after changes, and again at `nextChangeAt`; isolates render errors; all timers on the injected clock                                                                                                                                                                                                                                              | 09             | `status/backgroundStatus.ts`, `status/statusView.ts`, `scheduler/clock.ts`                                | yes                                              |
| `background/status/statusPanel.ts`      | **Created on card 09.** Thin adapter: one `WebviewPanel` beside the editor (revealed if open), `enableScripts: false`, a CSP nonce per render, the feed disposed with the panel                                                                                                                                                                                                                                                      | 09             | `vscode`, `status/statusFeed.ts`                                                                          | no (adapter)                                     |
| `context/enumerateConstructs.ts`        | **Created on card 12 (proposed).** `enumerateConstructs(source, fileName, languageId)`: one parse, one frozen descriptor per top-level class, interface and enum, each with the manual path's `TcContext`. Card 12 also split `javaParser/index.ts` (`metricsFor`, new `extractTopLevel`), `extractors.ts` (`memberMetrics`, new `extractEnumMetrics`) and `buildContext.ts` (`assembleContext`) without changing the manual context | 12             | `context/buildContext.ts`, `context/javaParser`                                                           | yes                                              |
| `test/background/*.test.ts`             | Offline unit tests with a fake clock and an in-memory `CacheStore`; never imports `@/utils/claude`                                                                                                                                                                                                                                                                                                                                   | 09             | the vscode-free modules above                                                                             | yes                                              |
| `detection/detectTechnicalCredit.ts`    | **Created on card 13 (proposed).** The shared detection service: `detectTechnicalCredit(request, client, signal)` makes the heuristic and ADR-matching calls through an injected `ClaudeClient`, validates each answer, and returns a `DetectionOutcome` in card 10's failure vocabulary. The manual command uses it; Task 14 wraps it in a `Detector`                                                                               | 13             | `detection/validateAnswer.ts`, `prompts/*`, `detector/detector.ts`                                        | yes                                              |
| `detection/validateAnswer.ts`           | **Created on card 13 (proposed).** `parseHeuristicAnswer` and `parseAdrAnswer`. The candidate rules match the cache's read rules, so every finding can be cached (known issue 26)                                                                                                                                                                                                                                                    | 13             | `comment/tcResult.ts`                                                                                     | yes                                              |
| `test/detection/*.test.ts`              | **Created on card 13.** Offline tests with a fake Claude client; `@/utils/claude` is mocked to throw if anything loads it. `manualAnalyse.test.ts` pins the manual command's calls and previews, using a virtual `vscode` mock                                                                                                                                                                                                       | 13             | `detection/*`, `analyse.ts`                                                                               | yes, except `analyse.ts` behind the virtual mock |

Design notes:

- **The scheduler owns all per-file state.** Card 07 defines the earliest start as `max(lastChange + debounce, lastCompletion + cooldown)`, which needs debounce, cooldown, coalescing and in-flight state together. Separate wrappers would each repeat the same bookkeeping.
- **Time is injected.** The scheduler and mock detector read time only through `Clock`, so card 09's fake-clock tests and the scripted 0 → 1 → 2 → 2 demo are deterministic without patching globals. Since card 06, `Clock` extends the mock's `MockTimers` with `now()`, and `backgroundAgent.ts` passes one real clock to both, so one fake (`createFakeTimers()`) drives both in tests. For the scheduler and the mock detector, only the composition root binds `Date.now` and the global timers. The file-event monitor separately stamps `observedAt` with `Date.now` in its own adapter, on the same time base. The mock's own `realTimers` default predates this and is unused in production.
- **No new dependencies.** Hashing uses `crypto.createHash('sha256')`, and storage goes through a small `CacheStore` interface, so tests use an in-memory store (C8).
- **No storage adapter.** `vscode.Memento` (`context.globalState`) already satisfies `CacheStore` structurally, as `TextDocument` satisfies card 02's `MonitoredDocument`, so the proposed `cache/vscodeCacheStore.ts` was not needed (card 04). The composition root passes `context.globalState` directly and never calls `setKeysForSync`, so results stay on the machine that produced them.
- **The dependency direction is one way**: adapters → core. Only the "no" rows import `vscode` (C1), and nothing under `background/` imports `@/utils/claude` (C7).

## Proposed contracts

The detector contract is agreed on card 10 (pending review). The file-event hand-off is agreed on card 02, the result cache on card 04, and the scheduler's in-flight rules on card 08.

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
  onVersionChange?(listener: (version: string) => void): () => void; // card 11, optional
}

export function isCacheable(result: DetectorResult): boolean; // result.ok
export function failureFromAbort(signal: AbortSignal): DetectorResult; // TimeoutError → 'timeout', else 'cancelled'
```

**Failures are returned, not rejected.** Promise rejections can't be typed, and a discriminated union forces every caller to handle the failure branch. It also makes the caching rule a single `ok` check, and keeps expected outcomes like cancellation out of exception handling. The card 01 draft rejected with a plain `{ kind }` object. That would fail the repo's `no-throw-literal` lint rule if written as `throw { kind: … }` in an `async` method, though not if written as `Promise.reject(…)`.

| #   | Rule                                                                                                                                                                                                                   | Who            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | `analyse` resolves on a later tick and never blocks editing                                                                                                                                                            | Every detector |
| 2   | `analyse` never rejects; problems are returned as `ok: false`                                                                                                                                                          | Every detector |
| 3   | Never edit a document, show UI, or touch `vscode`                                                                                                                                                                      | Every detector |
| 4   | Honour `signal`: once it aborts, resolve promptly with `failureFromAbort(signal)`                                                                                                                                      | Every detector |
| 5   | `output.detectorId` equals `this.id`; `output.detectorVersion` equals the `version` in effect when the call started (rule 14)                                                                                          | Every detector |
| 6   | Findings are candidates only, with the existing `TCResult` shape and a 0-based declaration `line`                                                                                                                      | Every detector |
| 7   | Depend only on this module, never on a concrete detector                                                                                                                                                               | Every caller   |
| 8   | Own the timeout policy (`AbortSignal.timeout`, combined with cancellation via `AbortSignal.any`)                                                                                                                       | Every caller   |
| 9   | Cache only when `isCacheable(result)` is true; empty results are cacheable, failures never are                                                                                                                         | Card 04        |
| 10  | Treat an unexpected rejection (a defect) as `{ kind: 'failed', message }`                                                                                                                                              | Card 08        |
| 11  | Never import `@/utils/claude` or `@anthropic-ai/sdk` in Sprint 1                                                                                                                                                       | Every detector |
| 12  | `version` changes whenever prompts, model, model configuration or detection logic change in a way that can change findings; never for timing-only settings                                                             | Every detector |
| 13  | A detector whose `version` can change while it lives implements `onVersionChange`, calling listeners synchronously after `version` returns the new value and never for a no-op; one that doesn't keeps `version` fixed | Every detector |
| 14  | A version change never aborts or alters calls already started; their output carries the version they started under                                                                                                     | Every detector |

Rules 12–14 are **Proposed (card 11)** until its PR is approved.

**Mock detector (card 03)**, in `src/background/detector/mockDetector.ts`:

- `id` is `'mock'`, the default `version` is `'mock-1'`, and the default delay is 2 s. A delay of 0 still answers on a later tick, and cancellation answers at once.
- Under the default behaviour, findings depend only on the content: one sample finding per `class` or `interface` declaration line, or none.
- `callCount` counts every call on entry, including cancelled and failed ones. `calls()` returns the file, document version, content hash and outcome of each call, never the file text.
- `behaviour: { kind: 'findings' }` and `{ kind: 'fail' }` change the results, so they require a `version` other than `'mock-1'`. Card 04 relies on this: old results can't hit under a new version. The delay is never part of the version.
- **Card 11 (proposed):** `version` is a getter. `setVersion(v)` applies the constructor's rules, is a no-op for the current version, and otherwise announces through `onVersionChange`. The extension sets it from `technicalcredit.background.mockDetectorVersion` (default `mock-1`), at start and on every change of that setting. The setting is application-scoped (user settings only), because the identity it changes is recorded once for every window (see "Detector version tracking").

These are extras on the concrete class. The scheduler must still depend only on `Detector`.

### Result cache (card 04)

**Agreed (card 04).** Source: `src/background/cache/resultCache.ts`.

1. **Identity**: a lookup hits only if workspace id, file URI, detector id, detector version **and** content hash all match. The hash is `sha256Hex(content)`, the same value the detector receives as `contentHash`; line endings are not normalised.
2. **One entry per file and version**: the key is `technicalCredit.resultCache.v1:` + `JSON.stringify([workspaceId, fileUri, detectorId, detectorVersion])`, and the content hash lives in the value. A new store replaces that file and version's previous entry, so storage doesn't grow with edits.
3. **Only successes are stored**: `store` skips anything `isCacheable` rejects (contract rule 9) and any output whose detector id or version differs from the identity's. Empty findings are stored.
4. **Versions never cross**: a result stored under one detector id or version is never returned under another. Older versions keep their entries, so rolling back hits again.
5. **Unreadable means miss**: every stored value is validated on read. Another format, a corrupt value or a throwing `get` is a miss; a failing `update` is a `failed` outcome. `lookup` and `store` never throw or reject.
6. **No reaction to a version change**: the cache never starts an analysis. A new version simply misses on the next lookup; proactive re-analysis is card 11 (see "Detector version tracking").
7. **No logging**: callers log from the returned outcomes, with counts, the first 8 hash characters, `detectorId@detectorVersion` and the URI, never file text or findings. `stats()` counts hits, misses and store outcomes since activation. A `lookup(identity, { recheck: true })` repeats a lookup whose miss the caller already counted, so only a hit counts (card 11's slot queue).

### File events → scheduler (cards 02 and 05)

**Agreed (card 02).** Source: `src/background/events/fileEvents.ts`.

The event monitor is the only background module that touches VS Code document events. It turns them into plain notifications for the vscode-free scheduler. **The monitor reports; the scheduler decides.**

| VS Code event                        | Forwards                     | When                                                        |
| ------------------------------------ | ---------------------------- | ----------------------------------------------------------- |
| Already-open documents at activation | `'startup'` snapshot         | each supported document, once                               |
| Detector version change (card 11)    | `'version'` snapshot         | each loaded supported document shown in a tab, once         |
| `workspace.onDidOpenTextDocument`    | `'open'` snapshot            | the document is supported                                   |
| `window.onDidChangeActiveTextEditor` | `'activate'` snapshot        | the newly active document is supported                      |
| `workspace.onDidChangeTextDocument`  | `'edit'` snapshot            | the document is supported and `contentChanges` is non-empty |
| `workspace.onDidSaveTextDocument`    | `'save'` snapshot            | the document is supported (manual save or any Auto Save)    |
| `workspace.onDidCloseTextDocument`   | `FileClosedNotice` (no text) | the document is supported                                   |

**Supported** means `languageId === 'java'` and `uri.scheme === 'file'`. Everything else (`untitled`, `git`, output channels, non-Java files) is ignored without an error.

```ts
export type TriggerKind =
  | 'open'
  | 'activate'
  | 'edit'
  | 'startup'
  | 'save'
  | 'version'; // card 11

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

**Rescans (Proposed, card 11):** `FileEventHandler.startup(docs)` now returns how many documents it forwarded, and `rescan(docs)` forwards each supported document as `'version'`, in the given order, returning the count. The monitor exposes `startupCount` and `rescan()`. Its rescan reads `workspace.textDocuments` and passes them through the pure `rescanOrder()`, which keeps only documents shown in a text tab or either side of a text diff tab (`window.tabGroups`) and orders them active editor, visible editors, then the rest. Unloaded background tabs are never loaded. The guarantees above apply to `'version'` snapshots too.

**Consumer obligations (card 08 onwards; agreed 2026-11-17; 1–2 amended on card 05):**

1. **Unchanged reports**: any snapshot (`'save'`, Auto Save, `'open'`, `'activate'`, `'startup'` or `'edit'`) whose content hash and detector version equal the latest snapshot received for that open file means no new content. It is a repeat: it must not start an analysis, look up the cache or reset the debounce timer (card 06). Content is compared by hash rather than `version`, because a save repeats the last edit's version and text, and an edit followed by its undo changes the version but not the text.
2. **Duplicates**: a repeat of the pending content leaves it untouched, and newer different content replaces it, so each file holds at most one pending snapshot (card 05).
3. **Closes**: the scheduler decides what happens to pending or in-flight work for a closed file, for example cancelling through the detector's `AbortSignal`. The monitor only reports.
4. `submit` and `closed` stay synchronous and never throw, because they run inside editor event listeners.
5. Text inserted by the manual **Analyse for TC** preview arrives as a normal `'edit'` and is absorbed by the debounce. No special case is needed in Sprint 1.

Since card 08, `backgroundAgent.ts` plugs in the `Scheduler`, which wraps `loggingSink.ts`. The logging sink writes one line per event (never file text) to the **Technical Credit (Background)** output channel, then the scheduler logs its own decision. Card 03's temporary run sink, which cancelled a file's previous call on every new snapshot, is gone.

### Scheduler (cards 08, 05, 06 and 07)

**Agreed (card 08; rules 2 and 6 amended and rule 9 added on card 05; rules 2 and 8 amended on card 06; rules 2, 7 and 8 amended and rule 10 added on card 07; rule 3 amended and rule 11 added on card 11, **proposed** until its PR is approved).** Source: `src/background/scheduler/scheduler.ts`. Changing a rule needs the team's agreement.

1. **One state per file**, in memory, keyed by `JSON.stringify([workspaceId, fileUri])`, never by content hash. In-flight state is never written to the result cache.
2. **Idle file**: a repeat of the file's latest snapshot logs `unchanged` and does nothing else (rule 9). Any other snapshot waits as pending work for its quiet period (rule 8) and any cooldown (rule 10), then is looked up in the cache. A hit logs `cache hit` and starts nothing; a miss logs `cache miss (<reason>)` and starts exactly one call. That happens inside `submit` only when nothing makes the work wait (quiet period off, and no cooldown running); otherwise `submit` just records pending work, and the lookup and call happen once the work is due and no request is running.
3. **Active file**: a snapshot never starts a call and never aborts the running one. Content is compared by hash: the running content is a `duplicate of running`, the pending content a `duplicate of pending`, and a change back to the running content is `pending cleared`. Any other content becomes the single pending snapshot (`pending`, then `pending replaced`). Since card 11 the running request covers a snapshot only if the current detector version is also the one it runs with: after a version change the same content becomes pending work, and runs once the old-version request settles.
4. **Settling**: the outcome is logged; a success is stored under the content actually analysed (`cache stored` or `cache store failed`) **before** the slot is released, so the next lookup sees it. Failures are never stored.
5. **Current or stale**: a success is `result current` only if its hash is the file's latest snapshot, its detector version is the current one, and the file is open; otherwise `result stale`. It is cached either way, but only a current result may ever be shown. `onSettled` reports `stored` and `eligible` without file text.
6. **Release**: after every outcome (success, failure, rejection, cancellation, failed store), the slot is freed and only the latest pending snapshot goes through rule 2. A failure is never retried without a new meaningful change, a reopen or a restart; an unchanged report is never one.
7. **Close** drops the pending snapshot (`pending dropped (closed)`) and lets the running request finish. An idle closed file is forgotten, unless its cooldown is still running (rule 10). **Dispose** aborts every running request, clears all state, and ignores everything afterwards. A late settlement never changes newer state.
8. **Quiet period (card 06)**: pending work becomes eligible at `lastChangeAt + quietMs` (`DEFAULT_QUIET_MS`, 3000; `0` disables it; the constructor rejects anything not finite or above Node's 2³¹−1 ms timer limit). `fileState().eligibleAt` exposes when work may start: the later of this deadline and the cooldown's (rule 10), with `waitingFor` (`'quiet'` or `'cooldown'`) saying which. A first report counts as a change; repeats never move it.
   - Stats: `pendingHeld` and `pendingReplaced` count pending work for any of three reasons: behind a running request, inside a quiet period, or inside a cooldown (rule 10). Use `fileState()` (`active`, `eligibleAt`, `waitingFor`) to tell which.
   - Wake-ups: a file holds one wake-up while it has pending work, set for its next check. That is first its quiet deadline (`quiet until <iso> …`), when the cache is consulted, then, if the cache missed during a cooldown, the cooldown's end (`cooldown until <iso> …`). A new change moves it rather than adding one. It is cleared on dispatch, cache hit, `pending cleared`, close and dispose. When it fires, it re-checks that it is still current, the file is open, work is pending and no request runs, and only then goes through rule 2's cache lookup.
   - With a request running: a wake-up starts nothing. When the request settles, pending work that is due starts at once. Otherwise it keeps waiting, and its wake-up moves to its next check if that changed.
9. **Repeats (card 05)**: a snapshot is a repeat when the file is open and its content hash and detector version equal the latest snapshot's. A repeat changes nothing but the `duplicates` count: no cache lookup, no call, no change to pending work, and `lastChangeAt` in `fileState` stays put. That value is the `observedAt` of the latest first report or real change, for card 06's quiet period. A repeat on an idle file logs `unchanged`; on an active file it logs `duplicate of running` or `duplicate of pending` (rule 3). A reopen after close is a first report; a file kept for its cooldown keeps only its completion time (rule 10). A new detector version makes unchanged content new work. `pendingCount()` returns the number of files holding pending work.
10. **Cooldown (card 07)**: after every detector completion (a request that settled with success, failure, cancellation or timeout), no new detector call starts for the file before `lastSettledAt + cooldownMs`. The default is `DEFAULT_COOLDOWN_MS`, 30000; `0` disables it, and it is validated like `quietMs`. Cache hits, repeats and dropped work are not completions, so none of them starts or restarts a cooldown.
    - The cooldown limits detector calls, not cache answers. Once pending work's quiet period has passed, the cache is checked even during a cooldown: a hit clears the work at once, at no cost. A miss waits out the cooldown, and the cache is checked again right before the call (rule 2).
    - The cooldown is the second half of rule 8's `eligibleAt`, the time a call may start; `waitingFor` says which deadline sets it. There is still one wake-up per file and one "is it due" check.
    - A closed file with nothing running or waiting is kept while its cooldown runs, with `open: false`, no pending work and no timer, so closing and reopening a tab cannot bypass the limit. Its `fileState()` stays visible until then, and no longer: `fileState()` treats an expired record as absent. Expired records are also swept on every `closed()` and replaced by the next report.
    - Cooldowns are in memory only; a restart forgets them, and the result cache still stops unchanged content from being re-analysed.
11. **Global limit (card 11, proposed)**: at most `maxConcurrent` detector calls run at once across all files (`DEFAULT_MAX_CONCURRENT`, 2; `0` = no limit; the constructor rejects anything but a non-negative safe integer). `running()` returns the count.
    - Due work that can't start is still looked up in the cache: a hit clears it at no cost. A miss logs `waiting for slot (<n> running) …`, counts `slotWaits`, and joins a FIFO slot queue with no timer. `fileState().waitingFor` is `'slot'`.
    - When any call settles, freed slots go to queued files in order, each re-checked and looked up again before its call (another window may have stored it meanwhile); that recheck doesn't count a second miss. While others wait, a settling file's own due follow-up joins the back of the queue and counts in `followUps` when it starts from there; otherwise it starts at once as before.
    - Close and a replacement that is no longer due take a file out of the queue; a replacement that is still due keeps its place. `dispose` clears the queue.
    - Log lines about a running or settled request name the version it ran under.

### Status interface (card 09)

**Proposed (card 09), until PR #12 is approved.** Sources: `src/background/status/*` and `Scheduler.files()` / `onChange()`. These are additions only; no scheduler rule changes.

1. **Read-only**: nothing on the status surface can trigger analysis, change scheduler or cache state, or edit a document. The page has no scripts, forms, inputs or message channel. It is separate from the Accept/Dismiss annotation UI.
2. **`Scheduler.files()`** lists every tracked file, sorted by workspace and URI, as `FileStateView` plus `workspaceId`, `fileUri`, `latest` and `keptUntil`. Expired kept records are dropped first.
   - `latest` is the file's last detector result or cache answer, with its finding count.
   - `latest.current` is decided when read (content and detector version match, and the file is open), so a stale result can never show as current.
3. **`Scheduler.onChange()`** notifies once after each burst of changes, through a microtask, never during one. A change is any logged decision, any close (even with nothing pending), or the removal of an expired kept record, including a removal made while reading `files()` or `fileState()`. A throwing listener is logged as `status listener error: …` and skipped. `dispose()` drops every listener.
4. **Snapshot**: `BackgroundStatus.snapshot()` is deep-frozen metadata. It holds the label ("Sprint 1 mock detector"), `detector`, `takenAt`, the session counts (`analyses`, `followUps`, `repeats` and the cache's hits, misses and stores) and the rows. Counts reset with each session; cached results persist.
   - `nextChangeAt` is the earliest future eligible time or kept-record expiry, so a page refreshes then without polling.
   - **Card 11 (proposed):** `versionChange` is the session's last detector version change, if any, and `concurrency` is `{ running, limit }`. `subscribe()` also listens to the version tracker. The page adds a "Detector version changed" line, a "Running: n / limit" line, and shows a slot wait as "waiting for a free slot".
5. **Page**: `renderStatusHtml` escapes every value. Its CSP is `default-src 'none'; style-src 'nonce-…'`. The feed renders at most once per 200 ms after changes, and its timers are cleared when the panel or the extension closes. A failed render is reported and skipped.

### Detector version tracking (card 11)

**Proposed (card 11), until its PR is approved.** Source: `src/background/detector/versionTracker.ts`, wired in `backgroundAgent.ts`.

1. **Recorded identity**: `{ detectorId, detectorVersion }` in `context.globalState` under `technicalCredit.activeDetector.v1`, never synced. Anything but two non-empty strings, or a throwing `get`, counts as nothing recorded.
2. **Startup**: `begin()` runs before the startup scan and compares the recorded identity with the detector's. Nothing recorded means `first start`, equal means `unchanged`, and different (rollbacks included) is a `startup` change. After the scan, `startupScheduled(count)` logs one line, for example `detector version changed mock@mock-1 → mock@mock-2 (startup), 3 files scheduled`. The startup count is every loaded supported document the scan forwarded, not only those in a tab, so the line says files rather than open files.
3. **Re-analysis is ordinary work**: the startup scan, or a rescan, submits snapshots. Because a new version makes unchanged content new work (scheduler rule 9), each file goes through the quiet period, cooldown, cache, deduplication and the global limit. The tracker holds no per-file state.
4. **Runtime**: if the detector implements `onVersionChange`, an announcement of a different identity calls `rescan()`, logs `… (runtime), N files scheduled`, records the new identity once the start was confirmed, and notifies listeners. A repeat of the active identity does nothing. A throwing rescan is logged and counts as 0.
5. **Recording**: `confirmStarted()` is the last step of `startBackgroundAgent`, so a start that throws earlier keeps the old identity and the next start detects the change again. A failed write is logged as `detector record failed: …` and never thrown.
6. **No polling**: the tracker sets no timers and makes no network or file access.
7. **Several windows** share the recorded identity, so a second window with the same build reports `unchanged`. The version setting is application-scoped so windows can't disagree about it; each window re-analyses only its own open files, through the shared cache.

### Construct enumeration (card 12)

**Proposed (card 12), until its PR is approved.** Source: `src/context/enumerateConstructs.ts`, over `extractTopLevel` in `src/context/javaParser/index.ts`; tests in `src/test/context/`.

```ts
export type ConstructKind = 'class' | 'interface' | 'enum';
export interface Position {
  readonly line: number;
  readonly column: number;
} // zero-based; UTF-16 columns

export interface ConstructDescriptor {
  readonly kind: ConstructKind;
  readonly name: string | null;
  readonly line: number; // the declaration's start, including annotations; equals context.insertLine
  readonly column: number;
  readonly nameLine: number | null;
  readonly nameColumn: number | null;
  readonly span: { readonly start: Position; readonly end: Position };
  readonly source: string;
  readonly incomplete: boolean; // the declaration has a syntax error; the caller decides
  readonly context: TcContext; // the manual path's shape
}

export type EnumerationResult =
  | {
      readonly ok: true;
      readonly constructs: readonly ConstructDescriptor[];
      readonly hasSyntaxErrors: boolean; // tree.rootNode.hasError; see rule 7
    }
  | { readonly ok: false; readonly reason: 'unavailable' };

export function enumerateConstructs(
  source: string,
  fileName: string,
  languageId: string,
): Promise<EnumerationResult>;
```

1. **Top-level only**: direct `class_declaration`, `interface_declaration` and `enum_declaration` children of the root, in source order. Records, annotation types and top-level `ERROR` nodes are skipped. Nested, local and anonymous types stay in their outer construct's source; nested member types are listed in its `nestedDeclarations`.
2. **One parse**: one `Parser.parse` per call, and the tree is freed afterwards. No trimming or per-construct re-parse, so every position refers to the original text. Columns are UTF-16 code units, as in VS Code.
3. **Manual parity**: for a top-level class or interface, `context` equals `buildContextFromSource` at the name position, serialised identically. `import type` keeps `buildContext.ts` vscode-free. The manual context for every cursor position is pinned by `manualContext.test.ts` snapshots; run them with `--ci` and treat a diff as a regression.
4. **Enums**: a top-level enum gets `constructMetrics.enumMetrics` (constants, implemented interfaces, fields, constructors, method count, nested declarations). Only enumeration adds the key, so manual prompts never gain it. The manual command still does nothing on a top-level enum.
5. **Any input**: an empty or declaration-free file, or a non-Java `languageId`, gives `{ ok: true, constructs: [], hasSyntaxErrors: false }`. A parser that isn't set up, or a parse that fails, gives `unavailable` and one `console.error` without file text. Nothing throws.
6. **Single file**: no imported file is read, no detector or Claude is called, and no prompt changes. Card 14 calls the detector per descriptor and decides what to do with `incomplete` ones.
7. **Syntax errors**: `hasSyntaxErrors` is true when the file has an error or missing token anywhere, including outside every returned construct. While it is set, `constructs` may miss or misplace declarations, so **a construct absent from the list must not be treated as deleted**. Typing `@` above `class Foo {` makes the parser read `@ class` as an annotation and scatter `Foo`'s members over top-level fragments, so `Foo` is missing rather than `incomplete`; a missing `}` in one class pulls the next class inside it. Reconstructing declarations from those fragments was rejected: their source and metrics would be unreliable context. Card 14 owns retention: it keeps the last good results and markers while the flag is set, removes a missing construct only after a clean parse, and skips analysis of `incomplete` constructs. The manual command is unchanged.

### Shared detection service (card 13)

**Proposed (card 13), until its PR is approved.** Source: `src/detection/detectTechnicalCredit.ts` and `src/detection/validateAnswer.ts`; tests in `src/test/detection/`.

```ts
export type ClaudeClient = (
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
) => Promise<unknown>;

export interface DetectionRequest {
  readonly context: TcContext;
  readonly adrs: readonly AdrSummary[];
}

export type DetectionOutcome =
  | { readonly ok: true; readonly findings: readonly TCResult[] }
  | { readonly ok: false; readonly failure: DetectorFailure };

export function detectTechnicalCredit(
  request: DetectionRequest,
  client: ClaudeClient,
  signal: AbortSignal,
): Promise<DetectionOutcome>;
```

1. **One implementation**: the prompts, heuristic calls, ADR matching, answer validation and findings exist only here. The manual command and a future live `Detector` (Task 14) both call it.
2. **Same calls as before card 13**:
   - one call per `HEURISTIC_CATEGORIES` entry, with `SYSTEM_PROMPT + '\n\n' + createHeuristicPrompt(category)` and `createUserPrompt(context)`, all started together;
   - then, when there is at least one candidate and `adrs` is non-empty, one `(ADR_SYSTEM_PROMPT, createAdrUserPrompt(candidate, adrs))` call per candidate.

   The prompts are unchanged (C2).

3. **Fixed order**: findings follow `HEURISTIC_CATEGORIES` order, whatever order the calls finish in. Only candidates are findings, and an empty list is a success. `adr` is present only when ADR matching ran.
4. **Validation**:
   - every heuristic answer needs a boolean `is_tc_candidate`;
   - a candidate also needs a valid `category`, string `benefit` and `conditions`, and string-array `signals`, and its `not_tc_reason` must be a string or null (missing becomes `null`);
   - an ADR answer needs `adr` as a string or null; a top-level `null` answer also means no match.

   These are the cache's read rules. `resolveAdrId` then records the matched ADR's listed id, ignoring whitespace, case and zero padding and accepting a title only when it is that ADR's. An id not among the workspace's ADRs, or shared by several, becomes `null`.

5. **Whole-run failure**: the first call that rejects, or answer that fails validation, ends the run as `failed` with `"<step>: <reason>"`, for example `heuristic "modularity": boom` or `ADR matching for "reusability": …`. The calls still in flight are aborted. A `SyntaxError` becomes "the answer is not valid JSON", because V8's message quotes the answer, so messages never contain file text.
6. **Cancellation**:
   - an already aborted signal makes no call;
   - an abort mid-run settles promptly even if the client ignores the signal, and starts no further call;
   - the outcome is `cancelled`, or `timeout` when the abort reason is a `TimeoutError` (`failureFromAbort`);
   - partial findings are never a success.

   `callClaude`'s own 30 s per-call timeout is not a caller abort, but it rejects with a `TimeoutError` DOMException, so it also gives `timeout`, not `failed`.

7. **Never throws, no UI**: it never rejects, imports `vscode`, reads the editor, workspace or file system, shows notifications, or edits documents.
8. **Injected client**: only composition roots bind the real `callClaude` (`registry.ts`). Offline tests use a fake client and never load `@/utils/claude`.
9. **No caching or versioning here**: the manual command calls the service directly, with no cache lookup, scheduler, quiet period or cooldown. The background `Detector` wrapper (Task 14) owns caching and needs a `version` covering the prompts, model and these validation rules.

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

- The scheduler marks a result stale when a newer snapshot of the same file arrived while the detector was running, or the file was closed (card 08: `result stale`, `eligible: false` in `onSettled`). A stale result may be cached, because it is correct for its own content, but must never be shown.
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

**Card 12 (proposed)** provides (a)'s input: `enumerateConstructs` returns every top-level class, interface and enum with its context from one parse, so no anchor or per-construct parse is needed (see "Construct enumeration (card 12)"). Calling the detector per construct is card 14.

## Card mapping

Every Sprint 1 card from 02 to 10, and Sprint 2's cards 11, 12 and 13, maps to at least one integration point and at least one proposed module.

| Card                                                 | Integration points                                                                        | Proposed modules                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 02 · Java File Event Monitoring                      | Command registry (listeners registered as disposables)                                    | `events/fileEventMonitor.ts`, `backgroundAgent.ts`                                                                 |
| 03 · Asynchronous Mock Detector                      | Context building (shape it must stay compatible with)                                     | `detector/mockDetector.ts`                                                                                         |
| 04 · SHA-256 Persistent Result Cache                 | Command registry (extension storage from `context`)                                       | `cache/resultCache.ts`, `backgroundAgent.ts`                                                                       |
| 05 · Event Coalescing                                | Command registry (via the composition root)                                               | `scheduler/scheduler.ts` (extends card 08's scheduler)                                                             |
| 06 · Per-file Debounce                               | Command registry (timers disposed on deactivation)                                        | `scheduler/scheduler.ts`, `scheduler/clock.ts`                                                                     |
| 07 · Per-file Cooldown                               | Command registry (timers disposed on deactivation)                                        | `scheduler/scheduler.ts`, `scheduler/clock.ts`                                                                     |
| 08 · In-flight Deduplication                         | Command registry (via the composition root)                                               | `scheduler/scheduler.ts`, `backgroundAgent.ts`                                                                     |
| 09 · Auto Save / Restart Tests & Demo                | Command registry (the status command; agent is re-created on each Extension Host restart) | `status/*`, `test/background/functional.test.ts`, `test/background/status.test.ts`                                 |
| 10 · Shared Detector Interface                       | Analysis flow; Context building; Pending-annotation display                               | `detector/detector.ts`, `backgroundAgent.ts`                                                                       |
| 11 · Detector Version Change & Open-file Re-analysis | Command registry (the setting listener and the recorded identity in `globalState`)        | `detector/versionTracker.ts`, `detector/*`, `events/*`, `scheduler/scheduler.ts`, `status/*`, `backgroundAgent.ts` |
| 12 · Tree-sitter Single-file Construct Enumeration   | Context building (one parse per file; the manual path unchanged)                          | `context/enumerateConstructs.ts`, `context/javaParser/*`, `context/buildContext.ts`                                |
| 13 · Decouple Manual Detection from Labeling UI      | Analysis flow; Command registry (binds `callClaude`)                                      | `detection/*`, `analyse.ts`, `registry.ts`, `utils/claude.ts`                                                      |

## Known issues & follow-ups

Found during the card 01 review. Only item 1 was fixed on this card; the rest are recorded for follow-up tickets.

| #   | Issue                                                                                                                                                                                                                                                                                                                                            | Status / proposed follow-up                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `compile` and `package` called `npm run lint`, which doesn't exist (the script is `lint:check`), so `npm run compile` failed after the type check.                                                                                                                                                                                               | **Fixed on this card**: both now call `lint:check`.                                                                                                                                                                                                                                                                                           |
| 2   | F5 fails on a clean machine with `Invalid problemMatcher reference: $esbuild-watch`, because the recommended esbuild Problem Matchers extension isn't installed. After that failed attempt, the `watch` task keeps running, so the next F5 silently waits on it.                                                                                 | Documented under [Build & launch](#build--launch). Optionally, have the README setup steps mention installing the recommended extensions.                                                                                                                                                                                                     |
| 17  | dotenv 17 prints `injected env (N) from …\.env` to the debug console on every activation (from `src/utils/claude.ts`).                                                                                                                                                                                                                           | Not fixed. Pass `quiet: true` to `dotenv.config` if the noise matters.                                                                                                                                                                                                                                                                        |
| 18  | `package.json` has no `publisher` field, so the extension id is `undefined_publisher.technicalcredit`. F5 works, but `vsce package` requires a publisher.                                                                                                                                                                                        | Not fixed. Add a `publisher` before packaging.                                                                                                                                                                                                                                                                                                |
| 19  | 43 of the 45 Java fixtures under `src/test/{behavioral,creational,structural}/{positive,negative}/` are empty placeholders (0 bytes, added in "TC-8 new test files created"). Only `src/test/creational/prototype/Positive.java` and `Negative.java` have content.                                                                               | Not fixed. Fill them in as heuristic tests are written; until then, use the prototype fixtures for manual checks.                                                                                                                                                                                                                             |
| 3   | The only offline test, `src/test/buildContextCore.test.ts`, reads `src/test/mockCode/MockTest.java`, which isn't tracked in git, so it fails.                                                                                                                                                                                                    | Not fixed. Restore the fixture or point the test at an existing one. Card 12's `src/test/context/` tests don't use `mockCode`.                                                                                                                                                                                                                |
| 4   | The README Testing section refers to `src/test/mockCode/` and `priorityHeuristicTests/h1…h5`, neither of which exists. The live tests now live under `src/test/creational/prototype/`.                                                                                                                                                           | Not fixed. Update the README.                                                                                                                                                                                                                                                                                                                 |
| 5   | There is no way to run only offline tests: `npm test` runs everything, including billed live tests.                                                                                                                                                                                                                                              | Not fixed. Propose a `test:offline` script (e.g. `jest src/test/background`) and/or move live tests behind an opt-in flag.                                                                                                                                                                                                                    |
| 6   | The README says Node 18+, but ESLint 10 needs Node `^20.19.0 \|\| ^22.13.0 \|\| >=24`.                                                                                                                                                                                                                                                           | Not fixed. Update the README prerequisites.                                                                                                                                                                                                                                                                                                   |
| 7   | `@types/vscode` is `^1.138.0` while `engines.vscode` is `^1.120.0`. F5 works, but `vsce package` refuses a types version newer than the engine.                                                                                                                                                                                                  | Not fixed. Align the two before packaging.                                                                                                                                                                                                                                                                                                    |
| 8   | `package.json` depends on `anthropic-ai@0.0.10`, an unofficial package from a different publisher than the official `@anthropic-ai/sdk`. Nothing in `src/` or `scripts/` imports it.                                                                                                                                                             | Not fixed. Propose removing it; it is a needless supply-chain exposure (C8: ask the team first).                                                                                                                                                                                                                                              |
| 9   | `npm install` reports 31 vulnerabilities (27 moderate, 2 high, 2 critical).                                                                                                                                                                                                                                                                      | Not fixed. Review `npm audit` output; Dependabot PRs cover part of this.                                                                                                                                                                                                                                                                      |
| 10  | `package-lock.json` was written by a newer npm. Running `npm install` with npm 10.7 strips its `libc` fields, which shows up as a spurious diff.                                                                                                                                                                                                 | Don't commit that drift (`git checkout -- package-lock.json`). Using a current npm avoids it.                                                                                                                                                                                                                                                 |
| 11  | On Windows with `core.autocrlf=true`, `npm run format:check` flags every file (CRLF vs. Prettier's LF), and `npm run format` would rewrite every file.                                                                                                                                                                                           | Not fixed. Use `git config core.autocrlf input` locally, or add a `.gitattributes` with `* text=auto eol=lf`.                                                                                                                                                                                                                                 |
| 12  | The README clone URL points at `cielbellerose/TechnicalCredit`, while this checkout's `origin` is the fork `XiaoyuZhou000/TechnicalCredit`.                                                                                                                                                                                                      | Not fixed. Confirm which repository the team treats as canonical.                                                                                                                                                                                                                                                                             |
| 13  | `resolveInsertLine` in `src/context/buildContext.ts` uses a non-null assertion (`enclosingClassStartRow!`), which goes against the repository's no-`!` convention.                                                                                                                                                                               | Not fixed. Model the type so the assertion isn't needed.                                                                                                                                                                                                                                                                                      |
| 14  | Live detection is construct-level (it needs a cursor anchor), but the agent is per-file.                                                                                                                                                                                                                                                         | Outlined on card 10, not built: see [Construct selection](#construct-selection).                                                                                                                                                                                                                                                              |
| 15  | Before showing a background result, check it still matches the document's current `contentHash` (US-09).                                                                                                                                                                                                                                         | Partly built on card 08: the scheduler classifies each result as current or stale. The display-time re-check is still to do before live integration; see [Stale-result guard (US-09)](#stale-result-guard-us-09).                                                                                                                             |
| 16  | `PendingAnnotation` can't show unsolicited background results (see [Pending-annotation display](#pending-annotation-display)).                                                                                                                                                                                                                   | Outlined on card 10, not built: see [Delivery through the labeling UI](#delivery-through-the-labeling-ui).                                                                                                                                                                                                                                    |
| 20  | `workspace.onDidCloseTextDocument` fires when VS Code disposes the document, which can lag behind the tab closing, and isn't guaranteed for every tab close (found on card 02).                                                                                                                                                                  | Not fixed. Card 02 reports closes whenever they arrive. If card 05 or 08 needs immediate closes, add `window.tabGroups.onDidChangeTabs` to the monitor. Card 11's runtime rescan reports only documents shown in a tab, so a closed tab whose document is still loaded isn't re-analysed by a version change.                                 |
| 21  | After a window reload, VS Code may restore tabs lazily, so a restored Java file can be reported as `'open'` (when first shown) instead of `'startup'` (found on card 02).                                                                                                                                                                        | Not a bug. Card 09's restart test and demo should accept either trigger.                                                                                                                                                                                                                                                                      |
| 22  | Card 03's temporary run sink starts a mock call on every edit, so the call count while typing is not card 09's demo count (found on card 03).                                                                                                                                                                                                    | Resolved on card 08: the scheduler never starts a second call while one runs, and runs only the latest edit afterwards. While typing there is still one call per settled request until debounce (card 06).                                                                                                                                    |
| 23  | Cached results are never pruned: entries for deleted or renamed files, closed workspaces and retired detector versions stay in `globalState` (found on card 04).                                                                                                                                                                                 | Bounded by files × detector versions, one entry each. Prune on activation by age once a policy is agreed.                                                                                                                                                                                                                                     |
| 24  | The cache keeps one entry per file and detector version, so when a stale result is stored after the file changed, it replaces the entry for the newer content. That newer content then misses and is analysed again (found on card 08).                                                                                                          | Costs at most one extra call when content goes back and forth during a call. Acceptable for Sprint 1; revisit if live calls make it expensive.                                                                                                                                                                                                |
| 25  | Interface lists are always empty. The bundled grammar puts `implements`/`extends` lists in a `type_list` node, but `resolveInterfaceNames` and `extractInterfaceMetrics` look for `interface_type_list`, so `implementedInterfaces`, `extendedInterfaces` and nested `implementedInterfaces` are `[]` in every manual prompt (found on card 12). | Not fixed on card 12, which must keep the manual context identical; enum interfaces match classes. Fix proposed as its own card (`tc-ba-task13-fix-interface-lists`); it changes manual prompts, so it needs team agreement, a deliberate update of `src/test/context/__snapshots__/manualContext.test.ts.snap`, and a live heuristic re-run. |
| 26  | The `TCResult` validation rules exist twice: in `detection/validateAnswer.ts` (card 13) and in the cache's private `parseResult` (card 04).                                                                                                                                                                                                      | Not fixed on card 13, which may not change card 04's code. `validateAnswer.test.ts` keeps the two consistent by storing service findings in `ResultCache` and reading them back. Move one validator into a shared module on a card that may change the cache.                                                                                 |
