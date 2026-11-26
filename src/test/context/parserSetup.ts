import * as path from 'path';

import { setExtensionPath } from '@/context/javaParser';

/**
 * Points the Java parser at the repository root, as the extension does at activation. It
 * loads `dist/web-tree-sitter.wasm` and `dist/tree-sitter-java.wasm`, so `npm run compile` must
 * have run once. Unlike `src/test/support/analyseLive.ts`, this pulls in nothing that calls
 * Claude.
 */
export function initParser(): void {
  setExtensionPath(path.join(__dirname, '../../../'));
}
