import * as vscode from 'vscode';

import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
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
  // `globalState` persists across restarts; no `setKeysForSync`, so results stay on this machine.
  const cache = new ResultCache({
    store: context.globalState,
    now: () => Date.now(),
  });
  // Card 05 replaces the run sink with the scheduler, which takes over the cache check and
  // keeps the mock as its detector.
  const runSink = createDetectorRunSink({
    inner: createLoggingSink(log),
    detector: new MockDetector(),
    hash: sha256Hex,
    log,
    now: () => Date.now(),
    cache,
  });
  const monitor = startFileEventMonitor(runSink, (error) =>
    log(describeSinkError(error)),
  );

  // Stop the events first and the channel last, so no in-flight call logs to a closed channel.
  context.subscriptions.push(monitor, runSink, channel);
}
