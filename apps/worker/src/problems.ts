import {
  LOG_KEEP_DAYS,
  NO_PROBLEMS,
  isRedditUrl,
  type AppLogEntry,
  type AppLogView,
  type AppProblem,
  type HelperLogEvent,
  type LogLevel,
  type PcRest,
  type ProblemsSummary,
  type ProblemsView,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { parseRhythm } from './rhythm';

// App problems: things going wrong inside the app itself, worked out from what
// the app already knows (each source's last checks, the PC helper's check-ins
// and the sites it is resting) plus the app's own log (warnings and errors from
// the PC helper and from Cloudflare's feed checks). Shown at the top of System
// status, with the log lines behind each problem, and in the inbox banner.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The helper checks in every minute or so; this long without one and it counts as offline. */
const HELPER_OFFLINE_MS = 20 * MINUTE;
/** Failed checks in a row before a source counts as a problem (one failure is often just a blip). */
const FAILING_AFTER = 2;
/** Checks failing this long and the problem is a big one. */
const FAILING_MAJOR_MS = 2 * DAY;
/** A source not checked at all for this long. */
const UNCHECKED_MS = 2 * DAY;
/** A source that posts regularly but brought nothing in for this many of its usual gaps (and at least 3 days). */
const SILENT_GAPS = 4;
const SILENT_MIN_MS = 3 * DAY;
/** PC errors in a day before they show as a problem of their own. */
const HELPER_ERRORS_MIN = 3;
const LOG_LINES = 12;
/** Full-article failures from one site in a week before they show. */
const ARTICLE_FAILS_MIN = 2;

/** Plain advice for a failed check, from what the site answered. */
export function adviceFor(
  error: string,
  kind: string,
  onPc: boolean,
  url?: string | null,
): { cause: string; fix: string[]; toPc?: boolean; skip?: boolean } {
  const e = error.toLowerCase();
  const article = kind === 'article';
  if (!article && url && /(^|\.)reddit\.com\//i.test(url.replace(/^https?:\/\//, '')) && /\b(404|410|403)\b|no longer returns a feed/.test(e)) {
    return {
      cause: 'Reddit ended its feeds',
      fix: [
        'Reddit switched off its RSS feeds from 13 November 2026 and is closing free access by March 2027, so this subreddit can’t be followed as a feed any more.',
        'The app pauses it by itself after three failed checks in a row. Its old posts stay in the app.',
      ],
    };
  }
  if (/leaves? (it )?alone|leave alone list/.test(e)) {
    return {
      cause: 'PC is resting from this site',
      fix: ['Nothing to do: after a bot check the PC gives the site a rest, then tries again by itself.'],
    };
  }
  if (/\b429\b|too many requests/.test(e)) {
    return {
      cause: 'Too many requests (429)',
      fix: [
        'The site says it is being asked too often. The app already waits longer between tries.',
        article
          ? 'If it keeps happening, set Full articles to Never on the source: you still get what the feed holds.'
          : 'If it keeps happening, open the source and set “Check every” to a longer time, such as once a day.',
      ],
    };
  }
  if (/bot check|turned (cloudflare|the pc) away|\b403\b|refus/.test(e)) {
    if (!onPc) {
      return {
        cause: 'Refuses Cloudflare (403)',
        fix: ['Let your PC fetch it instead: tap “Fetch it with my PC”. (The app does this by itself after three refusals in a row.)'],
        toPc: true,
      };
    }
    return article
      ? {
          cause: 'Refuses readers (403)',
          fix: [
            'The site blocks automatic readers, so retrying won’t help. The post still comes in with what the feed holds.',
            'If the feed already has the whole post, set Full articles to Never on the source so the PC stops asking.',
            'Or add the site to Sites the PC leaves alone and open its articles in your browser.',
          ],
          skip: true,
        }
      : {
          cause: 'Refuses readers (403)',
          fix: [
            'The site turns your PC away too, so retrying won’t help.',
            'On the source page use “Change how it’s followed”: the site may have another feed that is allowed.',
            'If the site looks abandoned, delete the source. Otherwise pause it and read it in your browser.',
          ],
        };
  }
  if (/\b(404|410)\b|no longer returns a feed|not a feed|not found/.test(e)) {
    return {
      cause: 'Address gone (404)',
      fix: article
        ? ['The page has moved or was taken down. Nothing to do: the post came in with what its feed holds.']
        : [
            'The feed address no longer works: the site moved or closed it.',
            'On the source page use “Change how it’s followed” to find the site’s feed again.',
            'If the site has closed, delete the source.',
          ],
    };
  }
  if (/\b5\d\d\b/.test(e)) {
    return {
      cause: 'Site having trouble (5xx)',
      fix: ['The website itself is broken right now. Nothing to do: the app keeps trying, less often. If it lasts more than a few days, check the site in your browser.'],
    };
  }
  if (/too long|timed? ?out|could not reach|fetch failed|enotfound|econn/.test(e)) {
    return {
      cause: 'Site not answering',
      fix: ['Usually temporary; the app keeps trying. If it lasts days, check the address still opens in your browser.'],
    };
  }
  if (/no article links/.test(e)) {
    return {
      cause: 'No articles found on the page',
      fix: [
        'On the source page switch on “Needs a browser” if the page is built by JavaScript, then Check now.',
        'Or fill in “Only links containing” with the part every article address shares, such as /blog/.',
      ],
    };
  }
  return {
    cause: 'Check failed',
    fix: ['Press Check now and read the line under the source’s address. If the same error keeps coming, ask Claude to look at it.'],
  };
}

const SUMMARY_KEY = 'problems_summary';
const HIDDEN_KEY = 'problems_hidden';

/** A site's name for the log: the host without www, and every Reddit address as reddit.com. */
export function siteOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (isRedditUrl(url)) return 'reddit.com';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

const LEVELS: LogLevel[] = ['info', 'warn', 'error'];
const cut = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : null);

