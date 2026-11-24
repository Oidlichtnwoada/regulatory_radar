import { getEncoding, type Tiktoken } from 'js-tiktoken';

/** Token counting and truncation for one embedding model. */
export interface TokenBudget {
  /** Maximum input tokens the model accepts. */
  readonly maxInputTokens: number;
  /** Token count of a text (exact or a safe over-estimate). */
  readonly count: (text: string) => number;
  /** The longest prefix of `text` that stays within `maxTokens`. */
  readonly truncate: (text: string, maxTokens: number) => string;
}

/** cl100k_base, loaded once on first use (bundled ranks, no network). */
const encoder = ((): (() => Tiktoken) => {
  const cache: { enc?: Tiktoken } = {}; // contained lazy cache: loading the ranks is expensive
  return () => {
    cache.enc ??= getEncoding('cl100k_base');
    return cache.enc;
  };
})();

/**
 * Budget based on cl100k_base. `factor` 1 is exact for OpenAI's text-embedding-3 models; Mistral's tokenizer
 * is not available in JS, so its count is cl100k scaled up by a safety factor (never under-counts in practice).
 */
export const tokenBudget = (maxInputTokens: number, factor = 1): TokenBudget => ({
  maxInputTokens,
  count: (text) => Math.ceil(encoder().encode(text).length * factor),
  truncate: (text, maxTokens) => {
    const tokens = encoder().encode(text);
    const keep = Math.floor(maxTokens / factor);
    return tokens.length <= keep ? text : encoder().decode(tokens.slice(0, keep));
  },
});
