import { DEFAULT_DAILY_CAP, EMPTY_POST_FILTER, type PostFilter } from '@newsletterapp/shared';
import { useState, type FormEvent } from 'react';

/** What a quick-add form hands to the feed finder: where to look and how to set the source up. */
export interface FollowPreset {
  /** The address to look up. */
  url: string;
  /** The feed itself, when it is known without looking (used if Cloudflare can't read it). */
  feedUrl: string | null;
  name: string;
  postFilter: PostFilter;
  dailyCap: number;
  /** One line on what you'll get, shown next to the Follow button. */
  note: string;
}

type Mode = 'site' | 'reddit' | 'github' | 'youtube';

const MODES: { value: Mode; label: string }[] = [
  { value: 'site', label: 'Website' },
  { value: 'reddit', label: 'Reddit' },
  { value: 'github', label: 'GitHub' },
  { value: 'youtube', label: 'YouTube' },
];

export function ModePicker({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="segmented" role="group" aria-label="What to follow">
      {MODES.map((m) => (
        <button key={m.value} type="button" aria-pressed={mode === m.value} onClick={() => onChange(m.value)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

export type { Mode as FollowMode };

const REDDIT_SORTS = [
  { value: 'day', label: 'Top posts of the day', cap: 10, note: 'About the 10 most upvoted posts each day.' },
  { value: 'week', label: 'Top posts of the week', cap: 10, note: 'The best posts of the week, a few at a time.' },
  { value: 'new', label: 'Every new post', cap: 30, note: 'Everything posted. Busy subreddits post hundreds a day, so the daily limit matters here.' },
] as const;

function RedditForm({ onLook }: { onLook: (p: FollowPreset) => void }) {
  const [name, setName] = useState('');
  const [sort, setSort] = useState<(typeof REDDIT_SORTS)[number]['value']>('day');
  const sub = name
    .trim()
    .replace(/^https?:\/\/(www\.|old\.)?reddit\.com/i, '')
    .replace(/^\/?r\//i, '')
    .split(/[/?#\s]/)[0]!;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!sub) return;
    const s = REDDIT_SORTS.find((x) => x.value === sort)!;
    const feedUrl = sort === 'new' ? `https://www.reddit.com/r/${sub}/new/.rss` : `https://www.reddit.com/r/${sub}/top/.rss?t=${sort}`;
    onLook({ url: feedUrl, feedUrl, name: `r/${sub}`, postFilter: EMPTY_POST_FILTER, dailyCap: s.cap, note: s.note });
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="field">
        <label htmlFor="reddit-sub">Subreddit</label>
        <input id="reddit-sub" className="input" placeholder="e.g. selfhosted or r/selfhosted" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="reddit-sort">Which posts</label>
        <select id="reddit-sort" className="input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          {REDDIT_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <button className="btn btn--primary" disabled={!sub} type="submit">
        Find it
      </button>
      <span className="hint" style={{ margin: 0 }}>
        Each post arrives with its text or picture, and your PC adds the top comments underneath (so they show up a minute or two after the post when the
        PC is on). "Top of the day" is the calmest choice for busy subreddits.
      </span>
    </form>
  );
}

const GITHUB_KINDS = [
  {
    value: 'key',
    label: 'Key releases only',
    filter: { ...EMPTY_POST_FILTER, skipPrereleases: true, majorMinorOnly: true },
    note: 'Big releases only, like 2.0 or 2.5. Patch fixes (2.5.1) and betas are skipped.',
  },
  { value: 'all', label: 'Every finished release', filter: { ...EMPTY_POST_FILTER, skipPrereleases: true }, note: 'Every release including patch fixes, but no betas.' },
  { value: 'everything', label: 'Everything, including betas', filter: EMPTY_POST_FILTER, note: 'Every release, including alpha, beta and release candidates.' },
] as const;

function GithubForm({ onLook }: { onLook: (p: FollowPreset) => void }) {
  const [repo, setRepo] = useState('');
  const [kind, setKind] = useState<(typeof GITHUB_KINDS)[number]['value']>('key');
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)/i.exec(repo.trim());
  const owner = m?.[1];
  const name = m?.[2]?.replace(/\.git$/, '');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!owner || !name) return;
    const k = GITHUB_KINDS.find((x) => x.value === kind)!;
    const feedUrl = `https://github.com/${owner}/${name}/releases.atom`;
    onLook({ url: feedUrl, feedUrl, name: `${name} releases`, postFilter: { ...k.filter }, dailyCap: 10, note: k.note });
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="field">
        <label htmlFor="gh-repo">Project</label>
        <input id="gh-repo" className="input" placeholder="e.g. ollama/ollama or its GitHub link" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="gh-kind">Which releases</label>
        <select id="gh-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {GITHUB_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <button className="btn btn--primary" disabled={!owner || !name} type="submit">
        Find it
      </button>
      <span className="hint" style={{ margin: 0 }}>
        Each release arrives as a post with its release notes. You can change which releases get through later on the source's settings page.
      </span>
    </form>
  );
}

function YoutubeForm({ onLook }: { onLook: (p: FollowPreset) => void }) {
  const [channel, setChannel] = useState('');
  const [skipShorts, setSkipShorts] = useState(true);
  const raw = channel.trim();
  const id = /(?:channel\/|channel_id=)?(UC[\w-]{22})/.exec(raw)?.[1];
  const handle = /^@?([\w.-]+)$/.exec(raw)?.[1];
  const url = id
    ? `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`
    : /youtube\.com\//i.test(raw)
      ? (raw.startsWith('http') ? raw : `https://${raw}`)
      : handle
        ? `https://www.youtube.com/@${handle}`
        : '';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!url) return;
    onLook({
      url,
      feedUrl: id ? url : null,
      name: handle && !id ? handle : '',
      postFilter: { ...EMPTY_POST_FILTER, skipShorts },
      dailyCap: 10,
      note: skipShorts ? 'Each new video (no Shorts).' : 'Each new video, Shorts included.',
    });
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="field">
        <label htmlFor="yt-channel">Channel</label>
        <input id="yt-channel" className="input" placeholder="e.g. @veritasium or the channel's link" value={channel} onChange={(e) => setChannel(e.target.value)} autoComplete="off" />
      </div>
      <label className="switchrow">
        <span style={{ fontSize: 15 }}>Skip Shorts</span>
        <input type="checkbox" checked={skipShorts} onChange={(e) => setSkipShorts(e.target.checked)} />
      </label>
      <button className="btn btn--primary" disabled={!url} type="submit">
        Find it
      </button>
      <span className="hint" style={{ margin: 0 }}>
        Each new video arrives with its picture and description; tap the picture to watch it on YouTube. Copy the link from the channel page (or type its
        @name).
      </span>
    </form>
  );
}

export function QuickForm({ mode, onLook }: { mode: Exclude<Mode, 'site'>; onLook: (p: FollowPreset) => void }) {
  if (mode === 'reddit') return <RedditForm onLook={onLook} />;
  if (mode === 'github') return <GithubForm onLook={onLook} />;
  return <YoutubeForm onLook={onLook} />;
}

const CAP_OPTIONS = [5, 10, 20, 30, 50, 100, 0];

/** The flood guard: at most this many new posts a day go to the inbox; the rest go to Archived. */
export function DailyCapPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const options = CAP_OPTIONS.includes(value) ? CAP_OPTIONS : [...CAP_OPTIONS.filter((n) => n > 0), value, 0].sort((a, b) => (a || 1e9) - (b || 1e9));
  return (
    <label className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
      <span className="hint" style={{ margin: 0 }}>Daily limit</span>
      <select className="input" style={{ flex: '1 1 120px' }} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((n) => (
          <option key={n} value={n}>
            {n === 0 ? 'No limit (flood guard off)' : `${n} new posts a day${n === DEFAULT_DAILY_CAP ? ' (usual)' : ''}`}
          </option>
        ))}
      </select>
      <span className="hint" style={{ margin: 0, flexBasis: '100%' }}>
        Any more that day skip your inbox and go to Archived. On the source's page you can choose to bin them instead.
      </span>
    </label>
  );
}

/** "About N posts a day", with a warning when that would be a lot. */
export function PerDayLine({ perDay, cap }: { perDay: number | null; cap: number }) {
  if (perDay === null) return null;
  const busy = cap > 0 && perDay > cap;
  const text =
    perDay >= 1 ? `About ${Math.round(perDay)} post${Math.round(perDay) === 1 ? '' : 's'} a day` : perDay * 7 >= 1 ? `About ${Math.round(perDay * 7)} a week` : 'A few a month';
  return (
    <span className={busy ? 'error' : 'hint'} style={{ margin: 0 }}>
      {text}
      {busy ? `. That's more than your limit of ${cap}, so the extras will go to Archived.` : '.'}
    </span>
  );
}
