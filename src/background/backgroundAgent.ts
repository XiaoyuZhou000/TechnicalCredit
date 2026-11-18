import * as vscode from 'vscode';

import { startFileEventMonitor } from '@/background/events/fileEventMonitor';
import {
  createLoggingSink,
  describeSinkError,
} from '@/background/events/loggingSink';

/** Composition root for the Background Agent; every piece it creates is disposed with the extension. */
export function startBackgroundAgent(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(
    'Technical Credit (Background)',
  );
  // Card 05 replaces the logging sink with the scheduler.
  const sink = createLoggingSink((line) => channel.appendLine(line));
  const monitor = startFileEventMonitor(sink, (error) =>
    channel.appendLine(describeSinkError(error)),
  );

  context.subscriptions.push(channel, monitor);
}
