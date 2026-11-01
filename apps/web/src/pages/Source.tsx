import type { AiMode, AppSettings, DiscoverResult, FullTextMode, Source, SourceUpdate } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconBack } from '../icons';
import { StartWithPicker } from './Add';

const AI_LABEL: Record<AiMode, string> = { default: 'Default', on: 'On', off: 'Off' };

/** How far back to summarise when AI is switched on: 0 = new items only. */
const BACKDATE: { value: number | 'all'; label: string }[] = [
  { value: 0, label: 'New items only' },
  { value: 1, label: 'Last day' },
  { value: 3, label: 'Last 3 days' },
  { value: 7, label: 'Last week' },
  { value: 30, label: 'Last month' },
  { value: 'all', label: 'Everything in the inbox' },
];

const FULL_TEXT_LABEL: Record<FullTextMode, string> = { auto: 'Teasers only', always: 'Always', never: 'Never' };
const EVERY: { minutes: number; label: string }[] = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: 'Daily' },
];

/** One source's settings: its usual category, whether it goes to the AI, and for feeds and websites how they are fetched. */
export function SourcePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [source, setSource] = useState<Source | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** A mode that would switch AI on, waiting for how far back to go. */
  const [turningOn, setTurningOn] = useState<AiMode | null>(null);

  async function bulk(action: 'read-all' | 'archive-all') {
    if (!source) return;
    if (action === 'archive-all' && !window.confirm(`Archive everything from ${source.name} in your inbox?`)) return;
    try {
      const r = await api.sourceBulk(source.id, action);
      setDone(`${r.changed} item${r.changed === 1 ? '' : 's'} ${action === 'read-all' ? 'marked read' : 'archived'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  useEffect(() => {
    Promise.all([api.sources(), api.settings()])
      .then(([sources, s]) => {
        setSettings(s);
        const found = sources.find((x) => x.id === id);
        if (found) setSource(found);
        else setError('Source not found');
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [id]);

  async function update(patch: SourceUpdate) {
    if (!source) return;
    const before = source;
    const { paused, ...rest } = patch;
    setSource({ ...source, ...rest, ...(paused === undefined ? {} : { pausedAt: paused ? Date.now() : null }) });
    try {
      setSource(await api.updateSource(source.id, patch));
    } catch (err) {
      setSource(before);
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  async function checkNow() {
    if (!source) return;
    setDone('Checking…');
    try {
      const r = await api.checkSource(source.id);
      setSource(r.source);
      setDone(
        r.waitingForPc
          ? 'Queued for your PC; it checks within a minute or two when the PC is on.'
          : r.source.lastError
            ? `Check failed: ${r.source.lastError}`
            : `${r.added} new post${r.added === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      setDone(null);
      setError(err instanceof Error ? err.message : 'Check failed');
    }
  }

  const kindDefault = source && settings ? source.kind !== 'ai' ? settings.aiByKind[source.kind] : false : null;
  const aiOn = (m: AiMode) => m === 'on' || (m === 'default' && kindDefault === true);
  const isWeb = source?.kind === 'feed' || source?.kind === 'site';
  const noun = source?.kind === 'newsletter' ? 'issue' : 'post';
  const categories = settings?.categories ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>{source?.name ?? 'Source'}</h1>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {source && (
        <>
          <div className="section">
            <span className="hint">
              {source.itemCount} {noun}{source.itemCount === 1 ? '' : 's'}
              {source.lastReceivedAt ? ` · last ${shortTime(source.lastReceivedAt)}` : ''}
              {source.senderEmail ? ` · ${source.senderEmail}` : ''}
              {source.unsubscribedAt ? ` · unsubscribed ${shortTime(source.unsubscribedAt)}` : ''}
              {source.pausedAt ? ` · paused since ${shortTime(source.pausedAt)}` : ''}
            </span>
            <div className="inline">
              <Link to={`/?source=${source.id}`} className="btn btn--small">
                Show {noun}s
              </Link>
              <button className="btn btn--small" onClick={() => void bulk('read-all')}>
                Mark all read
              </button>
              <button className="btn btn--small" onClick={() => void bulk('archive-all')}>
                Archive all
              </button>
              <button className="btn btn--small" onClick={() => void update({ paused: !source.pausedAt })}>
                {source.pausedAt ? 'Resume' : 'Pause'}
              </button>
            </div>
            <span className="hint">
              {source.pausedAt
                ? source.kind === 'newsletter'
                  ? 'Paused: new issues are kept but go straight to Archived. Nothing is deleted.'
                  : 'Paused: not checked for new posts. Nothing is deleted.'
                : `Pause keeps everything you already have and stops new ${noun}s reaching your inbox until you resume.`}
            </span>
            {done && <span className="hint">{done}</span>}
          </div>

          <div className="section">
            <span className="label">Category</span>
            <section className="card">
              <select
                className="input"
                value={source.category ?? ''}
                onChange={(e) => void update({ category: e.target.value || null })}
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
                {source.category && !categories.includes(source.category) && <option>{source.category}</option>}
              </select>
              <span className="hint">Applies to everything from this source, old and new, unless a keyword rule matches.</span>
            </section>
          </div>

          <div className="section">
            <span className="label">AI summaries</span>
            <section className="card">
              <div className="segmented" role="group" aria-label="AI summaries">
                {(Object.keys(AI_LABEL) as AiMode[]).map((m) => (
                  <button
                    key={m}
                    aria-pressed={(turningOn ?? source.aiMode) === m}
                    onClick={() => {
                      // Switching AI on asks how far back to go first; anything else saves straight away.
                      if (!aiOn(source.aiMode) && aiOn(m)) setTurningOn(m);
                      else {
                        setTurningOn(null);
                        void update({ aiMode: m });
                      }
                    }}
                  >
                    {AI_LABEL[m]}
                  </button>
                ))}
              </div>
              {turningOn && (
                <div className="field">
                  <label>Summarise which items?</label>
                  <div className="inline" style={{ flexWrap: 'wrap' }}>
                    {BACKDATE.map((b) => (
                      <button
                        key={String(b.value)}
                        className={b.value === 0 ? 'btn btn--primary btn--small' : 'btn btn--small'}
                        onClick={() => {
                          setTurningOn(null);
                          void update({ aiMode: turningOn, aiBackdateDays: b.value });
                        }}
                      >
                        {b.label}
                      </button>
                    ))}
                    <button className="btn btn--ghost btn--small" onClick={() => setTurningOn(null)}>
                      Cancel
                    </button>
                  </div>
                  <span className="hint">Going back sends older posts to your PC too; new items only keeps the queue short.</span>
                </div>
              )}
              {!turningOn && aiOn(source.aiMode) && source.aiSince !== null && source.aiSince > 0 && (
                <span className="hint">Summarising items from {shortTime(source.aiSince)} on.</span>
              )}
              <span className="hint">
                Default follows Settings (currently {kindDefault ? 'on' : 'off'} for this kind of source). Off means this source
                only gets the quick summary and never goes to your PC.
              </span>
            </section>
          </div>

          {isWeb && <FetchSection source={source} onUpdate={(p) => void update(p)} onCheck={() => void checkNow()} />}
          {isWeb && (
            <FollowSection
              source={source}
              onFollow={async (p) => {
                await update(p);
                await checkNow();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/** How a feed or website is fetched, and how it went last time. */
function FetchSection({ source, onUpdate, onCheck }: { source: Source; onUpdate: (p: SourceUpdate) => void; onCheck: () => void }) {
  const [hint, setHint] = useState(source.linkHint ?? '');
  const minutes = source.checkMinutes ?? (source.kind === 'site' ? 180 : 60);
  return (
    <div className="section">
      <span className="label">{source.kind === 'site' ? 'Watching the page' : 'Feed'}</span>
      <section className="card">
        <span className="hint" style={{ margin: 0, wordBreak: 'break-all' }}>
          <a href={source.kind === 'site' ? (source.url ?? '#') : (source.feedUrl ?? '#')} target="_blank" rel="noopener noreferrer">
            {source.kind === 'site' ? source.url : source.feedUrl}
          </a>
        </span>
        <span className="hint" style={{ margin: 0 }}>
          {source.pausedAt
            ? 'Paused.'
            : source.lastCheckedAt
              ? `Last checked ${shortTime(source.lastCheckedAt)}${source.nextCheckAt ? `, next ${shortTime(source.nextCheckAt)}` : ''}.`
              : 'Not checked yet.'}
        </span>
        {source.lastError && (
          <div className="error" style={{ margin: 0 }}>
            {source.lastError}
            {source.errorCount > 1 ? ` (${source.errorCount} times in a row)` : ''}
          </div>
        )}
        <div className="inline">
          <button className="btn btn--small" onClick={onCheck} disabled={Boolean(source.pausedAt)}>
            Check now
          </button>
        </div>
      </section>

      <section className="card">
        <span className="label">Check every</span>
        <div className="segmented" role="group" aria-label="Check every">
          {EVERY.map((e) => (
            <button key={e.minutes} aria-pressed={minutes === e.minutes} onClick={() => onUpdate({ checkMinutes: e.minutes })}>
              {e.label}
            </button>
          ))}
        </div>
        {source.kind === 'feed' && (
          <>
            <span className="label">Fetched by</span>
            <div className="segmented" role="group" aria-label="Fetched by">
              <button aria-pressed={source.fetchVia === 'cloud'} onClick={() => onUpdate({ fetchVia: 'cloud' })}>
                Cloudflare
              </button>
              <button aria-pressed={source.fetchVia === 'pc'} onClick={() => onUpdate({ fetchVia: 'pc' })}>
                My PC
              </button>
            </div>
            <span className="hint" style={{ margin: 0 }}>
              Cloudflare checks feeds even when your PC is off. Use your PC for sites that turn Cloudflare away (the app switches
              on its own after three refusals in a row).
            </span>
            <span className="label">Full articles</span>
            <div className="segmented" role="group" aria-label="Full articles">
              {(Object.keys(FULL_TEXT_LABEL) as FullTextMode[]).map((m) => (
                <button key={m} aria-pressed={source.fullText === m} onClick={() => onUpdate({ fullText: m })}>
                  {FULL_TEXT_LABEL[m]}
                </button>
              ))}
            </div>
            <span className="hint" style={{ margin: 0 }}>
              For feeds that only carry the start of each post, your PC fetches the article from the site.
            </span>
          </>
        )}
        {source.kind === 'site' && (
          <>
            <div className="field">
              <label htmlFor="src-hint">Only links containing</label>
              <input
                id="src-hint"
                className="input"
                placeholder="e.g. /blog/ (empty: anything that looks like an article)"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                onBlur={() => hint !== (source.linkHint ?? '') && onUpdate({ linkHint: hint })}
              />
            </div>
            <span className="hint" style={{ margin: 0 }}>
              Websites are always fetched by your PC: finding and cleaning up articles is too much work for the free Cloudflare plan.
            </span>
          </>
        )}
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>Needs a browser (page built by JavaScript)</span>
          <input type="checkbox" checked={source.render} onChange={(e) => onUpdate({ render: e.target.checked })} />
        </label>
        <span className="hint" style={{ margin: 0 }}>Your PC opens these pages in a hidden Edge or Chrome window. Slower, so only when needed.</span>
      </section>
    </div>
  );
}

/** Not getting what you want? Find the site's feeds again, or switch between a feed and watching the page. */
function FollowSection({ source, onFollow }: { source: Source; onFollow: (p: SourceUpdate) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(source.url ?? source.feedUrl ?? '');
  const [found, setFound] = useState<DiscoverResult | null>(null);
  const [startWith, setStartWith] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await api.discoverSource(address));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not look at that address');
    } finally {
      setBusy(false);
    }
  }

  async function choose(p: SourceUpdate) {
    setBusy(true);
    await onFollow({ ...p, startWith });
    setBusy(false);
    setOpen(false);
    setFound(null);
  }

  if (!open) {
    return (
      <div className="section">
        <section className="card">
          <span className="hint" style={{ margin: 0 }}>
            Not getting what you want from this {source.kind === 'site' ? 'website watch' : 'feed'}? Switch it to{' '}
            {source.kind === 'site' ? 'a feed' : 'watching the website'}, or point it at another address.
          </span>
          <button className="btn btn--small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
            Change how it's followed
          </button>
        </section>
      </div>
    );
  }

  const isCurrentFeed = (feedUrl: string) => source.kind === 'feed' && source.feedUrl === feedUrl;
  return (
    <div className="section">
      <span className="label">Change how it's followed</span>
      <section className="card">
        <div className="field">
          <label htmlFor="follow-url">Website or feed address</label>
          <input id="follow-url" className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="inline">
          <button className="btn btn--small" disabled={busy || !address.trim()} onClick={() => void find()}>
            {busy ? 'Looking…' : 'Look at this address'}
          </button>
          <button className="btn btn--small btn--ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {found && (
          <>
            {found.feeds.map((f) => (
              <div key={f.feedUrl} className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <span className="hint" style={{ margin: 0, wordBreak: 'break-all' }}>
                  Feed: {f.title ?? f.feedUrl}
                  {f.title ? ` (${f.feedUrl})` : ''}
                </span>
                <button
                  className="btn btn--small"
                  disabled={busy || isCurrentFeed(f.feedUrl)}
                  onClick={() => void choose({ followAs: 'feed', feedUrl: f.feedUrl, url: f.siteUrl ?? found.url })}
                >
                  {isCurrentFeed(f.feedUrl) ? 'Following' : 'Use this feed'}
                </button>
              </div>
            ))}
            {found.feeds.length === 0 && <span className="hint" style={{ margin: 0 }}>No feed found at this address.</span>}
            {found.page && <WatchRow page={found.page} source={source} busy={busy} onChoose={(p) => void choose(p)} />}
            <StartWithPicker value={startWith} onChange={setStartWith} />
            <span className="hint" style={{ margin: 0 }}>
              Items you already have stay. Posts you already have from the old address may show up once more if the new one names them
              differently; pick &quot;Nothing old&quot; to avoid that.
            </span>
          </>
        )}
      </section>
    </div>
  );
}

function WatchRow({
  page,
  source,
  busy,
  onChoose,
}: {
  page: NonNullable<DiscoverResult['page']>;
  source: Source;
  busy: boolean;
  onChoose: (p: SourceUpdate) => void;
}) {
  return (
    <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <span className="hint" style={{ margin: 0, wordBreak: 'break-all' }}>
        Watch the page {page.url}
        {page.sample.length ? ` (${page.sample.length} articles found, e.g. "${page.sample[0]!.title}")` : ''}
      </span>
      <button
        className="btn btn--small"
        disabled={busy || (source.kind === 'site' && source.url === page.url)}
        onClick={() => onChoose({ followAs: 'site', url: page.url, ...(page.scripted ? { render: true } : {}) })}
      >
        {source.kind === 'site' && source.url === page.url ? 'Watching' : 'Watch this page'}
      </button>
    </div>
  );
}
