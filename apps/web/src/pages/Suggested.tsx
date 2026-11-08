import type { Suggestion, SuggestionList } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { relativeTime } from '../format';
import { IconBack } from '../icons';
import { tagPath } from '../components/TagChip';
import { StartWithPicker } from './Add';

/** Done on this visit: shown as a line with Undo at the top. */
interface Done {
  site: string;
  title: string;
  kind: 'followed' | 'hidden';
  sourceId: string | null;
}

/** Feeds you might like, from the sites your reading keeps linking to. Settings > Your sources > Suggested for you. */
export function SuggestedPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<SuggestionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [asked, setAsked] = useState(false);

  const load = () =>
    api
      .suggestions()
      .then(setList)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load suggestions'));
  useEffect(() => {
    void load();
  }, []);

  const runNow = async () => {
    setAsked(true);
    try {
      await api.suggestionsRun();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ask the PC');
    }
  };

  const drop = (site: string) => setList((cur) => (cur ? { ...cur, suggestions: cur.suggestions.filter((s) => s.site !== site) } : cur));

  const follow = async (s: Suggestion, startWith: number) => {
    let sourceId: string | null = null;
    try {
      const r = await api.addSource({ kind: 'feed', url: s.siteUrl ?? s.feedUrl!, feedUrl: s.feedUrl!, name: s.title, startWith });
      sourceId = r.source.id;
    } catch (err) {
      // Already followed under this address: just mark it.
      if (!(err instanceof ApiError && err.status === 409)) {
        setError(err instanceof Error ? err.message : 'Could not follow it');
        return;
      }
    }
    const r = await api.suggestionFollowed(s.site, sourceId);
    drop(s.site);
    setDone({ site: s.site, title: s.title, kind: 'followed', sourceId: r.sourceId });
  };

  const dismiss = async (s: Suggestion) => {
    await api.suggestionDismiss(s.site);
    drop(s.site);
    setDone({ site: s.site, title: s.title, kind: 'hidden', sourceId: null });
  };

  const undo = async () => {
    if (!done) return;
    // Following is undone by pausing the feed it added; nothing more arrives from it.
    if (done.kind === 'followed' && done.sourceId) await api.updateSource(done.sourceId, { paused: true }).catch(() => undefined);
    await api.suggestionUndo(done.site);
    setDone(null);
    await load();
  };

  const waiting = list && (list.runWaiting || asked);

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="topbar__eyebrow">Your sources</span>
            <h1>Suggested for you</h1>
          </div>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {!list && !error && <div className="spinner">Loading…</div>}

      {done && (
        <div className="notice notice--teal-tint" role="status">
          <div className="notice__text">
            <span className="notice__title">{done.kind === 'followed' ? `Following ${done.title}` : `${done.title} hidden`}</span>
            <span className="notice__sub">
              {done.kind === 'followed'
                ? 'Its topics, and the sources that led you to it, now count for more.'
                : 'It won’t be suggested again, and its topics count for a little less.'}
            </span>
          </div>
          <button className="btn btn--small btn--ghost" onClick={() => void undo()}>
            Undo
          </button>
        </div>
      )}

      {list && (
        <div className="section">
          <span className="hint" style={{ margin: 0 }}>
            {list.lastRunAt ? `Updated ${relativeTime(list.lastRunAt)} by your PC` : 'Your PC hasn’t looked for suggestions yet'} · picked from the links in
            what you read, save, star and tap.
          </span>
          {!list.helperOnline && <span className="hint cardrow__flag">Your PC helper is offline, so new suggestions wait until it’s back.</span>}
          {list.linksWaiting > 0 && (
            <span className="hint">Still counting links in your past reading ({list.linksWaiting} items to go); more suggestions follow as it finishes.</span>
          )}
          {list.stars < 3 && (
            <span className="hint">Star (★) a few things you liked so the PC can tell how close each site is to your taste.</span>
          )}
          <div className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn--small btn--ghost" onClick={() => void runNow()} disabled={Boolean(waiting)}>
              {waiting ? 'Your PC will look within a few minutes' : 'Look again now'}
            </button>
          </div>
        </div>
      )}

      {list && list.suggestions.length === 0 && (
        <div className="empty">
          <h2>No suggestions yet</h2>
          <p>
            {list.lastRunAt
              ? 'Nothing stands out right now. As you read, save and star more, sites your reading keeps linking to show up here.'
              : 'Once your PC has counted the links in what you read, the sites they point to most show up here.'}
          </p>
        </div>
      )}

      {list && list.suggestions.length > 0 && (
        <div className="section">
          {list.suggestions.map((s) => (
            <SuggestionCard key={s.site} s={s} onFollow={(n) => follow(s, n)} onDismiss={() => void dismiss(s)} />
          ))}
        </div>
      )}

      <div className="section">
        <div className="card card--list">
          <Link to="/settings/sources/suggested/learnt" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Learnt from you</span>
              <span className="cardrow__sub">What Follow and Not interested have taught it, how your follows are doing, and hidden sites</span>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}

