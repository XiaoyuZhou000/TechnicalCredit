import { createHash } from 'crypto';
import * as vscode from 'vscode';

import { MockDetector } from '@/background/detector/mockDetector';
import { createDetectorRunSink } from '@/background/events/detectorRunSink';
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
  const log = (line: string): void => channel.appendLine(line);
  // Card 05 replaces the run sink with the scheduler and keeps the mock as its detector.
  const runSink = createDetectorRunSink({
    inner: createLoggingSink(log),
    detector: new MockDetector(),
    hash: (content) =>
      createHash('sha256').update(content, 'utf8').digest('hex'),
    log,
    now: () => Date.now(),
  });
  const monitor = startFileEventMonitor(runSink, (error) =>
    log(describeSinkError(error)),
  );

  // Stop the events first and the channel last, so no in-flight call logs to a closed channel.
  context.subscriptions.push(monitor, runSink, channel);
}
