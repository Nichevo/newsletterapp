import type { Hono } from 'hono';
import type { EmbedJob, EmbedResult, HelperHeartbeat, LikelyState } from '@newsletterapp/shared';
import { readJson, writeJson } from './ai';
import { parseList } from './db';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { assignStories } from './stories';

/**
 * Embeddings for stories (related reading) and Likely interesting. The PC helper turns each item's
 * subject, summary and topics into a vector with a local embedding model, keeps the vectors
 * on the PC, works out the nearest older items itself and sends back only those links. It
 * also scores recent items against the ones marked Interesting and sends back which ones
 * cross the line. The Worker stores the results; no vector maths runs here.
 */

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

/** Items waiting to be embedded: not yet done, and not about to get a summary (which changes the text). */
const WAITING = "items.embedded_at IS NULL AND (items.ai_status IS NULL OR items.ai_status NOT IN ('pending', 'working'))";
const MAX_CLAIM = 64;
const TEXT_CHARS = 2000;

/** Called from the heartbeat: resets the queue for a new store, and says whether there is work. */
export async function embedHeartbeat(env: Env, hb: HelperHeartbeat): Promise<{ embedWaiting: boolean; interestingKey: string }> {
  if (typeof hb.embedStore === 'string' && hb.embedStore) {
    const known = await readJson<{ store?: string }>(env, 'embed_store');
    if (known?.store !== hb.embedStore) {
      // A different store on the PC (new install, lost file or another model): embed everything again.
      await env.DB.batch([
        env.DB.prepare('UPDATE items SET embedded_at = NULL WHERE embedded_at IS NOT NULL'),
        env.DB.prepare('UPDATE items SET likely = NULL WHERE likely = 1'),
      ]);
      await writeJson(env, 'embed_store', { store: hb.embedStore.slice(0, 100), since: now() });
    }
  }
  const [waiting, stars] = await env.DB.batch([
    env.DB.prepare(`SELECT 1 AS w FROM items WHERE ${WAITING} LIMIT 1`),
    env.DB.prepare('SELECT COUNT(*) AS n, MAX(interesting_at) AS at FROM items WHERE interesting_at IS NOT NULL'),
  ]);
  const s = stars?.results[0] as { n: number; at: number | null } | undefined;
  return { embedWaiting: (waiting?.results.length ?? 0) > 0, interestingKey: `${s?.n ?? 0}:${s?.at ?? 0}` };
}

/** The text an item is embedded from: what it is about, without the full body. */
function embedText(r: { subject: string; summary: string | null; key_points: string | null; tags: string | null; preheader: string | null; snippet: string | null; source_name: string | null }) {
  const points = parseList(r.key_points);
  const tags = parseList(r.tags);
  return [
    r.subject,
    r.summary ?? r.preheader ?? r.snippet ?? '',
    points.length ? points.join('; ') : '',
    tags.length ? `Topics: ${tags.join(', ')}` : '',
    r.source_name ? `From: ${r.source_name}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, TEXT_CHARS);
}

export function registerEmbed(app: App) {
  /** The next items to embed, oldest first, so each one's older neighbours are already in the store. */
  app.post('/api/helper/embed/claim', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Number(input.max) || 32, 1), MAX_CLAIM);
    const rows = await c.env.DB.prepare(
      `SELECT items.id, items.subject, items.summary, items.key_points, items.tags, items.preheader, items.snippet, items.received_at,
         sources.name AS source_name
       FROM items LEFT JOIN sources ON sources.id = items.source_id
       WHERE ${WAITING} ORDER BY items.received_at ASC LIMIT ?`,
    )
      .bind(max)
      .all<{
        id: string;
        subject: string;
        summary: string | null;
        key_points: string | null;
        tags: string | null;
        preheader: string | null;
        snippet: string | null;
        received_at: number;
        source_name: string | null;
      }>();
    const jobs: EmbedJob[] = rows.results.map((r) => ({ itemId: r.id, receivedAt: r.received_at, text: embedText(r) }));
    return c.json({ jobs });
  });

  /** Nearest older items for each embedded one. */
  app.post('/api/helper/embed/result', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { results?: EmbedResult[] } | null;
    const results = Array.isArray(input?.results) ? input.results.slice(0, MAX_CLAIM) : [];
    const t = now();
    const stmts = results
      .filter((r) => typeof r?.itemId === 'string')
      .map((r) => {
        const neighbours = (Array.isArray(r.neighbours) ? r.neighbours : [])
          .filter((n) => Array.isArray(n) && typeof n[0] === 'string' && Number.isFinite(n[1]))
          .slice(0, 20)
          .map(([id, sim]) => [id.slice(0, 64), Math.round(sim * 1000) / 1000]);
        return c.env.DB.prepare('UPDATE items SET embedded_at = ?, neighbours = ? WHERE id = ?').bind(t, JSON.stringify(neighbours), r.itemId);
      });
    if (stmts.length) await c.env.DB.batch(stmts);
    // Match the new items into stories straight away (oldest waiting first).
    if (stmts.length) await assignStories(c.env, stmts.length + 8).catch((err: unknown) => console.error('story matching failed', err));
    return c.json({ ok: true, saved: stmts.length });
  });

  /** Which items are marked Interesting, and which are flagged Likely interesting now. */
  app.get('/api/helper/likely', async (c) => {
    const [stars, likely] = await c.env.DB.batch([
      c.env.DB.prepare('SELECT id FROM items WHERE interesting_at IS NOT NULL ORDER BY interesting_at DESC LIMIT 500'),
      c.env.DB.prepare('SELECT id FROM items WHERE likely = 1 ORDER BY received_at DESC LIMIT 2000'),
    ]);
    const ids = (r: D1Result | undefined) => ((r?.results ?? []) as { id: string }[]).map((x) => x.id);
    return c.json({ interesting: ids(stars), likely: ids(likely) } satisfies LikelyState);
  });

  /** Flags changes only, so a rescore writes a handful of rows rather than every recent item. */
  app.post('/api/helper/likely', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { set?: string[]; unset?: string[] } | null;
    const set = (Array.isArray(input?.set) ? input.set : []).filter((x) => typeof x === 'string').slice(0, 500);
    const unset = (Array.isArray(input?.unset) ? input.unset : []).filter((x) => typeof x === 'string').slice(0, 2000);
    const stmts = [
      ...set.map((id) => c.env.DB.prepare('UPDATE items SET likely = 1 WHERE id = ?').bind(id)),
      ...unset.map((id) => c.env.DB.prepare('UPDATE items SET likely = NULL WHERE id = ?').bind(id)),
    ];
    for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
    return c.json({ ok: true });
  });
}
