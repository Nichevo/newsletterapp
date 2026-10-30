import { Hono } from 'hono';
import type {
  AiMode,
  Address,
  AppSettings,
  ItemBody,
  ItemListResponse,
  ItemSort,
  ItemSummary,
  ItemView,
  Me,
  ReadingEventInput,
  ReadingEventType,
  SourceUpdate,
} from '@newsletterapp/shared';
import { registerAi } from './ai';
import { AuthError, authenticate } from './auth';
import {
  toAddress,
  toItemSummary,
  toSender,
  toSource,
  type AddressRow,
  type ItemJoined,
  type ItemRow,
  type SenderRow,
  type SourceRow,
} from './db';
import type { AppVariables, Env } from './env';
import { newId, now, slugify } from './ids';
import { categoryFromRules, quickSummary } from './quick';
import { loadSettings, normalizeSettings, saveSettings } from './settings';

export const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use('/api/*', async (c, next) => {
  try {
    const who = await authenticate(c.req.raw, c.env);
    // The helper's service token only opens the helper endpoints, and only the helper uses them.
    const helperPath = c.req.path.startsWith('/api/helper/');
    if (who.kind === 'helper' && !helperPath) return c.json({ error: 'not for the helper' }, 403);
    if (who.kind === 'user' && helperPath) return c.json({ error: 'helper only' }, 403);
    c.set('userEmail', who.kind === 'user' ? who.email : '');
  } catch (err) {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  await next();
});

app.get('/api/me', (c) => {
  const me: Me = { email: c.get('userEmail'), domain: c.env.MAIL_DOMAIN || null };
  return c.json(me);
});

// AI queue, helper endpoints and AI settings. Registered before the generic
// item action route so /api/items/:id/rate and friends match first.
registerAi(app);

// ---------- Items ----------

const ITEM_SELECT = `SELECT items.*, sources.name AS source_name, sources.category AS source_category,
    ai_runs.provider AS run_provider, ai_runs.model AS run_model, ai_runs.prompt_version AS run_prompt_version,
    ai_runs.seconds AS run_seconds, ai_runs.rating AS run_rating
  FROM items LEFT JOIN sources ON sources.id = items.source_id LEFT JOIN ai_runs ON ai_runs.id = items.ai_run_id`;
type ItemSelectRow = ItemRow & ItemJoined;

const VIEW_WHERE: Record<ItemView, string> = {
  inbox: "items.status = 'inbox'",
  unread: "items.status = 'inbox' AND items.read_at IS NULL",
  saved: "items.saved_at IS NOT NULL AND items.status != 'dropped'",
  archived: "items.status = 'archived'",
};

async function loadItem(env: Env, id: string): Promise<ItemSummary | null> {
  const row = await env.DB.prepare(`${ITEM_SELECT} WHERE items.id = ?`)
    .bind(id)
    .first<ItemSelectRow>();
  return row ? toItemSummary(row) : null;
}

app.get('/api/items', async (c) => {
  const view = (c.req.query('view') ?? 'inbox') as ItemView;
  const sort = (c.req.query('sort') ?? 'newest') as ItemSort;
  const sourceId = c.req.query('source');
  const category = c.req.query('category');
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const cursor = c.req.query('cursor');
  if (!(view in VIEW_WHERE)) return c.json({ error: 'bad view' }, 400);

  const where: string[] = [VIEW_WHERE[view]];
  const binds: unknown[] = [];
  if (sourceId) {
    where.push('items.source_id = ?');
    binds.push(sourceId);
  }
  if (category) {
    where.push("COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]')) = ?");
    binds.push(category);
  }
  if (cursor) {
    const sep = cursor.lastIndexOf(':');
    const at = Number(cursor.slice(0, sep));
    const id = cursor.slice(sep + 1);
    if (Number.isFinite(at) && id) {
      where.push(
        sort === 'oldest'
          ? '(items.received_at > ? OR (items.received_at = ? AND items.id > ?))'
          : '(items.received_at < ? OR (items.received_at = ? AND items.id < ?))',
      );
      binds.push(at, at, id);
    }
  }
  const order = sort === 'oldest' ? 'ASC' : 'DESC';
  const rows = await c.env.DB.prepare(
    `${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY items.received_at ${order}, items.id ${order} LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<ItemSelectRow>();

  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  const body: ItemListResponse = {
    items: page.map(toItemSummary),
    nextCursor: rows.results.length > limit && last ? `${last.received_at}:${last.id}` : null,
  };
  return c.json(body);
});

app.get('/api/items/:id', async (c) => {
  const item = await loadItem(c.env, c.req.param('id'));
  return item ? c.json(item) : c.json({ error: 'not found' }, 404);
});

app.get('/api/items/:id/body', async (c) => {
  const row = await c.env.DB.prepare('SELECT html_key, text_key, status FROM items WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ html_key: string | null; text_key: string | null; status: string }>();
  if (!row || row.status === 'dropped') return c.json({ error: 'not found' }, 404);
  const [html, text] = await Promise.all([
    row.html_key ? c.env.RAW.get(row.html_key).then((o) => o?.text() ?? null) : null,
    row.text_key ? c.env.RAW.get(row.text_key).then((o) => o?.text() ?? null) : null,
  ]);
  const body: ItemBody = { html, text };
  return c.json(body, 200, { 'Cache-Control': 'private, max-age=604800' });
});

app.get('/api/items/:id/raw', async (c) => {
  const row = await c.env.DB.prepare('SELECT raw_key FROM items WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ raw_key: string | null }>();
  const obj = row?.raw_key ? await c.env.RAW.get(row.raw_key) : null;
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${c.req.param('id')}.eml"` },
  });
});

