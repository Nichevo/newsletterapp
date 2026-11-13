import { PDF_MAX_PAGES } from '@newsletterapp/shared';

/**
 * Limits set in the app (Settings > PC helper and AI), refreshed at each check-in.
 * Until the app says otherwise, the helper's own config and the old fixed values apply.
 */
export const pcLimits: { maxChars: number | null; pdfMaxPages: number } = { maxChars: null, pdfMaxPages: PDF_MAX_PAGES };

export function updateLimits(config: { aiMaxChars?: number; pdfMaxPages?: number }): void {
  if (typeof config.aiMaxChars === 'number' && config.aiMaxChars >= 4_000 && config.aiMaxChars <= 200_000) pcLimits.maxChars = config.aiMaxChars;
  if (typeof config.pdfMaxPages === 'number' && config.pdfMaxPages >= 1 && config.pdfMaxPages <= 1_000) pcLimits.pdfMaxPages = config.pdfMaxPages;
}

/** Characters of text the model reads: the app's setting, else the helper's config file. */
export const maxChars = (fallback: number): number => pcLimits.maxChars ?? fallback;

/**
 * Ollama's context window, in tokens, sized to fit the text plus the prompt and the reply
 * (about 3 characters a token for English, with room to spare). Never below the old 16k.
 */
export function contextTokens(chars: number): number {
  return Math.max(16_384, Math.ceil((chars / 3 + 4_096) / 4_096) * 4_096);
}
