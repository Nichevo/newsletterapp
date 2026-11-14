// Adverts. The PC's summary step also says whether an item is only an advert
// (a sales or promo email with no real article) and where an ad tacked onto the
// end of a real article starts. An advert gets items.sponsored = 2 and, unless
// Settings say "label only", leaves the Inbox for the Adverts view. The reader
// hides an ad at the end from its first words down; nothing stored is cut.
// Your own say ("Not an advert", "Mark as advert") always wins over the AI's.

import type { AdInfo, AdvertMode, AiOutput } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { loadSettings } from './settings';

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

/** Added to whichever summary prompt is used (custom per-source and per-category ones too). */
export const ADVERT_RULES = `

Adverts: also fill in these two fields of the JSON.
"advert": true only when the whole text is an advert or sales promotion with no real article or news in it, e.g. a product or sale announcement, a discount code, "upgrade to paid", a webinar or ticket push, a sponsor's own email. A newsletter or article that merely carries a sponsored section is NOT an advert. When true, make "summary" one short line saying what is advertised and the offer (e.g. "Advert for Acme VPN: 40% off until Friday"), and leave "key_points" and "topics" empty.
"ad_starts_at": when a real article ends with an ad, promotion or sponsor message tacked on after the article itself is over, copy the first 6 to 10 words of that ad exactly as they appear in the text; otherwise "". Never point into the article's own content.`;

/** The prompt with the advert rules, unless adverts are switched off. */
export const withAdvertRules = (prompt: string, mode: AdvertMode) => (mode === 'off' ? prompt : prompt + ADVERT_RULES);

interface AdRow {
  ai_advert: number;
  tail: string | null;
  you: string | null;
  tail_wrong: number;
  moved: number;
}

/** The first words of an ad at the end, tidied; null when there's nothing usable. */
function cleanTail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '');
  // A few words at least, or it matches all over the place.
  return t.split(' ').length >= 3 && t.length >= 12 ? t.slice(0, 200) : null;
}

/** Moves an item out of the Inbox for being an advert (not one you saved or starred). */
const moveSql = `UPDATE items SET status = 'archived', archived_at = ?1
  WHERE id = ?2 AND status = 'inbox' AND saved_at IS NULL AND interesting_at IS NULL`;
/** Whether the move above would happen; recorded first so Not an advert can put it back. */
const canMoveSql = `(SELECT COUNT(*) FROM items WHERE id = ?2 AND status = 'inbox' AND saved_at IS NULL AND interesting_at IS NULL)`;
/** Back to the Inbox, only when it was moved for being an advert. */
const unmoveSql = `UPDATE items SET status = 'inbox', archived_at = NULL
  WHERE id = ?1 AND status = 'archived' AND EXISTS (SELECT 1 FROM item_ads WHERE item_id = ?1 AND moved = 1)`;

/**
 * Statements that record the AI's say on adverts with a finished summary. Runs
 * in the same batch as the summary itself.
 */
export async function adverdictStatements(env: Env, itemId: string, output: AiOutput, mode: AdvertMode): Promise<D1PreparedStatement[]> {
  if (mode === 'off') return [];
  const row = await env.DB.prepare('SELECT ai_advert, tail, you, tail_wrong, moved FROM item_ads WHERE item_id = ?').bind(itemId).first<AdRow>();
  const advert = output.advert === true;
  const tail = advert ? null : cleanTail(output.ad_starts_at);
  if (!row && !advert && !tail) return [];
  const t = now();
  const out: D1PreparedStatement[] = [];
  if (!row?.you) {
    if (advert) {
      out.push(
        env.DB.prepare(
          `INSERT INTO item_ads (item_id, ai_advert, tail, moved, at) VALUES (?2, 1, NULL, ${mode === 'move' ? canMoveSql : '0'}, ?1)
           ON CONFLICT(item_id) DO UPDATE SET ai_advert = 1, tail = NULL, moved = MAX(moved, excluded.moved), at = ?1`,
        ).bind(t, itemId),
        env.DB.prepare('UPDATE items SET sponsored = 2 WHERE id = ?').bind(itemId),
      );
      if (mode === 'move') out.push(env.DB.prepare(moveSql).bind(t, itemId));
      return out;
    }
    if (row?.ai_advert) {
      // A fresh summary says it isn't an advert after all (e.g. a fuller copy was fetched).
      out.push(env.DB.prepare('UPDATE items SET sponsored = 0 WHERE id = ? AND sponsored = 2').bind(itemId), env.DB.prepare(unmoveSql).bind(itemId));
    }
  }
  out.push(
    env.DB.prepare(
      `INSERT INTO item_ads (item_id, ai_advert, tail, at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(item_id) DO UPDATE SET ai_advert = ?2, tail = ?3, moved = CASE WHEN ?2 = 0 AND you IS NULL THEN 0 ELSE moved END, at = ?4`,
    ).bind(itemId, advert ? 1 : 0, tail, t),
  );
  return out;
}

