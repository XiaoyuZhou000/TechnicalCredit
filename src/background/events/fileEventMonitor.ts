import * as vscode from 'vscode';

import {
  FileEventHandler,
  type SnapshotSink,
} from '@/background/events/fileEvents';

/**
 * Wires editor document events to the vscode-free handler. Each listener is one call with
 * no branching, so all filtering stays in code the offline tests cover.
 */
export function startFileEventMonitor(
  sink: SnapshotSink,
  onSinkError: (error: unknown) => void,
): vscode.Disposable {
  const handler = new FileEventHandler<vscode.TextDocument>({
    sink,
    now: () => Date.now(),
    workspaceIdOf: (doc) =>
      vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString(),
    onSinkError,
  });

  const listeners = [
    vscode.workspace.onDidOpenTextDocument((doc) => handler.opened(doc)),
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      handler.activated(editor?.document),
    ),
  ];

  return vscode.Disposable.from(...listeners, {
    dispose: () => handler.stop(),
  });
}
