import type { AdrSummary } from '@/context/findAdrs';

// createAdrUserPrompt joins an ADR's id, title and tc context with this separator.
const SEPARATOR = ' — ';

/** Ignores case and runs of whitespace, including around the separator. */
function normalizeText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ ?— ?/g, SEPARATOR);
}

/** `ADR-7` and `ADR-0007` name one record: findAdrs pads a filename's digits. */
function idKey(id: string): string {
  const text = normalizeText(id);
  const numbered = /^adr ?- ?0*(\d+)$/.exec(text);
  return numbered ? `adr-${numbered[1]}` : text;
}

/** The answer is the ADR's id, alone or followed by its listed title. */
function namesAdr(answer: string, adr: AdrSummary): boolean {
  const key = idKey(adr.id);
  if (idKey(answer) === key) {
    return true;
  }
  // A model that copies its whole listed line also repeats the tc context after the title.
  const titles = [
    adr.title,
    [adr.title, adr.tcContext].filter(Boolean).join(SEPARATOR),
  ].map(normalizeText);
  // Ids and titles may themselves contain the separator, so try every split.
  for (
    let at = answer.indexOf(SEPARATOR);
    at !== -1;
    at = answer.indexOf(SEPARATOR, at + 1)
  ) {
    if (
      idKey(answer.slice(0, at)) === key &&
      titles.includes(answer.slice(at + SEPARATOR.length))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The canonical id of the one workspace ADR the model's answer names, or null. An answer that
 * names no ADR, names several, or names an id that several records share is no match, so a
 * finding never cites an ADR the reader can't find.
 */
export function resolveAdrId(
  candidate: unknown,
  adrs: readonly AdrSummary[],
): string | null {
  if (typeof candidate !== 'string') {
    return null;
  }
  const answer = normalizeText(candidate);
  const [match, ...others] = adrs.filter((adr) => namesAdr(answer, adr));
  if (match === undefined || others.length > 0) {
    return null;
  }
  const key = idKey(match.id);
  const shared = adrs.filter((adr) => idKey(adr.id) === key).length > 1;
  return shared ? null : match.id;
}
