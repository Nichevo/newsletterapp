import {
  DEFAULT_KEY_KINDS,
  DEFAULT_KEY_SETTINGS,
  isKeyKind,
  type ItemKeySentences,
  type KeyFixInput,
  type KeyJob,
  type KeyKindSetting,
  type KeyMark,
  type KeyMode,
  type KeyResult,
  type KeySentenceSettings,
  type KeyStatus,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { loadState, readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';
import { limitState } from './usage';

// Key sentences: long articles get the sentences that carry them marked by
// kind (main point, evidence, example, caveat, takeaway) by the PC, and the
// reader colours them. Stored one row per article in key_sentences, apart
// from your highlights.
//
// What gets done: an item is queued when its AI summary comes in (so its
// text is final), or by hand from the reader, or by "Also do older
// articles" in Settings. The PC checks the length and skips link roundups
// itself, since it has the text.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const SETTINGS_KEY = 'key_sentences';
/** A claimed article goes back in the queue if the PC hasn't answered in this long. */
const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 2;
const MAX_MARKS = 120;

// ---------- Settings ----------

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), min), max) : fallback;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function normalizeKeySettings(input: Partial<KeySentenceSettings>, base: KeySentenceSettings = DEFAULT_KEY_SETTINGS): KeySentenceSettings {
  const categories: Record<string, 'always' | 'never'> = {};
  const rawCats = input.categories && typeof input.categories === 'object' ? input.categories : base.categories;
  for (const [cat, mode] of Object.entries(rawCats ?? {}).slice(0, 60)) {
    const name = str(cat, 40);
    if (name && (mode === 'always' || mode === 'never')) categories[name] = mode;
  }
  const kinds: KeyKindSetting[] = DEFAULT_KEY_KINDS.map((d) => {
    const from = (Array.isArray(input.kinds) ? input.kinds : base.kinds).find((k) => k?.id === d.id);
    return {
      id: d.id,
      name: str(from?.name, 30) || d.name,
      meaning: str(from?.meaning, 200) || d.meaning,
      on: typeof from?.on === 'boolean' ? from.on : d.on,
    };
  });
  const perSection = clampInt(input.perSection, 1, 3, base.perSection) as 1 | 2 | 3;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    minWords: clampInt(input.minWords, 200, 20_000, base.minWords),
    perSection,
    maxShare: clampInt(input.maxShare, 3, 40, base.maxShare),
    categories,
    kinds,
    skimDefault: typeof input.skimDefault === 'boolean' ? input.skimDefault : base.skimDefault,
    roundupLinksPer100: clampInt(input.roundupLinksPer100, 1, 50, base.roundupLinksPer100),
    roundupParagraphWords: clampInt(input.roundupParagraphWords, 0, 100, base.roundupParagraphWords),
    model: typeof input.model === 'string' ? str(input.model, 200) : base.model,
    extraPrompt: typeof input.extraPrompt === 'string' ? str(input.extraPrompt, 1500) : base.extraPrompt,
    promptVersion: clampInt(input.promptVersion, 1, 1_000_000, base.promptVersion),
    since: typeof input.since === 'number' || input.since === null ? input.since : base.since,
  };
}

export async function loadKeySettings(env: Env): Promise<KeySentenceSettings> {
  return normalizeKeySettings((await readJson<Partial<KeySentenceSettings>>(env, SETTINGS_KEY)) ?? {});
}

/** What the model sees: the kinds and their meanings, how many to pick. {max} is filled in by the PC. */
export function keyPrompt(s: KeySentenceSettings): string {
  const kinds = s.kinds.filter((k) => k.on);
  return [
    'You mark the key sentences in a long article, for a reader who wants to skim it and still get what matters.',
    'The article comes as numbered sentences like "[12] ...". Lines starting with ## are section headings (not numbered).',
    '',
    `Pick about ${s.perSection} key sentence${s.perSection === 1 ? '' : 's'} per section, and never more than {max} in all. Most sentences are not key: only pick the ones a reader would most regret missing. Skip headlines, captions, sign-ups, adverts and link lists.`,
    '',
    'Label each pick with one of these kinds:',
    ...kinds.map((k) => `- ${k.id}: ${k.name}. ${k.meaning}`),
    '',
    'Reply with JSON only, no other text: {"marks": [{"s": 12, "k": "main"}, ...]} where s is the sentence number and k is the kind.',
    'If the text is not really an article (a list of links, an advert, a sign-up page), reply {"marks": []}.',
    ...(s.extraPrompt ? ['', s.extraPrompt] : []),
  ].join('\n');
}

