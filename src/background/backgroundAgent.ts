import * as vscode from 'vscode';

import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import {
  DEFAULT_MOCK_VERSION,
  MockDetector,
} from '@/background/detector/mockDetector';
import { DetectorVersionTracker } from '@/background/detector/versionTracker';
import { startFileEventMonitor } from '@/background/events/fileEventMonitor';
import {
  createLoggingSink,
  describeSinkError,
} from '@/background/events/loggingSink';
import type { Clock } from '@/background/scheduler/clock';
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_CONCURRENT,
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

const SETTINGS_SECTION = 'technicalcredit.background';
const MOCK_VERSION_SETTING = 'mockDetectorVersion';

/** The mock's version from settings (card 11), or why the value can't be used. */
function readMockVersion():
  | { readonly version: string }
  | { readonly reason: string } {
  const value = vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .get<unknown>(MOCK_VERSION_SETTING);
  if (typeof value === 'string' && value !== '') {
    return { version: value };
  }
  return {
    reason:
      typeof value === 'string' ? 'empty' : `not a string (${typeof value})`,
  };
}

function settingIgnored(log: (line: string) => void, reason: string): void {
  log(
    `${new Date(realClock.now()).toISOString()} detector version setting ignored: ${reason}`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const configured = readMockVersion();
  if ('reason' in configured) {
    settingIgnored(log, `${configured.reason}; using ${DEFAULT_MOCK_VERSION}`);
  }
  const detector = new MockDetector({
    timers: realClock,
    version:
      'version' in configured ? configured.version : DEFAULT_MOCK_VERSION,
  });
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
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
  });
  // Compared before the startup scan, so the change is known when its count is logged. Only
  // the settings listener below can announce a change, and it exists only once the monitor does.
  const tracker = new DetectorVersionTracker({
    detector,
    store: context.globalState,
    clock: realClock,
    log,
    rescan: () => monitor.rescan(),
  });
  tracker.begin();
  const monitor = startFileEventMonitor(scheduler, (error) =>
    log(describeSinkError(error)),
  );
  tracker.startupScheduled(monitor.startupCount);
  // A runtime version change for demos and tests (card 11): the mock announces, the tracker
  // rescans the open files.
  const versionSetting = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      !event.affectsConfiguration(`${SETTINGS_SECTION}.${MOCK_VERSION_SETTING}`)
    ) {
      return;
    }
    const next = readMockVersion();
    if ('reason' in next) {
      settingIgnored(log, `${next.reason}; keeping ${detector.version}`);
      return;
    }
    try {
      detector.setVersion(next.version);
    } catch (error) {
      settingIgnored(log, `${messageOf(error)}; keeping ${detector.version}`);
    }
  });
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
    versionSetting,
    showStatus,
    statusPanel,
    tracker,
    scheduler,
    channel,
  );
  // Last, so a start that throws earlier keeps the old identity and is detected again (card 11).
  void tracker.confirmStarted();
}
