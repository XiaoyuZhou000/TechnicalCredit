import * as vscode from 'vscode';

import {
  FileEventHandler,
  rescanOrder,
  type SnapshotSink,
} from '@/background/events/fileEvents';

/**
 * The running monitor. `startupCount` is what its startup scan forwarded, and `rescan()`
 * re-reports the open files after a detector version change, returning how many (card 11).
 */
export type FileEventMonitor = vscode.Disposable & {
  readonly startupCount: number;
  rescan(): number;
};

/** URIs shown in a text editor tab; unloaded background tabs are listed but never loaded. */
function tabbedUris(): Set<string> {
  const uris = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        uris.add(tab.input.uri.toString());
      }
    }
  }
  return uris;
}

/**
 * Wires editor document events to the vscode-free handler. Each listener is one call with
 * no branching, so all filtering stays in code the offline tests cover.
 */
export function startFileEventMonitor(
  sink: SnapshotSink,
  onSinkError: (error: unknown) => void,
): FileEventMonitor {
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

  const startupCount = handler.startup(vscode.workspace.textDocuments);

  const disposable = vscode.Disposable.from(...listeners, {
    dispose: () => handler.stop(),
  });
  return {
    startupCount,
    rescan: () =>
      handler.rescan(
        rescanOrder(vscode.workspace.textDocuments, tabbedUris(), [
          vscode.window.activeTextEditor?.document,
          ...vscode.window.visibleTextEditors.map((editor) => editor.document),
        ]),
      ),
    dispose: () => {
      disposable.dispose();
    },
  };
}
