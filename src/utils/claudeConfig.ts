/**
 * Everything about a Claude request except its prompts. Kept free of the SDK and `.env`, so
 * the background detector's fingerprint (card 14) can read the model offline.
 */
export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const CLAUDE_MAX_TOKENS = 4096;
/** Timing only: never part of a detector version. */
export const CLAUDE_TIMEOUT_MS = 30_000;

/**
 * Sent before every user message. A mid-conversation assistant turn (not a last-turn prefill)
 * primes raw JSON responses.
 */
export const CLAUDE_PRIMING_TURNS = [
  { role: 'user', content: 'Respond only with a JSON object.' },
  { role: 'assistant', content: '{"ok": true}' },
] as const;
