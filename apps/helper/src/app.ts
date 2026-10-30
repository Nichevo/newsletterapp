import type { AiLimitHit, HelperConfig, HelperHeartbeat, HelperJob, HelperResult, TrialJob, TrialResultInput } from '@newsletterapp/shared';
import type { LocalConfig } from './config';

/** Talks to the app through Cloudflare Access with the helper's service token. Outbound only. */
export class AppClient {
  constructor(private cfg: LocalConfig) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.appUrl}${path}`, {
      method,
      headers: {
        'CF-Access-Client-Id': this.cfg.clientId,
        'CF-Access-Client-Secret': this.cfg.clientSecret,
        // Local testing against `wrangler dev` with DEV_BYPASS_AUTH.
        ...(process.env.HELPER_DEV === '1' ? { 'X-Dev-Helper': '1' } : {}),
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', // an Access login redirect means the token was refused
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status >= 300 && res.status < 400) throw new Error('Cloudflare Access refused the service token (check the Service Auth policy)');
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    return (await res.json()) as T;
  }

  heartbeat = (hb: HelperHeartbeat) => this.call<HelperConfig>('POST', '/api/helper/heartbeat', hb);
  claim = (max: number) => this.call<{ jobs: HelperJob[]; paused?: boolean; limited?: AiLimitHit }>('POST', '/api/helper/claim', { max });
  result = (r: HelperResult) => this.call<{ ok: boolean; paused: boolean; limited?: AiLimitHit | null }>('POST', '/api/helper/result', r);
  release = (itemIds: string[]) => this.call<{ released: number }>('POST', '/api/helper/release', { itemIds });
  trial = (id: string) => this.call<TrialJob>('GET', `/api/helper/trials/${id}`);
  trialResults = (id: string, results: TrialResultInput[]) => this.call('POST', `/api/helper/trials/${id}/results`, results);
  trialDone = (id: string) => this.call('POST', `/api/helper/trials/${id}/done`, {});

  /** Downloads a file the web app serves (used for self-update). */
  async download(path: string): Promise<string> {
    const res = await fetch(`${this.cfg.appUrl}${path}`, {
      headers: { 'CF-Access-Client-Id': this.cfg.clientId, 'CF-Access-Client-Secret': this.cfg.clientSecret },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`download ${path} -> ${res.status}`);
    return res.text();
  }
}
