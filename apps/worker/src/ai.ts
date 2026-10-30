import {
  DEFAULT_PROMPT,
  HELPER_VERSION,
  type AiOutput,
  type AiStatsRow,
  type AiStatusView,
  type HelperConfig,
  type HelperHeartbeat,
  type HelperJob,
  type HelperLoad,
  type HelperResult,
  type ItemKind,
  type ModelInfo,
  type ModelRef,
  type PromptInfo,
  type PromptScope,
  type TrialJob,
  type TrialResultInput,
  type TrialView,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';
import { fetchJobsWaiting } from './feeds';
import { loadSettings } from './settings';

// The AI job queue. The PC helper checks in, claims a few items, summarises
// them with a local model and posts the results back. Everything here is
// plain D1 so it fits the free plan; the helper does the heavy lifting.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const LEASE_MS = 10 * 60_000; // a claimed item goes back in the queue after this
const MAX_ATTEMPTS = 3; // per item, then it is set aside as failed
const PAUSE_AFTER_FAILURES = 5; // in a row, across items
const POLL_SECONDS = 60;
const BATCH_SIZE = 5;

// ---------- Small key/value state kept in the settings table ----------

interface AiState {
  paused: boolean;
  pauseReason: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

const NO_STATE: AiState = { paused: false, pauseReason: null, lastError: null, consecutiveFailures: 0 };

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function writeJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3',
  )
    .bind(key, JSON.stringify(value), now())
    .run();
}

const loadState = async (env: Env) => ({ ...NO_STATE, ...(await readJson<AiState>(env, 'ai_state')) });

// ---------- Prompts ----------

interface PromptRow {
  id: string;
  scope: PromptScope;
  scope_value: string | null;
  version: number;
  body: string;
  updated_at: number;
}

const toPrompt = (r: PromptRow): PromptInfo => ({
  id: r.id,
  scope: r.scope,
  scopeValue: r.scope_value,
  version: r.version,
  body: r.body,
  updatedAt: r.updated_at,
});

/** All prompts, creating the default one from the built-in draft the first time. */
async function loadPrompts(env: Env): Promise<PromptRow[]> {
  const rows = await env.DB.prepare('SELECT * FROM prompts').all<PromptRow>();
  if (rows.results.some((r) => r.scope === 'default')) return rows.results;
  const t = now();
  const id = newId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO prompts (id, scope, scope_value, version, body, updated_at) VALUES (?, 'default', NULL, 1, ?, ?)").bind(
      id,
      DEFAULT_PROMPT,
      t,
    ),
    env.DB.prepare('INSERT INTO prompt_versions (prompt_id, version, body, created_at) VALUES (?, 1, ?, ?)').bind(id, DEFAULT_PROMPT, t),
  ]);
  return [...rows.results, { id, scope: 'default', scope_value: null, version: 1, body: DEFAULT_PROMPT, updated_at: t }];
}

/** Most specific prompt wins: this source, then the item's rules-based category, then the default. */
function pickPrompt(prompts: PromptRow[], sourceId: string | null, category: string | null): PromptRow {
  return (
    (sourceId && prompts.find((p) => p.scope === 'source' && p.scope_value === sourceId)) ||
    (category && prompts.find((p) => p.scope === 'category' && p.scope_value === category)) ||
    prompts.find((p) => p.scope === 'default')!
  );
}

function fillPrompt(body: string, categories: string[], interests: string): string {
  return body.replaceAll('{categories}', categories.join(', ')).replaceAll('{interests}', interests || 'general news');
}

// ---------- Validating model output ----------

const strList = (v: unknown, max: number, len = 200) =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim().slice(0, len))
        .filter(Boolean)
        .slice(0, max)
    : [];

/** Checks the helper's parsed output; returns null when it isn't usable. */
export function cleanOutput(o: unknown, categories: string[]): AiOutput | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, 1000) : '';
  if (!summary) return null;
  const lower = new Map(categories.map((c) => [c.toLowerCase(), c]));
  return {
    summary,
    key_points: strList(r.key_points, 6, 300),
    why_it_matters: typeof r.why_it_matters === 'string' ? r.why_it_matters.trim().slice(0, 400) : '',
    // Only categories from the reader's list; anything else the model invents is dropped.
    category: strList(r.category, 2, 40)
      .map((c) => lower.get(c.toLowerCase()))
      .filter((c): c is string => Boolean(c)),
    topics: strList(r.topics, 3, 40),
    thin_content: r.thin_content === true,
  };
}

