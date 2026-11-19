import { CATCH_UP_LEVELS, type AppSettings, type CatchUp, type CatchUpItem, type CatchUpLevel, type CatchUpListItem } from '@newsletterapp/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';

// Review > Day: the morning catch-up. What came in since your last visit,
// without the likely reads (they stay in the inbox and show greyed here), in
// themes the PC made, each cleared in one tap. The dial at the top changes how
// much it takes in today; Clear all at the bottom takes the rest.

const KEEP_LABEL: Record<NonNullable<CatchUpItem['keep']>, string> = {
  followed: 'a story you follow',
  likely: 'Likely interesting',
  saved: 'a saved page',
  source: 'a source you often read',
};

/** "2 Likely interesting", "1 from a story you follow": the kept-in-inbox line. */
const KEEP_COUNT: Record<NonNullable<CatchUpItem['keep']> | 'deep', (n: number) => string> = {
  followed: (n) => `${n} in ${n === 1 ? 'a story' : 'stories'} you follow`,
  likely: (n) => `${n} Likely interesting`,
  saved: (n) => `${n} saved ${n === 1 ? 'page' : 'pages'}`,
  source: (n) => `${n} from sources you often read`,
  deep: (n) => `${n} left for Normal and Deep`,
};

const SKIP_LABEL: Record<NonNullable<CatchUpItem['skip']>, (n: number) => string> = {
  advert: (n) => `${n} advert${n === 1 ? '' : 's'}`,
  unlikely: (n) => `${n} marked Probably not for you`,
  not_interested: (n) => `${n} from sources you often mark Not interested`,
};

const takesIn = (it: CatchUpItem, level: CatchUpLevel) => it.level !== 0 && it.level <= level;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hourText = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;

interface Toast {
  text: string;
  ids: string[];
}

/** /review/day: loads the settings the page needs for its tabs and wording. */
export function CatchUpRoute() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => undefined);
  }, []);
  return <CatchUpPage settings={settings} />;
}