function whyLines(s: Suggestion): string[] {
  const w = s.why;
  const lines: string[] = [];
  if (w.items > 0) {
    lines.push(
      w.starred > 0
        ? `Linked from ${w.items} things you read or saved, ${w.starred} of them starred`
        : `Linked from ${w.items} things you read or saved`,
    );
  }
  if (w.sources >= 2) lines.push(`From ${w.sources} of your sources${w.sourceNames.length ? `: ${w.sourceNames.join(', ')}` : ''}`);
  else if (w.sourceNames.length === 1) lines.push(`All from ${w.sourceNames[0]}`);
  if (w.clicks > 0) lines.push(`You tapped through to it ${w.clicks} time${w.clicks === 1 ? '' : 's'}`);
  if (w.topics.length) {
    const thin = w.topics.filter((t) => t.sources <= 2);
    lines.push(
      `Close to your ${w.topics.map((t) => t.label).join(', ')} reading` +
        (thin.length ? `, where you follow only ${Math.max(...thin.map((t) => t.sources))} source${thin.length === 1 && thin[0]!.sources === 1 ? '' : 's'}` : ''),
    );
  }
  if (s.fit !== null) lines.push(`Its posts are a ${s.fit}% match for what you star`);
  if (w.learnt > 0) lines.push('Ranked higher: like sites you followed before');
  if (w.learnt < 0) lines.push('Ranked lower: like sites you passed on');
  return lines;
}

function rateText(s: Suggestion): string {
  const parts = [s.site];
  if (s.postsPerWeek !== null) parts.push(s.postsPerWeek >= 1 ? `~${Math.round(s.postsPerWeek)} posts/week` : `~${Math.max(1, Math.round(s.postsPerWeek * 4.3))} posts/month`);
  if (s.lastPostAt) parts.push(`last post ${relativeTime(s.lastPostAt)}`);
  return parts.join(' · ');
}

function SuggestionCard({ s, onFollow, onDismiss }: { s: Suggestion; onFollow: (startWith: number) => Promise<void>; onDismiss: () => void }) {
  const [picking, setPicking] = useState(false);
  const [startWith, setStartWith] = useState(5);
  const [busy, setBusy] = useState(false);
  return (
    <article className="card suggest" aria-label={s.title}>
      <div className="suggest__head">
        <span className="suggest__mark" aria-hidden="true">
          {s.title.replace(/^the\s+/i, '').slice(0, 2)}
        </span>
        <div className="cardrow__main">
          <span className="cardrow__title" style={{ fontWeight: 600 }}>
            {s.title}
          </span>
          <span className="cardrow__sub">{rateText(s)}</span>
        </div>
        <span className="suggest__match" title="How good a match the app thinks it is">
          {s.match}% match
        </span>
      </div>
      {s.description && <p className="suggest__desc">{s.description}</p>}
      <div className="suggest__why">
        <span className="label" style={{ margin: 0 }}>
          Why you’re seeing this
        </span>
        {whyLines(s).map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      {s.why.topics.length > 0 && (
        <div className="pills">
          {s.why.topics.map((t) => (
            <Link key={t.tag} className="chip chip--tag" to={tagPath(t.label)}>
              {t.label}
            </Link>
          ))}
        </div>
      )}
      {s.samples.length > 0 && (
        <div className="suggest__samples">
          <span className="label" style={{ margin: 0 }}>
            Latest posts
          </span>
          {s.samples.map((p, i) =>
            p.url ? (
              <a key={i} href={p.url} target="_blank" rel="noreferrer noopener">
                {p.title}
              </a>
            ) : (
              <span key={i}>{p.title}</span>
            ),
          )}
        </div>
      )}
      {picking && (
        <div className="suggest__pick">
          <StartWithPicker value={startWith} onChange={setStartWith} />
        </div>
      )}
      <div className="suggest__actions">
        <button
          className="btn btn--primary"
          disabled={busy}
          onClick={() => {
            if (!picking) {
              setPicking(true);
              return;
            }
            setBusy(true);
            void onFollow(startWith).finally(() => setBusy(false));
          }}
        >
          {busy ? 'Following…' : picking ? 'Follow it' : 'Follow'}
        </button>
        {s.siteUrl && (
          <a className="btn btn--ghost" href={s.siteUrl} target="_blank" rel="noreferrer noopener">
            Visit site
          </a>
        )}
        <button className="btn btn--ghost suggest__no" aria-label={`Not interested in ${s.title}`} title="Not interested" onClick={onDismiss}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </article>
  );
}