// ---------- Queueing ----------

const LIVE = "items.status != 'dropped' AND items.kind != 'ai'";

/**
 * Called when an item's AI summary comes in: queues it when key sentences are
 * on and its source and category don't say Never. Length and link roundups
 * are checked on the PC, which has the text; known-short items are skipped here.
 */
export async function queueAfterSummary(env: Env, itemId: string): Promise<void> {
  const s = await loadKeySettings(env);
  if (!s.enabled) return;
  const row = await env.DB.prepare(
    `SELECT items.ks_status, items.word_count, items.received_at, items.created_at, items.kind, items.status,
       COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]')) AS category, sources.key_sentences
     FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id = ?`,
  )
    .bind(itemId)
    .first<{ ks_status: string | null; word_count: number | null; received_at: number; created_at: number; kind: string; status: string; category: string | null; key_sentences: string | null }>();
  if (!row || row.ks_status !== null || row.kind === 'ai' || row.status === 'dropped') return;
  // Only items that arrived after it was switched on (the "Also do older articles" button does the rest).
  if (s.since !== null && Math.max(row.created_at, row.received_at) < s.since) return;
  const mode = modeFor(s, row.key_sentences, row.category);
  if (mode === 'never') return;
  // Known to be short: no need to send it to the PC. Unknown lengths (some feeds, PDFs) go and are checked there.
  if (mode === 'auto' && row.word_count !== null && row.word_count < s.minWords) return;
  await env.DB.prepare("UPDATE items SET ks_status = 'pending', ks_attempts = 0, ks_manual = 0 WHERE id = ? AND ks_status IS NULL").bind(itemId).run();
}

/** Source setting first (Always / Never), then the category's, else Auto. */
function modeFor(s: KeySentenceSettings, sourceMode: string | null, category: string | null): KeyMode {
  if (sourceMode === 'always' || sourceMode === 'never') return sourceMode;
  return (category && s.categories[category]) || 'auto';
}

