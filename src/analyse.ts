import * as vscode from 'vscode';

import { buildContext } from '@/context/buildContext';
import { findAdrs } from '@/context/findAdrs';
import { formatTCComment } from '@/comment/formatComment';
import type { PendingAnnotation } from '@/comment/pendingAnnotation';
import {
  detectTechnicalCredit,
  type ClaudeClient,
} from '@/detection/detectTechnicalCredit';

/**
 * Analyses the construct at the cursor for Technical Credit and previews an annotation for each
 * finding. Detection itself is the shared service; this adapter owns the editor, progress,
 * messages and preview. It deliberately bypasses the background cache and scheduler.
 */
export async function analyseForTC(
  controller: Pick<PendingAnnotation, 'previewAll'>,
  client: ClaudeClient,
) {
  // Check for active editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Analyse for TC: no active editor.');
    return;
  }

  const context = await buildContext(editor);

  if (!context) {
    vscode.window.showErrorMessage(
      'Analyse for TC: cursor is not inside a class or interface.',
    );
    return;
  }

  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const adrs = workspaceRoot ? findAdrs(workspaceRoot) : [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Analysing for TC…',
      cancellable: false,
    },
    async () => {
      // The command offers no cancel button, so this signal never aborts.
      const outcome = await detectTechnicalCredit(
        { context, adrs },
        client,
        new AbortController().signal,
      );

      if (!outcome.ok) {
        const { failure } = outcome;
        const reason =
          failure.kind === 'failed'
            ? failure.message
            : failure.kind === 'timeout'
              ? 'a Claude call timed out'
              : 'cancelled';
        vscode.window.showErrorMessage(`Analyse for TC failed: ${reason}`);
        return;
      }

      if (outcome.findings.length === 0) {
        vscode.window.showInformationMessage('No TC detected in this class.');
        return;
      }

      try {
        const comments = outcome.findings.map((r) =>
          formatTCComment(r, context.insertIndent),
        );
        await controller.previewAll(editor, comments, context.insertLine);
      } catch (e) {
        vscode.window.showErrorMessage(`Analyse for TC failed: ${e}`);
      }
    },
  );
}