export function CatchUpPage({ settings }: { settings: AppSettings | null }) {
  const navigate = useNavigate();
  const [cu, setCu] = useState<CatchUp | null>(null);
  const [list, setList] = useState<CatchUpListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<CatchUpLevel | null>(null);
  // Cleared here this visit (on top of what the server says is gone).
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [building, setBuilding] = useState(false);

  const load = useCallback(
    () =>
      api
        .catchUp()
        .then((r) => {
          setCu(r.latest);
          setList(r.list);
          if (r.latest) setGone(new Set(r.latest.goneIds));
          setLevel((l) => l ?? r.latest?.startLevel ?? 2);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the catch-up')),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // While the PC is making the themes, look again every 20 seconds.
  const writing = cu && !cu.doneAt && (cu.status === 'waiting' || cu.status === 'working');
  useEffect(() => {
    if (!writing || !cu) return;
    const t = window.setInterval(() => {
      void api
        .catchUpOne(cu.id)
        .then((r) => {
          setCu((old) => (old && old.id === r.id ? { ...r } : old));
          setGone((g) => new Set([...g, ...r.goneIds]));
        })
        .catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(t);
  }, [writing, cu?.id]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const lv: CatchUpLevel = level ?? 2;
  const byId = useMemo(() => new Map((cu?.items ?? []).map((i) => [i.id, i])), [cu]);
  const live = (cu?.items ?? []).filter((i) => !gone.has(i.id));
  const inAtLevel = (cu?.items ?? []).filter((i) => takesIn(i, lv));
  const left = inAtLevel.filter((i) => !gone.has(i.id));
  const kept = live.filter((i) => !takesIn(i, lv));
  const skipPile = left.filter((i) => i.skip);
  // Settings > Reviews: clear the Probably skip pile as Not interested (teaches the app), or as plain read.
  const skipNi = cu?.skipPile !== false;
  const clearedNow = inAtLevel.length - left.length;

  const themes = useMemo(() => {
    if (!cu) return [];
    return cu.themes
      .map((t) => {
        const items = t.itemIds.map((id) => byId.get(id)).filter((i): i is CatchUpItem => !!i && !gone.has(i.id) && !i.skip);
        return { ...t, clear: items.filter((i) => takesIn(i, lv)), grey: items.filter((i) => !takesIn(i, lv)) };
      })
      .filter((t) => t.clear.length > 0)
      .sort((a, b) => Number(a.fromCategory) - Number(b.fromCategory) || b.clear.length - a.clear.length);
  }, [cu, byId, gone, lv]);

  async function clear(ids: string[], label: string, notInterested = false) {
    if (!cu || ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.catchUpClear(cu.id, ids, notInterested);
      const next = new Set([...gone, ...ids]);
      setGone(next);
      setToast({ text: label, ids });
      const stillLeft = inAtLevel.filter((i) => !next.has(i.id)).length;
      if (stillLeft === 0) void api.catchUpDone(cu.id).then((r) => setCu((c) => (c ? { ...c, doneAt: r.doneAt } : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear them');
    } finally {
      setBusy(false);
    }
  }

  async function undo(t: Toast) {
    if (!cu) return;
    setToast(null);
    await api.catchUpUnclear(cu.id, t.ids).catch(() => undefined);
    setGone((g) => new Set([...g].filter((id) => !t.ids.includes(id))));
    setCu((c) => (c ? { ...c, doneAt: null } : c));
  }

  /** Clear all: every theme still showing, and the Probably skip pile (as Not interested). */
  async function clearAll() {
    const plain = themes.flatMap((t) => t.clear.map((i) => i.id));
    const skips = skipPile.map((i) => i.id);
    if (!cu) return;
    setBusy(true);
    try {
      if (skips.length) await api.catchUpClear(cu.id, skips, skipNi);
      if (plain.length) await api.catchUpClear(cu.id, plain);
      const all = [...plain, ...skips];
      setGone((g) => new Set([...g, ...all]));
      setToast({ text: `${plural(all.length, 'item')} cleared`, ids: all });
      void api.catchUpDone(cu.id).then((r) => setCu((c) => (c ? { ...c, doneAt: r.doneAt } : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear them');
    } finally {
      setBusy(false);
    }
  }

  async function build() {
    setBuilding(true);
    setError(null);
    try {
      await api.buildCatchUp();
      setLevel(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build one');
    } finally {
      setBuilding(false);
    }
  }

  const r = settings?.reviews;
  const tabs = r && (r.weekly || r.monthly);
  const header = (
    <header className="topbar">
      <div className="topbar__titles">
        <h1>Catch-up</h1>
        <span className="topbar__eyebrow">{cu ? `Since ${shortTime(cu.fromAt)}` : ''}</span>
      </div>
      <div className="rv-top">
        {tabs && (
          <div className="segmented segmented--small" role="group" aria-label="Day, week or month">
            <button aria-pressed className="rv-pick">
              Day
            </button>
            {r.weekly && (
              <button aria-pressed={false} className="rv-pick" onClick={() => navigate('/review/week')}>
                Week
              </button>
            )}
            {r.monthly && (
              <button aria-pressed={false} className="rv-pick" onClick={() => navigate('/review/month')}>
                Month
              </button>
            )}
          </div>
        )}
        <button className="btn btn--ghost btn--small" disabled={building} onClick={() => void build()}>
          {building ? 'Building…' : 'Build now'}
        </button>
      </div>
    </header>
  );

  const past = (list ?? []).filter((x) => x.id !== cu?.id);
  const pastList = past.length > 0 && (
    <section className="rv-sec">
      <h2 className="rv-h">
        <span>Earlier catch-ups</span>
      </h2>
      <ul className="rv-past">
        {past.map((x) => (
          <li key={x.id}>
            <span>
              {shortTime(x.builtAt)} · {plural(x.total, 'item')}
            </span>
            <span className="rv-past__state">{x.cleared} cleared</span>
          </li>
        ))}
      </ul>
    </section>
  );

  const toastEl = toast && (
    <div className="toast" role="status">
      {toast.text}
      <button className="toast__undo" onClick={() => void undo(toast)}>
        Undo
      </button>
    </div>
  );

  if (error && !cu) {
    return (
      <div className="page">
        {header}
        <div className="error">{error}</div>
      </div>
    );
  }
  if (list === null) {
    return (
      <div className="page">
        {header}
        <div className="spinner">Loading…</div>
      </div>
    );
  }

  const nextText = r?.catchUp.on
    ? `The next one is built at ${hourText(r.catchUp.hour)} when ${r.catchUp.minNew} or more have come in${
        r.catchUp.afterBreak > 0 ? `, or after ${r.catchUp.breakHours} hours away with ${r.catchUp.afterBreak} or more` : ''
      }.`
    : 'The morning catch-up is off in Settings › Reviews. Build now makes one anyway.';

  // Nothing to do: none yet, finished, or nothing left at this level.
  if (!cu || cu.doneAt || left.length === 0) {
    const cleared = cu ? cu.items.filter((i) => gone.has(i.id)).length : 0;
    return (
      <div className="page">
        {header}
        <div className="rv rv-caught">
          <div className="empty">
            <h2>{cu ? 'All clear' : 'No catch-up yet'}</h2>
            {cu && cleared > 0 && <p>{plural(cleared, 'item')} from this catch-up cleared or read.</p>}
            {cu && kept.length > 0 && (
              <p>
                <Link to="/">{plural(kept.length, 'likely read')} waiting in your inbox</Link>
              </p>
            )}
            <p>{nextText}</p>
          </div>
          {pastList}
        </div>
        {toastEl}
      </div>
    );
  }

  const keptWhy = new Map<keyof typeof KEEP_COUNT, number>();
  for (const i of kept) {
    const why = i.keep ?? 'deep';
    keptWhy.set(why, (keptWhy.get(why) ?? 0) + 1);
  }
  const skipWhy = new Map<NonNullable<CatchUpItem['skip']>, number>();
  for (const i of skipPile) skipWhy.set(i.skip!, (skipWhy.get(i.skip!) ?? 0) + 1);
  const pct = inAtLevel.length ? (clearedNow / inAtLevel.length) * 100 : 0;

  return (
    <div className="page">
      {header}
      <div className="rv cu">
        {error && <div className="error">{error}</div>}
        <section className="rv-sec">
          {cu.overview ? (
            <>
              <p className="rv-lede">{cu.overview}</p>
              {cu.model && <span className="rv-by">Written by {cu.model} from the summaries</span>}
            </>
          ) : writing ? (
            <div className="rv-status">The PC is grouping these into themes and writing an overview. For now they are grouped by category.</div>
          ) : cu.status === 'failed' ? (
            <div className="rv-status rv-status--bad">
              <span>The PC couldn't make themes{cu.error ? ` (${cu.error})` : ''}, so these are grouped by category.</span>
              <button className="btn btn--small" onClick={() => void api.catchUpRetry(cu.id).then(load)}>
                Try again
              </button>
            </div>
          ) : null}

          <div className="cu-prog" aria-label={`${clearedNow} of ${inAtLevel.length} cleared`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="cu-legend">
            <span>{clearedNow} cleared</span>
            <span>{left.length} left</span>
          </div>

          <div className="cu-dial">
            <div className="cu-dial__top">
              <b>How much to catch</b>
              <span>
                {inAtLevel.length} of {cu.items.length}
              </span>
            </div>
            <div className="segmented" role="radiogroup" aria-label="How much to catch">
              {CATCH_UP_LEVELS.map((x) => (
                <button key={x.level} role="radio" aria-checked={lv === x.level} aria-pressed={lv === x.level} onClick={() => setLevel(x.level)}>
                  {x.label}
                </button>
              ))}
            </div>
            <span className="hint">{CATCH_UP_LEVELS.find((x) => x.level === lv)?.text}</span>
          </div>

          {kept.length > 0 && (
            <div className="cu-kept">
              <b>{plural(kept.length, 'item')} kept in your inbox for reading.</b>{' '}
              {[...keptWhy].map(([why, n]) => KEEP_COUNT[why](n)).join(', ')}. <Link to="/">See them</Link>
            </div>
          )}
        </section>

        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Themes</span>
            <small>Clear marks a whole theme read</small>
          </h2>
          {themes.map((t) => {
            const isOpen = open.has(t.id);
            const stories = new Map<string, { title: string; n: number }>();
            for (const i of [...t.clear, ...t.grey])
              if (i.storyId) stories.set(i.storyId, { title: i.storyTitle ?? 'Story', n: (stories.get(i.storyId)?.n ?? 0) + 1 });
            const storyRows = [...stories].filter(([, s]) => s.n >= 2);
            const loose = t.clear.filter((i) => !i.storyId || !storyRows.some(([sid]) => sid === i.storyId));
            return (
              <article key={t.id} className="cu-theme">
                <div className="cu-theme__hd">
                  <h3>{t.name}</h3>
                  {t.fromCategory && <span className="chip">your category</span>}
                  <span className="cu-theme__n">{t.clear.length}</span>
                </div>
                {t.gist && <p className="cu-theme__gist">{t.gist}</p>}
                {!isOpen && (
                  <>
                    {storyRows.slice(0, 3).map(([sid, s]) => (
                      <div key={sid} className="cu-story">
                        <b>{s.title}</b> <span className="chip">Story · {s.n}</span>
                      </div>
                    ))}
                    <ul className="cu-heads">
                      {loose.slice(0, 3).map((i) => (
                        <li key={i.id}>
                          {i.subject}
                          {i.sourceName && <span> · {i.sourceName}</span>}
                        </li>
                      ))}
                      {loose.length > 3 && <li className="cu-more">+{loose.length - 3} more</li>}
                    </ul>
                    {t.grey.map((i) => (
                      <div key={i.id} className="cu-grey">
                        {i.subject} · {i.keep ? `${KEEP_LABEL[i.keep]}, ` : ''}in your inbox, not cleared
                      </div>
                    ))}
                  </>
                )}
                {isOpen && (
                  <ul className="cu-rows">
                    {[...t.clear, ...t.grey].map((i) => (
                      <li key={i.id} className={takesIn(i, lv) ? '' : 'cu-rows--grey'}>
                        <Link to={`/item/${i.id}`}>{i.subject}</Link>
                        {i.line && <p>{i.line}</p>}
                        <span className="cu-rows__meta">
                          {i.sourceName ?? ''} · {shortTime(i.receivedAt)}
                          {i.storyTitle ? ` · ${i.storyTitle}` : ''}
                          {!takesIn(i, lv) && ` · stays in your inbox${i.keep ? ` (${KEEP_LABEL[i.keep]})` : ''}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="cu-theme__acts">
                  <button className="btn btn--small" disabled={busy} onClick={() => void clear(t.clear.map((i) => i.id), `${plural(t.clear.length, 'item')} cleared from ${t.name}`)}>
                    Clear {t.clear.length}
                  </button>
                  <button
                    className="btn btn--ghost btn--small"
                    onClick={() => setOpen((o) => (o.has(t.id) ? new Set([...o].filter((x) => x !== t.id)) : new Set([...o, t.id])))}
                  >
                    {isOpen ? 'Show less' : 'See all'}
                  </button>
                </div>
              </article>
            );
          })}
        </section>

        {skipPile.length > 0 && (
          <section className="rv-sec">
            <h2 className="rv-h">
              <span>Probably skip · {skipPile.length}</span>
            </h2>
            <div className="cu-skip">
              {[...skipWhy].map(([why, n]) => (
                <span key={why}>{SKIP_LABEL[why](n)}</span>
              ))}
              <div className="inline">
                <button className="btn btn--small" disabled={busy} onClick={() => void clear(skipPile.map((i) => i.id), skipNi ? `${skipPile.length} marked Not interested` : `${skipPile.length} cleared`, skipNi)}>
                  Clear {skipPile.length}
                  {skipNi ? ' as Not interested' : ''}
                </button>
                <button
                  className="btn btn--ghost btn--small"
                  onClick={() => setOpen((o) => (o.has('skip') ? new Set([...o].filter((x) => x !== 'skip')) : new Set([...o, 'skip'])))}
                >
                  {open.has('skip') ? 'Hide them' : 'Show them'}
                </button>
              </div>
              {open.has('skip') && (
                <ul className="cu-rows">
                  {skipPile.map((i) => (
                    <li key={i.id}>
                      <Link to={`/item/${i.id}`}>{i.subject}</Link>
                      <span className="cu-rows__meta">{i.sourceName ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
        {pastList}
      </div>
      <div className="cu-bar">
        <span>{plural(left.length, 'item')} left to skim</span>
        <button className="btn btn--primary btn--small" disabled={busy} onClick={() => void clearAll()}>
          Clear all {left.length}
        </button>
      </div>
      {toastEl}
    </div>
  );
}
