import {
  CUSTOM_ASK_PROMPT,
  DEFAULT_ASK_PRESETS,
  fillAskPrompt,
  markdownToHtml,
  markdownToText,
  type Ask,
  type AskJob,
  type AskOutput,
  type AskPreset,
  type AskPresetInput,
  type AskResultInput,
  type AskSource,
  type AskStatus,
  type Highlight,
  type HighlightAnchor,
  type ItemHighlights,
  type LookupMode,
  type NewAskInput,
  type NewAskResult,
  type PcOffMode,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';
import { loadSettings } from './settings';
import { countSearches, searchAllowance } from './websearch';

// Highlights, and questions to the AI about highlighted text ("asks"). The
// reader highlights a passage and picks a prompt; the PC helper answers it
// ahead of any waiting summaries; the answer becomes a note on the article,
// a new article from the "AI notes" source, or both.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const LEASE_MS = 5 * 60_000; // a claimed ask goes back in the queue after this
const MAX_ATTEMPTS = 3;
const EXPIRE_MS = 24 * 3_600_000; // asks the PC never picked up are given up after a day
/** How often the helper checks for asks between its normal once-a-minute rounds. */
export const ASK_POLL_SECONDS = 10;

const OUTPUTS: AskOutput[] = ['note', 'item', 'both'];
const LOOKUPS: LookupMode[] = ['none', 'wiki', 'web', 'both'];
const AI_SOURCE_NAME = 'AI notes';

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

// ---------- Rows ----------

interface HighlightRow {
  id: string;
  item_id: string;
  quote: string;
  prefix: string;
  suffix: string;
  text_offset: number;
  context: string | null;
  color: string;
  created_at: number;
}

const toHighlight = (r: HighlightRow): Highlight => ({
  id: r.id,
  itemId: r.item_id,
  quote: r.quote,
  prefix: r.prefix,
  suffix: r.suffix,
  textOffset: r.text_offset,
  context: r.context ?? '',
  color: r.color,
  createdAt: r.created_at,
});

interface AskRow {
  id: string;
  highlight_id: string;
  item_id: string;
  preset_id: string | null;
  label: string;
  preset_version: number | null;
  question: string | null;
  output: AskOutput;
  lookups: LookupMode;
  prompt: string;
  status: AskStatus;
  attempts: number;
  provider: string | null;
  model: string | null;
  answer: string | null;
  sources: string | null;
  error: string | null;
  rating: number | null;
  seconds: number | null;
  new_item_id: string | null;
  created_at: number;
  done_at: number | null;
  deleted_at?: number | null;
  lookup_note?: string | null;
}

function parseSources(raw: string | null): AskSource[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as AskSource[]).filter((s) => s && typeof s.url === 'string') : [];
  } catch {
    return [];
  }
}

