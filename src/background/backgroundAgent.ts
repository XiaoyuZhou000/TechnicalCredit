import * as vscode from 'vscode';

import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import { MockDetector } from '@/background/detector/mockDetector';
import { startFileEventMonitor } from '@/background/events/fileEventMonitor';
import {
  createLoggingSink,
  describeSinkError,
} from '@/background/events/loggingSink';
import type { Clock } from '@/background/scheduler/clock';
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_QUIET_MS,
  Scheduler,
} from '@/background/scheduler/scheduler';
import { BackgroundStatus } from '@/background/status/backgroundStatus';
import { BackgroundStatusPanel } from '@/background/status/statusPanel';

/** The one place real time is bound; core modules only ever see a `Clock`. */
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  // Handles only ever come from `setTimeout` above, so the narrowing is safe.
  clearTimeout: (handle) =>
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** Composition root for the Background Agent; every piece it creates is disposed with the extension. */
export function startBackgroundAgent(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(
    'Technical Credit (Background)',
  );
  const log = (line: string): void => channel.appendLine(line);
  // `globalState` persists across restarts; no `setKeysForSync`, so results stay on this machine.
  const cache = new ResultCache({
    store: context.globalState,
    now: () => realClock.now(),
  });
  const detector = new MockDetector({ timers: realClock });
  // Cards 05–07 add coalescing, debounce and cooldown to this scheduler, not a second sink.
  const scheduler = new Scheduler({
    inner: createLoggingSink(log),
    detector,
    cache,
    hash: sha256Hex,
    log,
    clock: realClock,
    quietMs: DEFAULT_QUIET_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
  });
  const monitor = startFileEventMonitor(scheduler, (error) =>
    log(describeSinkError(error)),
  );
  // Card 09's read-only status page; the output channel stays for diagnosis.
  const statusPanel = new BackgroundStatusPanel(
    new BackgroundStatus({
      scheduler,
      cache,
      clock: realClock,
      detector,
      label: 'Sprint 1 mock detector',
    }),
    realClock,
  );
  const showStatus = vscode.commands.registerCommand(
    'technicalcredit.showBackgroundStatus',
    () => statusPanel.show(),
  );

  // Stop the events first, then the page, and the channel last, so nothing logs to a closed
  // channel.
  context.subscriptions.push(
    monitor,
    showStatus,
    statusPanel,
    scheduler,
    channel,
  );
}