// ---------- Which items may go to the AI ----------

/** SQL condition for the AI switches: per source, falling back to the per-kind default. */
function eligibleSql(aiByKind: Record<ItemKind, boolean>): string {
  const kinds = (Object.keys(aiByKind) as ItemKind[]).filter((k) => aiByKind[k]);
  const byKind = kinds.length ? `items.kind IN (${kinds.map((k) => `'${k}'`).join(', ')})` : '0';
  return `(sources.ai_mode = 'on' OR (COALESCE(sources.ai_mode, 'default') = 'default' AND ${byKind}))`;
}

async function bodiesFor(env: Env, row: { html_key: string | null; text_key: string | null }) {
  const [html, text] = await Promise.all([
    row.html_key ? env.RAW.get(row.html_key).then((o) => o?.text() ?? null) : null,
    row.text_key ? env.RAW.get(row.text_key).then((o) => o?.text() ?? null) : null,
  ]);
  return { html, text };
}

interface JobRow {
  id: string;
  subject: string;
  from_name: string | null;
  received_at: number;
  html_key: string | null;
  text_key: string | null;
  source_id: string | null;
  source_name: string | null;
  rules_category: string | null;
}

const JOB_SELECT = `SELECT items.id, items.subject, items.from_name, items.received_at, items.html_key, items.text_key,
    items.source_id, sources.name AS source_name, COALESCE(items.category, sources.category) AS rules_category
  FROM items LEFT JOIN sources ON sources.id = items.source_id`;

// ---------- Routes ----------

