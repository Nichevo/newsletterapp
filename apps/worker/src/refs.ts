import type {
  ItemReferences,
  ItemStudy,
  KeySentenceSettings,
  KeyStatus,
  LinkDetail,
  LinkIn,
  LinkSummary,
  RefJob,
  RefResult,
  StudyCite,
  StudyCiteIn,
  StudyDetail,
  StudySummary,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { loadState } from './ai';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';
import { loadKeySettings } from './keysentences';
import { limitState } from './usage';

// Studies and source links. Every summarised article (when key sentences and
// "collect studies" are on) goes to the PC once more: it finds the sentences
// that cite a study, report or survey and names each one, and lists the
// article's source links. Here they're matched to studies and links already
// seen, so the same study can be followed across articles, and flagged when
// two articles quote it with different numbers. Links stay out of sight until
// a second article points to the same one.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 2;
const MAX_STUDIES = 25;
const MAX_LINKS = 60;
const PAGE = 50;

// ---------- Prompt ----------

export function refsPrompt(): string {
  return [
    'You find the studies an article cites. The text comes as numbered sentences like "[12] ...", only the ones that might cite something.',
    'A study here means research, a report, a survey, a poll, a paper, a dataset, an official statistic or a book that the article relies on for a fact.',
    'For each one, give s (the number of the sentence that cites it), title (its name, or a short description if unnamed, e.g. "Stanford study of remote workers"), publisher (who did it: university, agency, company, journal; null if not said), year (null if not said) and claim (what the article says it found, under 20 words).',
    'Skip vague mentions like "studies show" with nothing to tell them apart, and skip the article citing itself.',
    'Reply with JSON only, no other text: {"studies": [{"s": 7, "title": "...", "publisher": "...", "year": 2024, "claim": "..."}]}. If there are none, reply {"studies": []}.',
  ].join('\n');
}

// ---------- Queueing ----------

/** After a summary: every article gets its studies and links collected once, whatever its length. */
export async function queueRefs(env: Env, itemId: string, s: KeySentenceSettings): Promise<void> {
  if (!s.enabled || !s.studies) return;
  await env.DB.prepare(
    `UPDATE items SET refs_status = 'pending', refs_attempts = 0
     WHERE id = ? AND refs_status IS NULL AND kind != 'ai' AND status != 'dropped' AND received_at >= ?`,
  )
    .bind(itemId, s.since ?? 0)
    .run();
}

export async function refsWaiting(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS w FROM items INDEXED BY items_refs_queue
     WHERE refs_status IN ('pending', 'working') AND (refs_status = 'pending' OR refs_at < ?) LIMIT 1`,
  )
    .bind(now() - LEASE_MS)
    .first<{ w: number }>();
  return Boolean(row);
}

/** Switching off: nothing should wait for the PC. */
export async function clearRefsQueue(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE items SET refs_status = NULL WHERE id IN (
       SELECT id FROM items INDEXED BY items_refs_queue WHERE refs_status IN ('pending', 'working') LIMIT 5000)`,
  ).run();
}

