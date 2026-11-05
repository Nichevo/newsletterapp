import type { StoryPage as Story } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { storyTap, Timeline } from '../components/StoryBanner';
import { tagPath } from '../components/TagChip';
import { IconBack } from '../icons';
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
                close on their own. Change how strict this is in Statistics &gt; Stories.
              </p>
            )}
            <section className="card">
              <Timeline steps={story.steps} showWhy={why} onOpen={(s) => storyTap(s.id)} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