/** Adds one line to the app's log. Never throws: logging must not stop a feed check. */
export async function logLine(
  env: Env,
  line: { origin: 'pc' | 'cloud'; level: LogLevel; area: string; site?: string | null; sourceId?: string | null; message: string; at?: number; count?: number },
): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO app_log (at, level, origin, area, site, source_id, message, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(
        line.at ?? now(),
        line.level,
        line.origin,
        line.area.slice(0, 30),
        line.site?.slice(0, 120) ?? null,
        line.sourceId ?? null,
        line.message.slice(0, 600),
        Math.max(1, Math.round(line.count ?? 1)),
      )
      .run();
  } catch (err) {
    console.error('app log failed', err instanceof Error ? err.message : err);
  }
}

/** The warnings and errors a helper heartbeat brought (helpers from 0.12.0). */
export async function logHelperEvents(env: Env, events: HelperLogEvent[]): Promise<void> {
  const t = now();
  const stmts = events
    .filter((e) => e && typeof e.message === 'string' && e.message)
    .slice(0, 100)
    .map((e) =>
      env.DB.prepare('INSERT INTO app_log (at, level, origin, area, site, source_id, message, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        // The PC's clock, kept within reason (a day back at most, never in the future).
        Math.min(Math.max(Number(e.at) || t, t - DAY), t),
        LEVELS.includes(e.level) ? e.level : 'warn',
        'pc',
        cut(e.area, 30) ?? 'helper',
        cut(e.site, 120),
        cut(e.sourceId, 40),
        e.message.slice(0, 600),
        Math.min(Math.max(Math.round(Number(e.count) || 1), 1), 100_000),
      ),
    );
  if (stmts.length) await env.DB.batch(stmts);
}

/** Lines older than two weeks go (hourly). */
export async function tidyLog(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM app_log WHERE at < ?')
    .bind(now() - LOG_KEEP_DAYS * DAY)
    .run();
}

interface LogRow {
  id: number;
  at: number;
  level: LogLevel;
  origin: 'pc' | 'cloud';
  area: string;
  site: string | null;
  source_id: string | null;
  message: string;
  count: number;
}

const toEntry = (r: LogRow): AppLogEntry => ({
  id: r.id,
  at: r.at,
  level: r.level,
  origin: r.origin,
  area: r.area,
  site: r.site,
  sourceId: r.source_id,
  message: r.message,
  count: r.count,
});

interface SourceCheckRow {
  id: string;
  kind: string;
  name: string;
  url: string | null;
  feed_url: string | null;
  fetch_via: string;
  created_at: number;
  last_checked_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
  error_count: number;
  rhythm: string | null;
  last_item_at: number | null;
}