/** The reader's advert details for one item. */
export async function adInfo(env: Env, itemId: string, advert: boolean): Promise<AdInfo> {
  const row = await env.DB.prepare('SELECT ai_advert, tail, you, tail_wrong, moved FROM item_ads WHERE item_id = ?').bind(itemId).first<AdRow>();
  return {
    by: advert ? (row?.you === 'advert' ? 'you' : 'ai') : null,
    notAdvert: row?.you === 'not_advert',
    tail: advert ? null : (row?.tail ?? null),
    tailWrong: row?.tail_wrong === 1,
  };
}

export function registerAdverts(app: App) {
  /** Your say: { advert: true } marks it an advert, { advert: false } says it isn't one (the AI never flags it again). */
  app.post('/api/items/:id/advert', async (c) => {
    const id = c.req.param('id');
    const input = (await c.req.json().catch(() => null)) as { advert?: unknown } | null;
    if (typeof input?.advert !== 'boolean') return c.json({ error: 'advert: true or false' }, 400);
    const t = now();
    if (input.advert) {
      const mode = (await loadSettings(c.env)).adverts;
      const move = mode === 'move';
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO item_ads (item_id, you, moved, at) VALUES (?2, 'advert', ${move ? canMoveSql : '0'}, ?1)
           ON CONFLICT(item_id) DO UPDATE SET you = 'advert', moved = MAX(moved, excluded.moved), at = ?1`,
        ).bind(t, id),
        c.env.DB.prepare('UPDATE items SET sponsored = 2 WHERE id = ?').bind(id),
        ...(move ? [c.env.DB.prepare(moveSql).bind(t, id)] : []),
      ]);
    } else {
      await c.env.DB.batch([
        // Back first (it checks moved), then forget the move.
        c.env.DB.prepare(unmoveSql).bind(id),
        c.env.DB.prepare(
          `INSERT INTO item_ads (item_id, you, at) VALUES (?1, 'not_advert', ?2)
           ON CONFLICT(item_id) DO UPDATE SET you = 'not_advert', moved = 0, at = ?2`,
        ).bind(id, t),
        c.env.DB.prepare('UPDATE items SET sponsored = 0 WHERE id = ? AND sponsored = 2').bind(id),
      ]);
    }
    return c.json({ ok: true });
  });

  /** The hidden end of an article wasn't an ad ({ wrong: true }), or was after all ({ wrong: false }). */
  app.post('/api/items/:id/ad-tail', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { wrong?: unknown } | null;
    if (typeof input?.wrong !== 'boolean') return c.json({ error: 'wrong: true or false' }, 400);
    await c.env.DB.prepare('UPDATE item_ads SET tail_wrong = ?, at = ? WHERE item_id = ?')
      .bind(input.wrong ? 1 : 0, now(), c.req.param('id'))
      .run();
    return c.json({ ok: true });
  });

  /** Summarised items from the last few days go back to the PC, so adverts among them are spotted too. */
  app.post('/api/adverts/recheck', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { days?: unknown } | null;
    const days = input?.days === 7 || input?.days === 30 ? input.days : null;
    if (!days) return c.json({ error: 'days: 7 or 30' }, 400);
    const t = now();
    const r = await c.env.DB.prepare(
      `UPDATE items SET ai_status = 'pending', ai_attempts = 0, ai_error = NULL, ai_queued_at = ?1
       WHERE received_at >= ?2 AND ai_status = 'done' AND status IN ('inbox', 'archived') AND kind != 'ai'`,
    )
      .bind(t, t - days * 86_400_000)
      .run();
    return c.json({ queued: r.meta.changes ?? 0 });
  });

  /** How the advert spotting is doing: the AI's calls and yours, over the last 30 days. */
  app.get('/api/adverts/stats', async (c) => {
    const since = now() - 30 * 86_400_000;
    const row = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(ai_advert = 1), 0) AS ai,
         COALESCE(SUM(ai_advert = 1 AND you = 'not_advert'), 0) AS wrong,
         COALESCE(SUM(you = 'advert' AND ai_advert = 0), 0) AS missed,
         COALESCE(SUM(tail IS NOT NULL AND ai_advert = 0), 0) AS tails,
         COALESCE(SUM(tail IS NOT NULL AND tail_wrong = 1), 0) AS tailsWrong
       FROM item_ads INDEXED BY item_ads_at WHERE at >= ?`,
    )
      .bind(since)
      .first<{ ai: number; wrong: number; missed: number; tails: number; tailsWrong: number }>();
    return c.json(row ?? { ai: 0, wrong: 0, missed: 0, tails: 0, tailsWrong: 0 });
  });
}
