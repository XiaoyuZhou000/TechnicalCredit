# Background Agent Architecture Review

This review is the output of Trello card **01 · Repository Setup & Architecture Review** (Sprint 1, CS6510 Technical Credit Background Agent). It records how to build and launch the existing extension, where the Sprint 1 Background Agent attaches to it, which constraints apply, and a proposed module layout for cards 02–10.

Sprint 1 scope is a mock detector only, with **no live Claude calls**.

## Overview

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

## Proposed contracts

## Card mapping

Every Sprint 1 card from 02 to 10 maps to at least one integration point and at least one proposed module.

| Card                                  | Integration points                                                    | Proposed modules |
| ------------------------------------- | --------------------------------------------------------------------- | ---------------- |
| 02 · Java File Event Monitoring       | Command registry (listeners registered as disposables)                |                  |
| 03 · Asynchronous Mock Detector       | Context building (shape it must stay compatible with)                 |                  |
| 04 · SHA-256 Persistent Result Cache  | Command registry (extension storage from `context`)                   |                  |
| 05 · Event Coalescing                 | Command registry (via the composition root)                           |                  |
| 06 · Per-file Debounce                | Command registry (timers disposed on deactivation)                    |                  |
| 07 · Per-file Cooldown                | Command registry (timers disposed on deactivation)                    |                  |
| 08 · In-flight Deduplication          | Command registry (via the composition root)                           |                  |
| 09 · Auto Save / Restart Tests & Demo | Command registry (agent is re-created on each Extension Host restart) |                  |
| 10 · Shared Detector Interface        | Analysis flow; Context building; Pending-annotation display           |                  |

## Known issues & follow-ups
