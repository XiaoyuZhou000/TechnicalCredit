import { randomBytes } from 'crypto';

import * as vscode from 'vscode';

import type { Clock } from '@/background/scheduler/clock';
import type { StatusSource } from '@/background/status/backgroundStatus';
import { StatusFeed } from '@/background/status/statusFeed';

/**
 * The one VS Code-facing piece of card 09's status page. Everything it shows and every timer
 * live in the vscode-free `StatusFeed`; this only owns the single webview tab.
 */
export class BackgroundStatusPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private feed?: StatusFeed;

  constructor(
    private readonly status: StatusSource,
    private readonly clock: Clock,
  ) {}

  /** Opens the tab beside the editor, or reveals it: there is never a second one. */
  show(): void {
    if (this.panel !== undefined) {
      this.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'technicalcredit.backgroundStatus',
      'Technical Credit: Background Status',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // No scripts and no local resources: the page can only show, never act (constitution VIII).
      { enableScripts: false, localResourceRoots: [] },
    );
    this.panel = panel;
    this.feed = new StatusFeed({
      status: this.status,
      clock: this.clock,
      render: (html) => {
        panel.webview.html = html;
      },
      nonce: () => randomBytes(16).toString('base64'),
    });
    panel.onDidDispose(() => {
      this.feed?.dispose();
      this.feed = undefined;
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
