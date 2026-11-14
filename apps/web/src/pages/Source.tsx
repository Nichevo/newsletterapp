import { canMergeAway, depthTotal, depthValue, findDoubles, sourceVerdict } from '@newsletterapp/shared';
import type { AiMode, AppSettings, DiscoverResult, FullTextMode, Source, SourceActivity, SourceDepthDetail, SourceUpdate } from '@newsletterapp/shared';
import { DepthBar, DepthLegend, VerdictPill, valueColour } from '../components/DepthBar';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { keysShown } from '../keySentences';
import { activityView, nextTime, rhythmText, shortTime } from '../format';
import { IconBack } from '../icons';
import { StartWithPicker } from './Add';
import { DailyCapPicker } from './AddBuilders';
import { Help } from '../components/Help';
import { Choice } from './Settings';
import { OLD_LINK_CHOICES, REDDIT_COMMENT_CHOICES } from '@newsletterapp/shared';

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
  const [allSources, setAllSources] = useState<Source[]>([]);
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

  const [activity, setActivity] = useState<SourceActivity | undefined>(undefined);
  useEffect(() => {
    api
      .sourceActivity()
      .then((rows) => setActivity(rows.find((r) => r.sourceId === id)))
      .catch(() => undefined);
  }, [id]);

  useEffect(() => {
    Promise.all([api.sources(true), api.settings()])
      .then(([sources, s]) => {
        setSettings(s);
        setAllSources(sources);
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

  // The default follows the kind's switch, unless the source's category is one kept away from the AI.
  const kindDefault =
    source && settings
      ? source.kind !== 'ai' && settings.aiByKind[source.kind] && !(source.category && settings.aiOffCategories.includes(source.category))
      : null;
  const aiOn = (m: AiMode) => m === 'on' || (m === 'default' && kindDefault === true);
  const isWeb = (source?.kind === 'feed' || source?.kind === 'site') && !source.savedPages;
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
            {activity && <ActivityLine activity={activity} source={source} />}
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
              {!source.savedPages && (
                <button className="btn btn--small" onClick={() => void update({ paused: !source.pausedAt })}>
                  {source.pausedAt ? 'Resume' : 'Pause'}
                </button>
              )}
            </div>
            {source.savedPages ? (
              <span className="hint">Single pages you added from Add &gt; Just one page, or shared from another app. Nothing here is checked for new posts.</span>
            ) : (
            <span className="hint">
              {source.pausedAt
                ? source.kind === 'newsletter'
                  ? 'Paused: new issues are kept but go straight to Archived. Nothing is deleted.'
                  : 'Paused: not checked for new posts. Nothing is deleted.'
                : `Pause keeps everything you already have and stops new ${noun}s reaching your inbox until you resume.`}
            </span>
            )}
            {done && <span className="hint">{done}</span>}
          </div>

          {activity && (
            <SourceValue
              source={source}
              activity={activity}
              noun={noun}
              canFilter={isWeb}
              onPause={() => void update({ paused: true })}
            />
          )}

          {canMergeAway(source) && <MergeInto source={source} others={allSources} />}

          <div className="section">
            <span className="label">Category<Help topic="srcCategory" /></span>
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
            <span className="label">AI summaries<Help topic="srcAi" /></span>
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
                Default follows Settings (currently {kindDefault ? 'on' : 'off'} for this source, from its kind and category). Off means this source
                only gets the quick summary and never goes to your PC.
              </span>
            </section>
          </div>

          {keysShown() && source.kind !== 'ai' && (
            <div className="section">
              <span className="label">Key sentences<Help topic="srcKeys" /></span>
              <section className="card">
                <div className="segmented" role="group" aria-label="Key sentences">
                  {(['auto', 'always', 'never'] as const).map((m) => (
                    <button key={m} aria-pressed={source.keySentences === m} onClick={() => void update({ keySentences: m })}>
                      {{ auto: 'Auto', always: 'Always', never: 'Never' }[m]}
                    </button>
                  ))}
                </div>
                <span className="hint">
                  Colours the sentences that carry an article. Auto does long ones (the length is in Settings &gt; PC helper and AI &gt; Key
                  sentences), Always does every {noun} whatever its length, Never skips this source (right for link roundups). Only{' '}
                  {noun}s summarised from now on; older ones can be done from the reader.
                </span>
              </section>
            </div>
          )}

          {isWeb && <FetchSection source={source} onUpdate={(p) => void update(p)} onCheck={() => void checkNow()} />}
          {isWeb && <PostFilterSection source={source} onUpdate={(p) => void update(p)} />}
          {isWeb && <TroubleshootSection source={source} />}
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
      <span className="label">{source.kind === 'site' ? 'Watching the page' : source.platform ? `${{ reddit: 'Reddit', youtube: 'YouTube', github: 'GitHub' }[source.platform]} feed` : 'Feed'}</span>
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
              ? `Last checked ${shortTime(source.lastCheckedAt)}${source.nextCheckAt ? `, next ${nextTime(source.nextCheckAt)}` : ''}.`
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
        <span className="label">Check every<Help topic="srcCheckEvery" /></span>
        <div className="segmented" role="group" aria-label="Check every">
          {source.kind === 'feed' && (
            <button aria-pressed={source.checkMinutes === null} onClick={() => onUpdate({ checkMinutes: null })}>
              Auto
            </button>
          )}
          {EVERY.map((e) => (
            <button
              key={e.minutes}
              aria-pressed={(source.kind !== 'feed' || source.checkMinutes !== null) && minutes === e.minutes}
              onClick={() => onUpdate({ checkMinutes: e.minutes })}
            >
              {e.label}
            </button>
          ))}
        </div>
        {source.kind === 'feed' && <RhythmNote source={source} />}
        {source.kind === 'feed' && (
          <>
            <span className="label">Fetched by<Help topic="srcFetchedBy" /></span>
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
            <span className="label">Full articles<Help topic="srcFullText" /></span>
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
              <label htmlFor="src-hint">Only links containing<Help topic="srcLinkHint" /></label>
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
            <Choice
              label="Skip links older than (days)"
              help="srcOldLinks"
              value={source.oldLinkDays}
              options={OLD_LINK_CHOICES.map((n) => [n, n === 0 ? 'Never' : String(n)] as const)}
              onChange={(v) => onUpdate({ oldLinkDays: v })}
              width={260}
            />
          </>
        )}
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>Needs a browser (page built by JavaScript)<Help topic="srcBrowser" /></span>
          <input type="checkbox" checked={source.render} onChange={(e) => onUpdate({ render: e.target.checked })} />
        </label>
        <span className="hint" style={{ margin: 0 }}>Your PC opens these pages in a hidden Edge or Chrome window. Slower, so only when needed.</span>
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>Show the picture in the inbox<Help topic="srcPicture" /></span>
          <input type="checkbox" checked={source.showPicture} onChange={(e) => onUpdate({ showPicture: e.target.checked })} />
        </label>
        <span className="hint" style={{ margin: 0 }}>
          For comics and photo feeds: in the Expanded inbox view, each post shows its picture and hover text, so you can read it without
          opening it.
        </span>
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>Group new posts into one item<Help topic="srcBundle" /></span>
          <input type="checkbox" checked={source.bundle} onChange={(e) => onUpdate({ bundle: e.target.checked })} />
        </label>
        <span className="hint" style={{ margin: 0 }}>
          For feeds that post several at once (TED Talks): everything new from one check arrives as a single inbox item, with each post as
          its own section and link inside.
        </span>
        {source.kind === 'feed' && (
          <>
            <label className="switchrow">
              <span style={{ fontSize: 15 }}>Fetch the article it links to<Help topic="srcFollowLink" /></span>
              <input type="checkbox" checked={source.followLink} onChange={(e) => onUpdate({ followLink: e.target.checked })} />
            </label>
            <span className="hint" style={{ margin: 0 }}>
              For sites that point to other people's stories (Techmeme): your PC saves the original article under the post's summary, plus a
              list of the story's other links with each one's publication or quoted comment. Applies to new posts.
            </span>
          </>
        )}
      </section>
    </div>
  );
}

/** Which new posts get in: words to keep or skip, release types, Shorts, and the daily flood limit. */
function PostFilterSection({ source, onUpdate }: { source: Source; onUpdate: (p: SourceUpdate) => void }) {
  const f = source.postFilter;
  const [keep, setKeep] = useState(f.keep);
  const [skip, setSkip] = useState(f.skip);
  const set = (patch: Partial<typeof f>) => onUpdate({ postFilter: { ...f, keep, skip, ...patch } });
  const isGithub = /github\.com\/[^/]+\/[^/]+\/(releases|tags)/i.test(source.feedUrl ?? '');
  const isYoutube = /youtube\.com\/feeds\//i.test(source.feedUrl ?? '');
  const flooded = source.floodAt !== null && source.floodAt > Date.now() - 86_400_000 && source.floodCount > 0;
  return (
    <div className="section" id="which-posts">
      <span className="label">Which posts get in<Help topic="srcPostFilter" /></span>
      <section className="card">
        {flooded && (
          <div className="notice notice--amber" style={{ margin: 0 }}>
            <div className="notice__text">
              <span className="notice__title">
                Flood guard set aside {source.floodCount} post{source.floodCount === 1 ? '' : 's'} today
              </span>
              {source.floodSkip ? (
                <span className="notice__sub">They were binned, as set below. Raise the limit if you want them in the inbox.</span>
              ) : (
                <Link to={`/?source=${source.id}&view=archived`} className="notice__sub">
                  They're in Archived. Raise the limit below if you want them in the inbox.
                </Link>
              )}
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="pf-keep">Only posts mentioning (optional)</label>
          <input
            id="pf-keep"
            className="input"
            placeholder="e.g. release, security"
            value={keep}
            onChange={(e) => setKeep(e.target.value)}
            onBlur={() => keep !== f.keep && set({ keep })}
          />
        </div>
        <div className="field">
          <label htmlFor="pf-skip">Skip posts mentioning (optional)</label>
          <input
            id="pf-skip"
            className="input"
            placeholder="e.g. meme, giveaway"
            value={skip}
            onChange={(e) => setSkip(e.target.value)}
            onBlur={() => skip !== f.skip && set({ skip })}
          />
        </div>
        <span className="hint" style={{ margin: 0 }}>
          Checked against each post's title. Separate words or phrases with commas. Skipped posts never show up, not even in Archived.
        </span>
        {(isGithub || f.skipPrereleases || f.majorMinorOnly) && (
          <>
            <label className="switchrow">
              <span style={{ fontSize: 15 }}>Skip betas and previews</span>
              <input type="checkbox" checked={f.skipPrereleases} onChange={(e) => set({ skipPrereleases: e.target.checked })} />
            </label>
            <label className="switchrow">
              <span style={{ fontSize: 15 }}>Key releases only</span>
              <input type="checkbox" checked={f.majorMinorOnly} onChange={(e) => set({ majorMinorOnly: e.target.checked })} />
            </label>
            <span className="hint" style={{ margin: 0 }}>
              Key releases are versions like 2.0 or 2.5. Patch fixes such as 2.5.1 are skipped. Betas means alpha, beta, rc, preview and nightly.
            </span>
          </>
        )}
        {source.platform === 'reddit' && (
          <Choice
            label="Comments to add"
            help="srcRedditComments"
            value={source.redditComments}
            options={REDDIT_COMMENT_CHOICES.map((n) => [n, n === 0 ? 'None' : String(n)] as const)}
            onChange={(v) => onUpdate({ redditComments: v })}
            width={220}
          />
        )}
        {(isYoutube || f.skipShorts) && (
          <label className="switchrow">
            <span style={{ fontSize: 15 }}>Skip Shorts</span>
            <input type="checkbox" checked={f.skipShorts} onChange={(e) => set({ skipShorts: e.target.checked })} />
          </label>
        )}
        <label className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="hint" style={{ margin: 0 }}>
            Bring new posts in
            <Help topic="srcWait" />
          </span>
          <select className="input" style={{ flex: '1 1 160px' }} value={source.waitHours} onChange={(e) => onUpdate({ waitHours: Number(e.target.value) })}>
            {[0, 2, 6, 12, 24].map((h) => (
              <option key={h} value={h}>
                {h === 0 ? 'Straight away' : `Once they're ${h} hours old`}
              </option>
            ))}
          </select>
          <span className="hint" style={{ margin: 0, flexBasis: '100%' }}>
            Waiting lets votes and comments build up first (handy for Reddit, where the top comments come with each post).
          </span>
        </label>
        <span className="label" style={{ marginTop: 8 }}>
          Flood guard
          <Help topic="srcFloodGuard" />
        </span>
        <DailyCapPicker value={source.dailyCap} onChange={(n) => onUpdate({ dailyCap: n })} />
        {source.dailyCap > 0 && (
          <>
            <span className="hint" style={{ margin: 0 }}>Posts over the limit:</span>
            <div className="segmented" role="group" aria-label="Posts over the limit">
              <button aria-pressed={!source.floodSkip} onClick={() => onUpdate({ floodSkip: false })}>
                Go to Archived
              </button>
              <button aria-pressed={source.floodSkip} onClick={() => onUpdate({ floodSkip: true })}>
                Bin them
              </button>
            </div>
            <span className="hint" style={{ margin: 0 }}>
              {source.floodSkip
                ? "Binned posts are never saved, so they won't show up in Archived or Search."
                : 'Archived posts stay searchable but skip your inbox and the AI.'}
            </span>
          </>
        )}
        <span className="hint" style={{ margin: 0 }}>Changes apply to new posts from now on.</span>
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

/** Plain-words guide to the settings above, for a feed or website whose posts don't come out right. */
function TroubleshootSection({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  const feed = source.kind === 'feed';
  const tips: { problem: string; fix: string }[] = feed
    ? [
        {
          problem: 'Posts stop after the first paragraph, or say "read more".',
          fix: 'Set Full articles to Always. Your PC then fetches each post from the website. Takes effect for new posts.',
        },
        {
          problem: 'A full article comes out empty, jumbled, or only shows a cookie notice.',
          fix: 'Switch on "Needs a browser" so your PC opens the page in Edge or Chrome first, then wait for the next post.',
        },
        {
          problem: 'The check fails, or says the site turned Cloudflare away.',
          fix: 'Set Fetched by to My PC, then press Check now. (The app also does this by itself after three refusals.)',
        },
        {
          problem: 'Posts are missing, or you get the wrong section of the site.',
          fix: 'Use "Change how it\'s followed" below: look at the site again and pick another of its feeds, or watch the page itself.',
        },
        {
          problem: 'Not sure the app is the problem?',
          fix: 'Open a post and tap Live page to compare it with the website. If the website itself is short, the post is too.',
        },
      ]
    : [
        {
          problem: 'You get links that aren\'t articles (About, Contact, tags, other sections).',
          fix: 'Fill in "Only links containing" with the part every article address shares, such as /blog/ or /news/.',
        },
        {
          problem: 'Articles come out empty or jumbled, or nothing is found on the page.',
          fix: 'Switch on "Needs a browser" so your PC opens the page in Edge or Chrome, then press Check now.',
        },
        {
          problem: 'Nothing new arrives.',
          fix: 'Press Check now and read the line under the address: it says when it last worked and any error. Your PC must be on, since websites are checked by your PC.',
        },
        {
          problem: 'The site has a feed after all.',
          fix: 'Use "Change how it\'s followed" below. A feed is usually quicker and tidier than watching the page.',
        },
      ];
  return (
    <div className="section">
      <section className="card">
        <button className="quick__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Not coming through right? How to fix it'}
        </button>
        {open && (
          <>
            {tips.map((t) => (
              <div key={t.problem}>
                <strong style={{ fontSize: 14 }}>{t.problem}</strong>
                <span className="hint" style={{ display: 'block', margin: '2px 0 0' }}>
                  {t.fix}
                </span>
              </div>
            ))}
            <span className="hint" style={{ margin: 0 }}>
              Changes apply to posts that arrive after them; posts you already have stay as they are.
            </span>
          </>
        )}
      </section>
    </div>
  );
}

/** What the app has learnt about when this feed posts, and how that sets its checks. */
function RhythmNote({ source }: { source: Source }) {
  const { summary, checking } = rhythmText(source.rhythm, source.checkMinutes === null);
  return (
    <span className="hint" style={{ margin: 0 }}>
      <strong>When it posts:</strong> {summary} {checking}
      {source.rhythm && source.rhythm.posts > 0 ? ` Learnt from its last ${source.rhythm.posts} posts.` : ''}
    </span>
  );
}

const NOT_NOW_DAYS = 60;
const notNowKey = (id: string) => `sourceValueNotNow:${id}`;
function notNowUntil(id: string): number {
  try {
    return Number(localStorage.getItem(notNowKey(id))) || 0;
  } catch {
    return 0;
  }
}

function secsText(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/**
 * How you read this source: how far you went with its items over the last 90 days,
 * in 30-day steps, with a plain suggestion when you mostly skip it. Information
 * only: nothing is paused or removed unless you tap it.
 */
function SourceValue({
  source,
  activity,
  noun,
  canFilter,
  onPause,
}: {
  source: Source;
  activity: SourceActivity;
  noun: string;
  canFilter: boolean;
  onPause: () => void;
}) {
  const [detail, setDetail] = useState<SourceDepthDetail | null>(null);
  const [hidden, setHidden] = useState(() => notNowUntil(source.id) > Date.now());
  useEffect(() => {
    api
      .sourceDepth(source.id)
      .then(setDetail)
      .catch(() => undefined);
  }, [source.id]);
  const d = activity.depth;
  const total = depthTotal(d);
  const value = depthValue(d);
  const verdict = sourceVerdict(d);
  const low = verdict === 'mostly_skipped' || verdict === 'always_skipped';
  const skippedPct = total ? Math.round(((d.not_interested + d.skipped) / total) * 100) : 0;
  const nouns = `${noun}s`;
  const trend = (() => {
    if (!detail) return '';
    const [now, , old] = detail.buckets.map((b) => depthValue(b));
    if (now == null || old == null || depthTotal(detail.buckets[0]!) < 3 || depthTotal(detail.buckets[2]!) < 3) return '';
    if (now <= old - 8) return ', and less each month';
    if (now >= old + 8) return ', but more lately';
    return '';
  })();
  const notNow = () => {
    try {
      localStorage.setItem(notNowKey(source.id), String(Date.now() + NOT_NOW_DAYS * 86_400_000));
    } catch {
      /* this device only; fine without */
    }
    setHidden(true);
  };
  return (
    <div className="section">
      <span className="label">
        How you read this source<Help topic="srcValue" />
      </span>
      <section className="card">
        {total === 0 ? (
          <span className="hint" style={{ margin: 0 }}>
            Nothing to go on yet: none of its {nouns} from the last 90 days has been looked at, marked read or left unread for two weeks.
          </span>
        ) : (
          <>
            <div className="inline" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 26, fontVariantNumeric: 'tabular-nums', color: valueColour(value) }}>{value ?? '–'}</strong>
              <span className="hint" style={{ margin: 0 }}>
                value out of 100 · last 90 days · {total} {total === 1 ? noun : nouns}
              </span>
              <VerdictPill verdict={verdict} />
            </div>
            <DepthBar depth={d} big />
            <DepthLegend depth={d} />
            {detail && (
              <div className="depthmonths" aria-label="By 30 days">
                {(['Last 30 days', '30–60 days ago', '60–90 days ago'] as const).map((label, n) => {
                  const b = detail.buckets[n]!;
                  return (
                    <div key={label}>
                      <span>{label}</span>
                      <DepthBar depth={b} />
                      <em>{depthTotal(b) ? (depthValue(b) ?? '') : '–'}</em>
                    </div>
                  );
                })}
              </div>
            )}
            {detail && (
              <div className="kv">
                <span>Summaries read in the inbox</span>
                <b>{detail.summaryInInbox}</b>
                <span>Summaries read in the reader</span>
                <b>{detail.summaryInReader}</b>
                <span>Time on AI summaries</span>
                <b>{secsText(detail.summarySecs)}</b>
                <span>Time in articles</span>
                <b>{secsText(detail.articleSecs)}</b>
                <span>Live page or web version opened</span>
                <b>{detail.liveOpened}</b>
              </div>
            )}
            {low && !hidden && !source.pausedAt && (
              <div className="depthnote depthnote--low">
                <strong>
                  You skip {skippedPct}% of these{trend}
                  {d.kept === 0 ? ', and kept none.' : '.'}
                </strong>{' '}
                {canFilter ? 'Pause it, let fewer posts in, or leave it?' : 'Pause it, or leave it?'}
                <div className="inline" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn--small btn--primary" onClick={onPause}>
                    Pause
                  </button>
                  {canFilter && (
                    <button className="btn btn--small" onClick={() => document.getElementById('which-posts')?.scrollIntoView({ behavior: 'smooth' })}>
                      Which posts get in ↓
                    </button>
                  )}
                  <button className="btn btn--small" onClick={notNow}>
                    Not now
                  </button>
                </div>
              </div>
            )}
            {verdict === 'summary' && (
              <div className="depthnote">
                <strong>The AI summary is usually enough for this one.</strong> You read {Math.round((d.summary / total) * 100)}% of its summaries
                {d.kept ? ` and kept ${d.kept}` : ''}.
              </div>
            )}
            {verdict === 'keeper' && (
              <div className="depthnote">
                <strong>One you value.</strong> You went into the article or kept {Math.round(((d.article + d.kept) / total) * 100)}% of its {nouns}.
              </div>
            )}
            <span className="hint" style={{ margin: 0 }}>
              Unread {nouns} count as skipped after two weeks. Information only: nothing is paused or removed unless you tap it.
            </span>
          </>
        )}
      </section>
    </div>
  );
}

/** Items and reads per month over the last 90 days, and a warning when the source has gone quiet or unread. */
function ActivityLine({ activity, source }: { activity: SourceActivity; source: Source }) {
  const view = activityView(activity, source);
  return (
    <span className="hint" style={{ margin: 0 }}>
      Last 90 days: {view.line}.{view.flag && !source.pausedAt ? <strong> {view.flag}.</strong> : null}
    </span>
  );
}

/** Followed the same site twice? Merge this feed or website watch into the one you keep. */
function MergeInto({ source, others }: { source: Source; others: Source[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = others.filter((s) => s.id !== source.id && !s.savedPages);
  const likely = new Set(findDoubles([source, ...choices]).find((g) => g.some((s) => s.id === source.id))?.map((s) => s.id) ?? []);
  const sorted = [...choices].sort((a, b) => Number(likely.has(b.id)) - Number(likely.has(a.id)) || a.name.localeCompare(b.name));
  const target = choices.find((s) => s.id === into);

  const merge = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.mergeSource(source.id, target.id);
      navigate(`/source/${target.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not merge');
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <span className="label">Following this twice?</span>
      <section className="card">
        {!open ? (
          <>
            <span className="hint">
              If another source follows the same site, merge this one into it: its posts and reading history move across and it is no longer followed.
            </span>
            <div className="inline">
              <button className="btn btn--small" onClick={() => setOpen(true)}>
                Merge into another source…
              </button>
            </div>
          </>
        ) : (
          <>
            <select className="input" aria-label="Merge into" value={into} onChange={(e) => setInto(e.target.value)}>
              <option value="">Pick the source to keep</option>
              {sorted.map((s) => (
                <option key={s.id} value={s.id}>
                  {likely.has(s.id) ? '★ ' : ''}
                  {s.name} ({s.kind === 'site' ? 'website' : s.kind})
                </option>
              ))}
            </select>
            {target && (
              <span className="hint">
                {source.name} merges into {target.name}: {source.itemCount} post{source.itemCount === 1 ? '' : 's'}, stars and reading history move across, and{' '}
                {source.name} is no longer followed. This can&apos;t be undone.
              </span>
            )}
            <div className="inline">
              <button className="btn btn--small btn--primary" disabled={!target || busy} onClick={() => void merge()}>
                {busy ? 'Merging…' : 'Merge'}
              </button>
              <button className="btn btn--small" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
            {likely.size > 0 && <span className="hint">★ looks like the same site or name.</span>}
          </>
        )}
        {error && <div className="error">{error}</div>}
      </section>
    </div>
  );
}
