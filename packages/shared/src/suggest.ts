// Feed suggestions: sites the reader's own reading keeps pointing at, checked
// for a feed by the PC and ranked by how close their posts are to what the
// reader stars. These are the shared types and the link helpers both the
// Worker and the PC helper use.

import { attr, decodeEntities } from './web';

// ---------- Domains ----------

/** Hosts where each subdomain is someone's own site (alice.substack.com), so they are kept whole. */
const MULTI_TENANT = [
  'substack.com',
  'medium.com',
  'blogspot.com',
  'wordpress.com',
  'github.io',
  'ghost.io',
  'tumblr.com',
  'bearblog.dev',
  'micro.blog',
  'neocities.org',
  'beehiiv.com',
  'buttondown.email',
  'netlify.app',
  'pages.dev',
  'vercel.app',
  'mataroa.blog',
  'svbtle.com',
  'typepad.com',
  'livejournal.com',
  'dreamwidth.org',
];

/** Second-level parts that sit under a country code (bbc.co.uk, abc.net.au). */
const SECOND_LEVEL = /^(co|com|org|net|ac|gov|edu|ne|or)$/;

/**
 * The site a link belongs to, as one key per site: lower case, without www or
 * m., and cut to the registered name (edition.cnn.com -> cnn.com) except on
 * blogging platforms, where each subdomain is its own site.
 */
export function siteKey(url: string): string | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return null;
  host = host.replace(/^(www\d?|m|amp|mobile)\./, '');
  for (const p of MULTI_TENANT) {
    if (host === p) return host;
    if (host.endsWith(`.${p}`)) {
      const sub = host.slice(0, -p.length - 1).split('.').pop()!;
      return `${sub}.${p}`;
    }
  }
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const keep = parts.length >= 3 && parts[parts.length - 1]!.length === 2 && SECOND_LEVEL.test(parts[parts.length - 2]!) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/**
 * Sites never worth suggesting as a feed: social networks, video and code
 * hosts, shops, link shorteners, mail services and reference sites. Links to
 * them say nothing about which publishers the reader likes.
 */
export const SUGGEST_SKIP = new Set([
  'google.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 't.co', 'facebook.com', 'fb.com', 'instagram.com',
  'linkedin.com', 'lnkd.in', 'tiktok.com', 'reddit.com', 'redd.it', 'threads.net', 'bsky.app', 'mastodon.social',
  'wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'github.com', 'gitlab.com', 'apple.com', 'amazon.com', 'amzn.to',
  'amzn.com', 'ebay.com', 'bit.ly', 'tinyurl.com', 'ow.ly', 'buff.ly', 'goo.gl', 'substack.com', 'medium.com',
  'beehiiv.com', 'mailchimp.com', 'list-manage.com', 'mailchi.mp', 'campaign-archive.com', 'convertkit.com',
  'kit.com', 'ck.page', 'sendgrid.net', 'mailerlite.com', 'buttondown.email', 'ghost.io', 'patreon.com',
  'paypal.com', 'stripe.com', 'spotify.com', 'soundcloud.com', 'twitch.tv', 'discord.gg', 'discord.com', 't.me',
  'telegram.org', 'whatsapp.com', 'zoom.us', 'calendly.com', 'eventbrite.com', 'meetup.com', 'archive.org',
  'archive.ph', 'archive.is', 'doi.org', 'imgur.com', 'giphy.com', 'flickr.com', 'pinterest.com', 'tumblr.com',
  'wordpress.com', 'blogspot.com', 'gravatar.com', 'gmail.com', 'outlook.com', 'microsoft.com', 'live.com',
  'office.com', 'dropbox.com', 'box.com', 'notion.so', 'notion.site', 'typeform.com', 'surveymonkey.com',
  'forms.gle', 'airtable.com', 'linktr.ee', 'cloudflare.com', 'w3.org', 'schema.org', 'creativecommons.org',
  'feedly.com', 'feedburner.com', 'ycombinator.com', 'producthunt.com', 'vimeo.com', 'dailymotion.com',
  'unsplash.com', 'shutterstock.com', 'gettyimages.com', 'cdn.com', 'cloudfront.net', 'amazonaws.com',
  'googleusercontent.com', 'gstatic.com', 'googleapis.com', 'doubleclick.net', 'play.google.com', 'apps.apple.com',
  'podcasts.apple.com', 'news.google.com', 'techylearnings.com', 'example.com', 'wa.me', 'tinyletter.com',
  'stackoverflow.com', 'stackexchange.com', 'quora.com', 'imdb.com', 'goodreads.com', 'etsy.com', 'walmart.com',
  'bestbuy.com', 'target.com', 'aliexpress.com', 'temu.com', 'shopify.com', 'gumroad.com', 'kickstarter.com',
  'indiegogo.com', 'gofundme.com', 'skimresources.com', 'skimlinks.com', 'awin1.com', 'shareasale.com',
  'pxf.io', 'sjv.io', 'anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com', 'kqzyfj.com', 'tkqlhce.com', 'linksynergy.com',
]);

