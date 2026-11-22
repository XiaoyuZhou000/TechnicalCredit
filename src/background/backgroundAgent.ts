import * as vscode from 'vscode';

import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import { MockDetector } from '@/background/detector/mockDetector';
import { startFileEventMonitor } from '@/background/events/fileEventMonitor';
import {
  createLoggingSink,
  describeSinkError,
} from '@/background/events/loggingSink';
import { Scheduler } from '@/background/scheduler/scheduler';

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
  // Cards 05–07 add coalescing, debounce and cooldown to this scheduler, not a second sink.
  const scheduler = new Scheduler({
    inner: createLoggingSink(log),
    detector: new MockDetector(),
    cache,
    hash: sha256Hex,
    log,
    now: () => Date.now(),
  });
  const monitor = startFileEventMonitor(scheduler, (error) =>
    log(describeSinkError(error)),
  );

  // Stop the events first and the channel last, so no in-flight call logs to a closed channel.
  context.subscriptions.push(monitor, scheduler, channel);
}
