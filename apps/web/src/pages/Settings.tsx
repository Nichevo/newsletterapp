import { keysShown } from '../keySentences';
import { AI_MAX_CHARS_CHOICES, PDF_PAGES_CHOICES, STORY_DAYS_CHOICES, MAX_REVIEW_SEARCHES, REVIEW_CHART_WEEKS, REVIEW_PARTS, type AppSettings, type Me, type ReviewKind, type ReviewQuality, type ReviewSettings, type Source, type SummaryKind } from '@newsletterapp/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  DENSITIES,
  TEXT_SIZES,
  getHideSponsored,
  getSwipeReadSide,
  getLongSwipePx,
  setLongSwipePx,
  LONG_SWIPE_MIN,
  LONG_SWIPE_MAX,
  LONG_SWIPE_DEFAULT,
  getShortSwipePx,
  setShortSwipePx,
  SHORT_SWIPE_MIN,
  SHORT_SWIPE_MAX,
  SHORT_SWIPE_DEFAULT,
  SWIPE_GAP,
  getNotesPlace,
  setNotesPlace,
  type NotesPlace,
  getTextSize,
  getReadingSpeed,
  setReadingSpeed,
  READING_SPEEDS,
  setDensity,
  setHideSponsored,
  setSwipeReadSide,
  setTextSize,
  setViewOptions,
  type SwipeReadSide,
  type TextSize,
  getOpenIn,
  setOpenIn,
  type AppSite,
  type OpenIn,
} from '../prefs';
import { useDensity, useViewOptions } from '../components/DensityToggle';
import { Help } from '../components/Help';
import type { HelpTopic } from '../help';

/** Loads the app settings and saves changes optimistically; shared by Settings and its sub-pages. */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load settings'));
  }, []);

  async function save(patch: Partial<AppSettings>) {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, ...patch });
    try {
      setSettings(await api.saveSettings(patch));
    } catch (err) {
      setSettings(before);
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  return { settings, save, error };
}

function MenuRow({ to, title, sub }: { to: string; title: string; sub: string }) {
  return (
    <Link to={to} className="cardrow">
      <div className="cardrow__main">
        <span className="cardrow__title">{title}</span>
        <span className="cardrow__sub">{sub}</span>
      </div>
    </Link>
  );
}