async function logEvent(env: Env, itemId: string, type: ReadingEventType, value?: number, device?: string) {
  await env.DB.prepare('INSERT INTO events (item_id, type, value, device, at) VALUES (?, ?, ?, ?, ?)')
    .bind(itemId, type, value ?? null, device ?? null, now())
    .run();
}

type ItemAction = 'read' | 'unread' | 'save' | 'unsave' | 'archive' | 'unarchive';
// ?1 is the current time, ?2 the item id.
const ITEM_ACTIONS: Record<ItemAction, { sql: string; event: ReadingEventType | null }> = {
  read: { sql: 'UPDATE items SET read_at = COALESCE(read_at, ?1) WHERE id = ?2', event: 'mark_read' },
  unread: { sql: 'UPDATE items SET read_at = NULL WHERE id = ?2 AND ?1 > 0', event: null },
  save: { sql: 'UPDATE items SET saved_at = COALESCE(saved_at, ?1) WHERE id = ?2', event: 'save' },
  unsave: { sql: 'UPDATE items SET saved_at = NULL WHERE id = ?2 AND ?1 > 0', event: 'unsave' },
  archive: { sql: "UPDATE items SET status = 'archived', archived_at = ?1 WHERE id = ?2 AND status = 'inbox'", event: 'archive' },
  unarchive: { sql: "UPDATE items SET status = 'inbox', archived_at = NULL WHERE id = ?2 AND ?1 > 0 AND status = 'archived'", event: 'unarchive' },
};

app.post('/api/items/:id/:action', async (c) => {
  const action = c.req.param('action') as ItemAction | 'events';
  const id = c.req.param('id');

  if (action === 'events') {
    const input = (await c.req.json().catch(() => null)) as ReadingEventInput | null;
    if (!input?.type) return c.json({ error: 'type required' }, 400);
    await logEvent(c.env, id, input.type, input.value, input.device);
    if (input.type === 'open') {
      await c.env.DB.prepare('UPDATE items SET read_at = COALESCE(read_at, ?) WHERE id = ?').bind(now(), id).run();
    }
    return c.json({ ok: true });
  }

  const def = ITEM_ACTIONS[action];
  if (!def) return c.json({ error: 'unknown action' }, 404);
  await c.env.DB.prepare(def.sql).bind(now(), id).run();
  if (def.event) await logEvent(c.env, id, def.event);
  const item = await loadItem(c.env, id);
  return item ? c.json(item) : c.json({ error: 'not found' }, 404);
});

// ---------- Counts for badges ----------

