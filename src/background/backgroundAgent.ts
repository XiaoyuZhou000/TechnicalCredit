import * as vscode from 'vscode';

import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import {
  BackgroundDetector,
  type DetectorMode,
  type LiveCallGate,
} from '@/background/detector/backgroundDetector';
import type { DetectorInput } from '@/background/detector/detector';
import {
  DEFAULT_MOCK_VERSION,
  MockDetector,
  versionProblem,
} from '@/background/detector/mockDetector';
import { RealDetector } from '@/background/detector/realDetector';
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
import { findAdrs, type AdrSummary } from '@/context/findAdrs';
import { callClaude } from '@/utils/claude';

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
const DETECTOR_SETTING = 'detector';
const DEFAULT_MODE: DetectorMode = 'mock';

/**
 * Card 14: live background calls wait for card 15's enablement, credential and usage limits.
 * Until then real mode is wired but inert: every real-mode call is skipped, and no Claude call
 * is made. Card 15 replaces this gate.
 */
const LIVE_CALLS: LiveCallGate = {
  permitted: false,
  reason: 'live background analysis waits for card 15',
};

/** The mock's version from settings (card 11), or why the value can't be used. */
function readMockVersion():
  | { readonly version: string }
  | { readonly reason: string } {
  const value = vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .get<unknown>(MOCK_VERSION_SETTING);
  if (typeof value !== 'string') {
    return { reason: `not a string (${typeof value})` };
  }
  const problem = versionProblem(value);
  return problem === undefined ? { version: value } : { reason: problem };
}

/** The background detector mode from settings (card 14), or why the value can't be used. */
function readDetectorMode():
  | { readonly mode: DetectorMode }
  | { readonly reason: string } {
  const value = vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .get<unknown>(DETECTOR_SETTING);
  // Unset reads as undefined when the host hasn't registered the contributed default (seen in
  // an Extension Development Host started before the setting existed); that is the default.
  if (value === undefined) {
    return { mode: DEFAULT_MODE };
  }
  return value === 'mock' || value === 'real'
    ? { mode: value }
    : {
        reason: `${JSON.stringify(value)} is not "mock" or "real"`,
      };
}

/** The ADRs of the snapshot's own workspace folder, read as the manual command reads them. */
function adrsFor(input: DetectorInput): readonly AdrSummary[] {
  const folder = vscode.workspace.workspaceFolders?.find(
    (f) => f.uri.toString() === input.workspaceId,
  );
  return folder === undefined ? [] : findAdrs(folder.uri.fsPath);
}

function settingIgnored(
  log: (line: string) => void,
  setting: string,
  reason: string,
): void {
  log(
    `${new Date(realClock.now()).toISOString()} ${setting} setting ignored: ${reason}`,
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
    settingIgnored(
      log,
      'detector version',
      `${configured.reason}; using ${DEFAULT_MOCK_VERSION}`,
    );
  }
  const mock = new MockDetector({
    timers: realClock,
    version:
      'version' in configured ? configured.version : DEFAULT_MOCK_VERSION,
  });
  const configuredMode = readDetectorMode();
  if ('reason' in configuredMode) {
    settingIgnored(
      log,
      'detector mode',
      `${configuredMode.reason}; using ${DEFAULT_MODE}`,
    );
  }
  // Card 14: the same detection core as the manual command. Its client is bound only here.
  const real = new RealDetector({
    client: (systemPrompt, userMessage, signal) =>
      callClaude(systemPrompt, userMessage, signal),
    adrsFor,
    clock: realClock,
    fileNameOf: (fileUri) => vscode.Uri.parse(fileUri).fsPath,
  });
  const detector = new BackgroundDetector({
    mock,
    real,
    mode: 'mode' in configuredMode ? configuredMode.mode : DEFAULT_MODE,
    liveCalls: () => LIVE_CALLS,
  });
  const logGate = (): void => {
    if (detector.mode === 'real' && !LIVE_CALLS.permitted) {
      log(
        `${new Date(realClock.now()).toISOString()} real detector selected; no Claude call is made: ${LIVE_CALLS.reason}`,
      );
    }
  };
  logGate();
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
  // A runtime version change (card 11) or detector switch (card 14): the background detector
  // announces, and the tracker rescans the open files.
  const versionSetting = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration(`${SETTINGS_SECTION}.${MOCK_VERSION_SETTING}`)
    ) {
      const next = readMockVersion();
      if ('reason' in next) {
        settingIgnored(
          log,
          'detector version',
          `${next.reason}; keeping ${mock.version}`,
        );
      } else {
        try {
          mock.setVersion(next.version);
        } catch (error) {
          settingIgnored(
            log,
            'detector version',
            `${messageOf(error)}; keeping ${mock.version}`,
          );
        }
      }
    }
    if (event.affectsConfiguration(`${SETTINGS_SECTION}.${DETECTOR_SETTING}`)) {
      const next = readDetectorMode();
      if ('reason' in next) {
        settingIgnored(
          log,
          'detector mode',
          `${next.reason}; keeping ${detector.mode}`,
        );
      } else if (next.mode !== detector.mode) {
        detector.setMode(next.mode);
        logGate();
      }
    }
  });
  // Card 09's read-only status page; the output channel stays for diagnosis.
  const statusPanel = new BackgroundStatusPanel(
    new BackgroundStatus({
      scheduler,
      cache,
      clock: realClock,
      detector,
      label: () => detector.label,
      tracker,
      limit: DEFAULT_MAX_CONCURRENT,
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
    { dispose: () => detector.dispose() },
    channel,
  );
  // Last, so a start that throws earlier keeps the old identity and is detected again (card 11).
  void tracker.confirmStarted();
}
