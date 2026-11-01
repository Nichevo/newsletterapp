import { DEFAULT_WEB_SEARCH, type WebSearchSettings, type WebSearchView } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';

// Web search budget. The PC helper does the searching with the Brave key in
// its own config; the app only decides which jobs may search and counts the
// searches against a monthly budget. Highlight questions get first call on
// it: summaries stop searching once less than a tenth is left.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const SETTINGS_KEY = 'web_search';
const USAGE_KEY = 'web_search_usage';
/** Summaries leave this share of the month's budget for highlight questions. */
const ASK_RESERVE = 0.1;

interface Usage {
  month: string;
  asks: number;
  summaries: number;
}

const monthOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

const strList = (v: unknown, max: number) =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim().slice(0, 100))
            .filter(Boolean),
        ),
      ].slice(0, max)
    : null;

export function normalizeWebSearch(input: Partial<WebSearchSettings>, base: WebSearchSettings = DEFAULT_WEB_SEARCH): WebSearchSettings {
  const budget = Number(input.monthlyBudget);
  return {
    monthlyBudget: Number.isInteger(budget) && budget >= 0 && budget <= 1_000_000 ? budget : base.monthlyBudget,
    summaryCategories: strList(input.summaryCategories, 50) ?? base.summaryCategories,
    summarySources: strList(input.summarySources, 500) ?? base.summarySources,
  };
}

export async function loadWebSearch(env: Env): Promise<WebSearchSettings> {
  return normalizeWebSearch((await readJson<Partial<WebSearchSettings>>(env, SETTINGS_KEY)) ?? {});
}

async function loadUsage(env: Env): Promise<Usage> {
  const u = await readJson<Usage>(env, USAGE_KEY);
  const month = monthOf();
  return u && u.month === month ? { month, asks: u.asks || 0, summaries: u.summaries || 0 } : { month, asks: 0, summaries: 0 };
}

/** Searches left this month for highlight questions, and for summaries (which keep a reserve back). */
export async function searchAllowance(env: Env): Promise<{ asks: number; summaries: number; settings: WebSearchSettings }> {
  const [settings, usage] = await Promise.all([loadWebSearch(env), loadUsage(env)]);
  const left = settings.monthlyBudget - usage.asks - usage.summaries;
  return {
    asks: Math.max(0, left),
    summaries: Math.max(0, left - Math.ceil(settings.monthlyBudget * ASK_RESERVE)),
    settings,
  };
}

/** Counts searches the helper reports. Only written when there were some. */
export async function countSearches(env: Env, kind: 'asks' | 'summaries', n: unknown) {
  const count = Math.min(Math.max(Math.round(Number(n) || 0), 0), 20);
  if (count === 0) return;
  const usage = await loadUsage(env);
  usage[kind] += count;
  await writeJson(env, USAGE_KEY, usage);
}

/** Whether a summary of this item should search the web: its category or source is switched on, and there's budget. */
export function summarySearches(settings: WebSearchSettings, sourceId: string | null, category: string | null): boolean {
  return (
    (sourceId !== null && settings.summarySources.includes(sourceId)) ||
    (category !== null && settings.summaryCategories.some((c) => c.toLowerCase() === category.toLowerCase()))
  );
}

export function registerWebSearch(app: App) {
  app.get('/api/ai/web-search', async (c) => {
    const [settings, usage, helper] = await Promise.all([
      loadWebSearch(c.env),
      loadUsage(c.env),
      readJson<{ lastSeenAt?: number; webSearch?: 'brave' | null }>(c.env, 'helper'),
    ]);
    const view: WebSearchView = {
      settings,
      month: usage.month,
      used: usage.asks + usage.summaries,
      usedAsks: usage.asks,
      usedSummaries: usage.summaries,
      pcSearch: helper && 'webSearch' in helper ? (helper.webSearch ?? null) : undefined,
      helperLastSeenAt: helper?.lastSeenAt ?? null,
    };
    return c.json(view);
  });

  app.put('/api/ai/web-search', async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<WebSearchSettings> | null;
    if (!input) return c.json({ error: 'body required' }, 400);
    const settings = normalizeWebSearch(input, await loadWebSearch(c.env));
    await writeJson(c.env, SETTINGS_KEY, settings);
    return c.json(settings);
  });
}