export function registerAi(app: App) {
  // ----- Helper side (service token only; see the auth middleware) -----

  app.post('/api/helper/heartbeat', async (c) => {
    const hb = (await c.req.json().catch(() => null)) as HelperHeartbeat | null;
    if (!hb || !Array.isArray(hb.models)) return c.json({ error: 'bad heartbeat' }, 400);
    const t = now();
    await writeJson(c.env, 'helper', {
      version: String(hb.version ?? '').slice(0, 40),
      hostname: String(hb.hostname ?? '').slice(0, 100),
      models: hb.models.slice(0, 100),
      providerErrors: Array.isArray(hb.providerErrors) ? hb.providerErrors.slice(0, 10) : [],
      load: hb.load ?? {},
      lastSeenAt: t,
    });

    // Keep the model list in step with what is installed. New models go to the end, switched on.
    const reachable = new Set(hb.models.map((m) => m.provider));
    const max = await c.env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM models').first<{ p: number }>();
    let position = max?.p ?? 0;
    const stmts = [];
    for (const provider of reachable) {
      stmts.push(c.env.DB.prepare('UPDATE models SET installed = 0 WHERE provider = ?').bind(provider));
    }
    for (const m of hb.models) {
      position += 1;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO models (provider, name, enabled, position, installed, size_bytes, first_seen_at, last_seen_at)
           VALUES (?1, ?2, 1, ?3, 1, ?4, ?5, ?5)
           ON CONFLICT(provider, name) DO UPDATE SET installed = 1, size_bytes = ?4, last_seen_at = ?5`,
        ).bind(String(m.provider).slice(0, 40), String(m.name).slice(0, 120), position, m.sizeBytes ?? null, t),
      );
    }
    if (stmts.length) await c.env.DB.batch(stmts);

    const [state, models, trial, fetchWaiting] = await Promise.all([
      loadState(c.env),
      c.env.DB.prepare('SELECT provider, name FROM models WHERE enabled = 1 AND installed = 1 ORDER BY position').all<ModelRef>(),
      c.env.DB.prepare("SELECT id FROM trials WHERE status != 'done' ORDER BY created_at LIMIT 1").first<{ id: string }>(),
      fetchJobsWaiting(c.env),
    ]);
    const config: HelperConfig = {
      paused: state.paused,
      latestHelperVersion: HELPER_VERSION,
      models: models.results,
      pollSeconds: POLL_SECONDS,
      batchSize: BATCH_SIZE,
      trialId: trial?.id ?? null,
      fetchWaiting,
    };
    return c.json(config);
  });

  app.post('/api/helper/claim', async (c) => {
    const state = await loadState(c.env);
    if (state.paused) return c.json({ jobs: [], paused: true });
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Number(input.max) || BATCH_SIZE, 1), 10);
    const settings = await loadSettings(c.env);
    const t = now();
    const stale = t - LEASE_MS;

    // Items whose lease ran out too often are set aside rather than retried forever.
    await c.env.DB.prepare(
      `UPDATE items SET ai_status = 'failed', ai_error = COALESCE(ai_error, 'Timed out on the PC')
       WHERE ai_status = 'working' AND ai_claimed_at < ? AND ai_attempts >= ?`,
    )
      .bind(stale, MAX_ATTEMPTS)
      .run();

    const claimed = await c.env.DB.prepare(
      `UPDATE items SET ai_status = 'working', ai_claimed_at = ?1, ai_attempts = ai_attempts + 1
       WHERE id IN (
         SELECT items.id FROM items LEFT JOIN sources ON sources.id = items.source_id
         WHERE items.status = 'inbox'
           AND (items.ai_status = 'pending' OR (items.ai_status = 'working' AND items.ai_claimed_at < ?2))
           AND ${eligibleSql(settings.aiByKind)}
         ORDER BY items.received_at DESC LIMIT ?3
       )
       RETURNING id`,
    )
      .bind(t, stale, max)
      .all<{ id: string }>();
    if (claimed.results.length === 0) return c.json({ jobs: [] });

    const ids = claimed.results.map((r) => r.id);
    const rows = await c.env.DB.prepare(`${JOB_SELECT} WHERE items.id IN (${ids.map(() => '?').join(', ')})`)
      .bind(...ids)
      .all<JobRow>();
    const prompts = await loadPrompts(c.env);
    const jobs: HelperJob[] = await Promise.all(
      rows.results.map(async (r) => {
        const prompt = pickPrompt(prompts, r.source_id, r.rules_category);
        return {
          itemId: r.id,
          subject: r.subject,
          sourceName: r.source_name,
          fromName: r.from_name,
          receivedAt: r.received_at,
          ...(await bodiesFor(c.env, r)),
          prompt: fillPrompt(prompt.body, settings.categories, settings.interests),
          promptId: prompt.id,
          promptVersion: prompt.version,
          categories: settings.categories,
        };
      }),
    );
    return c.json({ jobs });
  });

  app.post('/api/helper/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as HelperResult | null;
    if (!r?.itemId || !r.model || !r.provider) return c.json({ error: 'bad result' }, 400);
    const item = await c.env.DB.prepare('SELECT id, source_id, ai_attempts FROM items WHERE id = ?')
      .bind(r.itemId)
      .first<{ id: string; source_id: string | null; ai_attempts: number }>();
    if (!item) return c.json({ error: 'not found' }, 404);

    const settings = await loadSettings(c.env);
    const output = r.ok ? cleanOutput(r.output, settings.categories) : null;
    const ok = output !== null;
    const error = ok ? null : String(r.error || (r.ok ? 'The model returned an unusable answer' : 'Unknown error')).slice(0, 500);
    const t = now();
    const runId = newId();
    const seconds = Number.isFinite(r.seconds) ? Math.round(r.seconds * 10) / 10 : null;

    const stmts = [
      c.env.DB.prepare(
        `INSERT INTO ai_runs (id, item_id, source_id, provider, model, prompt_id, prompt_version, seconds, ok, error, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        runId,
        item.id,
        item.source_id,
        String(r.provider).slice(0, 40),
        String(r.model).slice(0, 120),
        r.promptId ?? null,
        Number.isFinite(r.promptVersion) ? r.promptVersion : null,
        seconds,
        ok ? 1 : 0,
        error,
        t,
      ),
    ];
    if (output) {
      stmts.push(
        c.env.DB.prepare(
          `UPDATE items SET ai_status = 'done', ai_error = NULL, ai_run_id = ?, summary = ?, key_points = ?,
             why_it_matters = ?, ai_category = ?, tags = ?, thin_content = ? WHERE id = ?`,
        ).bind(
          runId,
          output.summary,
          JSON.stringify(output.key_points),
          output.why_it_matters || null,
          JSON.stringify(output.category),
          JSON.stringify(output.topics),
          output.thin_content ? 1 : 0,
          item.id,
        ),
      );
    } else {
      stmts.push(
        c.env.DB.prepare('UPDATE items SET ai_status = ?, ai_error = ?, ai_claimed_at = NULL WHERE id = ?').bind(
          item.ai_attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          error,
          item.id,
        ),
      );
    }
    await c.env.DB.batch(stmts);

    // Pause everything after several failures in a row, so a broken model or prompt
    // doesn't chew through the whole queue. Quick summaries carry on regardless.
    const state = await loadState(c.env);
    const next: AiState = ok
      ? { ...state, consecutiveFailures: 0 }
      : { ...state, consecutiveFailures: state.consecutiveFailures + 1, lastError: `${r.model}: ${error}` };
    if (!ok && next.consecutiveFailures >= PAUSE_AFTER_FAILURES && !state.paused) {
      next.paused = true;
      next.pauseReason = `${next.consecutiveFailures} items failed in a row`;
    }
    if (next.consecutiveFailures !== state.consecutiveFailures || next.paused !== state.paused) await writeJson(c.env, 'ai_state', next);
    return c.json({ ok, paused: next.paused });
  });

  app.get('/api/helper/trials/:id', async (c) => {
    const trial = await c.env.DB.prepare('SELECT * FROM trials WHERE id = ?')
      .bind(c.req.param('id'))
      .first<{ id: string; prompt_body: string; models: string; item_ids: string }>();
    if (!trial) return c.json({ error: 'not found' }, 404);
    await c.env.DB.prepare("UPDATE trials SET status = 'running' WHERE id = ? AND status = 'pending'").bind(trial.id).run();
    const ids = JSON.parse(trial.item_ids) as string[];
    const settings = await loadSettings(c.env);
    const rows = ids.length
      ? await c.env.DB.prepare(`${JOB_SELECT} WHERE items.id IN (${ids.map(() => '?').join(', ')})`)
          .bind(...ids)
          .all<JobRow>()
      : { results: [] as JobRow[] };
    const prompt = fillPrompt(trial.prompt_body, settings.categories, settings.interests);
    const job: TrialJob = {
      trialId: trial.id,
      models: JSON.parse(trial.models) as ModelRef[],
      items: await Promise.all(
        rows.results.map(async (r) => ({
          itemId: r.id,
          subject: r.subject,
          sourceName: r.source_name,
          fromName: r.from_name,
          receivedAt: r.received_at,
          ...(await bodiesFor(c.env, r)),
          prompt,
          categories: settings.categories,
        })),
      ),
    };
    return c.json(job);
  });

  app.post('/api/helper/trials/:id/results', async (c) => {
    const id = c.req.param('id');
    const results = (await c.req.json().catch(() => null)) as TrialResultInput[] | null;
    if (!Array.isArray(results)) return c.json({ error: 'array required' }, 400);
    const settings = await loadSettings(c.env);
    const stmts = results.slice(0, 200).map((r) => {
      const output = cleanOutput(r.output, settings.categories);
      return c.env.DB.prepare(
        `INSERT OR REPLACE INTO trial_results (trial_id, item_id, provider, model, output, error, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        r.itemId,
        String(r.provider).slice(0, 40),
        String(r.model).slice(0, 120),
        output ? JSON.stringify(output) : null,
        output ? null : String(r.error || 'Unusable answer').slice(0, 500),
        Number.isFinite(r.seconds) ? r.seconds : null,
      );
    });
    if (stmts.length) await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  });

  app.post('/api/helper/trials/:id/done', async (c) => {
    await c.env.DB.prepare("UPDATE trials SET status = 'done', finished_at = ? WHERE id = ?").bind(now(), c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ----- Reader side -----

  app.get('/api/ai/status', async (c) => {
    const day = now() - 86_400_000;
    const settings = await loadSettings(c.env);
    const [helper, state, queue, runs] = await Promise.all([
      readJson<HelperHeartbeat & { lastSeenAt: number; load: HelperLoad }>(c.env, 'helper'),
      loadState(c.env),
      // Only items the AI switches let through count as waiting (feeds are off by default).
      c.env.DB.prepare(
        `SELECT
           SUM(items.ai_status = 'pending' AND ${eligibleSql(settings.aiByKind)}) AS waiting, SUM(items.ai_status = 'working') AS working,
           SUM(items.ai_status = 'failed') AS failed, SUM(items.ai_status = 'done') AS done
         FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.status = 'inbox' OR items.ai_status = 'done'`,
      ).first<{ waiting: number | null; working: number | null; failed: number | null; done: number | null }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS runs, SUM(ok = 0) AS failures, AVG(CASE WHEN ok = 1 THEN seconds END) AS avg FROM ai_runs WHERE at > ?')
        .bind(day)
        .first<{ runs: number; failures: number | null; avg: number | null }>(),
    ]);
    const view: AiStatusView = {
      helper,
      paused: state.paused,
      pauseReason: state.pauseReason,
      lastError: state.lastError,
      consecutiveFailures: state.consecutiveFailures,
      queue: {
        waiting: queue?.waiting ?? 0,
        working: queue?.working ?? 0,
        failed: queue?.failed ?? 0,
        done: queue?.done ?? 0,
      },
      last24h: { runs: runs?.runs ?? 0, failures: runs?.failures ?? 0, avgSeconds: runs?.avg ?? null },
    };
    return c.json(view);
  });

  app.post('/api/ai/pause', async (c) => {
    await writeJson(c.env, 'ai_state', { ...(await loadState(c.env)), paused: true, pauseReason: 'Paused by you' });
    return c.json({ ok: true });
  });

  app.post('/api/ai/resume', async (c) => {
    await writeJson(c.env, 'ai_state', { ...(await loadState(c.env)), paused: false, pauseReason: null, consecutiveFailures: 0 });
    return c.json({ ok: true });
  });

  /** Puts failed items back in the queue (after fixing whatever made them fail). */
  app.post('/api/ai/retry-failed', async (c) => {
    const res = await c.env.DB.prepare(
      "UPDATE items SET ai_status = 'pending', ai_attempts = 0, ai_error = NULL WHERE ai_status = 'failed' AND status = 'inbox'",
    ).run();
    return c.json({ requeued: res.meta.changes ?? 0 });
  });

  app.get('/api/ai/models', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT models.*,
         (SELECT AVG(rating) FROM ai_runs WHERE ai_runs.provider = models.provider AND ai_runs.model = models.name AND rating IS NOT NULL) AS avg_rating,
         (SELECT COUNT(rating) FROM ai_runs WHERE ai_runs.provider = models.provider AND ai_runs.model = models.name) AS rated_count
       FROM models ORDER BY position`,
    ).all<{
      provider: string;
      name: string;
      enabled: number;
      position: number;
      installed: number;
      size_bytes: number | null;
      last_seen_at: number;
      avg_rating: number | null;
      rated_count: number;
    }>();
    const models: ModelInfo[] = rows.results.map((r) => ({
      provider: r.provider,
      name: r.name,
      enabled: r.enabled === 1,
      position: r.position,
      installed: r.installed === 1,
      sizeBytes: r.size_bytes,
      lastSeenAt: r.last_seen_at,
      avgRating: r.avg_rating,
      ratedCount: r.rated_count,
    }));
    return c.json(models);
  });

  /** Saves the order and on/off switches: the body is the full list in the new order. */
  app.put('/api/ai/models', async (c) => {
    const list = (await c.req.json().catch(() => null)) as (ModelRef & { enabled: boolean })[] | null;
    if (!Array.isArray(list)) return c.json({ error: 'array required' }, 400);
    const stmts = list.slice(0, 200).map((m, i) =>
      c.env.DB.prepare('UPDATE models SET position = ?, enabled = ? WHERE provider = ? AND name = ?').bind(
        i + 1,
        m.enabled ? 1 : 0,
        m.provider,
        m.name,
      ),
    );
    if (stmts.length) await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  });

  /** Re-summarises everything a model wrote, e.g. after switching it off. */
  app.post('/api/ai/redo', async (c) => {
    const input = (await c.req.json().catch(() => null)) as ModelRef | null;
    if (!input?.provider || !input?.name) return c.json({ error: 'provider and name required' }, 400);
    const res = await c.env.DB.prepare(
      `UPDATE items SET ai_status = 'pending', ai_attempts = 0, ai_error = NULL
       WHERE status = 'inbox' AND ai_run_id IN (SELECT id FROM ai_runs WHERE provider = ? AND model = ?)`,
    )
      .bind(input.provider, input.name)
      .run();
    return c.json({ requeued: res.meta.changes ?? 0 });
  });

  app.get('/api/ai/prompts', async (c) => c.json((await loadPrompts(c.env)).map(toPrompt)));

  /** Creates or updates the prompt for a scope; every save is a new version. */
  app.put('/api/ai/prompts', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { scope?: PromptScope; scopeValue?: string | null; body?: string } | null;
    const scope = input?.scope;
    const body = input?.body?.trim();
    if (!scope || !['default', 'category', 'source'].includes(scope) || !body) return c.json({ error: 'scope and body required' }, 400);
    const scopeValue = scope === 'default' ? null : input?.scopeValue?.trim() || null;
    if (scope !== 'default' && !scopeValue) return c.json({ error: 'scopeValue required' }, 400);
    await loadPrompts(c.env);
    const t = now();
    const existing = await c.env.DB.prepare('SELECT * FROM prompts WHERE scope = ? AND scope_value IS ?')
      .bind(scope, scopeValue)
      .first<PromptRow>();
    if (existing?.body === body) return c.json(toPrompt(existing));
    const id = existing?.id ?? newId();
    const version = (existing?.version ?? 0) + 1;
    await c.env.DB.batch([
      existing
        ? c.env.DB.prepare('UPDATE prompts SET version = ?, body = ?, updated_at = ? WHERE id = ?').bind(version, body, t, id)
        : c.env.DB.prepare('INSERT INTO prompts (id, scope, scope_value, version, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
            id,
            scope,
            scopeValue,
            version,
            body,
            t,
          ),
      c.env.DB.prepare('INSERT INTO prompt_versions (prompt_id, version, body, created_at) VALUES (?, ?, ?, ?)').bind(id, version, body, t),
    ]);
    return c.json(toPrompt({ id, scope, scope_value: scopeValue, version, body, updated_at: t }));
  });

  app.delete('/api/ai/prompts/:id', async (c) => {
    await c.env.DB.prepare("DELETE FROM prompts WHERE id = ? AND scope != 'default'").bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  /**
   * Monthly history of summary value, grouped by model, source or prompt version.
   * "Summary enough" = no open event for the item after the summary was written.
   */
  app.get('/api/ai/stats', async (c) => {
    const by = c.req.query('by') ?? 'model';
    const months = Math.min(Number(c.req.query('months') ?? 6) || 6, 24);
    const keyExpr =
      by === 'source'
        ? "COALESCE(sources.name, 'Unknown')"
        : by === 'prompt'
          ? "'v' || COALESCE(ai_runs.prompt_version, 0)"
          : 'ai_runs.model';
    const since = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - (months - 1), 1);
    const rows = await c.env.DB.prepare(
      `SELECT strftime('%Y-%m', ai_runs.at / 1000, 'unixepoch') AS month, ${keyExpr} AS key,
         COUNT(*) AS runs, SUM(ai_runs.ok = 0) AS failures,
         SUM(ai_runs.rating = 1) AS up, SUM(ai_runs.rating = -1) AS down,
         SUM(ai_runs.ok = 1 AND NOT EXISTS (
           SELECT 1 FROM events WHERE events.item_id = ai_runs.item_id AND events.type = 'open' AND events.at > ai_runs.at
         )) AS summary_enough,
         AVG(CASE WHEN ai_runs.ok = 1 THEN ai_runs.seconds END) AS avg_seconds
       FROM ai_runs LEFT JOIN sources ON sources.id = ai_runs.source_id
       WHERE ai_runs.at >= ?
       GROUP BY month, key ORDER BY month DESC, runs DESC`,
    )
      .bind(since)
      .all<{
        month: string;
        key: string;
        runs: number;
        failures: number | null;
        up: number | null;
        down: number | null;
        summary_enough: number | null;
        avg_seconds: number | null;
      }>();
    const out: AiStatsRow[] = rows.results.map((r) => ({
      month: r.month,
      key: r.key,
      runs: r.runs,
      failures: r.failures ?? 0,
      up: r.up ?? 0,
      down: r.down ?? 0,
      summaryEnough: r.summary_enough ?? 0,
      avgSeconds: r.avg_seconds,
    }));
    return c.json(out);
  });

  app.post('/api/ai/trials', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { models?: ModelRef[]; count?: number; promptBody?: string } | null;
    const models = (input?.models ?? []).filter((m) => m?.provider && m?.name).slice(0, 4);
    if (models.length === 0) return c.json({ error: 'pick at least one model' }, 400);
    const count = Math.min(Math.max(Number(input?.count) || 20, 1), 30);
    const prompts = await loadPrompts(c.env);
    const body = input?.promptBody?.trim() || prompts.find((p) => p.scope === 'default')!.body;
    const items = await c.env.DB.prepare(
      "SELECT id FROM items WHERE kind = 'newsletter' AND status IN ('inbox', 'archived') ORDER BY received_at DESC LIMIT ?",
    )
      .bind(count)
      .all<{ id: string }>();
    const id = newId();
    await c.env.DB.prepare('INSERT INTO trials (id, prompt_body, models, item_ids, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, body, JSON.stringify(models), JSON.stringify(items.results.map((r) => r.id)), now())
      .run();
    return c.json({ id }, 201);
  });

  app.get('/api/ai/trials/latest', async (c) => {
    const trial = await c.env.DB.prepare('SELECT * FROM trials ORDER BY created_at DESC LIMIT 1').first<{
      id: string;
      status: TrialView['status'];
      created_at: number;
      models: string;
      item_ids: string;
    }>();
    if (!trial) return c.json(null);
    const ids = JSON.parse(trial.item_ids) as string[];
    const [items, results] = await Promise.all([
      ids.length
        ? c.env.DB.prepare(
            `SELECT items.id, items.subject, sources.name AS source_name FROM items LEFT JOIN sources ON sources.id = items.source_id
             WHERE items.id IN (${ids.map(() => '?').join(', ')}) ORDER BY items.received_at DESC`,
          )
            .bind(...ids)
            .all<{ id: string; subject: string; source_name: string | null }>()
        : { results: [] },
      c.env.DB.prepare('SELECT * FROM trial_results WHERE trial_id = ?')
        .bind(trial.id)
        .all<{ item_id: string; provider: string; model: string; output: string | null; error: string | null; seconds: number | null }>(),
    ]);
    const view: TrialView = {
      id: trial.id,
      status: trial.status,
      createdAt: trial.created_at,
      models: JSON.parse(trial.models) as ModelRef[],
      items: items.results.map((i) => ({ id: i.id, subject: i.subject, sourceName: i.source_name })),
      results: results.results.map((r) => ({
        itemId: r.item_id,
        provider: r.provider,
        model: r.model,
        seconds: r.seconds ?? 0,
        output: r.output ? (JSON.parse(r.output) as AiOutput) : null,
        error: r.error,
      })),
    };
    return c.json(view);
  });

  // ----- Per item -----

  app.post('/api/items/:id/rate', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { rating?: number } | null;
    const rating = input?.rating === 1 || input?.rating === -1 ? input.rating : null;
    await c.env.DB.prepare('UPDATE ai_runs SET rating = ? WHERE id = (SELECT ai_run_id FROM items WHERE id = ?)')
      .bind(rating, c.req.param('id'))
      .run();
    return c.json({ ok: true, rating });
  });

  app.post('/api/items/:id/redo', async (c) => {
    await c.env.DB.prepare("UPDATE items SET ai_status = 'pending', ai_attempts = 0, ai_error = NULL WHERE id = ?")
      .bind(c.req.param('id'))
      .run();
    return c.json({ ok: true });
  });

  /**
   * True when the last few rated summaries from this item's source were all
   * thumbs down: the reader suggests switching AI off for it.
   */
  app.get('/api/items/:id/ai-advice', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT rating FROM ai_runs WHERE source_id = (SELECT source_id FROM items WHERE id = ?) AND rating IS NOT NULL
       ORDER BY at DESC LIMIT 3`,
    )
      .bind(c.req.param('id'))
      .all<{ rating: number }>();
    const suggestOff = rows.results.length === 3 && rows.results.every((r) => r.rating === -1);
    return c.json({ suggestOff });
  });
}
