import type {
  CategorySuggestion,
  Review,
  ReviewChartWeeks,
  ReviewFinding,
  ReviewKind,
  ReviewListItem,
  ReviewPart,
  ReviewSourceChange,
  ReviewSourceRow,
  WebSearchView,
} from '@newsletterapp/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Arcs, LineChart, Movers, PairBars, Spark } from '../components/ReviewCharts';
import { TagChip, tagPath } from '../components/TagChip';
import { shortTime } from '../format';

// The Review tab: weekly (and, when switched on, monthly) reviews. The Worker
// gathers the facts when a review is built, so the charts and lists show at
// once; the PC writes the opening, the story lines and the web findings, and
// those fill in when it has.

const BADGES: Record<string, { label: string; cls: string }> = {
  new: { label: 'New story', cls: 'rv-badge--new' },
  busiest: { label: 'Busiest', cls: 'rv-badge--hot' },
  followed: { label: 'Followed', cls: 'rv-badge--follow' },
  quiet: { label: 'Went quiet', cls: 'rv-badge--quiet' },
  back: { label: 'Back again', cls: 'rv-badge--follow' },
};

const SOURCE_TAGS: Record<ReviewSourceChange['kind'] | ReviewSourceRow['verdict'], { label: string; cls: string }> = {
  new: { label: 'New', cls: 'rv-badge--new' },
  busier: { label: 'Busier', cls: 'rv-badge--hot' },
  quiet: { label: 'Gone quiet', cls: 'rv-badge--quiet' },
  unopened: { label: 'Not opened', cls: 'rv-badge--follow' },
  starred: { label: 'Most starred', cls: 'rv-badge--hot' },
  best: { label: 'Best for you', cls: 'rv-badge--hot' },
  settling: { label: 'Settling in', cls: 'rv-badge--new' },
  low: { label: 'Low value?', cls: 'rv-badge--follow' },
};

const FINDING: Record<ReviewFinding['kind'], { label: string; cls: string }> = {
  new: { label: 'New since', cls: 'rv-kind--new' },
  link: { label: 'Connection', cls: 'rv-kind--link' },
  background: { label: 'Background', cls: 'rv-kind--bg' },
  check: { label: 'Check', cls: 'rv-kind--check' },
  next: { label: 'What happened next', cls: 'rv-kind--new' },
};

const CATEGORY_KIND: Record<CategorySuggestion['kind'], string> = {
  move_source: 'Source in the wrong category',
  elsewhere: 'Items that fit elsewhere',
  new_category: 'Possible new category',
  near_empty: 'Almost empty',
};

const vsUsual = (now: number, usual: number) => {
  if (usual === 0) return now > 0 ? { text: 'new', cls: 'rv-up' } : null;
  const d = Math.round(((now - usual) / usual) * 100);
  if (Math.abs(d) < 3) return { text: 'as usual', cls: '' };
  return { text: `${d > 0 ? '+' : ''}${d}% vs usual`, cls: d > 0 ? 'rv-up' : 'rv-down' };
};

const weekTick = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const monthTick = (at: number) => new Date(at + 15 * 86_400_000).toLocaleDateString(undefined, { month: 'short' });

