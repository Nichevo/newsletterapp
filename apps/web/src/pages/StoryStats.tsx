import type { StoryMatch, StoryStats } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { RangeSwitch } from '../components/BarChart';
import { tagPath } from '../components/TagChip';
import { StatsTabs } from '../components/StatsTabs';
import { agoText } from '../format';
import { IconBack } from '../icons';
import { useAppSettings } from './Settings';

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '–');
const MATCH_TEXT: Record<StoryMatch, string> = {
  loose: 'Loose: more links, some wrong ones',
  normal: 'Normal',
  strict: 'Strict: fewer links, only clear ones',
};

/** Statistics > Stories: how much of your reading joins stories, the busiest ones, and how the matching is doing. */
export function StoryStatsPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [data, setData] = useState<StoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const { settings, save } = useAppSettings();

  useEffect(() => {
    setData(null);
    api
      .storyStats(days, fresh > 0)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [days, fresh]);

  async function rebuild() {
    if (!window.confirm('Match every article into stories again? Stories you follow are lost, notes already written are kept. It works through older articles a minute at a time while your PC is on.')) return;
    setRebuilding(true);
    try {
      await api.rebuildStories();
      setFresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rebuild');
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Statistics</h1>
        </div>
      </header>
      <StatsTabs current="stories" />

      <div className="section">
        <RangeSwitch
          value={days}
          options={[
            [7, '7 days'],
            [30, '30 days'],
            [90, '90 days'],
          ]}
          onChange={setDays}
          label="Period"
        />
      </div>

      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="spinner">Loading…</div>}
      {data && (
        <>
          <div className="section">
            <span className="label">In the last {data.days} days</span>
            <section className="card">
              <div className="statgrid">
                <div className="stat">
                  <span className="label">Stories</span>
                  <strong>{data.active}</strong>
                  <span className="cardrow__sub">with new articles, {data.started} of them new</span>
                </div>
                <div className="stat">
                  <span className="label">In a story</span>
                  <strong>{pct(data.inStories, data.arrived)}</strong>
                  <span className="cardrow__sub">
                    {data.inStories} of {data.arrived} articles that arrived
                  </span>
                </div>
                <div className="stat">
                  <span className="label">Same news again</span>
                  <strong>{data.sameNews}</strong>
                  <span className="cardrow__sub">articles repeating news another source sent (grouped in the inbox)</span>
                </div>
                <div className="stat">
                  <span className="label">Following</span>
                  <strong>{data.followed}</strong>
                  <span className="cardrow__sub">{data.followedUnread} unread articles in them</span>
                </div>
              </div>
            </section>
          </div>

          <div className="section">
            <span className="label">Busiest stories</span>
            {data.top.length === 0 ? (
              <p className="hint">No stories yet. They form as your PC embeds new articles, and older ones are matched a minute at a time.</p>
            ) : (
              <div className="card card--list">
                {data.top.map((s) => (
                  <Link key={s.id} className="cardrow" to={`/story/${s.id}`}>
                    <div className="cardrow__main">
                      <span className="cardrow__title">{s.title}</span>
                      <span className="cardrow__sub">
                        {s.periodItems} new in the period · {s.items} in all from {s.sources} source{s.sources === 1 ? '' : 's'} · last {agoText(s.lastAt)}
                        {s.unread > 0 ? ` · ${s.unread} unread` : ''}
                        {s.followedAt ? ' · following' : ''}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="section">
            <span className="label">Story sizes</span>
            <section className="card">
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Articles in the story</th>
                      <th>Stories</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sizes.map((s) => (
                      <tr key={s.label}>
                        <td>{s.label}</td>
                        <td>{s.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="section">
            <span className="label">How the links are doing</span>
            <section className="card">
              <div className="statgrid">
                <div className="stat">
                  <span className="label">Links used</span>
                  <strong>{data.linkTaps}</strong>
                  <span className="cardrow__sub">taps on story banners, story pages and grouped rows</span>
                </div>
                <div className="stat">
                  <span className="label">Taken out</span>
                  <strong>{data.splits}</strong>
                  <span className="cardrow__sub">“Not part of this story” (a high number means matching is too loose)</span>
                </div>
                <div className="stat">
                  <span className="label">Near misses</span>
                  <strong>{data.nearMisses}</strong>
                  <span className="cardrow__sub">articles left out though their nearest one came within 0.06 of the line (a high number may mean too strict)</span>
                </div>
                <div className="stat">
                  <span className="label">Linked by hand</span>
                  <strong>{data.joins}</strong>
                  <span className="cardrow__sub">“Same story” under “Close, but not linked” (a high number means matching is too strict)</span>
                </div>
                <div className="stat">
                  <span className="label">PC notes</span>
                  <strong>{data.notes.done}</strong>
                  <span className="cardrow__sub">
                    {data.notes.done > 0 ? `${Math.round(data.notes.seconds / Math.max(data.notes.done, 1))}s each${data.notes.model ? ` with ${data.notes.model}` : ''}` : 'none yet'}
                    {data.notes.failed > 0 ? ` · ${data.notes.failed} failed` : ''}
                  </span>
                </div>
                <div className="stat">
                  <span className="label">Waiting</span>
                  <strong>{data.matchWaiting + data.notes.waiting}</strong>
                  <span className="cardrow__sub">
                    {data.matchWaiting >= 1000 ? '1000+' : data.matchWaiting} to match, {data.notes.waiting} notes for the PC
                  </span>
                </div>
              </div>
            </section>
          </div>

          <div className="section">
            <span className="label">Learnt from you</span>
            <section className="card">
              {data.learnt.length === 0 ? (
                <p className="hint" style={{ margin: 0 }}>
                  Nothing yet. Each “Same story” lowers the meaning line a little for the tags the two articles share and their sources; each “Not part of
                  this story” raises it for that article’s source and the tags it shared with the story. Only those tags and sources change, not everything.
                </p>
              ) : (
                <>
                  <div className="tablewrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Tag or source</th>
                          <th>Linked</th>
                          <th>Taken out</th>
                          <th>Line</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.learnt.map((t) => (
                          <tr key={`${t.kind}:${t.key}`}>
                            <td>
                              {t.kind === 'tag' ? <Link to={tagPath(t.label)}>{t.label}</Link> : <Link to={`/source/${t.key}`}>{t.label}</Link>}
                              <span className="muted"> · {t.kind}</span>
                              {t.specific && <span className="muted"> · now counts as specific</span>}
                            </td>
                            <td>{t.links}</td>
                            <td>{t.splits}</td>
                            <td>{t.shift === 0 ? 'unchanged' : t.shift < 0 ? `${t.shift.toFixed(2)} looser` : `+${t.shift.toFixed(2)} stricter`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <span className="hint">
                    Each net link moves the line 0.01 lower (at most 0.06), each net take-out 0.01 higher (at most 0.04). A broad tag you link on twice starts
                    counting as specific. New articles use this; Rebuild applies it to older ones.
                  </span>
                  <div>
                    <button
                      className="btn btn--small btn--ghost"
                      onClick={() => {
                        if (!window.confirm('Forget what matching learnt from your links and take-outs?')) return;
                        void api.resetStoryLearnt().then(() => setFresh((n) => n + 1));
                      }}
                    >
                      Forget what it learnt
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>

          {data.lookAlike.length > 0 && (
            <div className="section">
              <span className="label">Sources whose posts look alike</span>
              <section className="card">
                <div className="tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Usually</th>
                        <th>Two of its posts need</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lookAlike.map((s) => (
                        <tr key={s.key}>
                          <td>
                            <Link to={`/source/${s.key}`}>{s.label}</Link>
                            {s.everyday.length > 0 && <span className="muted"> · ignores {s.everyday.join(', ')}</span>}
                          </td>
                          <td>{s.base.toFixed(2)}</td>
                          <td>{s.line.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <span className="hint">
                  Learnt as articles are matched: how close a source’s new post usually is to its last one. Two posts from it only join a story when they are
                  clearly closer than that, and tags it puts on most posts don’t count. Other sources use the normal line.
                </span>
              </section>
            </div>
          )}

          {settings && (
            <div className="section">
              <span className="label">Matching</span>
              <section className="card">
                <p className="hint" style={{ margin: 0 }}>
                  Articles join a story when your PC rates them close in meaning and they share a specific tag (broad tags like “AI” don’t count), or
                  when they are very close on their own within a week. The same news from another source within two days is grouped in the inbox.
                  Articles that only share a tag aren’t linked; the story banner points to the tag page instead. Open a story and tap “Why these are
                  linked” to see what joined each article.
                </p>
                <div className="segmented" role="group" aria-label="How strict matching is">
                  {(['loose', 'normal', 'strict'] as StoryMatch[]).map((m) => (
                    <button key={m} aria-pressed={settings.stories.match === m} onClick={() => void save({ stories: { ...settings.stories, match: m } })}>
                      {m[0]!.toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
                <span className="hint">
                  {MATCH_TEXT[settings.stories.match]}. A change applies to new articles; Rebuild matches everything again with it.
                </span>
                <div>
                  <button className="btn btn--small btn--ghost" disabled={rebuilding} onClick={() => void rebuild()}>
                    {rebuilding ? 'Starting…' : 'Rebuild stories'}
                  </button>
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