/** Whether articles are waiting, for the helper's check-in (an index probe). */
async function keyWaiting(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS w FROM items INDEXED BY items_ks_queue
     WHERE ks_status IN ('pending', 'working') AND (ks_status = 'pending' OR ks_at < ?) LIMIT 1`,
  )
    .bind(now() - LEASE_MS)
    .first<{ w: number }>();
  return Boolean(row);
}

export async function keyHeartbeat(env: Env, paused: boolean): Promise<{ keyWaiting: boolean }> {
  if (paused) return { keyWaiting: false };
  const s = await loadKeySettings(env);
  // Off means no PC work at all, even for articles asked for by hand earlier.
  return { keyWaiting: s.enabled && (await keyWaiting(env)) };
}

// ---------- Cleaning what the PC sends ----------

function cleanMarks(input: unknown): KeyMark[] {
  if (!Array.isArray(input)) return [];
  const out: KeyMark[] = [];
  const seen = new Set<string>();
  for (const m of input.slice(0, MAX_MARKS)) {
    if (!m || typeof m !== 'object') continue;
    const v = m as Record<string, unknown>;
    const quote = typeof v.quote === 'string' ? v.quote.replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
    if (quote.length < 8 || !isKeyKind(v.kind) || seen.has(quote)) continue;
    seen.add(quote);
    out.push({
      kind: v.kind,
      quote,
      prefix: typeof v.prefix === 'string' ? v.prefix.slice(-40) : '',
      suffix: typeof v.suffix === 'string' ? v.suffix.slice(0, 40) : '',
      textOffset: typeof v.textOffset === 'number' && Number.isFinite(v.textOffset) ? Math.max(0, Math.round(v.textOffset)) : 0,
    });
  }
  return out;
}

const SKIP_NOTE: Record<NonNullable<KeyResult['skipped']>, string> = {
  short: 'Shorter than the length set in Settings.',
  roundup: 'Looks like a list of links, so it was skipped.',
  empty: 'The model found no key sentences in it.',
};

const parseMarks = (raw: string | null): KeyMark[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as KeyMark[]) : [];
  } catch {
    return [];
  }
};

// ---------- Routes ----------

export function registerKeySentences(app: App) {
  app.get('/api/key-sentences/settings', async (c) => c.json(await loadKeySettings(c.env)));

  app.put('/api/key-sentences/settings', async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<KeySentenceSettings> | null;
    if (!input || typeof input !== 'object') return c.json({ error: 'bad settings' }, 400);
    const before = await loadKeySettings(c.env);
    // These can't be set from outside.
    delete input.promptVersion;
    delete input.since;
    const next = normalizeKeySettings(input, before);
    // Switching on starts from now: older articles only on request.
    if (next.enabled && !before.enabled) next.since = now();
    // A new prompt version whenever what the model is asked changes, so runs can be told apart.
    if (keyPrompt(next) !== keyPrompt(before)) next.promptVersion = before.promptVersion + 1;
    await writeJson(c.env, SETTINGS_KEY, next);
    // Switching off empties the queue, so nothing shows as waiting for the PC.
    if (!next.enabled && before.enabled) {
      await c.env.DB.prepare(
        `UPDATE items SET ks_status = NULL WHERE id IN (
           SELECT id FROM items INDEXED BY items_ks_queue WHERE ks_status IN ('pending', 'working') LIMIT 5000)`,
      ).run();
    }
    return c.json(next);
  });

  /** "Also do older articles": queues articles from the last few days that were never looked at. */
  app.post('/api/key-sentences/backdate', async (c) => {
    const s = await loadKeySettings(c.env);
    if (!s.enabled) return c.json({ error: 'Key sentences are switched off' }, 400);
    const input = (await c.req.json().catch(() => ({}))) as { days?: number };
    const days = clampInt(input.days, 1, 90, 7);
    // Walks the received_at index over those days only; items known to be short are left out.
    const r = await c.env.DB.prepare(
      `UPDATE items SET ks_status = 'pending', ks_attempts = 0, ks_manual = 0
       WHERE id IN (
         SELECT items.id FROM items LEFT JOIN sources ON sources.id = items.source_id
         WHERE items.received_at >= ?1 AND items.ks_status IS NULL AND ${LIVE}
           AND COALESCE(sources.key_sentences, '') != 'never'
           AND (sources.key_sentences = 'always' OR items.word_count IS NULL OR items.word_count >= ?2)
         LIMIT 2000
       )`,
    )
      .bind(now() - days * 86_400_000, s.minWords)
      .run();
    return c.json({ queued: r.meta.changes ?? 0 });
  });

  app.get('/api/items/:id/key-sentences', async (c) => {
    const id = c.req.param('id');
    const [item, row, s] = await Promise.all([
      c.env.DB.prepare('SELECT ks_status FROM items WHERE id = ?').bind(id).first<{ ks_status: KeyStatus | null }>(),
      c.env.DB.prepare('SELECT model, marks, sentences, note FROM key_sentences WHERE item_id = ?')
        .bind(id)
        .first<{ model: string | null; marks: string; sentences: number | null; note: string | null }>(),
      loadKeySettings(c.env),
    ]);
    if (!item) return c.json({ error: 'not found' }, 404);
    const waiting = item.ks_status === 'pending' || item.ks_status === 'working';
    const helper = waiting ? await readJson<{ lastSeenAt?: number }>(c.env, 'helper') : null;
    const body: ItemKeySentences = {
      status: item.ks_status,
      note: row?.note ?? null,
      marks: item.ks_status === 'done' ? parseMarks(row?.marks ?? null) : [],
      sentences: row?.sentences ?? null,
      model: row?.model ?? null,
      kinds: s.kinds,
      skimDefault: s.skimDefault,
      helperLastSeenAt: helper?.lastSeenAt ?? null,
    };
    return c.json(body);
  });

  /** "Find key sentences" in the reader: goes to the front of the queue, whatever its length. */
  app.post('/api/items/:id/key-sentences', async (c) => {
    const s = await loadKeySettings(c.env);
    if (!s.enabled) return c.json({ error: 'Key sentences are switched off in Settings' }, 400);
    const r = await c.env.DB.prepare(
      "UPDATE items SET ks_status = 'pending', ks_attempts = 0, ks_manual = 1, ks_at = NULL WHERE id = ? AND COALESCE(ks_status, '') != 'working'",
    )
      .bind(c.req.param('id'))
      .run();
    return c.json({ ok: (r.meta.changes ?? 0) > 0 });
  });

  /** Not key / Wrong colour / Undo, kept with the marks so the model's pick isn't lost. */
  app.post('/api/items/:id/key-sentences/fix', async (c) => {
    const id = c.req.param('id');
    const input = (await c.req.json().catch(() => null)) as KeyFixInput | null;
    if (!input || !Number.isInteger(input.index)) return c.json({ error: 'bad fix' }, 400);
    const row = await c.env.DB.prepare('SELECT marks FROM key_sentences WHERE item_id = ?').bind(id).first<{ marks: string }>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const marks = parseMarks(row.marks);
    const m = marks[input.index];
    if (!m) return c.json({ error: 'not found' }, 404);
    const original = m.was ?? m.kind;
    if (input.action === 'remove') {
      m.fix = 'removed';
      if (m.kind !== original) m.was = original;
    } else if (input.action === 'kind' && isKeyKind(input.kind)) {
      m.kind = input.kind;
      if (input.kind === original) {
        delete m.fix;
        delete m.was;
      } else {
        m.fix = 'kind';
        m.was = original;
      }
    } else if (input.action === 'restore') {
      m.kind = original;
      delete m.fix;
      delete m.was;
    } else {
      return c.json({ error: 'bad fix' }, 400);
    }
    await c.env.DB.prepare('UPDATE key_sentences SET marks = ?, updated_at = ? WHERE item_id = ?').bind(JSON.stringify(marks), now(), id).run();
    return c.json({ marks });
  });

  // ----- Helper side -----

  app.post('/api/helper/key/claim', async (c) => {
    const [state, s] = await Promise.all([loadState(c.env), loadKeySettings(c.env)]);
    if (state.paused || !s.enabled) return c.json({ jobs: [] });
    const usage = await limitState(c.env, now(), true);
    if (usage.limited) return c.json({ jobs: [] });
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = clampInt(input.max, 1, 5, 2);
    const t = now();
    // Items whose lease ran out too often are set aside rather than retried forever.
    await c.env.DB.prepare(
      `UPDATE items SET ks_status = 'failed' WHERE id IN (
         SELECT id FROM items INDEXED BY items_ks_queue
         WHERE ks_status IN ('pending', 'working') AND ks_status = 'working' AND ks_at < ? AND ks_attempts >= ? LIMIT 20)`,
    )
      .bind(t - LEASE_MS, MAX_ATTEMPTS)
      .run();
    const claimed = await c.env.DB.prepare(
      `UPDATE items SET ks_status = 'working', ks_at = ?1, ks_attempts = ks_attempts + 1
       WHERE id IN (
         SELECT id FROM items INDEXED BY items_ks_queue
         WHERE ks_status IN ('pending', 'working') AND (ks_status = 'pending' OR ks_at < ?2)
         ORDER BY ks_manual DESC, received_at DESC LIMIT ?3
       )
       RETURNING id, subject, html_key, text_key, source_id, ks_manual,
         COALESCE(category, json_extract(ai_category, '$[0]')) AS category`,
    )
      .bind(t, t - LEASE_MS, max)
      .all<{ id: string; subject: string; html_key: string | null; text_key: string | null; source_id: string | null; ks_manual: number; category: string | null }>();
    const prompt = keyPrompt(s);
    const kinds = s.kinds.filter((k) => k.on).map((k) => k.id);
    const [provider, ...rest] = s.model.split(':');
    const model = s.model && provider && rest.length ? { provider, name: rest.join(':') } : null;
    const jobs: KeyJob[] = [];
    for (const r of claimed.results) {
      const [source, html, text] = await Promise.all([
        r.source_id
          ? c.env.DB.prepare('SELECT name, category, key_sentences FROM sources WHERE id = ?')
              .bind(r.source_id)
              .first<{ name: string; category: string | null; key_sentences: string | null }>()
          : null,
        r.html_key ? c.env.RAW.get(r.html_key).then((o) => o?.text() ?? null) : null,
        r.text_key ? c.env.RAW.get(r.text_key).then((o) => o?.text() ?? null) : null,
      ]);
      const forced = r.ks_manual === 1 || modeFor(s, source?.key_sentences ?? null, r.category ?? source?.category ?? null) === 'always';
      jobs.push({
        itemId: r.id,
        subject: r.subject,
        sourceName: source?.name ?? null,
        html,
        text,
        prompt,
        kinds,
        minWords: forced ? 0 : s.minWords,
        skipRoundups: !forced,
        roundupLinksPer100: s.roundupLinksPer100,
        roundupParagraphWords: s.roundupParagraphWords,
        perSection: s.perSection,
        maxShare: s.maxShare,
        model,
      });
    }
    return c.json({ jobs });
  });

  app.post('/api/helper/key/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as KeyResult | null;
    if (!r?.itemId || !r.model) return c.json({ error: 'bad result' }, 400);
    const [item, s] = await Promise.all([
      c.env.DB.prepare('SELECT id, ks_attempts, ks_manual FROM items WHERE id = ?').bind(r.itemId).first<{ id: string; ks_attempts: number; ks_manual: number }>(),
      loadKeySettings(c.env),
    ]);
    if (!item) return c.json({ error: 'not found' }, 404);
    const t = now();
    const marks = r.ok && !r.skipped ? cleanMarks(r.marks) : [];
    const skipped = r.ok ? (r.skipped ?? (marks.length === 0 ? 'empty' : undefined)) : undefined;
    const done = r.ok && !skipped;
    const status: KeyStatus = done ? 'done' : skipped ? 'none' : item.ks_attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const error = r.ok ? null : String(r.error || 'Unknown error').slice(0, 500);
    const seconds = Number.isFinite(r.seconds) ? Math.round(r.seconds * 10) / 10 : null;
    const watts = Number.isFinite(r.watts) && r.watts! > 0 ? Math.round(r.watts!) : null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    const note = done ? null : skipped ? SKIP_NOTE[skipped] : status === 'failed' ? `The PC couldn't do it: ${error}` : null;
    const stmts = [
      c.env.DB.prepare(
        `INSERT INTO ks_runs (id, item_id, provider, model, prompt_version, seconds, watts, ok, skipped, marks, manual, error, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        item.id,
        String(r.provider ?? '').slice(0, 40),
        String(r.model).slice(0, 120),
        s.promptVersion,
        seconds,
        watts,
        r.ok ? 1 : 0,
        skipped ?? null,
        marks.length,
        item.ks_manual,
        error,
        t,
      ),
      c.env.DB.prepare('UPDATE items SET ks_status = ?, ks_at = ? WHERE id = ?').bind(status, t, item.id),
    ];
    if (done || skipped || status === 'failed') {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO key_sentences (item_id, provider, model, prompt_version, marks, sentences, words, note, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
           ON CONFLICT(item_id) DO UPDATE SET provider = ?2, model = ?3, prompt_version = ?4, marks = ?5, sentences = ?6, words = ?7, note = ?8, updated_at = ?9`,
        ).bind(
          item.id,
          String(r.provider ?? '').slice(0, 40),
          String(r.model).slice(0, 120),
          s.promptVersion,
          JSON.stringify(marks),
          num(r.sentences),
          num(r.words),
          note,
          t,
        ),
      );
    }
    await c.env.DB.batch(stmts);
    return c.json({ ok: done, status });
  });
}