/** "Also do older articles": the last few days' summarised articles. */
export async function backdateRefs(env: Env, since: number): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE items SET refs_status = 'pending', refs_attempts = 0
     WHERE id IN (
       SELECT id FROM items WHERE received_at >= ? AND refs_status IS NULL AND status != 'dropped' AND kind != 'ai'
         AND ai_status = 'done'
       LIMIT 2000
     )`,
  )
    .bind(since)
    .run();
  return r.meta.changes ?? 0;
}

// ---------- Matching ----------

const STOP = new Set(
  'a an the of on in for and to by from with at as is are was were study report survey paper research analysis new its their his her this that'.split(' '),
);

/** "The 2024 Global Wellbeing Report" -> "2024 global report wellbeing": the title's words, sorted. */
export function titleKey(title: string): string {
  return [...new Set(words(title))].sort().join(' ');
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** How alike two titles are: shared words over all words. */
export function titleCloseness(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const TRACKING = /^(utm_|mc_|fbclid$|gclid$|igshid$|ref$|ref_src$|s$|cmpid$|ocid$|sr_share$|smid$|_hsenc$|_hsmi$|mkt_tok$)/i;

/** One form of a web address: no tracking bits, no #part, no www., no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.protocol = 'https:';
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  let out = u.toString();
  if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
  return out;
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Links that never point to a source: social, sharing, shops, sign-ups, the newsletter platforms themselves. */
const SKIP_HOSTS =
  /(^|\.)(twitter\.com|x\.com|facebook\.com|fb\.com|instagram\.com|linkedin\.com|tiktok\.com|threads\.net|bsky\.app|pinterest\.com|reddit\.com\/submit|whatsapp\.com|t\.me|telegram\.me|mailchi\.mp|list-manage\.com|substack\.com|beehiiv\.com|buttondown\.email|convertkit\.com|ck\.page|patreon\.com|ko-fi\.com|buymeacoffee\.com|apps\.apple\.com|play\.google\.com|amzn\.to|amazon\.[a-z.]+|bit\.ly|eepurl\.com|doubleclick\.net|google\.com\/url)$/i;
const SKIP_TEXT = /^(subscribe|unsubscribe|sign up|log ?in|share|tweet|follow|view (it )?in (your )?browser|read (it )?online|manage (your )?(preferences|subscription)|update your preferences|advertise|sponsor(ed)?|donate|privacy( policy)?|terms|contact( us)?|home|about( us)?|here|read more|continue reading|more)$/i;

export function keepLink(url: string, text: string, ownHost: string | null): boolean {
  const host = hostOf(url);
  if (!host || SKIP_HOSTS.test(host)) return false;
  if (ownHost && (host === ownHost || host.endsWith(`.${ownHost}`))) return false;
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '/';
    }
  })();
  // A bare home page is rarely a source.
  if (path === '/' || path === '') return false;
  if (SKIP_TEXT.test(text.trim())) return false;
  return true;
}

/** Numbers in a sentence, written one way: "40%", "40 percent" -> "40%"; "1.2 million" -> "1.2m". */
export function numbersIn(text: string): string[] {
  const out = new Set<string>();
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(%|per ?cent|percent|million|billion|trillion|bn|m\b|k\b)?/gi;
  for (const m of text.matchAll(re)) {
    const n = m[1]!.replace(/,/g, '');
    const unit = (m[2] ?? '').toLowerCase();
    // Years on their own say nothing about what a study found.
    if (!unit && /^(19|20)\d\d$/.test(n)) continue;
    if (!unit && Number(n) < 10) continue;
    const u = unit.startsWith('per') || unit === '%' ? '%' : unit === 'million' || unit === 'm' ? 'm' : unit === 'billion' || unit === 'bn' ? 'bn' : unit === 'trillion' ? 'tn' : unit;
    out.add(`${n}${u}`);
  }
  return [...out].slice(0, 12);
}

/** Two cites disagree when both give percentages (or both amounts) and none of them match. */
export function numbersDiffer(a: string[], b: string[]): boolean {
  for (const unit of ['%', 'm', 'bn']) {
    const x = a.filter((n) => n.endsWith(unit));
    const y = b.filter((n) => n.endsWith(unit));
    if (x.length && y.length && !x.some((n) => y.includes(n))) return true;
  }
  return false;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function cleanStudies(input: unknown): StudyCiteIn[] {
  if (!Array.isArray(input)) return [];
  const out: StudyCiteIn[] = [];
  for (const raw of input.slice(0, MAX_STUDIES)) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const title = clean(v.title, 200);
    const quote = clean(v.quote, 1500);
    if (title.length < 4 || quote.length < 8 || words(title).length === 0) continue;
    const year = typeof v.year === 'number' && v.year >= 1800 && v.year <= 2100 ? Math.round(v.year) : null;
    const doi = clean(v.doi, 200).toLowerCase() || null;
    out.push({
      title,
      publisher: clean(v.publisher, 120) || null,
      year,
      doi: doi && /^10\.\d{4,9}\//.test(doi) ? doi : null,
      url: typeof v.url === 'string' ? normalizeUrl(v.url) : null,
      claim: clean(v.claim, 300) || null,
      quote,
      prefix: typeof v.prefix === 'string' ? v.prefix.slice(-40) : '',
      suffix: typeof v.suffix === 'string' ? v.suffix.slice(0, 40) : '',
      textOffset: typeof v.textOffset === 'number' && Number.isFinite(v.textOffset) ? Math.max(0, Math.round(v.textOffset)) : 0,
      numbers: Array.isArray(v.numbers) ? v.numbers.filter((n): n is string => typeof n === 'string').slice(0, 12) : numbersIn(quote),
    });
  }
  return out;
}

interface StudyRow {
  id: string;
  title: string;
  publisher: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  title_key: string;
  cites: number;
  differs: number;
  last_seen: number;
}

/** Same DOI, same link, or the same title words (and no clash of year) is the same study. */
async function findStudy(env: Env, s: StudyCiteIn): Promise<StudyRow | null> {
  if (s.doi) {
    const row = await env.DB.prepare('SELECT * FROM studies WHERE doi = ? LIMIT 1').bind(s.doi).first<StudyRow>();
    if (row) return row;
  }
  if (s.url) {
    const row = await env.DB.prepare('SELECT * FROM studies WHERE url = ? LIMIT 1').bind(s.url).first<StudyRow>();
    if (row) return row;
  }
  const rows = await env.DB.prepare('SELECT * FROM studies WHERE title_key = ? LIMIT 5').bind(titleKey(s.title)).all<StudyRow>();
  return rows.results.find((r) => r.year === null || s.year === null || r.year === s.year) ?? null;
}

/** Studies close enough to be asked about ("Maybe the same study"): same year or publisher, most title words shared. */
async function maybeSame(env: Env, study: StudyRow): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id, title, year, publisher FROM studies
     WHERE id != ?1 AND ((?2 IS NOT NULL AND year = ?2) OR (?3 IS NOT NULL AND publisher = ?3))
     ORDER BY last_seen DESC LIMIT 300`,
  )
    .bind(study.id, study.year, study.publisher)
    .all<{ id: string; title: string; year: number | null; publisher: string | null }>();
  return rows.results
    .filter((r) => (r.year === null || study.year === null || r.year === study.year) && titleCloseness(r.title, study.title) >= 0.5)
    .slice(0, 3)
    .map((r) => r.id);
}