const toAsk = (r: AskRow): Ask => ({
  id: r.id,
  highlightId: r.highlight_id,
  itemId: r.item_id,
  presetId: r.preset_id,
  label: r.label,
  presetVersion: r.preset_version,
  question: r.question,
  output: r.output,
  status: r.status,
  provider: r.provider,
  model: r.model,
  answer: r.answer,
  sources: parseSources(r.sources),
  error: r.error,
  rating: r.rating === 1 || r.rating === -1 ? r.rating : null,
  seconds: r.seconds,
  lookupNote: r.lookup_note ?? null,
  newItemId: r.new_item_id,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

interface PresetRow {
  id: string;
  label: string;
  body: string;
  output: AskOutput;
  lookups: LookupMode;
  position: number;
  enabled: number;
  built_in: number;
  version: number;
  updated_at: number;
}

const toPreset = (r: PresetRow): AskPreset => ({
  id: r.id,
  label: r.label,
  body: r.body,
  output: r.output,
  lookups: r.lookups,
  position: r.position,
  enabled: r.enabled === 1,
  version: r.version,
  updatedAt: r.updated_at,
  builtIn: r.built_in === 1,
});

// ---------- Presets ----------

/** All presets in order, adding any built-in ones that aren't there yet (first use, or a new one shipped). */
export async function loadPresets(env: Env): Promise<PresetRow[]> {
  const rows = (await env.DB.prepare('SELECT * FROM ask_presets ORDER BY position, label').all<PresetRow>()).results;
  const missing = DEFAULT_ASK_PRESETS.filter((p) => !rows.some((r) => r.id === p.id));
  if (missing.length === 0) return rows;
  const t = now();
  let position = rows.reduce((m, r) => Math.max(m, r.position), 0);
  const stmts = missing.flatMap((p) => {
    position += 1;
    return [
      env.DB.prepare(
        'INSERT INTO ask_presets (id, label, body, output, lookups, position, enabled, built_in, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)',
      ).bind(p.id, p.label, p.body, p.output, p.lookups, position, t),
      env.DB.prepare('INSERT OR IGNORE INTO ask_preset_versions (preset_id, version, body, created_at) VALUES (?, 1, ?, ?)').bind(
        p.id,
        p.body,
        t,
      ),
    ];
  });
  await env.DB.batch(stmts);
  return (await env.DB.prepare('SELECT * FROM ask_presets ORDER BY position, label').all<PresetRow>()).results;
}

// ---------- Counts on the item, for the inbox markers ----------

function countsStmt(env: Env, itemId: string) {
  return env.DB.prepare(
    `UPDATE items SET
       highlight_count = (SELECT COUNT(*) FROM highlights WHERE item_id = ?1 AND deleted_at IS NULL),
       note_count = (SELECT COUNT(*) FROM asks WHERE item_id = ?1 AND deleted_at IS NULL AND status = 'done' AND output != 'item')
     WHERE id = ?1`,
  ).bind(itemId);
}

// ---------- Anchors ----------

function cleanAnchor(a: Partial<HighlightAnchor> | undefined): HighlightAnchor | null {
  const quote = clip(a?.quote, 2000).trim();
  if (quote.length < 1) return null;
  return {
    quote,
    prefix: clip(a?.prefix, 64),
    suffix: clip(a?.suffix, 64),
    textOffset: Number.isFinite(a?.textOffset) ? Math.max(0, Math.round(a!.textOffset!)) : 0,
    context: clip(a?.context, 2000).trim(),
  };
}

function insertHighlight(env: Env, id: string, itemId: string, a: HighlightAnchor, device: string | null, t: number) {
  return env.DB.prepare(
    'INSERT INTO highlights (id, item_id, quote, prefix, suffix, text_offset, context, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, itemId, a.quote, a.prefix, a.suffix, a.textOffset, a.context || null, device, t);
}

const deviceOf = (ua: string | undefined) => (/Mobi|Android|iPhone/i.test(ua ?? '') ? 'phone' : 'desktop');

// ---------- The helper's queue ----------

const QUEUED = `FROM asks INDEXED BY asks_queue WHERE status IN ('pending', 'working')`;

/** How many asks are waiting for the PC (0 while AI is paused). Reads only the queue index. */
export async function asksWaiting(env: Env, paused: boolean): Promise<number> {
  if (paused) return 0;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n ${QUEUED} AND (status = 'pending' OR claimed_at < ?)`)
    .bind(now() - LEASE_MS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Gives up on asks the PC never picked up within a day, and ones that timed out too often. */
async function expireStale(env: Env, t: number) {
  await env.DB.prepare(
    `UPDATE asks SET status = 'failed', error = CASE WHEN status = 'pending' THEN 'Your PC did not pick this up within a day' ELSE COALESCE(error, 'Timed out on the PC') END
     WHERE id IN (SELECT id ${QUEUED} AND ((status = 'pending' AND created_at < ?1) OR (status = 'working' AND claimed_at < ?2 AND attempts >= ?3)))`,
  )
    .bind(t - EXPIRE_MS, t - LEASE_MS, MAX_ATTEMPTS)
    .run();
}

async function bodies(env: Env, itemId: string) {
  const row = await env.DB.prepare(
    `SELECT items.subject, items.from_name, items.html_key, items.text_key, sources.name AS source_name
     FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id = ?`,
  )
    .bind(itemId)
    .first<{ subject: string; from_name: string | null; html_key: string | null; text_key: string | null; source_name: string | null }>();
  if (!row) return null;
  const [html, text] = await Promise.all([
    row.html_key ? env.RAW.get(row.html_key).then((o) => o?.text() ?? null) : null,
    row.text_key ? env.RAW.get(row.text_key).then((o) => o?.text() ?? null) : null,
  ]);
  return { subject: row.subject, fromName: row.from_name, sourceName: row.source_name, html, text };
}

// ---------- The "AI notes" article ----------

async function aiSourceId(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM sources WHERE kind = 'ai' ORDER BY created_at LIMIT 1").first<{ id: string }>();
  if (row) return row.id;
  const id = newId();
  await env.DB.prepare("INSERT INTO sources (id, kind, name, ai_mode, created_at) VALUES (?, 'ai', ?, 'off', ?)")
    .bind(id, AI_SOURCE_NAME, now())
    .run();
  return id;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function noteHtml(
  ask: AskRow,
  quote: string,
  origin: { id: string; subject: string; source_name: string | null },
  answer: string,
  sources: AskSource[],
  by: string,
) {
  const parts = [
    `<p style="color:#5b636b;font-size:0.9em">From your highlight in <a href="/item/${esc(origin.id)}">${esc(origin.subject)}</a>${
      origin.source_name ? ` · ${esc(origin.source_name)}` : ''
    }</p>`,
    `<blockquote style="margin:0 0 1em;padding:0.4em 0.9em;border-left:3px solid #e0b34a;background:rgba(224,179,74,0.12)">${esc(quote)}</blockquote>`,
    ask.question ? `<p><strong>Your question:</strong> ${esc(ask.question)}</p>` : '',
    markdownToHtml(answer),
  ];
  if (sources.length) {
    parts.push(
      `<h4>Sources</h4><ul>${sources
        .filter((s) => /^https?:\/\//i.test(s.url))
        .map((s) => `<li><a href="${esc(s.url)}">${esc(s.title || s.url)}</a></li>`)
        .join('')}</ul>`,
    );
  }
  parts.push(`<p style="font-style:italic;color:#5b636b;font-size:0.85em">${esc(ask.label)} · ${esc(by)}</p>`);
  return parts.filter(Boolean).join('\n');
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Writes the answer as a new inbox article from the "AI notes" source; returns its id. */
async function createNoteItem(env: Env, ask: AskRow, quote: string, answer: string, sources: AskSource[], by: string, t: number) {
  const origin = await env.DB.prepare(
    `SELECT items.id, items.subject, sources.name AS source_name, COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]')) AS category
     FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id = ?`,
  )
    .bind(ask.item_id)
    .first<{ id: string; subject: string; source_name: string | null; category: string | null }>();
  if (!origin) return null;
  const sourceId = await aiSourceId(env);
  const id = newId();
  const key = `ai/${id}.html`;
  const plain = markdownToText(answer);
  await env.RAW.put(key, noteHtml(ask, quote, origin, answer, sources, by), { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await env.DB.prepare(
    `INSERT INTO items (id, source_id, kind, status, subject, from_name, snippet, received_at, html_key, has_html, created_at,
       preheader, word_count, category, origin_item_id)
     VALUES (?, ?, 'ai', 'inbox', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      sourceId,
      shorten(`${ask.label}: “${shorten(quote.replace(/\s+/g, ' '), 80)}”`, 200),
      AI_SOURCE_NAME,
      shorten(plain, 300),
      t,
      key,
      t,
      shorten(plain, 200),
      plain.split(/\s+/).filter(Boolean).length,
      origin.category,
      origin.id,
    )
    .run();
  return id;
}

// ---------- Settings: what happens while the PC is off ----------

export async function loadPcOffMode(env: Env): Promise<PcOffMode> {
  // 'wait' is the only choice for now; a Cloudflare Workers AI mode can join here later,
  // for summaries and asks alike.
  const saved = await readJson<PcOffMode>(env, 'pc_off_mode');
  return saved === 'wait' ? saved : 'wait';
}

// ---------- Routes ----------

export function registerHighlights(app: App) {
  // ----- Reader side -----

  app.get('/api/items/:id/highlights', async (c) => {
    const id = c.req.param('id');
    const t = now();
    const [hl, asks] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM highlights WHERE item_id = ? AND deleted_at IS NULL ORDER BY created_at')
        .bind(id)
        .all<HighlightRow>(),
      c.env.DB.prepare('SELECT * FROM asks WHERE item_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(id).all<AskRow>(),
    ]);
    const waiting = asks.results.some((a) => a.status === 'pending' || a.status === 'working');
    if (waiting && asks.results.some((a) => a.status === 'pending' && a.created_at < t - EXPIRE_MS)) {
      await expireStale(c.env, t);
      for (const a of asks.results) if (a.status === 'pending' && a.created_at < t - EXPIRE_MS) a.status = 'failed';
    }
    const helper = waiting ? await readJson<{ lastSeenAt?: number }>(c.env, 'helper') : null;
    const body: ItemHighlights = {
      highlights: hl.results.map(toHighlight),
      asks: asks.results.map(toAsk),
      helperLastSeenAt: helper?.lastSeenAt ?? null,
    };
    return c.json(body);
  });

  app.post('/api/items/:id/highlights', async (c) => {
    const itemId = c.req.param('id');
    const anchor = cleanAnchor((await c.req.json().catch(() => null)) as Partial<HighlightAnchor> | undefined);
    if (!anchor) return c.json({ error: 'quote required' }, 400);
    const exists = await c.env.DB.prepare('SELECT 1 FROM items WHERE id = ?').bind(itemId).first();
    if (!exists) return c.json({ error: 'not found' }, 404);
    const id = newId();
    const t = now();
    await c.env.DB.batch([insertHighlight(c.env, id, itemId, anchor, deviceOf(c.req.header('user-agent')), t), countsStmt(c.env, itemId)]);
    const hl: Highlight = { id, itemId, ...anchor, color: 'yellow', createdAt: t };
    return c.json(hl, 201);
  });

  /** Removes a highlight and the notes about it. An "AI notes" article made from it stays. */
  app.delete('/api/highlights/:id', async (c) => {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare('SELECT item_id FROM highlights WHERE id = ?').bind(id).first<{ item_id: string }>();
    if (!row) return c.json({ ok: true });
    const t = now();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE highlights SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(t, id),
      c.env.DB.prepare('UPDATE asks SET deleted_at = ? WHERE highlight_id = ? AND deleted_at IS NULL').bind(t, id),
      countsStmt(c.env, row.item_id),
    ]);
    return c.json({ ok: true });
  });

  app.post('/api/asks', async (c) => {
    const input = (await c.req.json().catch(() => null)) as NewAskInput | null;
    if (!input?.itemId) return c.json({ error: 'itemId required' }, 400);
    const question = clip(input.question, 1000).trim() || null;
    const [item, settings, presets] = await Promise.all([
      c.env.DB.prepare(
        'SELECT items.id, items.subject, sources.name AS source_name FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id = ?',
      )
        .bind(input.itemId)
        .first<{ id: string; subject: string; source_name: string | null }>(),
      loadSettings(c.env),
      input.presetId ? loadPresets(c.env) : Promise.resolve([] as PresetRow[]),
    ]);
    if (!item) return c.json({ error: 'not found' }, 404);
    const preset = input.presetId ? presets.find((p) => p.id === input.presetId) : null;
    if (input.presetId && !preset) return c.json({ error: 'unknown prompt' }, 400);
    if (!preset && !question) return c.json({ error: 'pick a prompt or type a question' }, 400);

    const t = now();
    const stmts = [];
    let highlight: Highlight;
    if (input.highlightId) {
      const row = await c.env.DB.prepare('SELECT * FROM highlights WHERE id = ? AND item_id = ? AND deleted_at IS NULL')
        .bind(input.highlightId, item.id)
        .first<HighlightRow>();
      if (!row) return c.json({ error: 'highlight not found' }, 404);
      highlight = toHighlight(row);
    } else {
      const anchor = cleanAnchor(input.highlight);
      if (!anchor) return c.json({ error: 'quote required' }, 400);
      highlight = { id: newId(), itemId: item.id, ...anchor, color: 'yellow', createdAt: t };
      stmts.push(insertHighlight(c.env, highlight.id, item.id, anchor, deviceOf(c.req.header('user-agent')), t));
    }

    const output: AskOutput =
      input.output && OUTPUTS.includes(input.output as AskOutput) ? (input.output as AskOutput) : (preset?.output ?? 'note');
    const prompt = fillAskPrompt(preset?.body ?? CUSTOM_ASK_PROMPT, {
      quote: highlight.quote,
      context: highlight.context,
      title: item.subject,
      source: item.source_name ?? '',
      interests: settings.interests,
      question,
    });
    const ask: AskRow = {
      id: newId(),
      highlight_id: highlight.id,
      item_id: item.id,
      preset_id: preset?.id ?? null,
      label: preset?.label ?? 'Your question',
      preset_version: preset?.version ?? null,
      question: preset ? null : question,
      output,
      lookups: preset?.lookups ?? 'none',
      prompt,
      status: 'pending',
      attempts: 0,
      provider: null,
      model: null,
      answer: null,
      sources: null,
      error: null,
      rating: null,
      seconds: null,
      new_item_id: null,
      created_at: t,
      done_at: null,
    };
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO asks (id, highlight_id, item_id, preset_id, label, preset_version, question, output, lookups, prompt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ask.id,
        ask.highlight_id,
        ask.item_id,
        ask.preset_id,
        ask.label,
        ask.preset_version,
        ask.question,
        ask.output,
        ask.lookups,
        ask.prompt,
        t,
      ),
      countsStmt(c.env, item.id),
    );
    await c.env.DB.batch(stmts);
    const result: NewAskResult = { highlight, ask: toAsk(ask) };
    return c.json(result, 201);
  });

  app.post('/api/asks/:id/retry', async (c) => {
    await c.env.DB.prepare(
      "UPDATE asks SET status = 'pending', attempts = 0, error = NULL, claimed_at = NULL, created_at = ? WHERE id = ? AND status = 'failed' AND deleted_at IS NULL",
    )
      .bind(now(), c.req.param('id'))
      .run();
    return c.json({ ok: true });
  });

  app.post('/api/asks/:id/rate', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { rating?: number } | null;
    const rating = input?.rating === 1 || input?.rating === -1 ? input.rating : null;
    await c.env.DB.prepare('UPDATE asks SET rating = ?, rated_at = ? WHERE id = ?')
      .bind(rating, rating === null ? null : now(), c.req.param('id'))
      .run();
    return c.json({ ok: true, rating });
  });

  /** Removes one note. The highlight stays. */
  app.delete('/api/asks/:id', async (c) => {
    const row = await c.env.DB.prepare('SELECT item_id FROM asks WHERE id = ?').bind(c.req.param('id')).first<{ item_id: string }>();
    if (!row) return c.json({ ok: true });
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE asks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now(), c.req.param('id')),
      countsStmt(c.env, row.item_id),
    ]);
    return c.json({ ok: true });
  });

  // ----- Presets (Settings > AI > Highlight prompts) -----

  app.get('/api/ask-presets', async (c) => c.json((await loadPresets(c.env)).map(toPreset)));

  /** Saves the order: the body is every preset id in the new order. */
  app.put('/api/ask-presets/order', async (c) => {
    const ids = (await c.req.json().catch(() => null)) as string[] | null;
    if (!Array.isArray(ids)) return c.json({ error: 'array required' }, 400);
    const stmts = ids
      .slice(0, 100)
      .map((id, i) => c.env.DB.prepare('UPDATE ask_presets SET position = ? WHERE id = ?').bind(i + 1, String(id)));
    if (stmts.length) await c.env.DB.batch(stmts);
    return c.json((await loadPresets(c.env)).map(toPreset));
  });

  app.post('/api/ask-presets', async (c) => {
    const input = (await c.req.json().catch(() => null)) as AskPresetInput | null;
    const label = clip(input?.label, 40).trim();
    const body = clip(input?.body, 4000).trim();
    if (!label || !body) return c.json({ error: 'label and prompt required' }, 400);
    const presets = await loadPresets(c.env);
    const id = newId();
    const t = now();
    const output = OUTPUTS.includes(input!.output!) ? input!.output! : 'note';
    const lookups = LOOKUPS.includes(input!.lookups!) ? input!.lookups! : 'none';
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO ask_presets (id, label, body, output, lookups, position, enabled, built_in, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, ?)',
      ).bind(id, label, body, output, lookups, presets.reduce((m, p) => Math.max(m, p.position), 0) + 1, t),
      c.env.DB.prepare('INSERT INTO ask_preset_versions (preset_id, version, body, created_at) VALUES (?, 1, ?, ?)').bind(id, body, t),
    ]);
    const row = await c.env.DB.prepare('SELECT * FROM ask_presets WHERE id = ?').bind(id).first<PresetRow>();
    return c.json(toPreset(row!), 201);
  });

  /** Edits a preset; a changed prompt is saved as a new version. */
  app.put('/api/ask-presets/:id', async (c) => {
    const id = c.req.param('id');
    const input = (await c.req.json().catch(() => null)) as AskPresetInput | null;
    if (!input) return c.json({ error: 'body required' }, 400);
    await loadPresets(c.env);
    const row = await c.env.DB.prepare('SELECT * FROM ask_presets WHERE id = ?').bind(id).first<PresetRow>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const label = clip(input.label, 40).trim() || row.label;
    const body = clip(input.body, 4000).trim() || row.body;
    const output = input.output && OUTPUTS.includes(input.output) ? input.output : row.output;
    const lookups = input.lookups && LOOKUPS.includes(input.lookups) ? input.lookups : row.lookups;
    const enabled = typeof input.enabled === 'boolean' ? (input.enabled ? 1 : 0) : row.enabled;
    const version = body !== row.body ? row.version + 1 : row.version;
    const t = now();
    const stmts = [
      c.env.DB.prepare(
        'UPDATE ask_presets SET label = ?, body = ?, output = ?, lookups = ?, enabled = ?, version = ?, updated_at = ? WHERE id = ?',
      ).bind(label, body, output, lookups, enabled, version, t, id),
    ];
    if (version !== row.version) {
      stmts.push(
        c.env.DB.prepare('INSERT OR REPLACE INTO ask_preset_versions (preset_id, version, body, created_at) VALUES (?, ?, ?, ?)').bind(
          id,
          version,
          body,
          t,
        ),
      );
    }
    await c.env.DB.batch(stmts);
    return c.json(toPreset({ ...row, label, body, output, lookups, enabled, version, updated_at: t }));
  });

  /** Puts a built-in preset's prompt back to the one the app ships with. */
  app.post('/api/ask-presets/:id/reset', async (c) => {
    const seed = DEFAULT_ASK_PRESETS.find((p) => p.id === c.req.param('id'));
    if (!seed) return c.json({ error: 'not a built-in prompt' }, 400);
    const row = await c.env.DB.prepare('SELECT * FROM ask_presets WHERE id = ?').bind(seed.id).first<PresetRow>();
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.body === seed.body && row.label === seed.label) return c.json(toPreset(row));
    const version = row.body === seed.body ? row.version : row.version + 1;
    const t = now();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE ask_presets SET label = ?, body = ?, version = ?, updated_at = ? WHERE id = ?').bind(
        seed.label,
        seed.body,
        version,
        t,
        seed.id,
      ),
      c.env.DB.prepare('INSERT OR REPLACE INTO ask_preset_versions (preset_id, version, body, created_at) VALUES (?, ?, ?, ?)').bind(
        seed.id,
        version,
        seed.body,
        t,
      ),
    ]);
    return c.json(toPreset({ ...row, label: seed.label, body: seed.body, version, updated_at: t }));
  });

  app.delete('/api/ask-presets/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM ask_presets WHERE id = ? AND built_in = 0').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  app.get('/api/ai/pc-off', async (c) => c.json({ mode: await loadPcOffMode(c.env) }));

  app.put('/api/ai/pc-off', async (c) => {
    await writeJson(c.env, 'pc_off_mode', 'wait');
    return c.json({ mode: 'wait' satisfies PcOffMode });
  });

  // ----- Helper side (service token only) -----

  app.post('/api/helper/asks/peek', async (c) => {
    const state = await readJson<{ paused?: boolean }>(c.env, 'ai_state');
    return c.json({ waiting: await asksWaiting(c.env, state?.paused === true) });
  });

  app.post('/api/helper/asks/claim', async (c) => {
    const state = await readJson<{ paused?: boolean }>(c.env, 'ai_state');
    if (state?.paused) return c.json({ jobs: [], paused: true });
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Number(input.max) || 2, 1), 5);
    const t = now();
    await expireStale(c.env, t);
    // Asks are answered in the order they were asked.
    const claimed = await c.env.DB.prepare(
      `UPDATE asks SET status = 'working', claimed_at = ?1, attempts = attempts + 1
       WHERE id IN (SELECT id ${QUEUED} AND deleted_at IS NULL AND (status = 'pending' OR claimed_at < ?2) ORDER BY created_at LIMIT ?3)
       RETURNING *`,
    )
      .bind(t, t - LEASE_MS, max)
      .all<AskRow>();
    const jobs: AskJob[] = [];
    const wantsWeb = claimed.results.some((a) => a.lookups === 'web' || a.lookups === 'both');
    let searchesLeft = wantsWeb ? (await searchAllowance(c.env)).asks : 0;
    for (const a of claimed.results.sort((x, y) => x.created_at - y.created_at)) {
      const [item, hl] = await Promise.all([
        bodies(c.env, a.item_id),
        c.env.DB.prepare('SELECT quote, context FROM highlights WHERE id = ?')
          .bind(a.highlight_id)
          .first<{ quote: string; context: string | null }>(),
      ]);
      if (!item || !hl) {
        await c.env.DB.prepare("UPDATE asks SET status = 'failed', error = 'The article or highlight is gone' WHERE id = ?")
          .bind(a.id)
          .run();
        continue;
      }
      jobs.push({
        askId: a.id,
        itemId: a.item_id,
        subject: item.subject,
        sourceName: item.sourceName,
        fromName: item.fromName,
        html: item.html,
        text: item.text,
        prompt: a.prompt,
        quote: hl.quote,
        context: hl.context ?? '',
        question: a.question,
        lookups: a.lookups,
        // A question with web search uses up to two searches.
        searchAllowed: (a.lookups === 'web' || a.lookups === 'both') && searchesLeft > 0,
      });
      if (a.lookups === 'web' || a.lookups === 'both') searchesLeft -= 2;
    }
    return c.json({ jobs });
  });

  app.post('/api/helper/asks/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as AskResultInput | null;
    if (!r?.askId || !r.model || !r.provider) return c.json({ error: 'bad result' }, 400);
    const ask = await c.env.DB.prepare('SELECT * FROM asks WHERE id = ?').bind(r.askId).first<AskRow>();
    if (!ask) return c.json({ error: 'not found' }, 404);
    const t = now();
    const answer = r.ok
      ? clip(r.answer, 12_000)
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .trim()
      : '';
    const ok = answer.length > 0;
    const error = ok ? null : clip(r.error || (r.ok ? 'The model returned an empty answer' : 'Unknown error'), 500);
    const sources = (Array.isArray(r.sources) ? r.sources : [])
      .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
      .slice(0, 10)
      .map((s) => ({ title: clip(s.title, 200), url: clip(s.url, 1000) }));
    const provider = clip(r.provider, 40);
    const model = clip(r.model, 120);
    const seconds = Number.isFinite(r.seconds) ? Math.round(r.seconds * 10) / 10 : null;
    const watts = Number.isFinite(r.watts) && r.watts! > 0 ? Math.round(r.watts!) : null;

    let newItemId: string | null = null;
    if (ok && ask.output !== 'note' && !ask.new_item_id && !ask.deleted_at) {
      const hl = await c.env.DB.prepare('SELECT quote FROM highlights WHERE id = ?').bind(ask.highlight_id).first<{ quote: string }>();
      newItemId = await createNoteItem(c.env, ask, hl?.quote ?? '', answer, sources, `by ${model} via ${provider}`, t);
    }
    const status: AskStatus = ok ? 'done' : ask.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await countSearches(c.env, 'asks', r.searches);
    const lookupNote = ok && typeof r.lookupNote === 'string' && r.lookupNote.trim() ? r.lookupNote.trim().slice(0, 300) : null;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE asks SET status = ?, provider = ?, model = ?, answer = ?, sources = ?, error = ?, seconds = ?, watts = ?, done_at = ?,
           claimed_at = NULL, new_item_id = COALESCE(new_item_id, ?), lookup_note = ? WHERE id = ?`,
      ).bind(
        status,
        provider,
        model,
        ok ? answer : ask.answer,
        ok ? JSON.stringify(sources) : ask.sources,
        error,
        seconds,
        watts,
        t,
        newItemId,
        lookupNote,
        ask.id,
      ),
      countsStmt(c.env, ask.item_id),
    ]);
    return c.json({ ok, status });
  });
}