interface HelperState {
  lastSeenAt?: number;
  version?: string;
  resting?: PcRest[];
}

/**
 * Works out the open problems. `withLog` adds the log lines behind each one
 * (the System status page); the cron's summary leaves them out.
 */
export async function computeProblems(env: Env, withLog: boolean): Promise<AppProblem[]> {
  const t = now();
  const [helper, hiddenRaw, sources, errors, articles] = await Promise.all([
    readJson<HelperState>(env, 'helper'),
    readJson<Record<string, number>>(env, HIDDEN_KEY),
    // One indexed seek per source for its newest post.
    env.DB.prepare(
      `SELECT id, kind, name, url, feed_url, fetch_via, created_at, last_checked_at, last_ok_at, last_error, error_count, rhythm,
         (SELECT MAX(received_at) FROM items INDEXED BY items_source WHERE items.source_id = sources.id) AS last_item_at
       FROM sources WHERE kind IN ('feed', 'site') AND paused_at IS NULL AND NOT (kind = 'site' AND url IS NULL)`,
    ).all<SourceCheckRow>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(count), 0) AS n, MIN(at) AS first,
         (SELECT message FROM app_log INDEXED BY app_log_at WHERE at >= ?1 AND origin = 'pc' AND level = 'error' ORDER BY at DESC LIMIT 1) AS sample
       FROM app_log INDEXED BY app_log_at WHERE at >= ?1 AND origin = 'pc' AND level = 'error'`,
    )
      .bind(t - DAY)
      .first<{ n: number; first: number | null; sample: string | null }>(),
    // Sites whose full articles failed at least twice this week.
    env.DB.prepare(
      `SELECT site, SUM(count) AS n, MIN(at) AS first, MAX(source_id) AS source_id,
         (SELECT message FROM app_log AS l2 WHERE l2.site = app_log.site AND l2.area = 'article'
           AND l2.message NOT LIKE '%PC leaves it to your browser%' AND l2.message NOT LIKE '%leaving it alone until%' ORDER BY at DESC LIMIT 1) AS message
       FROM app_log INDEXED BY app_log_at WHERE at >= ? AND area = 'article' AND site IS NOT NULL
         -- Articles the PC never asked for (site left alone, or resting after a bot check) aren't failures.
         AND message NOT LIKE '%PC leaves it to your browser%' AND message NOT LIKE '%leaving it alone until%'
         -- A moved or deleted page has nothing to fix (the post came in with what its feed holds).
         AND message NOT LIKE '%answered 404%' AND message NOT LIKE '%answered 410%'
       GROUP BY site HAVING SUM(count) >= ${ARTICLE_FAILS_MIN} ORDER BY n DESC LIMIT 15`,
    )
      .bind(t - 7 * DAY)
      .all<{ site: string; n: number; first: number; source_id: string | null; message: string }>(),
  ]);
  const hidden = hiddenRaw ?? {};
  const out: AppProblem[] = [];
  const base = { log: [] as AppLogEntry[], hidden: false };

  const seen = helper?.lastSeenAt ?? 0;
  const helperOffline = seen > 0 && t - seen > HELPER_OFFLINE_MS;
  if (helperOffline) {
    out.push({
      ...base,
      key: 'helper_offline',
      kind: 'helper_offline',
      category: 'pc',
      level: 'major',
      title: 'The PC helper is offline',
      cause: 'No check-in from your PC',
      detail: 'Reddit, website watches, full articles and AI summaries wait until it is back. Nothing is lost: they catch up when it returns.',
      fix: [
        'Make sure the PC is on and awake (sleep stops the helper).',
        'Restart the helper: open Task Scheduler on the PC, find “Newsletter helper”, and click Run.',
        'Still offline after a few minutes? Run install-helper.ps1 again; it puts the helper back without touching its settings.',
      ],
      actions: [{ label: 'PC helper settings', to: '/settings/ai' }],
      since: seen,
    });
  }

  // Sites the PC is resting after a bot check or "too many requests" (as of its last check-in).
  if (!helperOffline) {
    for (const r of helper?.resting ?? []) {
      if (!r?.site || r.until <= t) continue;
      const reddit = r.site === 'reddit.com';
      out.push({
        ...base,
        key: `site_resting:${r.site}`,
        kind: 'site_resting',
        category: 'blocked',
        level: 'minor',
        title: r.site,
        cause: /429|too many/i.test(r.why ?? '') ? 'Too many requests' : 'Bot check',
        detail: `It answered ${r.why ?? 'with a bot check or "too many requests"'}, so the PC is giving it a rest rather than get your home network flagged.`,
        fix: reddit
          ? ['Nothing to do: Reddit says how long to wait and the PC waits that long, then carries on with your subreddits.']
          : [
              'Nothing to do now: the PC tries again by itself.',
              'If this site keeps doing it, add it to Sites the PC leaves alone. Its posts still come in from the feed; you read the full article in your browser.',
            ],
        actions: reddit ? [] : [{ label: 'Sites the PC leaves alone', to: '/settings/ai/sites' }],
        since: r.until - r.ms,
        site: r.site,
        until: r.until,
      });
    }
  }

  for (const s of sources.results) {
    const toPc = s.kind === 'site' || s.fetch_via === 'pc' || isRedditUrl(s.feed_url ?? s.url);
    const lastOk = s.last_ok_at;
    const page = { label: 'Open source', to: `/source/${s.id}` };
    const common = { ...base, sourceId: s.id, site: siteOfUrl(s.feed_url ?? s.url), lastOkAt: lastOk, lastItemAt: s.last_item_at };
    if (s.error_count >= FAILING_AFTER) {
      const since = lastOk ?? s.created_at;
      const why = adviceFor(s.last_error ?? '', s.kind, toPc, s.feed_url ?? s.url);
      out.push({
        ...common,
        key: `source_failing:${s.id}`,
        kind: 'source_failing',
        category: 'failing',
        level: t - since > FAILING_MAJOR_MS ? 'major' : 'minor',
        title: s.name,
        cause: why.cause,
        detail: s.last_error ?? 'Its checks keep failing.',
        fix: why.fix,
        actions: [
          page,
          ...(why.toPc && !toPc ? [{ label: 'Fetch it with my PC', pcSourceId: s.id }] : []),
          { label: 'Check now', checkSourceId: s.id },
        ],
        since,
        count: s.error_count,
      });
      continue;
    }
    const checked = s.last_checked_at ?? 0;
    if (t - Math.max(checked, s.created_at) > UNCHECKED_MS) {
      // While the helper is offline, the PC's sources are covered by that problem.
      if (toPc && helperOffline) continue;
      out.push({
        ...common,
        key: `source_unchecked:${s.id}`,
        kind: 'source_unchecked',
        category: 'unchecked',
        level: 'minor',
        title: s.name,
        cause: toPc ? 'Waiting for your PC' : 'Check keeps being put off',
        detail: toPc ? 'Your PC fetches this one, and its checks have not come back.' : 'Its checks keep being put off.',
        fix: toPc
          ? ['Press Check now. If nothing changes in a few minutes, the PC may be busy with a long queue or the site keeps timing out: the log below says which.']
          : ['Press Check now. If it still is not checked, tell Claude: this one should not happen.'],
        actions: [page, { label: 'Check now', checkSourceId: s.id }],
        since: checked || s.created_at,
      });
      continue;
    }
    // Checks work but nothing new: a source that usually posts regularly and has stopped.
    if (lastOk === null || t - lastOk > DAY) continue;
    const quietFix = [
      'Open the site in your browser. If it still posts, its feed has probably moved: on the source page use “Change how it’s followed” to pick its feed again.',
      'If posts are there but never arrive, check the source’s filter and daily limit are not leaving them out.',
      'If the site has stopped posting, pause or delete the source.',
    ];
    if (s.last_item_at === null) {
      if (t - s.created_at > SILENT_MIN_MS) {
        out.push({
          ...common,
          key: `source_silent:${s.id}`,
          kind: 'source_silent',
          category: 'quiet',
          level: 'minor',
          title: s.name,
          cause: 'Nothing since you added it',
          detail: 'Its checks work, but no post has come in since you added it.',
          fix: quietFix,
          actions: [page],
          since: s.created_at,
        });
      }
      continue;
    }
    const r = parseRhythm(s.rhythm);
    if (!r?.pattern || !r.gapHours || r.posts < 6) continue;
    const quietFor = Math.max(r.gapHours * HOUR * SILENT_GAPS, SILENT_MIN_MS);
    if (t - s.last_item_at > quietFor) {
      const usual = r.gapHours < 36 ? `${Math.round(r.gapHours)} hours` : `${Math.round(r.gapHours / 24)} days`;
      out.push({
        ...common,
        key: `source_silent:${s.id}`,
        kind: 'source_silent',
        category: 'quiet',
        level: 'minor',
        title: s.name,
        cause: `Usually every ${usual}`,
        detail: `It usually posts every ${usual}, and its checks work, but nothing new has come in.`,
        fix: quietFix,
        actions: [page],
        since: s.last_item_at,
        count: r.gapHours,
      });
    }
  }

  // Full articles the PC could not fetch, by site, over the last week (the posts came in anyway).
  for (const a of articles.results) {
    if (!a.site) continue;
    const why = adviceFor(a.message, 'article', true);
    out.push({
      ...base,
      key: `article_failures:${a.site}`,
      kind: 'article_failures',
      category: 'articles',
      level: 'minor',
      title: a.site,
      cause: why.cause,
      detail: `${a.n} full article${a.n === 1 ? '' : 's'} from this site could not be fetched this week. Last: ${a.message.replace(/^article \S+: /, '')}`,
      fix: why.fix,
      actions: [
        ...(a.source_id ? [{ label: 'Open source', to: `/source/${a.source_id}` }] : []),
        ...(why.skip ? [{ label: 'Sites the PC leaves alone', to: '/settings/ai/sites' }] : []),
      ],
      since: a.first,
      sourceId: a.source_id,
      site: a.site,
      count: a.n,
    });
  }

  if ((errors?.n ?? 0) >= HELPER_ERRORS_MIN && !helperOffline) {
    const ai = /model|JSON|summary/i.test(errors?.sample ?? '');
    out.push({
      ...base,
      key: 'helper_errors',
      kind: 'helper_errors',
      category: 'pc',
      level: 'minor',
      title: `${errors!.n} errors in the last day`,
      cause: ai ? 'Mostly AI answers' : 'Helper errors',
      detail: `Latest: ${errors?.sample ?? ''}`,
      fix: ai
        ? [
            'A model on your PC sometimes gives an answer the app can’t read. The item is tried again, so one-offs need nothing.',
            'If the same model keeps failing, switch it off or move it down the list in PC helper and AI.',
          ]
        : ['Most of these fix themselves on the next round. If the same line keeps repeating, the log below shows it: ask Claude to look.'],
      actions: [{ label: 'PC helper and AI', to: '/settings/ai' }],
      since: errors!.first,
    });
  }

  // Hidden problems stay hidden while they last; once one clears up it is forgotten, so it shows if it comes back.
  const open = new Set(out.map((p) => p.key));
  const keep = Object.fromEntries(Object.entries(hidden).filter(([k]) => open.has(k)));
  if (Object.keys(keep).length !== Object.keys(hidden).length) await writeJson(env, HIDDEN_KEY, keep);
  for (const p of out) p.hidden = p.key in keep;

  out.sort((a, b) => Number(a.hidden) - Number(b.hidden) || (a.level === b.level ? 0 : a.level === 'major' ? -1 : 1) || (b.since ?? 0) - (a.since ?? 0));

  if (withLog) {
    await Promise.all(
      out.slice(0, 40).map(async (p) => {
        const stmt =
          p.kind === 'article_failures'
            ? env.DB.prepare(`SELECT * FROM app_log INDEXED BY app_log_site WHERE site = ? AND area = 'article' ORDER BY at DESC LIMIT ${LOG_LINES}`).bind(p.site)
            : p.kind === 'helper_errors'
            ? env.DB.prepare(`SELECT * FROM app_log INDEXED BY app_log_at WHERE at >= ? AND origin = 'pc' AND level = 'error' ORDER BY at DESC LIMIT ${LOG_LINES}`).bind(t - DAY)
            : p.kind === 'helper_offline'
              ? env.DB.prepare(`SELECT * FROM app_log INDEXED BY app_log_at WHERE origin = 'pc' ORDER BY at DESC LIMIT ${LOG_LINES}`)
              : p.sourceId
                ? env.DB.prepare(`SELECT * FROM app_log INDEXED BY app_log_source WHERE source_id = ? ORDER BY at DESC LIMIT ${LOG_LINES}`).bind(p.sourceId)
                : p.site
                  ? env.DB.prepare(`SELECT * FROM app_log INDEXED BY app_log_site WHERE site = ? ORDER BY at DESC LIMIT ${LOG_LINES}`).bind(p.site)
                  : null;
        if (stmt) p.log = (await stmt.all<LogRow>()).results.map(toEntry);
      }),
    );
  }
  return out;
}

function bannerTitle(p: AppProblem): string {
  if (p.kind === 'source_failing') return `${p.title} isn't coming through`;
  if (p.kind === 'source_silent') return `${p.title} has gone quiet`;
  if (p.kind === 'source_unchecked') return `${p.title} hasn't been checked lately`;
  if (p.kind === 'site_resting') return `${p.title} turned the PC away`;
  if (p.kind === 'article_failures') return `Full articles from ${p.title} failing`;
  if (p.kind === 'helper_errors') return `PC helper: ${p.title}`;
  return p.title;
}

function summarise(problems: AppProblem[]): ProblemsSummary {
  const shown = problems.filter((p) => !p.hidden);
  const top = shown[0];
  return {
    open: shown.length,
    level: shown.length === 0 ? 'ok' : shown.some((p) => p.level === 'major') ? 'major' : 'minor',
    top: top ? { title: bannerTitle(top), detail: top.cause } : null,
    checkedAt: now(),
  };
}

/** The cron's part (every run): works the problems out again for the inbox's Status button and banner. */
export async function refreshProblemsSummary(env: Env): Promise<ProblemsSummary> {
  const summary = summarise(await computeProblems(env, false));
  await writeJson(env, SUMMARY_KEY, summary);
  return summary;
}

export function parseProblemsSummary(raw: string | null | undefined): ProblemsSummary {
  if (!raw) return NO_PROBLEMS;
  try {
    return { ...NO_PROBLEMS, ...(JSON.parse(raw) as ProblemsSummary) };
  } catch {
    return NO_PROBLEMS;
  }
}

export function registerProblems(app: App) {
  app.get('/api/problems', async (c) => {
    const problems = await computeProblems(c.env, true);
    await writeJson(c.env, SUMMARY_KEY, summarise(problems));
    const view: ProblemsView = { problems, checkedAt: now() };
    return c.json(view);
  });

  // Hide a problem until it clears up (or show it again).
  app.put('/api/problems/hidden', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { key?: string; hidden?: boolean } | null;
    if (!input?.key || typeof input.key !== 'string') return c.json({ error: 'bad key' }, 400);
    const hidden = (await readJson<Record<string, number>>(c.env, HIDDEN_KEY)) ?? {};
    if (input.hidden) hidden[input.key.slice(0, 120)] = now();
    else delete hidden[input.key];
    await writeJson(c.env, HIDDEN_KEY, hidden);
    const problems = await computeProblems(c.env, true);
    await writeJson(c.env, SUMMARY_KEY, summarise(problems));
    return c.json({ problems, checkedAt: now() } satisfies ProblemsView);
  });

  // The whole log, newest first, 100 lines a page. Filters: level (warn = warnings and errors), source, site, origin.
  app.get('/api/log', async (c) => {
    const where: string[] = [];
    const binds: unknown[] = [];
    const before = Number(c.req.query('before'));
    if (before > 0) {
      where.push('id < ?');
      binds.push(before);
    }
    const level = c.req.query('level');
    if (level === 'error') where.push("level = 'error'");
    else if (level === 'warn') where.push("level IN ('warn', 'error')");
    const origin = c.req.query('origin');
    if (origin === 'pc' || origin === 'cloud') {
      where.push('origin = ?');
      binds.push(origin);
    }
    const source = c.req.query('source');
    const site = c.req.query('site');
    let index = '';
    if (source) {
      where.push('source_id = ?');
      binds.push(source);
      index = 'INDEXED BY app_log_source';
    } else if (site) {
      where.push('site = ?');
      binds.push(site.toLowerCase());
      index = 'INDEXED BY app_log_site';
    }
    const rows = await c.env.DB.prepare(
      // Newest added first (the PC's lines carry the PC's own times, so ids page more reliably than times).
      `SELECT * FROM app_log ${index} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 101`,
    )
      .bind(...binds)
      .all<LogRow>();
    const entries = rows.results.slice(0, 100).map(toEntry);
    const view: AppLogView = { entries, before: rows.results.length > 100 ? entries[entries.length - 1]!.id : null };
    return c.json(view);
  });
}
