import type { StoryBanner as Banner, StoryStep } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, isPhone } from '../api';
import { agoText, shortTime } from '../format';
import { IconChevron } from '../icons';
import { tagPath } from './TagChip';

/** Counts a tap on a story link, for Statistics > Stories (how often the links get used). */
export function storyTap(itemId: string) {
  api.event(itemId, { type: 'story_link', device: isPhone() });
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * The story banner at the top of an article: which story it's part of, what this item
 * adds since you last read about it, and the unread items on it. Tapping the title row
 * opens the earlier steps, the same news from other sources and broader tag links.
 */
export function StoryBanner({ itemId, onSplit }: { itemId: string; onSplit?: () => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Banner | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setOpen(false);
    api
      .storyBanner(itemId)
      .then((b) => !cancelled && setData(b))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (!data) return null;
  const { story, lastRead, note } = data;
  const unread = data.unreadIds.length;

  async function split() {
    if (!window.confirm('Take this article out of the story? It won’t be put in a story again.')) return;
    await api.splitFromStory(itemId).catch(() => undefined);
    setData(null);
    onSplit?.();
  }

  return (
    <section className="sbanner" aria-label="Story">
      <button type="button" className="sbanner__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
          <path d="M7 12h3M14 12h3" />
        </svg>
        <span className="sbanner__titles">
          <span className="sbanner__title">{story.title}</span>
          <span className="sbanner__sub">
            Story · {story.items} items since {day(story.firstAt)}
            {data.read > 0 ? ` · you read ${data.read}${lastRead?.readAt ? `, last ${agoText(lastRead.readAt)}` : ''}` : ''}
            {story.followedAt ? ' · following' : ''}
          </span>
        </span>
        <IconChevron style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {(note || data.notePending) && (
        <div className="sbanner__new">
          <span className="label">{lastRead ? 'New since you last read' : 'What this adds'}</span>
          {note ? (
            <p>
              {lastRead && (
                <>
                  Last time ({day(lastRead.readAt ?? lastRead.receivedAt)}
                  {lastRead.sourceName ? `, ${lastRead.sourceName}` : ''}): {lastRead.subject}.{' '}
                </>
              )}
              <strong>New here:</strong> {note}
            </p>
          ) : (
            <p className="muted">Your PC is writing this…</p>
          )}
        </div>
      )}

      {unread > 0 && (
        <div className="sbanner__unread">
          <span>
            You also have <strong>{unread} unread</strong> on this story
          </span>
          <Link
            className="btn btn--small"
            to={`/story/${story.id}`}
            onClick={() => storyTap(itemId)}
          >
            Read together
          </Link>
        </div>
      )}

      {open && (
        <div className="sbanner__more">
          {data.earlier.length > 0 && (
            <div className="sbanner__part">
              <span className="sbanner__parthead">Earlier in this story</span>
              <Timeline steps={data.earlier} onOpen={(s) => storyTap(s.id)} />
            </div>
          )}
          {data.sameNews.length > 0 && (
            <div className="sbanner__part">
              <span className="sbanner__parthead">Same news, other sources</span>
              <div className="pills">
                {data.sameNews.map((s) => (
                  <Link key={s.id} className="chip chip--outline sbanner__source" to={`/item/${s.id}`} onClick={() => storyTap(s.id)}>
                    {s.sourceName ?? s.subject}
                    {!s.readAt && ' · unread'}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {data.tags.length > 0 && (
            <div className="sbanner__part">
              <span className="sbanner__parthead">Broader reading (shares a tag, not this story)</span>
              <div className="pills">
                {data.tags.slice(0, 4).map((t) => (
                  <Link key={t.tag} className="chip chip--tag" to={tagPath(t.label)}>
                    More on {t.label} <span className="chip__n">{t.n}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div className="sbanner__actions">
            <button type="button" className="btn btn--ghost btn--small" onClick={() => void split()}>
              Not part of this story
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                storyTap(itemId);
                navigate(`/story/${story.id}`);
              }}
            >
              Whole story
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Story steps as a timeline: date, dot (filled = read), headline, source and what each added. */
export function Timeline({ steps, current, onOpen, showWhy }: { steps: StoryStep[]; current?: string; onOpen?: (s: StoryStep) => void; showWhy?: boolean }) {
  return (
    <ol className="timeline">
      {steps.map((s) => (
        <li key={s.id} className={`timeline__step${s.id === current ? ' timeline__step--current' : ''}${s.readAt ? '' : ' timeline__step--unread'}`}>
          <span className="timeline__date">{shortTime(s.receivedAt)}</span>
          <span className="timeline__dot" aria-hidden="true" />
          <span className="timeline__body">
            <Link to={`/item/${s.id}`} onClick={() => onOpen?.(s)}>
              {s.subject}
            </Link>
            <span className="timeline__meta">
              {s.sourceName ?? ''}
              {s.sourceName ? ' · ' : ''}
              {s.id === current ? 'reading now' : s.readAt ? 'read' : <strong className="timeline__unread">unread</strong>}
              {s.savedAt ? ' · saved' : ''}
            </span>
            {(s.note ?? s.summary) && <span className="timeline__note">{s.note ? `Added: ${s.note}` : s.summary}</span>}
            {showWhy && <span className="timeline__why">{whyText(s)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "Same news as another source · meaning 0.88 · shares Nuvia", or how the story started. */
export function whyText(s: StoryStep): string {
  if (!s.why) return 'Started the story';
  const parts = [s.why.kind === 'news' ? 'Same news as another source' : 'Later step', `meaning ${s.why.sim.toFixed(2)}`];
  if (s.why.tags.length) parts.push(`shares ${s.why.tags.join(', ')}`);
  return parts.join(' · ');
}
