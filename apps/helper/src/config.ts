import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Settings on the PC. Secrets stay here and never go to the app. */
export interface LocalConfig {
  /** e.g. https://app.techylearnings.com */
  appUrl: string;
  /** Cloudflare Access service token for the helper. */
  clientId: string;
  clientSecret: string;
  ollamaUrl: string;
  /** Other OpenAI-compatible servers, e.g. LM Studio on this PC, or a hosted service. */
  openaiCompatible: { name: string; baseUrl: string; apiKey?: string }[];
  /** Optional; only used if a Claude model is switched on in the app. */
  anthropicApiKey?: string;
  /** Characters of newsletter text sent to the model. */
  maxChars: number;
  /** Edge or Chrome for pages built by JavaScript; found on its own when left out. */
  browserPath?: string;
}

/** %LOCALAPPDATA%\NewsletterHelper on Windows, ~/.newsletter-helper elsewhere. */
export function dataDir(): string {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'NewsletterHelper') : join(homedir(), '.newsletter-helper');
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return base;
}

export const configPath = () => process.env.HELPER_CONFIG ?? join(dataDir(), 'config.json');

function toList(value: unknown): LocalConfig['openaiCompatible'] {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' && 'baseUrl' in value ? [value as LocalConfig['openaiCompatible'][number]] : [];
}

export function loadConfig(): LocalConfig {
  const path = configPath();
  if (!existsSync(path)) throw new Error(`No config at ${path}. Run install-helper.ps1 first.`);
  // Windows PowerShell 5 saves UTF-8 with a BOM, which JSON.parse rejects.
  const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Partial<LocalConfig>;
  if (!raw.appUrl || !raw.clientId || !raw.clientSecret) throw new Error(`${path} needs appUrl, clientId and clientSecret`);
  return {
    appUrl: raw.appUrl.replace(/\/+$/, ''),
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    ollamaUrl: (raw.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    // PowerShell 5's ConvertTo-Json turns an empty list into {} and a one-item list into the bare item.
    openaiCompatible: toList(raw.openaiCompatible),
    anthropicApiKey: raw.anthropicApiKey,
    maxChars: raw.maxChars ?? 24_000,
    browserPath: raw.browserPath,
  };
}
