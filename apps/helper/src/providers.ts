import type { ModelRef } from '@newsletterapp/shared';
import type { LocalConfig } from './config';
import { OUTPUT_SCHEMA } from './text';

/**
 * One way of running a model. The app decides which model to use (the
 * reader's ordered, switchable list); providers just list and run models.
 */
export interface Provider {
  name: string;
  listModels(): Promise<{ name: string; sizeBytes?: number }[]>;
  /** Returns the model's raw reply; the caller parses the JSON. */
  complete(model: string, system: string, user: string): Promise<string>;
}

const TIMEOUT_MS = 5 * 60_000;

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

export function ollama(baseUrl: string): Provider {
  return {
    name: 'ollama',
    async listModels() {
      const r = await getJson<{ models: { name: string; size?: number }[] }>(`${baseUrl}/api/tags`);
      // Embedding-only models can't write summaries.
      return r.models.filter((m) => !/embed/i.test(m.name)).map((m) => ({ name: m.name, sizeBytes: m.size }));
    },
    async complete(model, system, user) {
      const r = await postJson<{ message?: { content?: string } }>(`${baseUrl}/api/chat`, {
        model,
        stream: false,
        format: OUTPUT_SCHEMA,
        options: { temperature: 0.2, num_ctx: 16384 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      return r.message?.content ?? '';
    },
  };
}

export function openaiCompatible(name: string, baseUrl: string, apiKey?: string): Provider {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  return {
    name,
    async listModels() {
      const r = await getJson<{ data: { id: string }[] }>(`${base}/models`, headers);
      return r.data.map((m) => ({ name: m.id }));
    },
    async complete(model, system, user) {
      const r = await postJson<{ choices?: { message?: { content?: string } }[] }>(
        `${base}/chat/completions`,
        {
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        headers,
      );
      return r.choices?.[0]?.message?.content ?? '';
    },
  };
}

/** Hosted Claude models, kept ready for the digest; only listed when an API key is configured. */
export function anthropic(apiKey: string): Provider {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  return {
    name: 'anthropic',
    async listModels() {
      const r = await getJson<{ data: { id: string }[] }>('https://api.anthropic.com/v1/models', headers);
      return r.data.map((m) => ({ name: m.id }));
    },
    async complete(model, system, user) {
      const r = await postJson<{ content?: { type: string; text?: string }[] }>(
        'https://api.anthropic.com/v1/messages',
        { model, max_tokens: 1024, temperature: 0.2, system, messages: [{ role: 'user', content: user }] },
        headers,
      );
      return (r.content ?? []).map((b) => b.text ?? '').join('');
    },
  };
}

export function providersFrom(cfg: LocalConfig): Provider[] {
  const list = [ollama(cfg.ollamaUrl), ...cfg.openaiCompatible.map((p) => openaiCompatible(p.name, p.baseUrl, p.apiKey))];
  if (cfg.anthropicApiKey) list.push(anthropic(cfg.anthropicApiKey));
  return list;
}

export const findProvider = (providers: Provider[], ref: ModelRef) => providers.find((p) => p.name === ref.provider);
