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

## Known issues & follow-ups