async function saveStudies(env: Env, itemId: string, list: StudyCiteIn[], t: number) {
  // Done again (e.g. after a re-fetch): this article's old cites go first.
  const old = await env.DB.prepare('SELECT study_id FROM study_cites WHERE item_id = ?').bind(itemId).all<{ study_id: string }>();
  if (old.results.length) {
    await env.DB.prepare('DELETE FROM study_cites WHERE item_id = ?').bind(itemId).run();
    await recount(env, old.results.map((r) => r.study_id));
  }
  const touched = new Set<string>();
  for (const s of list) {
    let study = await findStudy(env, s);
    if (study) {
      // Fill in what this article knows that the first one didn't.
      await env.DB.prepare(
        'UPDATE studies SET publisher = COALESCE(publisher, ?), year = COALESCE(year, ?), doi = COALESCE(doi, ?), url = COALESCE(url, ?), last_seen = ? WHERE id = ?',
      )
        .bind(s.publisher, s.year, s.doi, s.url, t, study.id)
        .run();
    } else {
      study = {
        id: newId(),
        title: s.title,
        publisher: s.publisher,
        year: s.year,
        doi: s.doi,
        url: s.url,
        title_key: titleKey(s.title),
        cites: 0,
        differs: 0,
        last_seen: t,
      };
      await env.DB.prepare(
        'INSERT INTO studies (id, title, publisher, year, doi, url, title_key, cites, differs, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
      )
        .bind(study.id, study.title, study.publisher, study.year, study.doi, study.url, study.title_key, t, t)
        .run();
      for (const other of await maybeSame(env, study)) {
        const [a, b] = [study.id, other].sort();
        await env.DB.prepare('INSERT OR IGNORE INTO study_maybe (a, b, decided, at) VALUES (?, ?, NULL, ?)').bind(a, b, t).run();
      }
    }
    if (touched.has(study.id)) continue; // one cite per article
    touched.add(study.id);
    // Do other articles give different numbers for it?
    const others = await env.DB.prepare('SELECT id, numbers FROM study_cites WHERE study_id = ? AND item_id != ? ORDER BY at DESC LIMIT 20')
      .bind(study.id, itemId)
      .all<{ id: string; numbers: string | null }>();
    const differsFrom = others.results.find((o) => numbersDiffer(s.numbers, parseList(o.numbers)))?.id ?? null;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO study_cites (id, study_id, item_id, claim, quote, prefix, suffix, text_offset, numbers, differs_from, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(newId(), study.id, itemId, s.claim, s.quote, s.prefix, s.suffix, s.textOffset, JSON.stringify(s.numbers), differsFrom, t)
      .run();
  }
  await recount(env, [...touched]);
}

/** Keeps studies.cites and studies.differs in step with study_cites. */
async function recount(env: Env, ids: string[]) {
  for (const id of new Set(ids)) {
    await env.DB.prepare(
      `UPDATE studies SET
         cites = (SELECT COUNT(*) FROM study_cites WHERE study_id = ?1),
         differs = EXISTS (SELECT 1 FROM study_cites WHERE study_id = ?1 AND differs_from IS NOT NULL)
       WHERE id = ?1`,
    )
      .bind(id)
      .run();
  }
}

async function saveLinks(env: Env, itemId: string, list: LinkIn[], ownHost: string | null, t: number) {
  const seen = new Map<string, string>();
  for (const l of list) {
    const url = typeof l?.url === 'string' ? normalizeUrl(l.url) : null;
    const text = clean(l?.text, 200);
    // A link with no words (a picture, a tracking pixel) says nothing about what it is.
    if (!url || !text || seen.has(url) || !keepLink(url, text, ownHost)) continue;
    seen.set(url, text);
    if (seen.size >= MAX_LINKS) break;
  }
  const old = await env.DB.prepare('SELECT link_id FROM link_cites WHERE item_id = ?').bind(itemId).all<{ link_id: string }>();
  const stmts: D1PreparedStatement[] = [];
  if (old.results.length) stmts.push(env.DB.prepare('DELETE FROM link_cites WHERE item_id = ?').bind(itemId));
  const ids: string[] = old.results.map((r) => r.link_id);
  for (const [url, text] of seen) {
    const id = newId();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO links (id, url, host, title, cites, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
         ON CONFLICT(url) DO UPDATE SET last_seen = ?5, title = COALESCE(links.title, ?4)`,
      ).bind(id, url, hostOf(url), text || null, t),
      env.DB.prepare('INSERT OR IGNORE INTO link_cites (link_id, item_id, text, at) SELECT id, ?, ?, ? FROM links WHERE url = ?').bind(itemId, text || null, t, url),
      env.DB.prepare('UPDATE links SET cites = (SELECT COUNT(*) FROM link_cites WHERE link_id = links.id) WHERE url = ?').bind(url),
    );
  }
  for (const id of ids) stmts.push(env.DB.prepare('UPDATE links SET cites = (SELECT COUNT(*) FROM link_cites WHERE link_id = ?1) WHERE id = ?1').bind(id));
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

const parseList = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const toSummary = (r: StudyRow): StudySummary => ({
  id: r.id,
  title: r.title,
  publisher: r.publisher,
  year: r.year,
  url: r.url,
  doi: r.doi,
  cites: r.cites,
  differs: r.differs === 1,
  lastSeen: r.last_seen,
});

interface LinkRow {
  id: string;
  url: string;
  host: string;
  title: string | null;
  cites: number;
  last_seen: number;
}
const toLink = (r: LinkRow): LinkSummary => ({ id: r.id, url: r.url, host: r.host, title: r.title, cites: r.cites, lastSeen: r.last_seen });

/** Same: every cite of `drop` moves to `keep`, and `drop` goes. */
async function mergeStudies(env: Env, keep: string, drop: string) {
  const t = now();
  // An article that cites both keeps its cite of the one kept.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM study_cites WHERE study_id = ?1 AND item_id IN (SELECT item_id FROM study_cites WHERE study_id = ?2)').bind(drop, keep),
    env.DB.prepare('UPDATE study_cites SET study_id = ? WHERE study_id = ?').bind(keep, drop),
    env.DB.prepare(
      `UPDATE studies SET
         publisher = COALESCE(publisher, (SELECT publisher FROM studies WHERE id = ?2)),
         year = COALESCE(year, (SELECT year FROM studies WHERE id = ?2)),
         doi = COALESCE(doi, (SELECT doi FROM studies WHERE id = ?2)),
         url = COALESCE(url, (SELECT url FROM studies WHERE id = ?2)),
         last_seen = ?3
       WHERE id = ?1`,
    ).bind(keep, drop, t),
    env.DB.prepare('DELETE FROM studies WHERE id = ?').bind(drop),
    env.DB.prepare('DELETE FROM study_maybe WHERE a = ?1 OR b = ?1').bind(drop),
  ]);
  // Numbers may now disagree across the joined cites.
  const cites = await env.DB.prepare('SELECT id, numbers FROM study_cites WHERE study_id = ? ORDER BY at').bind(keep).all<{ id: string; numbers: string | null }>();
  const stmts: D1PreparedStatement[] = [];
  cites.results.forEach((c, i) => {
    const mine = parseList(c.numbers);
    const other = cites.results.slice(0, i).find((o) => numbersDiffer(mine, parseList(o.numbers)));
    stmts.push(env.DB.prepare('UPDATE study_cites SET differs_from = ? WHERE id = ?').bind(other?.id ?? null, c.id));
  });
  if (stmts.length) await env.DB.batch(stmts);
  await recount(env, [keep]);
}

// ---------- Routes ----------

export function registerRefs(app: App) {
  app.get('/api/items/:id/references', async (c) => {
    const id = c.req.param('id');
    const [item, s] = await Promise.all([
      c.env.DB.prepare('SELECT refs_status FROM items WHERE id = ?').bind(id).first<{ refs_status: KeyStatus | null }>(),
      loadKeySettings(c.env),
    ]);
    if (!item) return c.json({ error: 'not found' }, 404);
    if (!s.enabled) return c.json({ status: null, studies: [], links: [], hiddenLinks: 0 } satisfies ItemReferences);
    const [studies, links] = await Promise.all([
      c.env.DB.prepare(
        `SELECT studies.*, study_cites.id AS cite_id, study_cites.claim, study_cites.quote, study_cites.prefix, study_cites.suffix,
           study_cites.text_offset, study_cites.differs_from,
           (SELECT CASE WHEN study_maybe.a = studies.id THEN study_maybe.b ELSE study_maybe.a END FROM study_maybe
             WHERE (study_maybe.a = studies.id OR study_maybe.b = studies.id) AND study_maybe.decided IS NULL LIMIT 1) AS maybe_id
         FROM study_cites JOIN studies ON studies.id = study_cites.study_id
         WHERE study_cites.item_id = ? ORDER BY study_cites.text_offset`,
      )
        .bind(id)
        .all<StudyRow & { cite_id: string; claim: string | null; quote: string; prefix: string | null; suffix: string | null; text_offset: number | null; differs_from: string | null; maybe_id: string | null }>(),
      c.env.DB.prepare(
        `SELECT links.* FROM link_cites JOIN links ON links.id = link_cites.link_id WHERE link_cites.item_id = ? ORDER BY links.cites DESC, links.url LIMIT 100`,
      )
        .bind(id)
        .all<LinkRow>(),
    ]);
    const maybeIds = [...new Set(studies.results.map((r) => r.maybe_id).filter((x): x is string => Boolean(x)))];
    const maybes = maybeIds.length
      ? await c.env.DB.prepare(`SELECT id, title, cites FROM studies WHERE id IN (${maybeIds.map(() => '?').join(',')})`)
          .bind(...maybeIds)
          .all<{ id: string; title: string; cites: number }>()
      : { results: [] };
    // Another article citing it with different numbers, either way round.
    const differing = new Set<string>();
    const citeIds = studies.results.map((r) => r.cite_id);
    if (citeIds.length) {
      const rows = await c.env.DB.prepare(`SELECT differs_from FROM study_cites WHERE differs_from IN (${citeIds.map(() => '?').join(',')})`)
        .bind(...citeIds)
        .all<{ differs_from: string }>();
      for (const r of rows.results) differing.add(r.differs_from);
    }
    const out: ItemStudy[] = studies.results.map((r) => ({
      ...toSummary(r),
      citeId: r.cite_id,
      claim: r.claim,
      quote: r.quote,
      prefix: r.prefix ?? '',
      suffix: r.suffix ?? '',
      textOffset: r.text_offset ?? 0,
      citeDiffers: r.differs_from !== null || differing.has(r.cite_id),
      maybe: (() => {
        const m = maybes.results.find((x) => x.id === r.maybe_id);
        return m ? { id: m.id, title: m.title, cites: m.cites } : null;
      })(),
    }));
    const shown = links.results.filter((l) => s.linksAll || l.cites >= 2);
    return c.json({ status: item.refs_status, studies: out, links: shown.map(toLink), hiddenLinks: links.results.length - shown.length } satisfies ItemReferences);
  });

  /** The Studies page: most cited or newest, optionally only those cited by 2+ articles, or matching words. */
  app.get('/api/studies', async (c) => {
    const sort = c.req.query('sort') === 'recent' ? 'recent' : 'cited';
    const min = c.req.query('min') === '2' ? 2 : 1;
    const q = (c.req.query('q') ?? '').trim().slice(0, 80);
    const differs = c.req.query('differs') === '1';
    const page = Math.max(0, Math.min(200, Number(c.req.query('page') ?? 0) || 0));
    const where = ['cites >= ?'];
    const binds: (string | number)[] = [min];
    if (differs) where.push('differs = 1');
    if (q) {
      where.push("(title LIKE ? ESCAPE '\\' OR publisher LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      binds.push(like, like);
    }
    const rows = await c.env.DB.prepare(
      `SELECT * FROM studies INDEXED BY ${sort === 'cited' ? 'studies_cited' : 'studies_recent'} WHERE ${where.join(' AND ')}
       ORDER BY ${sort === 'cited' ? 'cites DESC, last_seen DESC' : 'last_seen DESC'} LIMIT ? OFFSET ?`,
    )
      .bind(...binds, PAGE + 1, page * PAGE)
      .all<StudyRow>();
    return c.json({ studies: rows.results.slice(0, PAGE).map(toSummary), more: rows.results.length > PAGE });
  });

  app.get('/api/studies/:id', async (c) => {
    const id = c.req.param('id');
    const study = await c.env.DB.prepare('SELECT * FROM studies WHERE id = ?').bind(id).first<StudyRow>();
    if (!study) return c.json({ error: 'not found' }, 404);
    const [cites, maybe] = await Promise.all([
      c.env.DB.prepare(
        `SELECT study_cites.*, items.subject, items.received_at, COALESCE(sources.name, items.from_name) AS source_name
         FROM study_cites JOIN items ON items.id = study_cites.item_id LEFT JOIN sources ON sources.id = items.source_id
         WHERE study_cites.study_id = ? ORDER BY items.received_at DESC LIMIT 200`,
      )
        .bind(id)
        .all<{ id: string; item_id: string; subject: string; received_at: number; source_name: string | null; claim: string | null; quote: string; numbers: string | null; differs_from: string | null }>(),
      c.env.DB.prepare(
        `SELECT studies.id, studies.title, studies.publisher, studies.year, studies.cites FROM study_maybe
         JOIN studies ON studies.id = CASE WHEN study_maybe.a = ?1 THEN study_maybe.b ELSE study_maybe.a END
         WHERE (study_maybe.a = ?1 OR study_maybe.b = ?1) AND study_maybe.decided IS NULL LIMIT 10`,
      )
        .bind(id)
        .all<{ id: string; title: string; publisher: string | null; year: number | null; cites: number }>(),
    ]);
    const body: StudyDetail = {
      ...toSummary(study),
      citedBy: cites.results.map(
        (r): StudyCite => ({
          id: r.id,
          itemId: r.item_id,
          subject: r.subject,
          sourceName: r.source_name,
          receivedAt: r.received_at,
          claim: r.claim,
          quote: r.quote,
          numbers: parseList(r.numbers),
          differsFrom: r.differs_from,
        }),
      ),
      maybe: maybe.results,
    };
    return c.json(body);
  });

  /** "Same study": the other one is merged into this one. "Different": never asked again. */
  app.post('/api/studies/:id/same', async (c) => {
    const id = c.req.param('id');
    const input = (await c.req.json().catch(() => ({}))) as { other?: string; same?: boolean };
    if (!input.other || input.other === id) return c.json({ error: 'bad request' }, 400);
    const [a, b] = [id, input.other].sort();
    if (input.same === false) {
      await c.env.DB.prepare("INSERT INTO study_maybe (a, b, decided, at) VALUES (?1, ?2, 'different', ?3) ON CONFLICT(a, b) DO UPDATE SET decided = 'different', at = ?3")
        .bind(a, b, now())
        .run();
      return c.json({ ok: true, id });
    }
    const both = await c.env.DB.prepare('SELECT id, cites FROM studies WHERE id IN (?, ?)').bind(id, input.other).all<{ id: string; cites: number }>();
    if (both.results.length !== 2) return c.json({ error: 'not found' }, 404);
    await mergeStudies(c.env, id, input.other);
    return c.json({ ok: true, id });
  });

  /** Links 2+ articles point to (the Links tab on the Studies page). */
  app.get('/api/links', async (c) => {
    const page = Math.max(0, Math.min(200, Number(c.req.query('page') ?? 0) || 0));
    const rows = await c.env.DB.prepare('SELECT * FROM links INDEXED BY links_cited WHERE cites >= 2 ORDER BY cites DESC, last_seen DESC LIMIT ? OFFSET ?')
      .bind(PAGE + 1, page * PAGE)
      .all<LinkRow>();
    return c.json({ links: rows.results.slice(0, PAGE).map(toLink), more: rows.results.length > PAGE });
  });

  app.get('/api/links/:id', async (c) => {
    const link = await c.env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(c.req.param('id')).first<LinkRow>();
    if (!link) return c.json({ error: 'not found' }, 404);
    const items = await c.env.DB.prepare(
      `SELECT link_cites.item_id, link_cites.text, items.subject, items.received_at, COALESCE(sources.name, items.from_name) AS source_name
       FROM link_cites JOIN items ON items.id = link_cites.item_id LEFT JOIN sources ON sources.id = items.source_id
       WHERE link_cites.link_id = ? ORDER BY items.received_at DESC LIMIT 100`,
    )
      .bind(link.id)
      .all<{ item_id: string; text: string | null; subject: string; received_at: number; source_name: string | null }>();
    const body: LinkDetail = {
      ...toLink(link),
      items: items.results.map((r) => ({ itemId: r.item_id, subject: r.subject, sourceName: r.source_name, receivedAt: r.received_at, text: r.text ?? '' })),
    };
    return c.json(body);
  });

  // ----- Helper side -----

  app.post('/api/helper/refs/claim', async (c) => {
    const [state, s] = await Promise.all([loadState(c.env), loadKeySettings(c.env)]);
    if (state.paused || !s.enabled || !s.studies) return c.json({ jobs: [] });
    const usage = await limitState(c.env, now(), true);
    if (usage.limited) return c.json({ jobs: [] });
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Math.round(Number(input.max) || 3), 1), 8);
    const t = now();
    await c.env.DB.prepare(
      `UPDATE items SET refs_status = 'failed' WHERE id IN (
         SELECT id FROM items INDEXED BY items_refs_queue
         WHERE refs_status IN ('pending', 'working') AND refs_status = 'working' AND refs_at < ? AND refs_attempts >= ? LIMIT 20)`,
    )
      .bind(t - LEASE_MS, MAX_ATTEMPTS)
      .run();
    const claimed = await c.env.DB.prepare(
      `UPDATE items SET refs_status = 'working', refs_at = ?1, refs_attempts = refs_attempts + 1
       WHERE id IN (
         SELECT id FROM items INDEXED BY items_refs_queue
         WHERE refs_status IN ('pending', 'working') AND (refs_status = 'pending' OR refs_at < ?2)
         ORDER BY received_at DESC LIMIT ?3
       )
       RETURNING id, subject, html_key, text_key, source_id, web_url`,
    )
      .bind(t, t - LEASE_MS, max)
      .all<{ id: string; subject: string; html_key: string | null; text_key: string | null; source_id: string | null; web_url: string | null }>();
    const [provider, ...rest] = s.model.split(':');
    const model = s.model && provider && rest.length ? { provider, name: rest.join(':') } : null;
    const prompt = refsPrompt();
    const jobs: RefJob[] = [];
    for (const r of claimed.results) {
      const [source, html, text] = await Promise.all([
        r.source_id ? c.env.DB.prepare('SELECT name FROM sources WHERE id = ?').bind(r.source_id).first<{ name: string }>() : null,
        r.html_key ? c.env.RAW.get(r.html_key).then((o) => o?.text() ?? null) : null,
        r.text_key ? c.env.RAW.get(r.text_key).then((o) => o?.text() ?? null) : null,
      ]);
      jobs.push({ itemId: r.id, subject: r.subject, sourceName: source?.name ?? null, url: r.web_url, html, text, prompt, model });
    }
    return c.json({ jobs });
  });

  app.post('/api/helper/refs/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as RefResult | null;
    if (!r?.itemId || !r.model) return c.json({ error: 'bad result' }, 400);
    const [item, s] = await Promise.all([
      c.env.DB.prepare('SELECT id, refs_attempts, web_url FROM items WHERE id = ?').bind(r.itemId).first<{ id: string; refs_attempts: number; web_url: string | null }>(),
      loadKeySettings(c.env),
    ]);
    if (!item) return c.json({ error: 'not found' }, 404);
    const t = now();
    const studies = r.ok ? cleanStudies(r.studies) : [];
    const links = r.ok && Array.isArray(r.links) ? r.links.slice(0, 300) : [];
    const status: KeyStatus = r.ok ? (studies.length || links.length ? 'done' : 'none') : item.refs_attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const error = r.ok ? null : String(r.error || 'Unknown error').slice(0, 500);
    const seconds = Number.isFinite(r.seconds) ? Math.round(r.seconds * 10) / 10 : null;
    const watts = Number.isFinite(r.watts) && r.watts! > 0 ? Math.round(r.watts!) : null;
    if (r.ok) {
      await saveStudies(c.env, item.id, studies, t);
      await saveLinks(c.env, item.id, links, item.web_url ? hostOf(item.web_url) : null, t);
    }
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO ks_runs (id, item_id, provider, model, prompt_version, seconds, watts, ok, skipped, marks, manual, error, at, task)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, 'refs')`,
      ).bind(newId(), item.id, String(r.provider ?? '').slice(0, 40), String(r.model).slice(0, 120), s.promptVersion, seconds, watts, r.ok ? 1 : 0, studies.length, error, t),
      c.env.DB.prepare('UPDATE items SET refs_status = ?, refs_at = ? WHERE id = ?').bind(status, t, item.id),
    ]);
    return c.json({ ok: r.ok, status, studies: studies.length });
  });
}