/** Mail-tracking hosts: their links bounce through to the real page. */
const TRACKER_HOST =
  /(^|\.)(list-manage\.com|mailchi\.mp|sendgrid\.net|mcsv\.net|mandrillapp\.com|rs6\.net|exct\.net|sailthru\.com|createsend\d*\.com|cmail\d+\.com|hubspotlinks\.com|hs-sites\.com|mailerlite\.com|mlsend\.com|convertkit-mail\d*\.com|ck\.page|kit-mail\d*\.com|mailgun\.org|mailjet\.com|sparkpostmail\.com|klclick\d*\.com|klaviyomail\.com|pstmrk\.it|urldefense\.com|safelinks\.protection\.outlook\.com|emltrk\.com|awstrack\.me|r\.mail\.|click\.|clicks\.|links?\.|track\.|trk\.|email\.|e\.)/i;

const REDIRECT_PARAMS = ['url', 'u', 'target', 'redirect', 'redirect_url', 'redirect_to', 'r', 'link', 'dest', 'destination', 'to', 'q', 'href', 'goto'];

function decodeB64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return decodeURIComponent(
      Array.from(bin, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
  } catch {
    return null;
  }
}

/**
 * Where a link really goes, when that can be read from the link itself:
 * direct links as they are, and mail-tracking links whose destination is
 * written into them (a ?url= parameter, or Substack's encoded redirect).
 * Returns null for a tracking link that hides its destination; those are
 * never opened just to find out, since that would count as a click to the
 * sender (and could be an unsubscribe link).
 */
export function linkTarget(href: string): { url: string; tracked: boolean } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const redirect = /\/redirect\//.test(u.pathname);
  if (!redirect && !TRACKER_HOST.test(u.hostname)) return { url: u.toString(), tracked: false };
  for (const p of REDIRECT_PARAMS) {
    const v = u.searchParams.get(p);
    if (v && /^https?:\/\//i.test(v)) return { url: v, tracked: true };
  }
  // Substack: /redirect/2/<base64 JSON with "e": the destination>
  const m = /\/redirect\/(?:\d+\/)?([A-Za-z0-9_-]{20,})/.exec(u.pathname);
  if (m) {
    const json = decodeB64Url(m[1]!.split('.')[0]!);
    const e = json ? /"e"\s*:\s*"([^"]+)"/.exec(json)?.[1] : null;
    if (e && /^https?:\/\//i.test(e)) return { url: e.replace(/\\\//g, '/'), tracked: true };
  }
  return redirect && !TRACKER_HOST.test(u.hostname) && !/(^|\.)substack\.com$/i.test(u.hostname) ? { url: u.toString(), tracked: false } : null;
}

/** Link words that mean "not an article": account and list management, sharing, app stores. */
const NOT_CONTENT = /unsubscribe|manage (your )?(subscription|preferences)|update (your )?preferences|view (it )?in (your )?browser|view online|forward to a friend|privacy policy|terms of (service|use)|advertise|sponsor|share on|follow us|download the app|sign up|subscribe/i;

/** One site a piece of reading links to: how many links, and the words on the first one. */
export interface LinkCount {
  site: string;
  n: number;
}

/**
 * The outside sites an item links to, from its HTML: one row per site with the
 * number of links. Links to the item's own site, to the sites listed in
 * `own` (the sources the reader already follows), to big platforms and
 * account or unsubscribe links are left out.
 */