app.get('/api/counts', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM items WHERE status = 'inbox') AS inbox,
       (SELECT COUNT(*) FROM items WHERE status = 'inbox' AND read_at IS NULL) AS unread,
       (SELECT COUNT(*) FROM items WHERE saved_at IS NOT NULL AND status != 'dropped') AS saved,
       (SELECT COUNT(*) FROM senders WHERE status = 'pending') AS pendingSenders`,
  ).first<{ inbox: number; unread: number; saved: number; pendingSenders: number }>();
  return c.json(row ?? { inbox: 0, unread: 0, saved: 0, pendingSenders: 0 });
});

// ---------- Senders (New senders screen) ----------

const SENDER_SELECT = `
  SELECT senders.*, addresses.local_part AS address_local_part,
    (SELECT COUNT(*) FROM items WHERE items.sender_id = senders.id AND items.status = 'screening') AS pending_count,
    (SELECT subject FROM items WHERE items.sender_id = senders.id ORDER BY received_at DESC LIMIT 1) AS latest_subject,
    (SELECT id FROM items WHERE items.sender_id = senders.id ORDER BY received_at DESC LIMIT 1) AS latest_item_id
  FROM senders LEFT JOIN addresses ON addresses.id = senders.address_id`;

app.get('/api/senders', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'approved', 'blocked'].includes(status)) return c.json({ error: 'bad status' }, 400);
  const rows = await c.env.DB.prepare(`${SENDER_SELECT} WHERE senders.status = ? ORDER BY senders.last_seen_at DESC LIMIT 200`)
    .bind(status)
    .all<SenderRow & { address_local_part: string | null; pending_count: number; latest_subject: string | null; latest_item_id: string | null }>();
  return c.json(rows.results.map(toSender));
});

app.post('/api/senders/:id/:decision', async (c) => {
  const id = c.req.param('id');
  const decision = c.req.param('decision');
  const t = now();
  if (decision === 'allow') {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE senders SET status = 'approved', decided_at = ? WHERE id = ?").bind(t, id),
      c.env.DB.prepare(
        "UPDATE items SET status = 'inbox', ai_status = COALESCE(ai_status, 'pending') WHERE sender_id = ? AND status = 'screening'",
      ).bind(id),
    ]);
  } else if (decision === 'block') {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE senders SET status = 'blocked', decided_at = ? WHERE id = ?").bind(t, id),
      c.env.DB.prepare("UPDATE items SET status = 'dropped' WHERE sender_id = ? AND status IN ('screening', 'inbox')").bind(id),
    ]);
  } else {
    return c.json({ error: 'unknown decision' }, 404);
  }
  const row = await c.env.DB.prepare(`${SENDER_SELECT} WHERE senders.id = ?`).bind(id).first<SenderRow>();
  return row ? c.json(toSender(row)) : c.json({ error: 'not found' }, 404);
});

// ---------- Addresses (sign-up aliases) ----------

const ADDRESS_SELECT = `
  SELECT addresses.*,
    (SELECT COUNT(*) FROM senders WHERE senders.address_id = addresses.id AND senders.status = 'approved') AS approved_sender_count
  FROM addresses`;

app.get('/api/addresses', async (c) => {
  const rows = await c.env.DB.prepare(`${ADDRESS_SELECT} ORDER BY created_at DESC`).all<AddressRow & { approved_sender_count: number }>();
  const domain = c.env.MAIL_DOMAIN || null;
  const body: Address[] = rows.results.map((r) => toAddress(r, domain));
  return c.json(body);
});

app.post('/api/addresses', async (c) => {
  const input = (await c.req.json().catch(() => null)) as { label?: string; localPart?: string } | null;
  const label = input?.label?.trim() || null;
  let localPart = slugify(input?.localPart?.trim() || label || '');
  if (!localPart) return c.json({ error: 'label or localPart required' }, 400);

  // Keep the slug unique: money-matters, money-matters-2, ...
  const base = localPart;
  for (let n = 2; n < 50; n++) {
    const taken = await c.env.DB.prepare('SELECT 1 FROM addresses WHERE local_part = ?').bind(localPart).first();
    if (!taken) break;
    localPart = `${base}-${n}`;
  }
  const id = newId();
  const t = now();
  await c.env.DB.prepare(
    'INSERT INTO addresses (id, local_part, label, status, created_in_app, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  )
    .bind(id, localPart, label, 'active', t)
    .run();
  const row = await c.env.DB.prepare(`${ADDRESS_SELECT} WHERE addresses.id = ?`).bind(id).first<AddressRow & { approved_sender_count: number }>();
  return c.json(toAddress(row!, c.env.MAIL_DOMAIN || null), 201);
});

app.post('/api/addresses/:id/:action', async (c) => {
  const id = c.req.param('id');
  const action = c.req.param('action');
  if (action === 'block') {
    await c.env.DB.prepare("UPDATE addresses SET status = 'blocked', blocked_at = ? WHERE id = ?").bind(now(), id).run();
  } else if (action === 'unblock') {
    await c.env.DB.prepare("UPDATE addresses SET status = 'active', blocked_at = NULL WHERE id = ?").bind(id).run();
  } else {
    return c.json({ error: 'unknown action' }, 404);
  }
  const row = await c.env.DB.prepare(`${ADDRESS_SELECT} WHERE addresses.id = ?`).bind(id).first<AddressRow & { approved_sender_count: number }>();
  return row ? c.json(toAddress(row, c.env.MAIL_DOMAIN || null)) : c.json({ error: 'not found' }, 404);
});

// ---------- Sources ----------

app.get('/api/sources', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT sources.*,
         (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS item_count,
         (SELECT MAX(received_at) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS last_received_at
       FROM sources
     ) WHERE item_count > 0 ORDER BY last_received_at DESC`,
  ).all<SourceRow & { item_count: number; last_received_at: number | null }>();
  return c.json(rows.results.map(toSource));
});

