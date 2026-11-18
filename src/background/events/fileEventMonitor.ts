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
    vscode.workspace.onDidChangeTextDocument((e) =>
      handler.changed(e.document, e.contentChanges.length),
    ),
    vscode.workspace.onDidSaveTextDocument((doc) => handler.saved(doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => handler.closed(doc)),
  ];

  handler.startup(vscode.workspace.textDocuments);

  return vscode.Disposable.from(...listeners, {
    dispose: () => handler.stop(),
  });
}
