import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import * as path from 'path';

import {
  CLAUDE_MAX_TOKENS,
  CLAUDE_MODEL,
  CLAUDE_PRIMING_TURNS,
  CLAUDE_TIMEOUT_MS,
} from '@/utils/claudeConfig';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/** Tokens billed for one response, as the API reports them. */
export interface ClaudeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * `signal` lets the caller cancel; the per-call timeout applies either way. When the timeout
 * ends the call, it rejects with the timeout's `TimeoutError` DOMException rather than the SDK's
 * abort error, so callers can tell a timeout from a cancellation or an API failure.
 *
 * `onUsage` (card 15A, optional) hears the tokens of every response received, before its
 * answer is parsed, since a response that fails to parse is billed too.
 */
export async function callClaude<T>(
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
  onUsage?: (usage: ClaudeUsage) => void,
): Promise<T> {
  const timeout = AbortSignal.timeout(CLAUDE_TIMEOUT_MS);
  let response: Anthropic.Message;
  try {
    response = await claude.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: systemPrompt,
        messages: [
          ...CLAUDE_PRIMING_TURNS,
          { role: 'user', content: userMessage },
        ],
      },
      { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    );
  } catch (e) {
    // The SDK reports every abort alike; the caller's own abort keeps the SDK's error.
    if (timeout.aborted && !signal?.aborted) {
      throw timeout.reason;
    }
    throw e;
  }
  onUsage?.({
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  return JSON.parse(raw) as T;
}