export function outboundSites(html: string, own: Set<string>, max = 40): LinkCount[] {
  const counts = new Map<string, number>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(html)) && seen < 2000) {
    seen += 1;
    const href = attr(`<a ${m[1]}>`, 'href');
    if (!href) continue;
    const words = decodeEntities(m[2]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (NOT_CONTENT.test(words) || NOT_CONTENT.test(href)) continue;
    const target = linkTarget(href);
    if (!target) continue;
    const site = siteKey(target.url);
    if (!site || SUGGEST_SKIP.has(site) || own.has(site)) continue;
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([site, n]) => ({ site, n: Math.min(n, 50) }));
}

// ---------- API shapes ----------

/** One item whose links the PC counts: its HTML and the sites to leave out. */
export interface LinkJob {
  itemId: string;
  html: string;
  /** The item's own page, so links back to its own site don't count. */
  webUrl: string | null;
}

export interface LinkResult {
  itemId: string;
  sites: LinkCount[];
}

/** A site the PC should check for a feed and score. */
export interface SuggestCheck {
  site: string;
}

/** What the PC found on one candidate site. */
export interface SuggestCheckResult {
  site: string;
  /** Null when the site has no feed the PC could find (or turned it away). */
  feedUrl: string | null;
  siteUrl: string | null;
  title: string | null;
  description: string | null;
  /** Latest posts: title and link. */
  samples: { title: string; url: string | null }[];
  postsPerWeek: number | null;
  lastPostAt: number | null;
  /** How close the posts are to the items marked Interesting, 0..1, or null with too few stars. */
  fit: number | null;
  /** The reader's items closest in meaning to the posts, for the topics shown on the card. */
  near: string[];
  error?: string | null;
}

/** The weekly run the PC is asked to do. */
export interface SuggestRun {
  /** Sites to check, at most a couple of dozen a run. */
  checks: SuggestCheck[];
}

export type SuggestionStatus = 'new' | 'followed' | 'dismissed' | 'nofeed';

/** Why a site is suggested: the numbers behind the "Why you're seeing this" lines. */
export interface SuggestionWhy {
  /** Items you read, saved or starred that link to it, and how many of those were starred. */
  items: number;
  starred: number;
  /** Different sources whose items link to it. */
  sources: number;
  /** Names of up to three of those sources. */
  sourceNames: string[];
  /** Times you tapped through to it from the reader. */
  clicks: number;
  /** Topics its posts share with your reading, with how many of your sources cover each. */
  topics: { tag: string; label: string; sources: number }[];
  /** Points added or taken off by what the app has learnt from your Follow and Not interested taps. */
  learnt: number;
}

export interface Suggestion {
  site: string;
  status: SuggestionStatus;
  title: string;
  feedUrl: string | null;
  siteUrl: string | null;
  description: string | null;
  samples: { title: string; url: string | null }[];
  postsPerWeek: number | null;
  lastPostAt: number | null;
  /** 0..100: how good a match the app thinks it is. */
  match: number;
  /** 0..100 closeness to what you star, or null before the PC has scored it. */
  fit: number | null;
  why: SuggestionWhy;
  sourceId: string | null;
  checkedAt: number | null;
  decidedAt: number | null;
}

export interface SuggestionList {
  suggestions: Suggestion[];
  /** When the PC last finished a run, and whether one is waiting. */
  lastRunAt: number | null;
  runWaiting: boolean;
  helperOnline: boolean;
  /** Items counted so far / still to count (the first run works through past reading). */
  linksCounted: number;
  linksWaiting: number;
  stars: number;
}

/** A learnt weight: a topic or a linking source, with its net count of yes (positive) and no. */
export interface SuggestLearnt {
  key: string;
  label: string;
  kind: 'topic' | 'source';
  net: number;
}

/** How a followed suggestion is doing: read share since it was followed. */
export interface SuggestFollowed {
  site: string;
  title: string;
  sourceId: string;
  followedAt: number;
  items: number;
  read: number;
  starred: number;
  /** Counted as a soft no: hardly opened after three weeks. Null while too early to tell. */
  verdict: 'reading' | 'not-opening' | null;
  /** Kept on purpose, so it no longer teaches the list either way. */
  ignored: boolean;
}

export interface SuggestLearntPage {
  learnt: SuggestLearnt[];
  followed: SuggestFollowed[];
  hidden: { site: string; title: string; decidedAt: number | null }[];
}
