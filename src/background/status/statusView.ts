import type { FileStatus } from '@/background/scheduler/scheduler';
import type { StatusSnapshot } from '@/background/status/backgroundStatus';

export interface RenderOptions {
  /** Per render; the only style block carries it, and the CSP allows nothing else. */
  readonly nonce: string;
  /** Defaults to local `HH:MM:SS`; tests pass a fixed one. */
  readonly formatTime?: (ms: number) => string;
}

/** File URIs come from the user's workspace, so everything shown is escaped. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function basename(uri: string): string {
  const name = uri.slice(uri.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const findings = (n: number): string => `${n} finding${n === 1 ? '' : 's'}`;

function versionCell(part?: {
  readonly version: number;
  readonly contentHash: string;
}): string {
  return part === undefined
    ? '—'
    : escapeHtml(`v${part.version} ${part.contentHash.slice(0, 8)}`);
}

function waitingCell(file: FileStatus, time: (ms: number) => string): string {
  if (file.keptUntil !== undefined) {
    return escapeHtml(`closed · cooldown until ${time(file.keptUntil)}`);
  }
  if (
    file.pending === undefined ||
    file.waitingFor === undefined ||
    file.eligibleAt === undefined
  ) {
    return '—';
  }
  return escapeHtml(`${file.waitingFor} until ${time(file.eligibleAt)}`);
}

function latestCell(file: FileStatus): string {
  const latest = file.latest;
  if (latest === undefined) {
    return '—';
  }
  if (!latest.ok) {
    return escapeHtml(`failed (v${latest.version})`);
  }
  const state = latest.current ? 'current' : 'stale';
  const source = latest.source === 'cache' ? 'cached' : 'analysed';
  return escapeHtml(
    `${state} · ${source} v${latest.version} · ${findings(latest.findings ?? 0)}`,
  );
}

function row(file: FileStatus, time: (ms: number) => string): string {
  const name = escapeHtml(basename(file.fileUri));
  const location = escapeHtml(file.fileUri);
  return `<tr>
<td><span class="name">${name}</span><br><span class="uri">${location}</span></td>
<td>${versionCell(file.active)}</td>
<td>${versionCell(file.pending)}</td>
<td>${waitingCell(file, time)}</td>
<td>${latestCell(file)}</td>
</tr>`;
}

/**
 * The whole page as one HTML string. Pure, so card 09's tests check it offline. It has no
 * scripts, forms or inputs: with nothing to click, the page can only show, never act.
 */
export function renderStatusHtml(
  snapshot: StatusSnapshot,
  options: RenderOptions,
): string {
  const time = options.formatTime ?? localTime;
  const nonce = escapeHtml(options.nonce);
  const s = snapshot.session;
  const counters: readonly (readonly [string, number])[] = [
    ['Analyses', s.analyses],
    ['Follow-ups', s.followUps],
    ['Repeats ignored', s.repeats],
    ['Cache hits', s.cacheHits],
    ['Cache misses', s.cacheMisses],
    ['Results stored', s.cacheStored],
  ];
  const body =
    snapshot.files.length === 0
      ? '<p class="empty">No Java files tracked yet</p>'
      : `<table>
<thead><tr><th>File</th><th>Running</th><th>Waiting</th><th>Waiting for</th><th>Latest result</th></tr></thead>
<tbody>
${snapshot.files.map((file) => row(file, time)).join('\n')}
</tbody>
</table>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'">
<title>Technical Credit: Background Status</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1em; }
.label { display: inline-block; padding: 2px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
dl { display: grid; grid-template-columns: max-content max-content; gap: 2px 1em; }
dt { opacity: 0.8; }
dd { margin: 0; font-weight: bold; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
.uri { opacity: 0.7; font-size: 0.85em; }
.empty { opacity: 0.8; }
</style>
</head>
<body>
<h1>Background status</h1>
<p><span class="label">${escapeHtml(snapshot.label)}</span> ${escapeHtml(snapshot.detector)} · updated ${escapeHtml(time(snapshot.takenAt))}</p>
<dl>
${counters.map(([name, value]) => `<dt>${escapeHtml(name)}</dt>\n<dd>${value}</dd>`).join('\n')}
</dl>
${body}
</body>
</html>`;
}
