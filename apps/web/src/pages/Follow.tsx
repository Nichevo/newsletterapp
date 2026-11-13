import {
  FOLLOW_VIA_LABEL,
  type FollowCandidate,
  type FollowLookup,
  type FollowLookupListItem,
  type FollowThing,
} from '@newsletterapp/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { relativeTime } from '../format';
import { IconBack, IconCopy } from '../icons';
import { useVisiblePolling } from '../poll';
import { StartWithPicker } from './Add';

// Find a way to follow: the form (on Add and on the lookups page), the list of
// past lookups, and one lookup's results.

const THING_LABEL: Record<FollowThing['kind'], string> = {
  person: 'person',
  org: 'organisation',
  site: 'site',
  topic: 'topic',
  subreddit: 'subreddit',
};

/** The search box: a name, @handle, site, topic or link. Starts a lookup and opens it. */
export function FindForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const url = q.match(/https?:\/\/\S+/)?.[0] ?? null;
      const lookup = await api.followStart(q, url);
      navigate(`/follow/${lookup.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the lookup');
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="find-follow">Who or what</label>
        <input
          id="find-follow"
          className="input"
          placeholder="Name, @handle, site, topic or link"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          autoFocus={autoFocus}
        />
      </div>
      <button className="btn btn--primary" disabled={busy || !text.trim()} type="submit">
        {busy ? 'Starting…' : 'Find ways to follow'}
      </button>
      <span className="hint" style={{ margin: 0 }}>
        Your PC looks for their blog, newsletter, Substack, GitHub, YouTube and Bluesky, and for news and posts about a topic. It checks each one works
        before listing it. Uses a few web searches from your monthly budget.
      </span>
      {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
    </form>
  );
}

function statusLine(l: { status: FollowLookupListItem['status']; found: number; followed: number }): string {
  switch (l.status) {
    case 'understanding':
    case 'searching':
      return 'Your PC is looking…';
    case 'confirm':
      return 'Pick what to look for';
    case 'failed':
      return "Couldn't finish";
    default:
      return `${l.found} way${l.found === 1 ? '' : 's'} found${l.followed ? `, ${l.followed} followed` : ''}`;
  }
}

/** Settings > Your sources > Find a way to follow: the form and past lookups. */
export function FollowListPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<FollowLookupListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .followLookups()
      .then(setList)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Find a way to follow</h1>
        </div>
      </header>
      <div className="section">
        <FindForm />
      </div>
      {error && <div className="error">{error}</div>}
      {list && list.length > 0 && (
        <div className="section">
          <span className="label">Past lookups</span>
          <div className="card card--list">
            {list.map((l) => (
              <Link key={l.id} to={`/follow/${l.id}`} className="cardrow">
                <div className="cardrow__main">
                  <span className="cardrow__title">{l.query}</span>
                  <span className="cardrow__sub">
                    {statusLine(l)} · {relativeTime(l.createdAt)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function rateText(c: FollowCandidate): string {
  const parts: string[] = [];
  if (c.lastPostAt) parts.push(`Last post ${relativeTime(c.lastPostAt)}`);
  if (c.postsPerWeek !== null) {
    parts.push(
      c.postsPerWeek >= 7
        ? `~${Math.round(c.postsPerWeek / 7)} a day`
        : c.postsPerWeek >= 1
          ? `~${Math.round(c.postsPerWeek)} a week`
          : `~${Math.max(1, Math.round(c.postsPerWeek * 4.3))} a month`,
    );
  }
  return parts.join(' · ');
}

const DAY = 86_400_000;

function CandidateCard({ lookupId, c, onChange }: { lookupId: string; c: FollowCandidate; onChange: (c: FollowCandidate) => void }) {
  const [picking, setPicking] = useState(false);
  const [startWith, setStartWith] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stale = c.lastPostAt !== null && Date.now() - c.lastPostAt > 90 * DAY;

  async function mark(state: 'new' | 'followed' | 'dismissed', sourceId?: string | null) {
    onChange(await api.followCandidate(lookupId, c.key, state, sourceId));
  }

  async function follow() {
    setBusy(true);
    setError(null);
    try {
      let sourceId: string | null = null;
      try {
        const r = c.feedUrl
          ? await api.addSource({
              kind: 'feed',
              url: c.url,
              feedUrl: c.feedUrl,
              name: c.title,
              startWith,
              ...(c.viaPc ? { fetchVia: 'pc' as const } : {}),
              ...(c.group === 'topic' ? { dailyCap: 10 } : {}),
            })
          : await api.addSource({ kind: 'site', url: c.url, name: c.title, startWith });
        sourceId = r.source.id;
      } catch (err) {
        // Already followed under this address: just mark it.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
      }
      await mark('followed', sourceId);
      setPicking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not follow it');
    } finally {
      setBusy(false);
    }
  }

  /** A newsletter with no feed: a new address of its own, copied, and its sign-up page. */
  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const a = await api.createAddress(c.title.slice(0, 60));
      setAddress(a.email);
      await navigator.clipboard?.writeText(a.email).then(
        () => setCopied(true),
        () => undefined,
      );
      await mark('followed', null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make an address');
    } finally {
      setBusy(false);
    }
  }

  const dim = c.state === 'dismissed';
  return (
    <article className="card suggest" aria-label={c.title} style={dim ? { opacity: 0.6 } : undefined}>
      <div className="suggest__head">
        <div className="cardrow__main">
          <span className="cardrow__title" style={{ fontWeight: 600 }}>
            {c.title}
          </span>
          <span className="inline" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="chip chip--outline">{c.watch ? 'Website, no feed' : FOLLOW_VIA_LABEL[c.via]}</span>
            {c.same === 'high' && <span className="chip chip--newsletter">Same person: sure</span>}
            {c.same === 'medium' && <span className="chip chip--warn">Same person: likely</span>}
            {c.same === 'low' && <span className="chip chip--warn">Not sure it's them</span>}
          </span>
        </div>
      </div>
      {c.why && <p className="suggest__desc">{c.why}</p>}
      {(c.lastPostAt || c.postsPerWeek !== null) && (
        <span className={stale ? 'error' : 'hint'} style={{ margin: 0 }}>
          {rateText(c)}
          {stale ? '. Quiet for a while.' : ''}
        </span>
      )}
      {c.samples.length > 0 && (
        <div className="suggest__samples">
          {c.samples.map((p, i) =>
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
      {address && (
        <div className="addressbox">
          <strong>{address}</strong>
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => undefined)}
          >
            <IconCopy size={16} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {address && c.signupUrl && (
        <p className="hint" style={{ margin: 0 }}>
          Paste it into the sign-up form.{' '}
          <a href={c.signupUrl} target="_blank" rel="noreferrer noopener">
            Open the sign-up page
          </a>
          . The confirmation email appears in your inbox here.
        </p>
      )}
      {picking && (
        <div className="suggest__pick">
          <StartWithPicker value={startWith} onChange={setStartWith} />
        </div>
      )}
      {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
      <div className="suggest__actions">
        {c.group === 'cant' ? (
          <a className="btn btn--ghost" href={c.url} target="_blank" rel="noreferrer noopener">
            Open
          </a>
        ) : c.state === 'already' ? (
          c.sourceId ? (
            <Link className="btn btn--ghost" to={`/source/${c.sourceId}`}>
              You follow this
            </Link>
          ) : (
            <span className="hint">You follow this</span>
          )
        ) : c.state === 'followed' ? (
          <>
            {c.sourceId ? (
              <Link className="btn" to={`/?source=${c.sourceId}`}>
                ✓ Following: show posts
              </Link>
            ) : (
              <span className="btn btn--ghost" aria-disabled="true">
                ✓ {c.via === 'newsletter' ? 'Address made' : 'Following'}
              </span>
            )}
          </>
        ) : c.state === 'dismissed' ? (
          <button className="btn btn--ghost" onClick={() => void mark('new')}>
            Undo Not now
          </button>
        ) : (
          <>
            {c.feedUrl || c.watch ? (
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={() => {
                  if (!picking) setPicking(true);
                  else void follow();
                }}
              >
                {busy ? 'Following…' : picking ? 'Follow it' : c.watch ? 'Watch page' : c.group === 'topic' ? 'Watch topic' : 'Follow'}
              </button>
            ) : c.signupUrl ? (
              <button className="btn btn--primary" disabled={busy} onClick={() => void subscribe()}>
                {busy ? 'Making an address…' : 'Subscribe by email'}
              </button>
            ) : null}
            <a className="btn btn--ghost" href={c.url} target="_blank" rel="noreferrer noopener">
              Visit
            </a>
            <button className="btn btn--ghost" onClick={() => void mark('dismissed')}>
              Not now
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function ThingPicker({ things, onChange }: { things: FollowThing[]; onChange: (t: FollowThing[]) => void }) {
  return (
    <div className="card card--list">
      {things.map((t, i) => (
        <label key={`${t.kind}:${t.name}`} className="switchrow" style={{ padding: '10px 14px' }}>
          <span style={{ fontSize: 15 }}>
            {t.name}
            {t.handle && t.handle.toLowerCase() !== t.name.toLowerCase() ? ` · @${t.handle}` : ''}
            <span className="hint" style={{ margin: 0, display: 'block' }}>
              {THING_LABEL[t.kind]}
            </span>
          </span>
          <input type="checkbox" checked={t.on} onChange={(e) => onChange(things.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
        </label>
      ))}
    </div>
  );
}

/** /follow/:id: one lookup, while the PC works on it and once it has finished. */
export function FollowLookupPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [lookup, setLookup] = useState<FollowLookup | null>(null);
  const [things, setThings] = useState<FollowThing[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const working = lookup?.status === 'understanding' || lookup?.status === 'searching';
  const refresh = useCallback(() => {
    api
      .followLookup(id)
      .then((l) => {
        setLookup(l);
        setThings((cur) => (cur.length && editing ? cur : l.things));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [id, editing]);
  // Every few seconds while the PC works on it; once when it's done.
  useVisiblePolling(refresh, lookup === null || working ? 4000 : null);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      setLookup(await api.followThings(id, things));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the search');
    } finally {
      setBusy(false);
    }
  }

  async function again() {
    setBusy(true);
    try {
      setLookup(await api.followAgain(id));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await api.followDelete(id);
    navigate('/settings/sources/follow', { replace: true });
  }

  const update = (c: FollowCandidate) => setLookup((cur) => (cur ? { ...cur, candidates: cur.candidates.map((x) => (x.key === c.key ? c : x)) } : cur));
  const helperAway = lookup?.helperLastSeenAt !== undefined && (!lookup.helperLastSeenAt || Date.now() - lookup.helperLastSeenAt > 5 * 60_000);
  const groups = lookup
    ? ([
        ['best', 'Best ways to follow'],
        ['topic', 'Topic watches'],
        ['cant', "Can't follow here"],
      ] as const)
        .map(([g, label]) => ({ label, list: lookup.candidates.filter((c) => c.group === g) }))
        .filter((g) => g.list.length > 0)
    : [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Ways to follow</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!lookup && !error && <div className="spinner">Loading…</div>}
      {lookup && (
        <>
          <div className="section">
            <span className="label">You asked about</span>
            <div className="card">
              <span style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{lookup.query}</span>
            </div>
          </div>

          {working && (
            <div className="notice notice--teal">
              <div className="notice__text">
                <span className="notice__title">
                  {lookup.status === 'understanding' ? 'Your PC is working out who and what this is about…' : 'Your PC is looking for ways to follow…'}
                </span>
                <span className="notice__sub">
                  {lookup.aiPaused
                    ? 'AI is paused in Settings > PC helper and AI, so the PC won’t start until you resume it.'
                    : helperAway
                      ? 'Your PC hasn’t checked in for a while. It starts as soon as it’s back on.'
                      : 'Usually a minute or two. You can leave this page; the results are kept under Settings > Your sources > Find a way to follow.'}
                </span>
              </div>
            </div>
          )}

          {lookup.status === 'confirm' && (
            <div className="section">
              <span className="label">What your PC found · untick anything you don't want</span>
              <ThingPicker things={things} onChange={setThings} />
              <button className="btn btn--primary" style={{ marginTop: 12 }} disabled={busy || !things.some((t) => t.on)} onClick={() => void search()}>
                {busy ? 'Starting…' : 'Find ways to follow'}
              </button>
            </div>
          )}

          {lookup.status === 'failed' && (
            <div className="section">
              <div className="error">{lookup.error ?? "Couldn't finish this lookup."}</div>
              <button className="btn" disabled={busy} onClick={() => void again()}>
                Try again
              </button>
            </div>
          )}

          {lookup.status === 'done' && (
            <div className="section">
              <span className="label">Looked for</span>
              {editing ? (
                <>
                  <ThingPicker things={things} onChange={setThings} />
                  <div className="inline" style={{ marginTop: 12 }}>
                    <button className="btn btn--primary" disabled={busy || !things.some((t) => t.on)} onClick={() => void search()}>
                      Look again
                    </button>
                    <button
                      className="btn btn--ghost"
                      onClick={() => {
                        setThings(lookup.things);
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="pills" style={{ alignItems: 'center' }}>
                  {lookup.things
                    .filter((t) => t.on)
                    .map((t) => (
                      <span key={`${t.kind}:${t.name}`} className="chip chip--category">
                        {t.name} · {THING_LABEL[t.kind]}
                      </span>
                    ))}
                  <button className="btn btn--ghost btn--small" onClick={() => setEditing(true)}>
                    Change
                  </button>
                </div>
              )}
            </div>
          )}

          {lookup.status === 'done' && groups.length === 0 && (
            <div className="empty">
              <h2>Nothing found</h2>
              <p>Your PC couldn't find a working way to follow this. Try a fuller name, an @handle, or a link to something they wrote.</p>
            </div>
          )}

          {groups.map((g) => (
            <div key={g.label} className="section">
              <span className="label">{g.label}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {g.list.map((c) => (
                  <CandidateCard key={c.key} lookupId={lookup.id} c={c} onChange={update} />
                ))}
              </div>
            </div>
          ))}

          {lookup.status === 'done' && (
            <div className="section">
              <span className="hint">
                Checked {lookup.finishedAt ? relativeTime(lookup.finishedAt) : ''} by your PC
                {lookup.model ? ` with ${lookup.model}` : ''} · {lookup.searches} web search{lookup.searches === 1 ? '' : 'es'} used
              </span>
              <div className="inline" style={{ marginTop: 8 }}>
                <button className="btn btn--ghost btn--small" disabled={busy} onClick={() => void again()}>
                  Check again
                </button>
                <button className="btn btn--ghost btn--small" onClick={() => void remove()}>
                  Delete this lookup
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