const AI_MODES: AiMode[] = ['default', 'on', 'off'];

app.post('/api/sources/:id', async (c) => {
  const id = c.req.param('id');
  const input = (await c.req.json().catch(() => null)) as SourceUpdate | null;
  if (!input) return c.json({ error: 'body required' }, 400);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.category !== undefined) {
    sets.push('category = ?');
    binds.push(typeof input.category === 'string' && input.category.trim() ? input.category.trim().slice(0, 40) : null);
  }
  if (input.aiMode !== undefined) {
    if (!AI_MODES.includes(input.aiMode)) return c.json({ error: 'bad aiMode' }, 400);
    sets.push('ai_mode = ?');
    binds.push(input.aiMode);
  }
  if (sets.length > 0) {
    await c.env.DB.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  }
  const row = await c.env.DB.prepare(
    `SELECT sources.*,
       (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS item_count,
       (SELECT MAX(received_at) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS last_received_at
     FROM sources WHERE id = ?`,
  )
    .bind(id)
    .first<SourceRow & { item_count: number; last_received_at: number | null }>();
  return row ? c.json(toSource(row)) : c.json({ error: 'not found' }, 404);
});

// ---------- Settings ----------

app.get('/api/settings', async (c) => c.json(await loadSettings(c.env)));

app.put('/api/settings', async (c) => {
  const input = (await c.req.json().catch(() => null)) as Partial<AppSettings> | null;
  if (!input) return c.json({ error: 'body required' }, 400);
  const settings = normalizeSettings(input, await loadSettings(c.env));
  await saveSettings(c.env, settings);
  return c.json(settings);
});

// ---------- Quick summaries for items that arrived before they existed ----------

const BACKFILL_BATCH = 5;

/**
 * Fills in the quick summary for a few older items per call; the web app
 * calls it until nothing remains. Small batches keep each request inside
 * the free plan's CPU budget.
 */
app.post('/api/maintenance/quick-backfill', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, subject, html_key, text_key FROM items WHERE word_count IS NULL AND status != 'dropped' LIMIT ?",
  )
    .bind(BACKFILL_BATCH)
    .all<{ id: string; subject: string; html_key: string | null; text_key: string | null }>();
  const settings = rows.results.length > 0 ? await loadSettings(c.env) : null;
  for (const row of rows.results) {
    const [html, text] = await Promise.all([
      row.html_key ? c.env.RAW.get(row.html_key).then((o) => o?.text() ?? null) : null,
      row.text_key ? c.env.RAW.get(row.text_key).then((o) => o?.text() ?? null) : null,
    ]);
    const quick = quickSummary(html, text);
    const category = categoryFromRules(settings!.keywordRules, row.subject, quick.preheader);
    await c.env.DB.prepare(
      'UPDATE items SET preheader = ?, word_count = ?, sponsored = ?, category = COALESCE(category, ?) WHERE id = ?',
    )
      .bind(quick.preheader, quick.wordCount, quick.sponsored ? 1 : 0, category, row.id)
      .run();
  }
  const left = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE word_count IS NULL AND status != 'dropped'").first<{
    n: number;
  }>();
  return c.json({ done: rows.results.length, remaining: left?.n ?? 0 });
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});