export function SettingsPage({
  me,
  onReviewsChange,
  onGroupChange,
}: {
  me: Me;
  onReviewsChange: (on: boolean) => void;
  onGroupChange: (on: boolean) => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const { settings, save, error } = useAppSettings();

  useEffect(() => {
    api.sources().then(setSources).catch(() => undefined);
  }, []);

  // Shows or hides the Review tab as soon as a switch is saved (or put back after a failed save).
  const reviewsOn = settings ? settings.reviews.weekly || settings.reviews.monthly : undefined;
  useEffect(() => {
    if (reviewsOn !== undefined) onReviewsChange(reviewsOn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewsOn]);
  const groupOn = settings?.stories.groupSameNews;
  useEffect(() => {
    if (groupOn !== undefined) onGroupChange(groupOn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupOn]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <h1>Settings</h1>
        </div>
      </header>

      <div className="section">
        <div className="card card--list">
          <MenuRow
            to="/settings/sources"
            title="Your sources"
            sub={
              sources.length === 0
                ? 'Newsletters, feeds and websites appear here once something arrives; categories and keyword rules'
                : `${sources.length} source${sources.length === 1 ? '' : 's'} · when each posts, pause, history · categories and keyword rules`
            }
          />
          <MenuRow to="/add" title="Add a source" sub="Follow a site or feed, import from Feedly, or create a newsletter address" />
          <MenuRow
            to="/settings/send"
            title="Send pages from anywhere"
            sub="Save address for emailing links in, and bookmarks that send the page you're on"
          />
          <MenuRow to="/senders" title="Senders" sub="Allow or block who can reach your inbox" />
          <MenuRow
            to="/settings/ai"
            title="PC helper and AI"
            sub="What gets summarised, models, prompts, highlight prompts, web search, usage limits and cost"
          />
          <MenuRow to="/settings/status" title="System status" sub="Status pages for Apple, Google, Microsoft and more; the inbox's Status button and banner" />
          <MenuRow to="/tags" title="All tags" sub="Every AI tag with how many items carry it; search, sort and open a tag's page" />
          <MenuRow to="/stats" title="Statistics" sub="What arrives and what you read; how the AI summaries are doing" />
          <MenuRow to="/settings/export" title="Backup and export" sub="Your feeds as OPML, newsletters as CSV, or everything as JSON" />
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <ReadingSection />
      {settings && <RankingSection settings={settings} onSave={save} />}
      {settings && <StoriesSection settings={settings} onSave={save} />}
      {settings && <ReviewsSection settings={settings} onSave={save} />}

      <div className="section">
        <span className="label">Account</span>
        <div className="card card--list">
          <div className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Signed in as {me.email}</span>
              <span className="cardrow__sub">
                {me.domain ? `Newsletters are sent to @${me.domain}` : 'Mail domain not configured yet'}
              </span>
            </div>
          </div>
          <a href="/cdn-cgi/access/logout" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Sign out</span>
            </div>
          </a>
        </div>
      </div>
    </div>
  );
}

export function CategoriesSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [ruleCategory, setRuleCategory] = useState(settings.categories[0] ?? '');

  function addCategory(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || settings.categories.includes(n)) return;
    void onSave({ categories: [...settings.categories, n] });
    setName('');
  }

  function addRule(e: FormEvent) {
    e.preventDefault();
    if (!words.trim() || !ruleCategory) return;
    void onSave({ keywordRules: [...settings.keywordRules, { match: words.trim(), category: ruleCategory }] });
    setWords('');
  }

  return (
    <div className="section">
      <span className="label">Categories<Help topic="categories" /></span>
      <section className="card">
        <div className="chipedit">
          {settings.categories.map((c) => (
            <span key={c} className="chip chip--category">
              {c}
              <button
                aria-label={`Remove ${c}`}
                onClick={() => void onSave({ categories: settings.categories.filter((x) => x !== c) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form className="inline" onSubmit={addCategory}>
          <input className="input" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn--small" type="submit">
            Add
          </button>
        </form>
        <span className="hint">
          Set each newsletter's usual category on its page below. Keyword rules override it for single issues.
        </span>
      </section>

      <span className="label">Keyword rules<Help topic="keywordRules" /></span>
      <section className="card">
        {settings.keywordRules.length === 0 && <span className="hint">No rules yet.</span>}
        {settings.keywordRules.map((r, i) => (
          <div key={`${r.match}-${i}`} className="switchrow">
            <span style={{ fontSize: 14 }}>
              “{r.match}” → <strong>{r.category}</strong>
            </span>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => void onSave({ keywordRules: settings.keywordRules.filter((_, j) => j !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <form className="field" onSubmit={addRule}>
          <input
            className="input"
            placeholder="Words in the subject, e.g. Fed, interest rates"
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <div className="inline">
            <select className="input" value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value)}>
              {settings.categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button className="btn btn--small" type="submit">
              Add rule
            </button>
          </div>
        </form>
        <span className="hint">Rules apply to new issues as they arrive.</span>
      </section>
    </div>
  );
}

const KIND_LABEL: Record<SummaryKind, string> = { newsletter: 'Newsletters', feed: 'RSS feeds', site: 'Websites' };

export function AiSummariesSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const [interests, setInterests] = useState(settings.interests);

  return (
    <div className="section">
      <span className="label">AI summaries<Help topic="aiByKind" /></span>
      <section className="card">
        {(Object.keys(KIND_LABEL) as SummaryKind[]).map((kind) => (
          <label key={kind} className="switchrow">
            <span style={{ fontSize: 15 }}>{KIND_LABEL[kind]}</span>
            <input
              type="checkbox"
              checked={settings.aiByKind[kind]}
              onChange={(e) => void onSave({ aiByKind: { ...settings.aiByKind, [kind]: e.target.checked } })}
            />
          </label>
        ))}
        <span className="hint">
          Which items go to the AI on your PC. Switching a kind on summarises new items only; to go back further, switch AI on
          from a source’s own page. Each source can override this. Everything always gets the quick summary. When the PC is off,
          summaries and highlight questions wait until it’s back.
        </span>
        {settings.categories.length > 0 && (
          <div className="field">
            <label>Categories without AI<Help topic="aiOffCategories" /></label>
            <div className="chipedit">
              {settings.categories.map((c) => {
                const off = settings.aiOffCategories.includes(c);
                return (
                  <button
                    key={c}
                    className={`chip ${off ? 'chip--outline' : 'chip--category'}`}
                    aria-pressed={off}
                    style={{ textDecoration: off ? 'line-through' : 'none' }}
                    onClick={() =>
                      void onSave({ aiOffCategories: off ? settings.aiOffCategories.filter((x) => x !== c) : [...settings.aiOffCategories, c] })
                    }
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <span className="hint">
              Tap a category to keep its items away from the AI, e.g. Comics; struck-through ones get the quick summary only. A source
              set to AI On still goes.
            </span>
          </div>
        )}
        <div className="field">
          <label htmlFor="interests">Your interests<Help topic="interests" /></label>
          <input
            id="interests"
            className="input"
            placeholder="e.g. AI, investing, home tech"
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            onBlur={() => interests !== settings.interests && void onSave({ interests })}
          />
          <span className="hint">Used for the “why it matters” line in AI summaries.</span>
        </div>
        <Choice
          label="Longest text the AI reads"
          help="aiMaxChars"
          value={settings.tuning.aiMaxChars}
          options={AI_MAX_CHARS_CHOICES.map((n) => [n, `${n / 1000}k`] as const)}
          onChange={(v) => void onSave({ tuning: { ...settings.tuning, aiMaxChars: v } })}
          width={220}
        />
        <span className="hint">
          Characters; 24k is about 4,000 words. The rest of a longer article is cut. Bigger is slower and needs more of the graphics card's memory.
        </span>
        <Choice
          label="PDF pages to read"
          help="pdfMaxPages"
          value={settings.tuning.pdfMaxPages}
          options={PDF_PAGES_CHOICES.map((n) => [n, String(n)] as const)}
          onChange={(v) => void onSave({ tuning: { ...settings.tuning, pdfMaxPages: v } })}
          width={180}
        />
      </section>
    </div>
  );
}

/** Top sort and Likely interesting: how the app ranks and picks for you. */
function RankingSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const t = settings.tuning;
  return (
    <div className="section">
      <span className="label">Sorting</span>
      <section className="card">
        <Choice
          label="Top sort leans towards"
          help="topLean"
          value={t.topLean}
          options={[
            ['newest', 'Newest'],
            ['balanced', 'Balanced'],
            ['favourites', 'Favourites'],
          ]}
          onChange={(v) => void onSave({ tuning: { ...t, topLean: v } })}
          width={260}
        />
        <span className="hint">Favourites means the sources you read, save and star most.</span>
        <Choice
          label="Likely interesting shows"
          help="likelyShare"
          value={t.likelyShare}
          options={[
            [10, 'Fewer'],
            [15, 'Normal'],
            [25, 'More'],
          ]}
          onChange={(v) => void onSave({ tuning: { ...t, likelyShare: v } })}
          width={220}
        />
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>
            Leave "Probably not for you" out of the inbox
            <Help topic="unlikely" />
          </span>
          <input type="checkbox" checked={t.hideUnlikely} onChange={(e) => void onSave({ tuning: { ...t, hideUnlikely: e.target.checked } })} />
        </label>
        <span className="hint">
          Your PC flags unread items close to the ones you marked Not interested. They always sink in the Top sort; with this on they
          also leave the All and Unread lists and wait under the "Probably not for you" view.
        </span>
      </section>
    </div>
  );
}

/** Live page for Reddit or YouTube posts: their app or the browser (Android). */
function OpenInPicker({ site }: { site: AppSite }) {
  const [where, setWhere] = useState<OpenIn>(getOpenIn(site));
  const name = site === 'reddit' ? 'Reddit' : 'YouTube';
  return (
    <div className="field">
      <span className="label">Live page for {name} posts<Help topic="openIn" /></span>
      <div className="segmented" role="group" aria-label={`Live page for ${name} posts`}>
        {(['app', 'browser'] as OpenIn[]).map((w) => (
          <button
            key={w}
            aria-pressed={where === w}
            onClick={() => {
              setOpenIn(site, w);
              setWhere(w);
            }}
          >
            {w === 'app' ? `${name} app` : 'Browser'}
          </button>
        ))}
      </div>
      <span className="hint">On Android phones. If the app isn't installed, the browser opens it instead.</span>
    </div>
  );
}

/** Text size and sponsored-section hiding, remembered on this device only. */
function ReadingSection() {
  const [size, setSize] = useState<TextSize>(getTextSize());
  const [speed, setSpeed] = useState(getReadingSpeed());
  const [hideSponsored, setHide] = useState(getHideSponsored());
  const [swipeRead, setSwipeRead] = useState<SwipeReadSide>(getSwipeReadSide());
  const [shortPx, setShortPx] = useState(getShortSwipePx());
  const [longPx, setLongPx] = useState(getLongSwipePx());
  const [notesPlace, setNotesPlaceState] = useState<NotesPlace>(getNotesPlace());
  const density = useDensity();
  const opts = useViewOptions();

  function pick(next: TextSize) {
    setTextSize(next);
    setSize(next);
  }

  return (
    <div className="section">
      <span className="label">Reading<Help topic="readingTime" /></span>
      <section className="card">
        <div className="field">
          <label>Text size<Help topic="textSize" /></label>
          <div className="segmented" role="group" aria-label="Text size">
            {TEXT_SIZES.map((t) => (
              <button key={t.id} aria-pressed={size === t.id} onClick={() => pick(t.id)} style={{ fontSize: t.px - 3 }}>
                {t.label}
              </button>
            ))}
          </div>
          <span className="hint">Applies to newsletter text in the reader on this device.</span>
        </div>
        <Choice
          label="Reading speed (words a minute)"
          help="readingSpeed"
          value={speed}
          options={READING_SPEEDS.map((n) => [n, String(n)] as const)}
          onChange={(v) => {
            setReadingSpeed(v);
            setSpeed(v);
          }}
          width={220}
        />
        <div className="field">
          <label>Inbox view<Help topic="inboxView" /></label>
          <div className="segmented" role="group" aria-label="Inbox view">
            {DENSITIES.map((d) => (
              <button key={d.id} aria-pressed={density === d.id} onClick={() => setDensity(d.id)}>
                {d.label}
              </button>
            ))}
          </div>
          <span className="hint">{DENSITIES.find((d) => d.id === density)?.hint}. The icon at the top of the inbox switches too.</span>
        </div>
        <div className="field">
          <label>Card view<Help topic="cardView" /></label>
          <div className="switchrow">
            <span style={{ fontSize: 14 }}>Preview lines</span>
            <div className="segmented" role="group" aria-label="Preview lines" style={{ width: 200 }}>
              {([0, 1, 2, 3] as const).map((n) => (
                <button key={n} aria-pressed={opts.cardLines === n} onClick={() => setViewOptions({ cardLines: n })}>
                  {n === 0 ? 'None' : n}
                </button>
              ))}
            </div>
          </div>
          <OptionSwitch label="Show tags and category" value={opts.cardTags} onChange={(v) => setViewOptions({ cardTags: v })} />
        </div>
        <div className="field">
          <label>Expanded view<Help topic="expandedView" /></label>
          <OptionSwitch
            label="Whole summary (off: first 4 lines)"
            value={opts.expandedFullSummary}
            onChange={(v) => setViewOptions({ expandedFullSummary: v })}
          />
          <div className="switchrow">
            <span style={{ fontSize: 14 }}>Key points</span>
            <div className="segmented" role="group" aria-label="Key points" style={{ width: 200 }}>
              {([0, 3, 5, 99] as const).map((n) => (
                <button key={n} aria-pressed={opts.expandedPoints === n} onClick={() => setViewOptions({ expandedPoints: n })}>
                  {n === 0 ? 'None' : n === 99 ? 'All' : n}
                </button>
              ))}
            </div>
          </div>
          <OptionSwitch label="Why it matters" value={opts.expandedWhy} onChange={(v) => setViewOptions({ expandedWhy: v })} />
          <OptionSwitch label="Show tags and category" value={opts.expandedTags} onChange={(v) => setViewOptions({ expandedTags: v })} />
          <span className="hint">Key points and “why it matters” come from the AI summary, so they show once the PC helper has done an issue.</span>
        </div>
        {keysShown() && (
          <div className="field">
            <label>Key sentences in the lists<Help topic="inboxKeys" /></label>
            <OptionSwitch label="Show under the summary (Card and Expanded)" value={opts.inboxKeys} onChange={(v) => setViewOptions({ inboxKeys: v })} />
            <div className="switchrow">
              <span style={{ fontSize: 14 }}>Colours</span>
              <div className="segmented" role="group" aria-label="Which key sentences" style={{ width: 240 }}>
                {(
                  [
                    ['main', 'Main'],
                    ['main-takeaway', 'Main + takeaway'],
                    ['all', 'All'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} aria-pressed={opts.inboxKeyKinds === k} onClick={() => setViewOptions({ inboxKeyKinds: k })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="switchrow">
              <span style={{ fontSize: 14 }}>How many</span>
              <div className="segmented" role="group" aria-label="How many key sentences" style={{ width: 200 }}>
                {([3, 5, 99] as const).map((n) => (
                  <button key={n} aria-pressed={opts.inboxKeyCount === n} onClick={() => setViewOptions({ inboxKeyCount: n })}>
                    {n === 99 ? 'All' : n}
                  </button>
                ))}
              </div>
            </div>
            <span className="hint">The coloured button at the top of Inbox, Saved and Interesting switches them on and off.</span>
          </div>
        )}
        <div className="field">
          <span className="label">Swipe to mark read<Help topic="swipe" /></span>
          <div className="segmented" role="group" aria-label="Swipe to mark read">
            {(['right', 'left'] as SwipeReadSide[]).map((side) => (
              <button
                key={side}
                aria-pressed={swipeRead === side}
                onClick={() => {
                  setSwipeReadSide(side);
                  setSwipeRead(side);
                }}
              >
                Swipe {side}
              </button>
            ))}
          </div>
          <span className="hint">The other way saves the item for later.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="short-swipe">
            Swipe distance: <b>{shortPx} px</b>
            <Help topic="swipe" />
          </label>
          <input
            id="short-swipe"
            type="range"
            min={SHORT_SWIPE_MIN}
            max={SHORT_SWIPE_MAX}
            step={5}
            value={shortPx}
            onChange={(e) => {
              const px = Number(e.target.value);
              setShortPx(px);
              setShortSwipePx(px);
              // The long swipe stays a little further out than the short one.
              if (longPx < px + SWIPE_GAP) {
                setLongPx(px + SWIPE_GAP);
                setLongSwipePx(px + SWIPE_GAP);
              }
            }}
          />
          <span className="hint">How far you pull before a swipe counts: Mark read on the read side, Save on the other.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="long-swipe">
            Long swipe distance: <b>{longPx} px</b>
          </label>
          <input
            id="long-swipe"
            type="range"
            min={Math.max(LONG_SWIPE_MIN, shortPx + SWIPE_GAP)}
            max={LONG_SWIPE_MAX}
            step={5}
            value={longPx}
            onChange={(e) => {
              const px = Math.max(Number(e.target.value), shortPx + SWIPE_GAP);
              setLongPx(px);
              setLongSwipePx(px);
            }}
          />
          <span className="hint">
            How far you pull before it switches to Not interested (read side) or Star and read (save side). Always at least {SWIPE_GAP} px past the swipe
            distance. Both are kept on this device.
            {(longPx !== LONG_SWIPE_DEFAULT || shortPx !== SHORT_SWIPE_DEFAULT) && (
              <>
                {' '}
                <button
                  className="linkbtn"
                  onClick={() => {
                    setShortPx(SHORT_SWIPE_DEFAULT);
                    setShortSwipePx(SHORT_SWIPE_DEFAULT);
                    setLongPx(LONG_SWIPE_DEFAULT);
                    setLongSwipePx(LONG_SWIPE_DEFAULT);
                  }}
                >
                  Back to {SHORT_SWIPE_DEFAULT} / {LONG_SWIPE_DEFAULT} px
                </button>
              </>
            )}
          </span>
        </div>
        {(['reddit', 'youtube'] as AppSite[]).map((site) => (
          <OpenInPicker key={site} site={site} />
        ))}
        <div className="field">
          <span className="label">AI notes card<Help topic="notesPlace" /></span>
          <div className="segmented" role="group" aria-label="AI notes card">
            {(['top', 'bottom'] as NotesPlace[]).map((place) => (
              <button
                key={place}
                aria-pressed={notesPlace === place}
                onClick={() => {
                  setNotesPlace(place);
                  setNotesPlaceState(place);
                }}
              >
                {place === 'top' ? 'Top of article' : 'Bottom of article'}
              </button>
            ))}
          </div>
          <span className="hint">
            Where answers about your highlights show in the reader. At the bottom, a small “notes ↓” tag at the top says they’re
            there. Tapping a highlight jumps to its note either way.
          </span>
        </div>
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>
            Hide sponsored sections
            <Help topic="hideSponsored" />
          </span>
          <input
            type="checkbox"
            checked={hideSponsored}
            onChange={(e) => {
              setHideSponsored(e.target.checked);
              setHide(e.target.checked);
            }}
          />
        </label>
        <span className="hint">
          Sponsor blocks are collapsed in the reader; a note shows how many, with a tap to reveal them. Images are off until
          you tap “Load images”, or “Always” for that newsletter.
        </span>
      </section>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'am' : 'pm'}`;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Weekly and monthly reviews: when they're built, what goes in, how much web searching. */
function ReviewsSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const [building, setBuilding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [quality, setQuality] = useState<ReviewQuality | null>(null);
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([settings.timezone, deviceZone, 'UTC'])];
  const r = settings.reviews;
  const saveReviews = (patch: Partial<ReviewSettings>) => onSave({ reviews: { ...r, ...patch } });
  const on = r.weekly || r.monthly;
  // Sliders save when let go, not on every step.
  const [weekly, setWeekly] = useState(r.weeklySearches);
  const [monthly, setMonthly] = useState(r.monthlySearches);
  useEffect(() => {
    setWeekly(r.weeklySearches);
    setMonthly(r.monthlySearches);
  }, [r.weeklySearches, r.monthlySearches]);
  useEffect(() => {
    api.reviewQuality().then(setQuality).catch(() => undefined);
  }, []);
  const perMonth = Math.round((r.weekly ? weekly * 4.35 : 0) + (r.monthly ? monthly : 0));

  async function buildNow(kind: ReviewKind) {
    setBuilding(true);
    setNote(null);
    try {
      const rv = await api.buildReview(kind);
      setNote(`Built the review for ${rv.pack.label}. The PC writes its words and web findings next.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not build the review');
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="section">
      <span className="label">Reviews</span>
      <section className="card">
        <span className="hint">
          A look back over the week (and, if you like, the month): stories that moved, how your topics are trending, source changes, what you
          starred, and a few things the PC finds on the web. They replaced the daily digest; its lead stories live on as Top of the week.
        </span>
        <OptionSwitch label="Weekly review" help="reviewWeekly" value={r.weekly} onChange={(v) => void saveReviews({ weekly: v })} />
        <OptionSwitch label="Monthly review (longer view)" help="reviewMonthly" value={r.monthly} onChange={(v) => void saveReviews({ monthly: v })} />
        {!on && <span className="hint">Off: no reviews are built and the Review tab is hidden. Earlier reviews are kept.</span>}
        {on && (
          <>
            <div className="inline" style={{ flexWrap: 'wrap' }}>
              {r.weekly && (
                <div className="field" style={{ flex: 1, minWidth: 130 }}>
                  <label htmlFor="review-day">Weekly on</label>
                  <select id="review-day" className="input" value={r.weekDay} onChange={(e) => void saveReviews({ weekDay: Number(e.target.value) })}>
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field" style={{ flex: 1, minWidth: 110 }}>
                <label htmlFor="review-hour">
                  At<Help topic="reviewWhen" />
                </label>
                <select id="review-hour" className="input" value={r.hour} onChange={(e) => void saveReviews({ hour: Number(e.target.value) })}>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 2, minWidth: 160 }}>
                <label htmlFor="review-zone">Time zone</label>
                <select id="review-zone" className="input" value={settings.timezone} onChange={(e) => void onSave({ timezone: e.target.value })}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z === deviceZone ? `${z} (this device)` : z}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {r.monthly && <span className="hint">The monthly review is built on the 1st at the same hour and covers the month before.</span>}

            <div className="field">
              <label htmlFor="review-ws-week">
                Web searches per weekly review: <b>{weekly}</b>
                <Help topic="reviewSearches" />
              </label>
              <input
                id="review-ws-week"
                type="range"
                min={0}
                max={MAX_REVIEW_SEARCHES}
                value={weekly}
                onChange={(e) => setWeekly(Number(e.target.value))}
                onPointerUp={() => void saveReviews({ weeklySearches: weekly })}
                onKeyUp={() => void saveReviews({ weeklySearches: weekly })}
              />
            </div>
            {r.monthly && (
              <div className="field">
                <label htmlFor="review-ws-month">
                  Web searches per monthly review: <b>{monthly}</b>
                </label>
                <input
                  id="review-ws-month"
                  type="range"
                  min={0}
                  max={MAX_REVIEW_SEARCHES}
                  value={monthly}
                  onChange={(e) => setMonthly(Number(e.target.value))}
                  onPointerUp={() => void saveReviews({ monthlySearches: monthly })}
                  onKeyUp={() => void saveReviews({ monthlySearches: monthly })}
                />
              </div>
            )}
            <span className="hint">
              About {perMonth} searches a month from your web search budget. Each review also has a Find more button for a few extra.
              {quality && quality.findings > 0
                ? ` Last 8 weeks: ${quality.findings} findings from ${quality.searches} searches, ${quality.notUseful} marked not useful.`
                : ''}
            </span>

            <div className="switchrow">
              <span style={{ fontSize: 14 }}>
                Trend chart opens at<Help topic="reviewChart" />
              </span>
              <div className="segmented" role="group" aria-label="Trend chart range" style={{ width: 240 }}>
                {REVIEW_CHART_WEEKS.map((n) => (
                  <button key={n} aria-pressed={r.chartWeeks === n} onClick={() => void saveReviews({ chartWeeks: n })}>
                    {n === 12 ? '12 weeks' : n === 26 ? '6 months' : '1 year'}
                  </button>
                ))}
              </div>
            </div>
            <div className="switchrow">
              <span style={{ fontSize: 14 }}>Top of the week stories</span>
              <div className="segmented" role="group" aria-label="Lead stories" style={{ width: 160 }}>
                {[1, 3, 5].map((n) => (
                  <button key={n} aria-pressed={r.topStories === n} onClick={() => void saveReviews({ topStories: n })}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>
                Parts to include<Help topic="reviewParts" />
              </label>
              <div className="chipedit">
                {REVIEW_PARTS.filter((p) => p.kinds.some((k) => (k === 'week' ? r.weekly : r.monthly))).map((p) => {
                  const off = r.skipParts.includes(p.part);
                  return (
                    <button
                      key={p.part}
                      className={`chip ${off ? 'chip--outline' : 'chip--category'}`}
                      aria-pressed={!off}
                      style={{ textDecoration: off ? 'line-through' : 'none' }}
                      onClick={() => void saveReviews({ skipParts: off ? r.skipParts.filter((x) => x !== p.part) : [...r.skipParts, p.part] })}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <span className="hint">Tap a part to leave it out; struck-through ones are skipped from the next review.</span>
            </div>
            <div className="field">
              <label>
                Leave out categories<Help topic="reviewSkip" />
              </label>
              <div className="chipedit">
                {settings.categories.map((c) => {
                  const off = r.skipCategories.includes(c);
                  return (
                    <button
                      key={c}
                      className={`chip ${off ? 'chip--outline' : 'chip--category'}`}
                      aria-pressed={off}
                      style={{ textDecoration: off ? 'line-through' : 'none' }}
                      onClick={() => void saveReviews({ skipCategories: off ? r.skipCategories.filter((x) => x !== c) : [...r.skipCategories, c] })}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
            <OptionSwitch
              label="Done also marks the lead stories and story items read (changeable on each review)"
              help="reviewDone"
              value={r.doneMarksRead}
              onChange={(v) => void saveReviews({ doneMarksRead: v })}
            />
            <OptionSwitch label="Also put each review in the inbox" help="reviewInbox" value={r.inInbox} onChange={(v) => void saveReviews({ inInbox: v })} />
            <div className="inline">
              {r.weekly && (
                <button className="btn btn--small" disabled={building} onClick={() => void buildNow('week')}>
                  {building ? 'Building…' : 'Build weekly now'}
                </button>
              )}
              {r.monthly && (
                <button className="btn btn--small" disabled={building} onClick={() => void buildNow('month')}>
                  Build last month now
                </button>
              )}
              <Link to="/review" className="btn btn--ghost btn--small">
                Open reviews
              </Link>
            </div>
            {note && <span className="hint">{note}</span>}
          </>
        )}
      </section>
    </div>
  );
}

/** Stories: related reading grouped by chain of events. */
function StoriesSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const st = settings.stories;
  return (
    <div className="section">
      <span className="label">Stories</span>
      <section className="card">
        <p className="hint" style={{ margin: 0 }}>
          Articles about the same chain of events are joined into a story, shown at the top of an article with what's new since you last read about
          it. How strict the matching is, and how it's doing, is under <Link to="/stats/stories">Statistics &gt; Stories</Link>.
        </p>
        <OptionSwitch
          label="Show the same news from several sources as one inbox row"
          help="storyGroup"
          value={st.groupSameNews}
          onChange={(v) => void onSave({ stories: { ...st, groupSameNews: v } })}
        />
        <OptionSwitch
          label="Your PC writes what each new article adds to its story"
          help="storyNotes"
          value={st.notes}
          onChange={(v) => void onSave({ stories: { ...st, notes: v } })}
        />
        <Choice
          label="Join a story across (days)"
          help="storyDays"
          value={st.joinDays ?? 30}
          options={STORY_DAYS_CHOICES.map((n) => [n, String(n)] as const)}
          onChange={(v) => void onSave({ stories: { ...st, joinDays: v } })}
          width={260}
        />
        <OptionSwitch
          label="Summarise every story automatically"
          help="storyAuto"
          value={st.autoSummaries}
          onChange={(v) => void onSave({ stories: { ...st, autoSummaries: v } })}
        />
        <span className="hint">
          Your PC writes a whole-story summary as soon as a story forms, and writes it again each time an article joins. It covers stories from the last two
          weeks. You can still switch it off for one story on its page.
        </span>
        {settings.categories.length > 0 && (
          <div className="field">
            <label>Stories by category<Help topic="storyCategories" /></label>
            {settings.categories.map((c) => {
              const mode = st.categories[c] ?? 'normal';
              return (
                <div key={c} className="switchrow">
                  <span style={{ fontSize: 14 }}>{c}</span>
                  <div className="segmented" role="group" aria-label={`Stories for ${c}`}>
                    {(['normal', 'strict', 'off'] as const).map((m) => (
                      <button
                        key={m}
                        aria-pressed={mode === m}
                        onClick={() => {
                          const categories = { ...st.categories };
                          if (m === 'normal') delete categories[c];
                          else categories[c] = m;
                          void onSave({ stories: { ...st, categories } }).then(() => {
                            // New articles use the change; older story links stay unless you ask.
                            if (m !== 'normal' && window.confirm(`Also take ${c} articles already in stories out and match them again? Cancel keeps them as they are.`))
                              return api.recheckStories(c).then(() => undefined);
                            return undefined;
                          });
                        }}
                      >
                        {m === 'normal' ? 'Normal' : m === 'strict' ? 'Stricter' : 'Off'}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <span className="hint">
              Stricter needs a much closer match and a shared specific tag, for things like comics whose titles look alike. Off keeps a category out of
              stories. A change applies to new articles; you’re asked whether to match the ones already in stories again. Articles from the same source always need a slightly closer match.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

/** A labelled row of buttons, one per choice. */
export function Choice<T extends string | number>({
  label,
  help,
  value,
  options,
  onChange,
  width,
}: {
  label: string;
  help?: HelpTopic;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  width?: number;
}) {
  return (
    <div className="switchrow">
      <span style={{ fontSize: 14 }}>
        {label}
        {help && <Help topic={help} />}
      </span>
      <div className="segmented" role="group" aria-label={label} style={width ? { width } : undefined}>
        {options.map(([v, text]) => (
          <button key={String(v)} aria-pressed={value === v} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function OptionSwitch({ label, value, onChange, help }: { label: string; value: boolean; onChange: (v: boolean) => void; help?: HelpTopic }) {
  return (
    <label className="switchrow">
      <span style={{ fontSize: 14 }}>
        {label}
        {help && <Help topic={help} />}
      </span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
