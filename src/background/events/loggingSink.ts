import type { SnapshotSink } from '@/background/events/fileEvents';

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Placeholder sink until the scheduler (card 05) replaces it. Never logs file text: it
 * would bloat the channel and leak source code into shared screenshots.
 */
export function createLoggingSink(log: (line: string) => void): SnapshotSink {
  return {
    submit: (s) => {
      log(
        `${iso(s.observedAt)} ${s.trigger} v${s.version} ${s.content.length} chars ${s.fileUri} [${s.workspaceId}]`,
      );
    },
    closed: (n) => {
      log(`${iso(n.observedAt)} closed ${n.fileUri} [${n.workspaceId}]`);
    },
  };
}

export function describeSinkError(error: unknown): string {
  return `sink error: ${error instanceof Error ? error.message : String(error)}`;
}