export function ReviewPage({ on }: { on: boolean }) {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [list, setList] = useState<ReviewListItem[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  // After Done: a short line at the bottom with Undo, while the next review (or the caught-up screen) shows.
  const [toast, setToast] = useState<{ text: string; id: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const loadList = () =>
    api
      .reviews()
      .then(setList)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load reviews'));

  useEffect(() => {
    void loadList();
  }, []);

  // Which review to show: the one in the address, else the newest one not yet done.
  // When every review is done, /review shows the caught-up screen with the past reviews.
  const currentId = id ?? list?.find((r) => !r.readAt)?.id ?? null;
  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    const load = () =>
      api
        .review(currentId)
        .then((r) => alive && setReview(r))
        .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : 'Could not load the review'));
    void load();
    // While the PC is writing it, look again every half minute.
    const timer = window.setInterval(() => {
      setReview((r) => {
        if (r && r.id === currentId && (r.status === 'waiting' || r.status === 'working')) void load();
        return r;
      });
    }, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [currentId]);

  const kinds = new Set(list?.map((r) => r.kind));
  const shown = review && review.id === currentId ? review : null;

  async function build(kind: ReviewKind) {
    setBuilding(true);
    setError(null);
    try {
      const r = await api.buildReview(kind);
      await loadList();
      setReview(r);
      navigate(`/review/${r.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the review');
    } finally {
      setBuilding(false);
    }
  }

  if (!on && list && list.length === 0) {
    return (
      <div className="page">
        <header className="topbar">
          <div className="topbar__titles">
            <h1>Review</h1>
          </div>
        </header>
        <div className="empty">
          <p>Weekly and monthly reviews are switched off.</p>
          <p>
            <Link to="/settings">Turn them on in Settings</Link>
          </p>
        </div>
      </div>
    );
  }

  const kind = shown?.kind ?? 'week';
  const earlier = (list ?? []).filter((r) => r.kind === kind && r.id !== currentId);
  const caughtUp = !id && list !== null && list.length > 0 && !currentId;

  /** Done slid the review away: go on to the next one not yet done, or the caught-up screen. */
  function afterDone(r: Review, note: string) {
    setToast({ text: note, id: r.id });
    void loadList();
    navigate('/review', { replace: !!id });
  }

  async function undo(reviewId: string) {
    setToast(null);
    await api.reviewUndone(reviewId);
    await loadList();
    navigate(`/review/${reviewId}`);
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <h1>{kind === 'month' ? 'Your month' : 'Your week'}</h1>
          {shown && <span className="topbar__eyebrow">{shown.pack.label}</span>}
        </div>
        <div className="rv-top">
          {kinds.size > 1 && (
            <div className="segmented segmented--small" role="group" aria-label="Weekly or monthly">
              {(['week', 'month'] as const).map((k) => (
                <button
                  key={k}
                  aria-pressed={kind === k}
                  onClick={() => {
                    const r = list?.find((x) => x.kind === k && !x.readAt) ?? list?.find((x) => x.kind === k);
                    if (r) navigate(`/review/${r.id}`);
                  }}
                >
                  {k === 'week' ? 'Week' : 'Month'}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn--ghost btn--small" disabled={building} onClick={() => void build(kind)}>
            {building ? 'Building…' : 'Build now'}
          </button>
        </div>
      </header>

      {!caughtUp && earlier.length > 0 && (
        <div className="tabs">
          <button className="pill" aria-pressed={!showEarlier} onClick={() => setShowEarlier((v) => !v)}>
            {showEarlier ? 'Hide past reviews' : `Past reviews (${earlier.length})`}
          </button>
          {showEarlier &&
            earlier.map((r) => (
              <button key={r.id} className="pill" onClick={() => navigate(`/review/${r.id}`)}>
                {r.label}
                {r.readAt ? ' ✓' : ''}
              </button>
            ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {list === null && !error && <div className="spinner">Loading…</div>}
      {list && list.length === 0 && (
        <div className="empty">
          <h2>No review yet</h2>
          <p>The weekly review is built on the day and hour set in Settings › Reviews. Tap “Build now” for one covering the last 7 days.</p>
        </div>
      )}
      {currentId && !shown && !error && list && list.length > 0 && <div className="spinner">Loading…</div>}
      {caughtUp && list && (
        <div className="rv-caught">
          <div className="empty">
            <h2>All caught up</h2>
            <p>Every review is done. The next weekly review is built on the day and hour set in Settings › Reviews.</p>
          </div>
          <h2 className="rv-h">
            <span>Past reviews</span>
          </h2>
          <ul className="rv-past">
            {list.map((r) => (
              <li key={r.id}>
                <Link to={`/review/${r.id}`}>
                  <span className="rv-past__label">{r.label}</span>
                  <span className="rv-past__kind">{r.kind === 'month' ? 'Month' : 'Week'}</span>
                  <span className="rv-past__state">{r.readAt ? 'Done' : r.status === 'done' ? 'Not done' : 'Being written'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {shown && <ReviewView key={shown.id} review={shown} onChange={setReview} onDone={() => void loadList()} onFinished={afterDone} />}
      {toast && (
        <div className="toast" role="status">
          {toast.text}
          <button className="toast__undo" onClick={() => void undo(toast.id)}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewView({
  review,
  onChange,
  onDone,
  onFinished,
}: {
  review: Review;
  onChange: (r: Review) => void;
  onDone: () => void;
  /** Called once the review has slid away after Done. */
  onFinished: (r: Review, note: string) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  const p = review.pack;
  const w = review.written;
  const has = (part: ReviewPart) => !review.skipParts.includes(part);
  const writing = review.status === 'waiting' || review.status === 'working';
  const [markRead, setMarkRead] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<ReviewChartWeeks>(review.chartWeeks);
  const [search, setSearch] = useState<WebSearchView | null>(null);

  useEffect(() => {
    setRange(review.chartWeeks);
    setNote(null);
  }, [review.id, review.chartWeeks]);
  useEffect(() => {
    api
      .settings()
      .then((s) => setMarkRead((v) => v ?? s.reviews.doneMarksRead))
      .catch(() => setMarkRead((v) => v ?? false));
    api.webSearch().then(setSearch).catch(() => undefined);
  }, []);

  const trend = useMemo(() => {
    const t = p.trends;
    if (!t || t.weeks.length < 2) return null;
    const n = Math.min(range, t.weeks.length);
    return {
      ticks: t.weeks.slice(-n).map(weekTick),
      lines: t.tags.map((s) => ({ key: s.tag, label: s.label, values: s.counts.slice(-n) })),
    };
  }, [p.trends, range]);

  async function done() {
    try {
      const r = await api.reviewDone(review.id, markRead === true);
      const note = r.itemsRead > 0 ? `Review done. ${r.itemsRead} item${r.itemsRead === 1 ? '' : 's'} marked read.` : 'Review done.';
      const finished = { ...review, readAt: r.readAt };
      // Slide it away, then move on. With reduced motion the CSS skips the slide.
      setLeaving(true);
      window.scrollTo({ top: 0 });
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.setTimeout(() => onFinished(finished, note), reduce ? 0 : 320);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark it done');
    }
  }

  async function more() {
    setError(null);
    try {
      await api.reviewMore(review.id);
      onChange({ ...review, status: 'waiting' });
      setNote('Asked the PC for a few more searches. They show here when it has done them.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ask for more');
    }
  }

  async function retry() {
    await api.reviewRetry(review.id).catch(() => undefined);
    onChange({ ...review, status: 'waiting', error: null, written: {} });
  }

  async function markFinding(f: ReviewFinding) {
    const updated = await api.reviewFinding(review.id, f.id, !f.notUseful).catch(() => null);
    if (updated) onChange({ ...review, written: { ...w, findings: w.findings?.map((x) => (x.id === f.id ? updated : x)) } });
  }

  async function savePage(url: string) {
    try {
      const r = await api.savePage(url);
      setNote(r.already ? `Already saved: ${r.title}` : `Saved as a page: ${r.title}${r.waitingForPc ? ' (the PC is fetching it)' : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the page');
    }
  }

  async function category(s: CategorySuggestion, action: 'apply' | 'apply_old' | 'dismiss') {
    setError(null);
    try {
      const r = await api.reviewCategory(review.id, s.id, action);
      setNote(r.message);
      onChange({ ...review, pack: { ...p, categories: p.categories?.map((x) => (x.id === s.id ? r.suggestion : x)) } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply it');
    }
  }

  const c = p.counts;
  const stats = [
    { n: c.arrived, label: 'arrived' },
    { n: c.read, label: 'read' },
    { n: c.stories, label: review.kind === 'week' ? 'stories active' : 'stories active' },
    { n: c.stars, label: 'starred' },
  ];

  return (
    <div className="rv">
      {writing && (
        <p className="rv-status">
          {review.written.writtenAt ? 'The PC is looking up a few more things.' : 'The PC is writing this review. The charts and lists below are ready; its words and web findings fill in when it has.'}
        </p>
      )}
      {review.status === 'failed' && (
        <div className="rv-status rv-status--bad">
          <span>The PC couldn't write this review{review.error ? `: ${review.error}` : '.'}</span>
          <button className="btn btn--small" onClick={() => void retry()}>
            Try again
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {note && <p className="hint rv-note">{note}</p>}

      <section className="rv-sec">
        <h2 className="rv-h">
          <span>{p.label}</span>
          <small>Built {shortTime(review.createdAt)}</small>
        </h2>
        {w.opening ? <p className="rv-lede">{w.opening}</p> : !writing && <p className="hint">No opening was written for this one.</p>}
        {w.model && (
          <p className="rv-by">
            Written by {w.model}
            {w.searches ? ` · ${w.searches} web search${w.searches === 1 ? '' : 'es'}` : ''}
          </p>
        )}
        <div className="rv-stats">
          {stats.map((s) => {
            const d = vsUsual(s.n.now, s.n.usual);
            return (
              <div key={s.label} className="rv-stat">
                <strong>{s.n.now.toLocaleString()}</strong>
                <span>{s.label}</span>
                {d && <em className={d.cls}>{d.text}</em>}
              </div>
            );
          })}
        </div>
        <p className="rv-by">Usual = the average of {p.usualLabel}.</p>
      </section>

      {has('top') && p.top && p.top.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Top of the week</span>
          </h2>
          {p.top.map((s) => (
            <article key={s.itemId} className={`story${s.readAt ? ' story--read' : ''}`}>
              <Link to={`/item/${s.itemId}`} className="story__title">
                {s.subject}
              </Link>
              <span className="story__source">
                {s.sourceName ?? 'Unknown sender'} · {shortTime(s.receivedAt)}
                {s.readAt ? ' · read' : ''}
              </span>
              {s.summary && <p className="story__summary">{s.summary}</p>}
              {s.more.length > 0 && (
                <ul className="story__more">
                  <li>More:</li>
                  {s.more.map((m) => (
                    <li key={m.itemId}>
                      <Link to={`/item/${m.itemId}`}>{m.sourceName ?? m.subject}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}

      {has('stories') && p.stories && p.stories.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Stories that moved</span>
            <small>
              <Link to="/saved/stories">All stories</Link>
            </small>
          </h2>
          {p.stories.map((s) => (
            <Link key={s.id} to={`/story/${s.id}`} className="rv-story">
              <span className="rv-story__t">{s.title}</span>
              <Spark values={s.perDay} label={`${s.items} items over the week`} />
              <span className="rv-story__meta">
                {s.badges.map((b) => (
                  <span key={b} className={`rv-badge ${BADGES[b]?.cls ?? ''}`}>
                    {BADGES[b]?.label ?? b}
                    {b === 'back' && s.gapWeeks ? ` after ${s.gapWeeks} weeks` : ''}
                  </span>
                ))}
                <span>
                  {s.items} item{s.items === 1 ? '' : 's'} from {s.sources} source{s.sources === 1 ? '' : 's'} · {s.totalItems} in all
                </span>
              </span>
              {w.storyLines?.[s.id] && (
                <span className="rv-story__line">
                  <b>What changed:</b> {w.storyLines[s.id]}
                </span>
              )}
            </Link>
          ))}
        </section>
      )}

      {has('trends') && p.trends && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Topic trends</span>
            <small>items per week</small>
          </h2>
          {trend && (
            <>
              <div className="segmented segmented--small" role="group" aria-label="How far back">
                {([12, 26, 52] as const)
                  .filter((n) => n <= Math.max(12, p.trends!.weeks.length))
                  .map((n) => (
                    <button key={n} aria-pressed={range === n} onClick={() => setRange(n)}>
                      {n === 12 ? '12 weeks' : n === 26 ? '6 months' : '1 year'}
                    </button>
                  ))}
              </div>
              <LineChart
                lines={trend.lines}
                ticks={trend.ticks}
                label="Items per week for your busiest tags"
                onPick={(tag) => navigate(tagPath(p.trends!.tags.find((t) => t.tag === tag)?.label ?? tag))}
              />
              <p className="rv-by">Shaded = this week. Tap a line to open the tag.</p>
            </>
          )}
          <Movers movers={p.trends.movers} onPick={(m) => navigate(tagPath(m.label))} />
          {p.trends.movers.some((m) => m.note) && (
            <ul className="rv-notes">
              {p.trends.movers
                .filter((m) => m.note)
                .map((m) => (
                  <li key={m.tag}>
                    <b>{m.label}:</b> {m.note}
                  </li>
                ))}
            </ul>
          )}
          {p.trends.newTags.length > 0 && (
            <>
              <p className="rv-by">New tags this week</p>
              <div className="rv-chips">
                {p.trends.newTags.map((t) => (
                  <TagChip key={t.tag} tag={t.label} count={t.n} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {has('sources') && p.sources && p.sources.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Source changes</span>
            <small>
              <Link to="/settings/sources">Your sources</Link>
            </small>
          </h2>
          <SourceRows rows={p.sources.map((s) => ({ ...s, tag: s.kind }))} />
        </section>
      )}

      {has('arcs') && p.arcs && p.arcs.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>How your stories ran</span>
            <small>last 6 months</small>
          </h2>
          <Arcs arcs={p.arcs} toAt={review.toAt} onPick={(a) => navigate(`/story/${a.id}`)} />
          <ul className="rv-notes">
            {p.arcs
              .filter((a) => a.status !== 'running' || a.lastAt - a.firstAt > 60 * 86_400_000)
              .slice(0, 4)
              .map((a) => (
                <li key={a.id}>
                  <b>{a.status === 'ended' ? 'Ended' : a.status === 'back' ? 'Came back' : 'Long runner'}:</b> {a.title}, {a.items} items
                </li>
              ))}
          </ul>
        </section>
      )}

      {has('interests') && p.interests && p.interests.tags.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Your interests over the year</span>
            <small>share of what you read</small>
          </h2>
          <LineChart
            lines={p.interests.tags.map((t) => ({ key: t.tag, label: t.label, values: t.shares }))}
            ticks={p.interests.months.map(monthTick)}
            unit="%"
            label="Share of what you read carrying each tag, per month"
            onPick={(tag) => navigate(tagPath(p.interests!.tags.find((t) => t.tag === tag)?.label ?? tag))}
          />
          {p.interests.notes.length > 0 && (
            <ul className="rv-notes">
              {p.interests.notes.map((n) => (
                <li key={n.label}>
                  <b>{n.label}:</b> {n.text}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {has('sourceReview') && p.sourceReview && p.sourceReview.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Source review</span>
            <small>last 3 months</small>
          </h2>
          <SourceRows rows={p.sourceReview.map((s) => ({ ...s, tag: s.verdict }))} />
        </section>
      )}

      {has('categories') && p.categories && p.categories.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Category check</span>
            <small>nothing changes until you say</small>
          </h2>
          {p.categories.map((s) => (
            <div key={s.id} className="rv-card">
              <span className="rv-kind rv-kind--link">{CATEGORY_KIND[s.kind]}</span>
              <b>{s.title}</b>
              {s.mix && s.mix.length > 1 && <Mix mix={s.mix} />}
              <span className="rv-why">{s.why}</span>
              {s.status ? (
                <span className="rv-by">{s.status === 'dismissed' ? 'Left as it is.' : s.status === 'applied_old' ? 'Done, earlier items too.' : 'Done.'}</span>
              ) : (
                <div className="rv-acts">
                  {s.kind === 'move_source' && (
                    <>
                      <button className="btn btn--small" onClick={() => void category(s, 'apply')}>
                        Apply to new items
                      </button>
                      <button className="btn btn--ghost btn--small" onClick={() => void category(s, 'apply_old')}>
                        Apply and move old items
                      </button>
                    </>
                  )}
                  {s.kind === 'elsewhere' && (
                    <button className="btn btn--small" onClick={() => void category(s, 'apply_old')}>
                      Move these {s.itemIds?.length ?? ''} items
                    </button>
                  )}
                  {s.kind === 'new_category' && (
                    <>
                      <button className="btn btn--small" onClick={() => void category(s, 'apply')}>
                        Add it for new items
                      </button>
                      <button className="btn btn--ghost btn--small" onClick={() => void category(s, 'apply_old')}>
                        Add it and move old items
                      </button>
                    </>
                  )}
                  {s.kind === 'near_empty' && (
                    <button className="btn btn--small" onClick={() => void category(s, 'apply')}>
                      Take it off the list
                    </button>
                  )}
                  <button className="btn btn--ghost btn--small" onClick={() => void category(s, 'dismiss')}>
                    Not now
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {has('stars') && (p.stars.length > 0 || w.starsSay) && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>{review.kind === 'month' ? 'What your stars say' : 'What you starred'}</span>
            <small>
              <Link to="/saved/interesting">Saved › Interesting</Link>
            </small>
          </h2>
          {w.starsSay && <p>{w.starsSay}</p>}
          <ul className="rv-stars">
            {p.stars.slice(0, review.kind === 'month' ? 6 : 12).map((s) => (
              <li key={s.itemId}>
                <span aria-hidden="true" className="rv-star">
                  ★
                </span>
                <span>
                  <Link to={`/item/${s.itemId}`}>{s.subject}</Link>
                  <span className="rv-by">
                    {[s.sourceName, shortTime(s.at), s.highlights ? `${s.highlights} highlight${s.highlights === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </li>
            ))}
            {review.kind === 'month' && p.stars.length > 6 && <li className="rv-by">and {p.stars.length - 6} more</li>}
          </ul>
          {w.thread && <p className="rv-thread">{w.thread}</p>}
        </section>
      )}

      {has('further') && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>{review.kind === 'month' ? 'Follow-ups' : 'Looking further'}</span>
            <small>PC AI + web search</small>
          </h2>
          {review.kind === 'month' && <p className="rv-by">The monthly review looks at things you starred 1 to 3 months ago, and long-running stories, and checks what happened next.</p>}
          {(w.findings ?? []).length === 0 && !writing && <p className="hint">Nothing new was found this time.</p>}
          {(w.findings ?? []).map((f) => (
            <div key={f.id} className={`rv-card${f.notUseful ? ' rv-card--dim' : ''}`}>
              <span className={`rv-kind ${FINDING[f.kind].cls}`}>{FINDING[f.kind].label}</span>
              <p className="rv-q">
                <b>Asked:</b> {f.question}
              </p>
              {f.bridge && (
                <div className="rv-bridge">
                  <span className="rv-bridge__end">{f.bridge[0]}</span>
                  <span className="rv-bridge__mid">{f.bridge[1]}</span>
                  <span className="rv-bridge__end">{f.bridge[2]}</span>
                </div>
              )}
              <p className="rv-a">{f.answer}</p>
              {f.sources.length > 0 && (
                <ul className="rv-src">
                  {f.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>{' '}
                      <button className="linkbtn" onClick={() => void savePage(s.url)}>
                        Save as page
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="rv-acts">
                <button className="btn btn--ghost btn--small" aria-pressed={f.notUseful === true} onClick={() => void markFinding(f)}>
                  {f.notUseful ? 'Marked not useful' : 'Not useful'}
                </button>
              </div>
            </div>
          ))}
          {w.note && <p className="hint">{w.note}</p>}
          <div className="rv-acts">
            <button className="btn btn--small" disabled={writing || review.status !== 'done'} onClick={() => void more()}>
              Find more ({review.kind === 'week' ? 3 : 5} more searches)
            </button>
          </div>
          {search && (
            <div className="rv-budget">
              <span>{w.searches ?? 0} searches for this review</span>
              <span className="rv-meter">
                <i style={{ width: `${Math.min(100, (search.used / Math.max(1, search.settings.monthlyBudget)) * 100)}%` }} />
              </span>
              <span>
                {Math.max(0, search.settings.monthlyBudget - search.used).toLocaleString()} of {search.settings.monthlyBudget.toLocaleString()} left this month
              </span>
            </div>
          )}
        </section>
      )}

      {has('reading') && p.reading.buckets.length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>{review.kind === 'month' ? 'Reading over the months' : 'How you read'}</span>
          </h2>
          <PairBars buckets={p.reading.buckets} label="Arrived and read" />
          <div className="rv-legend">
            <span>
              <i style={{ background: 'var(--border-strong)' }} />
              Arrived
            </span>
            <span>
              <i style={{ background: 'var(--teal)' }} />
              Read
            </span>
          </div>
          {p.reading.note && <p className="rv-by">{p.reading.note}</p>}
        </section>
      )}

      {has('coming') && (w.coming ?? []).length > 0 && (
        <section className="rv-sec">
          <h2 className="rv-h">
            <span>Coming up</span>
            <small>dates found in your articles</small>
          </h2>
          <div className="rv-watch">
            {w.coming!.map((x) => (
              <div key={x.date + x.what} className="rv-watch__row">
                <b>{comingDate(x.date)}</b>
                <span>{x.itemId ? <Link to={`/item/${x.itemId}`}>{x.what}</Link> : x.what}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rv-sec rv-end">
        {review.readAt ? (
          <button
            className="btn btn--ghost"
            onClick={() => {
              void api.reviewUndone(review.id).then(() => {
                onChange({ ...review, readAt: null });
                onDone();
              });
            }}
          >
            Reopen
          </button>
        ) : (
          <>
            <label className="digest__option">
              <input type="checkbox" checked={markRead === true} onChange={(e) => setMarkRead(e.target.checked)} />
              Also mark the lead stories and story items read
            </label>
            <button className="btn btn--block" onClick={() => void done()}>
              Mark review done
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function comingDate(d: string): string {
  const [y = 1970, m = 1, day] = d.split('-').map(Number);
  const date = new Date(y, m - 1, day ?? 1);
  return day ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function SourceRows({ rows }: { rows: { id: string; name: string; detail: string; tag: keyof typeof SOURCE_TAGS }[] }) {
  return (
    <div className="rv-srcs">
      {rows.map((s) => (
        <Link key={s.id + s.tag} to={`/source/${s.id}`} className="rv-srow">
          <span className="rv-srow__n">{s.name}</span>
          <span className={`rv-badge ${SOURCE_TAGS[s.tag].cls}`}>{SOURCE_TAGS[s.tag].label}</span>
          <span className="rv-srow__d">{s.detail}</span>
        </Link>
      ))}
    </div>
  );
}

const MIX = ['var(--ks-evidence)', 'var(--ks-takeaway)', 'var(--ks-main)', 'var(--ks-example)'];

function Mix({ mix }: { mix: { label: string; n: number }[] }) {
  const total = mix.reduce((a, m) => a + m.n, 0) || 1;
  return (
    <div className="rv-mixwrap">
      <div className="rv-mix" aria-hidden="true">
        {mix.map((m, i) => (
          <i key={m.label} style={{ width: `${(m.n / total) * 100}%`, background: MIX[i % MIX.length] }} />
        ))}
      </div>
      <div className="rv-legend">
        {mix.map((m, i) => (
          <span key={m.label}>
            <i style={{ background: MIX[i % MIX.length] }} />
            {m.label} {m.n}
          </span>
        ))}
      </div>
    </div>
  );
}
