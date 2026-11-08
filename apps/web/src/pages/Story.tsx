import { markdownToHtml, type StoryList, type StoryOverview, type StoryPage as Story } from '@newsletterapp/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { storyTap, Timeline } from '../components/StoryBanner';
import { tagPath } from '../components/TagChip';
import { IconBack } from '../icons';
import { agoText } from '../format';
import { SavedTabs } from './Highlights';
import { rememberList } from '../readingList';

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A story's page: what it's about so far, Follow, and every item in it as a timeline. */
export function StoryPagePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);

  useEffect(() => {
    setStory(null);
    api
      .story(id)
      .then(setStory)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the story'));
  }, [id]);

  /** "Unlink": takes one article out of the story, and matching gets a little stricter for its source and tags. */
  async function unlink(step: Story['steps'][number]) {
    if (!story) return;
    if (!window.confirm(`Take “${step.subject}” out of this story? It won’t be put in a story again, and matching gets a little stricter for its source and the tags it shared with the story.`)) return;
    try {
      await api.splitFromStory(step.id);
      const fresh = await api.story(story.id).catch(() => null);
      if (fresh) setStory(fresh);
      else {
        setStory(null);
        setError('That left one article, so the story was taken apart.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink it');
    }
  }

  async function follow(on: boolean) {
    if (!story) return;
    setStory({ ...story, followedAt: on ? Date.now() : null });
    await api.followStory(story.id, on).catch(() => setStory(story));
  }

  /** Opens the oldest unread item, with the story's unread items as the reader's next/previous list. */
  function readUnread() {
    if (!story) return;
    const unread = story.steps.filter((s) => !s.readAt).sort((a, b) => a.receivedAt - b.receivedAt);
    if (!unread.length) return;
    rememberList(unread.map((s) => s.id));
    storyTap(unread[0]!.id);
    navigate(`/item/${unread[0]!.id}`);
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Story</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!story && !error && <div className="spinner">Loading…</div>}
      {story && (
        <>
          <div className="storypage__head">
            <h2>{story.title}</h2>
            {story.summary && <p>{story.summary}</p>}
            {story.tags.length > 0 && (
              <div className="pills">
                {story.tags.map((t) => (
                  <Link key={t.tag} className="chip chip--tag" to={tagPath(t.label)}>
                    {t.label}
                  </Link>
                ))}
              </div>
            )}
            <span className="cardrow__sub">
              {story.items} items from {story.sources} source{story.sources === 1 ? '' : 's'} · {day(story.firstAt)} to {day(story.lastAt)} · you
              read {story.read}
            </span>
            <div className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button className={`btn btn--small${story.followedAt ? '' : ' btn--ghost'}`} aria-pressed={Boolean(story.followedAt)} onClick={() => void follow(!story.followedAt)}>
                {story.followedAt ? 'Following' : 'Follow story'}
              </button>
              {story.unread > 0 && (
                <button className="btn btn--small btn--ghost" onClick={readUnread}>
                  Read the {story.unread} unread in order
                </button>
              )}
            </div>
            {story.followedAt && <span className="hint">New items in this story are marked “Update to a story you follow” in the inbox.</span>}
          </div>

          <Overview storyId={story.id} overview={story.overview} onChange={(o) => setStory((cur) => (cur ? { ...cur, overview: o } : cur))} />

          <div className="section">
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <span className="label">Timeline</span>
              <button className="btn btn--ghost btn--small" aria-pressed={why} onClick={() => setWhy((v) => !v)}>
                {why ? 'Hide why linked' : 'Why these are linked'}
              </button>
            </div>
            {why && (
              <p className="hint">
                Meaning is how close your PC rates two items (0 to 1). Items join a story when they are close in meaning and share a specific tag, or are very
                close on their own. Change how strict this is in Statistics &gt; Stories. Unlink takes an article out if it doesn’t belong.
              </p>
            )}
            <section className="card">
              <Timeline steps={story.steps} showWhy={why} onOpen={(s) => storyTap(s.id)} onUnlink={(s) => void unlink(s)} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The PC's summary of the whole story: asked for with a button, or rewritten each time an
 * article joins when "Update it when new articles join" is on. Checks back while it's being written.
 */
function Overview({ storyId, overview, onChange }: { storyId: string; overview: StoryOverview | null; onChange: (o: StoryOverview) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const html = useMemo(() => (overview?.answer ? markdownToHtml(overview.answer) : ''), [overview?.answer]);
  const waiting = overview?.status === 'waiting';

  // While the PC is writing it, look again every 20 seconds for up to 10 minutes.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > 10 * 60_000) return window.clearInterval(timer);
      api
        .story(storyId)
        .then((s) => s.overview && s.overview.status !== 'waiting' && onChange(s.overview))
        .catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [waiting, storyId, onChange]);

  async function run(fn: () => Promise<StoryOverview>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ask the PC');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <span className="label">Whole-story summary</span>
      <section className="card">
        {html ? (
          // markdownToHtml escapes everything first; only its own few tags come out.
          <div className="note__answer" dangerouslySetInnerHTML={{ __html: html }} />
        ) : !waiting ? (
          <p className="hint" style={{ margin: 0 }}>
            Your PC can write an overview of every article in this story: what it’s about, the key steps in order, and where it stands now.
          </p>
        ) : null}
        {waiting && <p className="muted" style={{ margin: 0 }}>{html ? 'Your PC is writing a newer one…' : 'Your PC is writing this…'}</p>}
        {overview?.status === 'failed' && <p className="error" style={{ margin: 0 }}>{overview.error ?? 'The PC could not write it.'}</p>}
        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        {overview?.doneAt && html && (
          <span className="cardrow__sub">
            Written {agoText(overview.doneAt)}
            {overview.model ? ` by ${overview.model}` : ''}
          </span>
        )}
        <div className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn--small btn--ghost" disabled={busy || waiting} onClick={() => void run(() => api.summariseStory(storyId))}>
            {html || overview?.status === 'failed' ? 'Write it again' : 'Summarise the whole story'}
          </button>
        </div>
        <label className="switchrow">
          <span style={{ fontSize: 14 }}>Update it when new articles join</span>
          <input
            type="checkbox"
            checked={Boolean(overview?.auto)}
            disabled={busy}
            onChange={(e) => void run(() => api.storySummaryAuto(storyId, e.target.checked))}
          />
        </label>
      </section>
    </div>
  );
}

/** Saved > Stories: the stories you follow, then other recent ones. */
export function StoriesPage() {
  const [list, setList] = useState<StoryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    api
      .stories()
      .then(setList)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load stories'));
  }, []);

  const pick = (rows: StoryList['recent']) => (unreadOnly ? rows.filter((s) => s.unread > 0) : rows);
  const row = (s: StoryList['recent'][number]) => (
    <Link key={s.id} className="cardrow" to={`/story/${s.id}`}>
      <div className="cardrow__main">
        <span className="cardrow__title">{s.title}</span>
        <span className="cardrow__sub">
          {s.items} items from {s.sources} source{s.sources === 1 ? '' : 's'} · updated {agoText(s.lastAt)}
          {s.unread > 0 ? ` · ${s.unread} unread` : ' · all read'}
        </span>
      </div>
    </Link>
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <span className="topbar__eyebrow">Articles about the same chain of events</span>
          <h1>Stories</h1>
        </div>
      </header>
      <SavedTabs current="stories" />
      <div className="section">
        <div className="pills">
          <button className="pill" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
            All
          </button>
          <button className="pill" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
            With unread
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!list && !error && <div className="spinner">Loading…</div>}
      {list && (
        <>
          <div className="section">
            <span className="label">Following</span>
            {pick(list.followed).length ? (
              <div className="card card--list">{pick(list.followed).map(row)}</div>
            ) : (
              <p className="hint">
                {list.followed.length ? 'Nothing unread in the stories you follow.' : 'Tap Follow story on a story page to keep it here and flag its new articles in the inbox.'}
              </p>
            )}
          </div>
          <div className="section">
            <span className="label">Recent stories</span>
            {pick(list.recent).length ? (
              <div className="card card--list">{pick(list.recent).map(row)}</div>
            ) : (
              <p className="hint">{list.recent.length
                  ? 'Nothing unread in recent stories.'
                  : list.followed.length
                    ? 'No other recent stories.'
                    : 'No stories yet. They form as your PC matches new articles.'}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
