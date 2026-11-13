// Find a way to follow: give the app a person, @handle, site, topic or link,
// and the PC searches out the ways to keep hearing from it (feeds, blogs,
// newsletters, GitHub, YouTube, Bluesky, Mastodon, topic watches), checks each
// one works, and lists them with a Follow button. Shared by the Worker, the
// PC helper and the web app.

/** What a lookup is about, as the PC understood it. The owner can untick any before the search. */
export type FollowThingKind = 'person' | 'org' | 'site' | 'topic' | 'subreddit';

export interface FollowThing {
  kind: FollowThingKind;
  name: string;
  /** An @handle, without the @, when one is known (often the same on X, GitHub and Bluesky). */
  handle?: string | null;
  url?: string | null;
  /** Ticked: included in the search. */
  on: boolean;
}

/**
 * understanding / searching: waiting for (or on) the PC.
 * confirm: the PC found several things; the owner picks which to look for.
 */
export type FollowStatus = 'understanding' | 'confirm' | 'searching' | 'done' | 'failed';

export type FollowVia =
  | 'website'
  | 'newsletter'
  | 'substack'
  | 'github'
  | 'youtube'
  | 'reddit'
  | 'bluesky'
  | 'mastodon'
  | 'podcast'
  | 'news'
  | 'hackernews'
  | 'x'
  | 'linkedin'
  | 'threads'
  | 'instagram'
  | 'facebook'
  | 'tiktok';

export type FollowGroup = 'best' | 'topic' | 'cant';

/** new: not acted on. already: a source you follow already has this feed or site. */
export type FollowCandidateState = 'new' | 'followed' | 'dismissed' | 'already';

export interface FollowCandidate {
  /** Unique within the lookup (the feed, else the page, else via + name). */
  key: string;
  group: FollowGroup;
  via: FollowVia;
  title: string;
  /** The page to open. */
  url: string;
  /** The feed to follow; null for a page to watch, a newsletter or something you can't follow. */
  feedUrl: string | null;
  /** Watch the page for new articles (no feed). */
  watch?: boolean;
  /** A newsletter's sign-up page (no feed): Subscribe by email makes an address for it. */
  signupUrl?: string | null;
  /** One line on why it's listed. */
  why: string;
  /** Which of the lookup's things it is for. */
  about?: string;
  /** How sure the PC is that it's the same person or organisation. Null for topics and sites. */
  same: 'high' | 'medium' | 'low' | null;
  postsPerWeek: number | null;
  lastPostAt: number | null;
  samples: { title: string; url: string | null }[];
  /** Read by the PC (Reddit turns Cloudflare away). */
  viaPc?: boolean;
  state: FollowCandidateState;
  sourceId?: string | null;
}

export interface FollowLookup {
  id: string;
  query: string;
  url: string | null;
  status: FollowStatus;
  things: FollowThing[];
  candidates: FollowCandidate[];
  error: string | null;
  searches: number;
  model: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** Set while waiting for the PC: when the helper last checked in. */
  helperLastSeenAt?: number | null;
  /** AI is paused in Settings, so the PC won't pick this up. */
  aiPaused?: boolean;
}

export interface FollowLookupListItem {
  id: string;
  query: string;
  status: FollowStatus;
  createdAt: number;
  /** Ways found, not counting the "can't follow here" ones. */
  found: number;
  followed: number;
}

export interface NewFollowLookup {
  query: string;
  url?: string | null;
}

/** One stage of a lookup for the PC. */
export interface FollowJob {
  lookupId: string;
  stage: 'understand' | 'search';
  query: string;
  url: string | null;
  things: FollowThing[];
  /** Web searches this lookup may use (0 when the month's budget is used up). */
  searchesAllowed: number;
  understandPrompt: string;
  rankPrompt: string;
}

export interface FollowResult {
  lookupId: string;
  ok: boolean;
  stage: 'understand' | 'search';
  things?: FollowThing[];
  candidates?: Omit<FollowCandidate, 'state' | 'sourceId'>[];
  searches: number;
  error?: string;
  provider?: string;
  model?: string;
  seconds?: number;
}

// ---------- Helpers ----------

const SOCIAL: { re: RegExp; via: FollowVia; name: string; why: string }[] = [
  {
    re: /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i,
    via: 'x',
    name: 'X (Twitter)',
    why: "There's no free way to bring X posts in. You can still share a single X post into the app to save it.",
  },
  { re: /^https?:\/\/([\w-]+\.)?linkedin\.com\//i, via: 'linkedin', name: 'LinkedIn', why: 'LinkedIn has no feeds and blocks outside readers.' },
  { re: /^https?:\/\/(www\.)?threads\.(net|com)\//i, via: 'threads', name: 'Threads', why: 'Threads has no public feeds.' },
  { re: /^https?:\/\/(www\.)?instagram\.com\//i, via: 'instagram', name: 'Instagram', why: 'Instagram has no public feeds.' },
  { re: /^https?:\/\/([\w-]+\.)?facebook\.com\//i, via: 'facebook', name: 'Facebook', why: 'Facebook has no public feeds.' },
  { re: /^https?:\/\/(www\.)?tiktok\.com\//i, via: 'tiktok', name: 'TikTok', why: 'TikTok has no public feeds.' },
];

/** A profile on a network the app can't follow, with why; null for anything else. */
export function cantFollow(url: string): { via: FollowVia; name: string; why: string; handle: string | null } | null {
  for (const s of SOCIAL) {
    if (!s.re.test(url)) continue;
    let handle: string | null = null;
    try {
      const first = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
      if (first && !/^(in|company|i|home|search|hashtag|status|p|reel|share|intent|watch)$/i.test(first)) handle = first.replace(/^@/, '');
      if (s.via === 'linkedin') handle = new URL(url).pathname.split('/').filter(Boolean)[1] ?? null;
    } catch {
      /* not a URL */
    }
    return { via: s.via, name: s.name, why: s.why, handle };
  }
  return null;
}

/** Free feeds that watch a topic: news coverage, Hacker News and Reddit posts that mention it. */
export function topicFeeds(topic: string): { via: FollowVia; title: string; url: string; feedUrl: string; viaPc?: boolean }[] {
  const q = topic.trim();
  const quoted = /\s/.test(q) ? `"${q}"` : q;
  const enc = encodeURIComponent(quoted);
  return [
    {
      via: 'news',
      title: `News about ${q}`,
      url: `https://news.google.com/search?q=${enc}`,
      feedUrl: `https://news.google.com/rss/search?q=${enc}&hl=en-NZ&gl=NZ&ceid=NZ:en`,
    },
    {
      via: 'hackernews',
      title: `Hacker News posts about ${q}`,
      url: `https://hn.algolia.com/?q=${encodeURIComponent(q)}`,
      feedUrl: `https://hnrss.org/newest?q=${enc}`,
    },
    {
      via: 'reddit',
      title: `Reddit posts about ${q}`,
      url: `https://www.reddit.com/search/?q=${enc}&sort=new`,
      feedUrl: `https://www.reddit.com/search.rss?q=${enc}&sort=new`,
      viaPc: true,
    },
  ];
}

/** How a candidate's source is labelled on its card. */
export const FOLLOW_VIA_LABEL: Record<FollowVia, string> = {
  website: 'Website',
  newsletter: 'Newsletter',
  substack: 'Substack',
  github: 'GitHub',
  youtube: 'YouTube',
  reddit: 'Reddit',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  podcast: 'Podcast',
  news: 'News',
  hackernews: 'Hacker News',
  x: 'X / Twitter',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};
