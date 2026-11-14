// Security alerts: Have I Been Pwned's free alert emails (Notify me for single
// addresses, Domain search for whole domains) sent to the app's alerts address,
// kept as one breach each with the addresses it hit, a to-do list and a history.
// The app itself only ever reads HIBP's public breach list, which carries no
// addresses; nothing of yours is sent anywhere.

/** The address HIBP's alerts (and its sign-in codes) go to, on the mail domain. */
export const ALERTS_LOCAL_PART = 'alerts';
/** The domain HIBP's mail comes from. */
export const HIBP_DOMAIN = 'haveibeenpwned.com';
export const HIBP_SITE = 'https://haveibeenpwned.com';

/** high: passwords, bank or ID details; medium: other personal data; low: email-only or spam lists; watch: a site you get mail from. */
export type BreachLevel = 'high' | 'medium' | 'low' | 'watch';
export type SecurityLevel = 'off' | 'ok' | BreachLevel;

/** What the shield button and the inbox banner show; read with the inbox counts. */
export interface SecuritySummary {
  level: SecurityLevel;
  /** Breaches still to deal with that count for the button. */
  open: number;
  top: { title: string; who: string; leaked: string; level: BreachLevel } | null;
  /** Show the banner (the switch, and something at a level the banner covers). */
  banner: boolean;
}

export const NO_SECURITY: SecuritySummary = { level: 'off', open: 0, top: null, banner: false };

/** An address or a whole domain being watched, with whose it is. */
export interface WatchEntry {
  id: string;
  /** An email address, or a domain (no @). Lower case. */
  target: string;
  /** Whose it is, e.g. "Me" or a family member's name. Kept in this app only. */
  person: string;
  /** Ticked by you once HIBP is set up for it (verified domain, Notify me + forwarding). */
  setupDone: boolean;
}

export interface SecuritySettings {
  /** Banner in the inbox while a breach is still to deal with. */
  banner: boolean;
  /** Also flag breaches at sites you get mail from (HIBP's newest breach, checked hourly). */
  siteWatch: boolean;
  /** Banner for email-only leaks and spam lists too (otherwise they only colour the shield). */
  bannerLow: boolean;
  watch: WatchEntry[];
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = { banner: true, siteWatch: true, bannerLow: false, watch: [] };

/** One breach as HIBP describes it (its public breach list, no addresses). */
export interface BreachInfo {
  name: string;
  title: string;
  domain: string;
  /** YYYY-MM-DD the breach happened, as HIBP gives it. */
  breachDate: string | null;
  /** When HIBP loaded it (ms). */
  addedAt: number | null;
  modifiedAt: number | null;
  pwnCount: number | null;
  /** HIBP's description; HTML with links. */
  description: string;
  logo: string | null;
  dataClasses: string[];
  verified: boolean;
  sensitive: boolean;
  spamList: boolean;
  fabricated: boolean;
  malware: boolean;
}

export type HitVia = 'alert' | 'domain' | 'past';

/** One of your addresses in a breach. */
export interface BreachHit {
  /** The address, "@domain" when HIBP only said "addresses on your domain", or "" when the email named none. */
  address: string;
  person: string | null;
  via: HitVia;
  seenAt: number;
  /** For "@domain" hits: how many addresses HIBP said, when it said. */
  count: number | null;
  /** A newsletter address on the mail domain: the app's address and the sources using it. */
  addressId: string | null;
  sources: { id: string; name: string }[];
}

export type BreachOrigin = 'alert' | 'past' | 'site';

export interface SecurityBreach {
  name: string;
  info: BreachInfo;
  origin: BreachOrigin;
  level: BreachLevel;
  state: 'open' | 'handled';
  firstSeenAt: number;
  updatedAt: number;
  handledAt: number | null;
  /** Something new since you last opened it. */
  unseen: boolean;
  hits: BreachHit[];
  todoDone: string[];
  /** For a site you get mail from: the sources that matched its domain. */
  siteSources: { id: string; name: string }[];
}

export interface SecurityEvent {
  at: number;
  kind: 'announced' | 'alert' | 'past' | 'changed' | 'handled' | 'reopened';
  text: string;
  mailId: string | null;
}

export interface SecurityMail {
  id: string;
  receivedAt: number;
  from: string;
  subject: string;
  /** Cloudflare vouched the mail really came from Have I Been Pwned (or from your own sign-in address). */
  genuine: boolean;
  fromHibp: boolean;
  /** Breaches this mail was read as. */
  breaches: string[];
}

export interface SecurityMailPage extends SecurityMail {
  text: string;
}

export interface SecurityView {
  summary: SecuritySummary;
  open: SecurityBreach[];
  history: SecurityBreach[];
  mail: SecurityMail[];
  watching: number;
  alertsAddress: string;
  lastCheckAt: number | null;
  checkError: string | null;
}

export interface SecurityBreachPage {
  breach: SecurityBreach;
  events: SecurityEvent[];
  seenBefore: number | null;
}

export interface WatchStatus extends WatchEntry {
  kind: 'address' | 'domain';
  lastAlertAt: number | null;
  breaches: number;
}

export interface SecuritySettingsView {
  settings: SecuritySettings;
  watch: WatchStatus[];
  alertsAddress: string;
  /** Some mail from HIBP has reached the alerts address (so signing in there worked). */
  hibpMailSeen: boolean;
  lastCheckAt: number | null;
  checkError: string | null;
}

// ---------- Helpers both sides use ----------

const HIGH = [
  'passwords',
  'password hints',
  'security questions and answers',
  'credit cards',
  'partial credit card data',
  'credit card cvv',
  'bank account numbers',
  'financial transactions',
  'government issued ids',
  'passport numbers',
  'social security numbers',
  'national ids',
  'auth tokens',
  'private messages',
  'pins',
  'tax file numbers',
  'driver’s licenses',
  "driver's licenses",
  'health insurance information',
  'medical records',
];
const LOW_ONLY = ['email addresses', 'names', 'usernames', 'spam list'];

export function breachLevel(dataClasses: string[], spamList: boolean): Exclude<BreachLevel, 'watch'> {
  const lower = dataClasses.map((d) => d.toLowerCase());
  if (lower.some((d) => HIGH.includes(d))) return 'high';
  if (spamList || lower.every((d) => LOW_ONLY.includes(d))) return 'low';
  return 'medium';
}

/** The data classes that matter most, first. */
export function sortDataClasses(dataClasses: string[]): string[] {
  const rank = (d: string) => (HIGH.includes(d.toLowerCase()) ? 0 : LOW_ONLY.includes(d.toLowerCase()) ? 2 : 1);
  return [...dataClasses].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export const isHighClass = (d: string) => HIGH.includes(d.toLowerCase());

/** "passwords and phone numbers" from the two most serious data classes. */
export function leakedPhrase(dataClasses: string[]): string {
  const top = sortDataClasses(dataClasses)
    .filter((d) => d.toLowerCase() !== 'email addresses')
    .slice(0, 2)
    .map((d) => d.toLowerCase());
  if (!top.length) return 'email addresses';
  return top.join(' and ');
}

const ms = (s: unknown): number | null => {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** One entry of HIBP's breach API (PascalCase) as a BreachInfo; null if it isn't one. */
export function breachFromHibp(raw: unknown): BreachInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const name = str(b.Name, 120).trim();
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const logo = str(b.LogoPath, 400);
  return {
    name,
    title: str(b.Title, 200).trim() || name,
    domain: str(b.Domain, 200).trim().toLowerCase(),
    breachDate: /^\d{4}-\d{2}-\d{2}/.test(str(b.BreachDate, 20)) ? str(b.BreachDate, 10) : null,
    addedAt: ms(b.AddedDate),
    modifiedAt: ms(b.ModifiedDate),
    pwnCount: typeof b.PwnCount === 'number' && Number.isFinite(b.PwnCount) ? b.PwnCount : null,
    description: str(b.Description, 4000),
    logo: /^https:\/\//.test(logo) ? logo : null,
    dataClasses: Array.isArray(b.DataClasses) ? b.DataClasses.filter((d): d is string => typeof d === 'string').map((d) => d.slice(0, 80)).slice(0, 60) : [],
    verified: b.IsVerified === true,
    sensitive: b.IsSensitive === true,
    spamList: b.IsSpamList === true,
    fabricated: b.IsFabricated === true,
    malware: b.IsMalware === true,
  };
}

/** A BreachInfo sent back by the app (Add past breaches), cleaned. */
export function cleanBreachInfo(raw: unknown): BreachInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<BreachInfo>;
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    name,
    title: str(b.title, 200).trim() || name,
    domain: str(b.domain, 200).trim().toLowerCase(),
    breachDate: typeof b.breachDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.breachDate) ? b.breachDate : null,
    addedAt: num(b.addedAt),
    modifiedAt: num(b.modifiedAt),
    pwnCount: num(b.pwnCount),
    description: str(b.description, 4000),
    logo: typeof b.logo === 'string' && /^https:\/\//.test(b.logo) ? b.logo.slice(0, 400) : null,
    dataClasses: Array.isArray(b.dataClasses) ? b.dataClasses.filter((d): d is string => typeof d === 'string').map((d) => d.slice(0, 80)).slice(0, 60) : [],
    verified: b.verified === true,
    sensitive: b.sensitive === true,
    spamList: b.spamList === true,
    fabricated: b.fabricated === true,
    malware: b.malware === true,
  };
}

/** A placeholder until HIBP's details are fetched. */
export function bareBreach(name: string, title?: string): BreachInfo {
  return {
    name,
    title: title?.trim() || name,
    domain: '',
    breachDate: null,
    addedAt: null,
    modifiedAt: null,
    pwnCount: null,
    description: '',
    logo: null,
    dataClasses: [],
    verified: false,
    sensitive: false,
    spamList: false,
    fabricated: false,
    malware: false,
  };
}

/** What changed between two descriptions of the same breach, in words; empty if nothing that matters. */
export function breachChanges(before: BreachInfo, after: BreachInfo): string[] {
  const out: string[] = [];
  if (before.pwnCount !== null && after.pwnCount !== null && after.pwnCount !== before.pwnCount) {
    out.push(`Accounts: ${before.pwnCount.toLocaleString('en-NZ')} → ${after.pwnCount.toLocaleString('en-NZ')}`);
  }
  const added = after.dataClasses.filter((d) => !before.dataClasses.includes(d));
  if (before.dataClasses.length && added.length) out.push(`Also leaked: ${added.join(', ')}`);
  if (!before.verified && after.verified) out.push('Now confirmed as genuine by Have I Been Pwned');
  if (!before.spamList && after.spamList) out.push('Now marked as a spam list');
  if (!before.fabricated && after.fabricated) out.push('Now marked as probably made up');
  return out;
}

export interface ParsedAlert {
  /** HIBP breach names linked from the email. */
  names: string[];
  /** A breach title the wording names ("... the Example data breach"), for when there's no link. */
  title: string | null;
  /** Every email address in the email, lower case, HIBP's own left out. */
  addresses: string[];
  /** "N addresses" when the email gives a count. */
  count: number | null;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Reads an HIBP alert email (Notify me, or a domain alert). Kept loose: their wording may change. */
export function parseHibpAlert(text: string): ParsedAlert {
  const names = new Set<string>();
  for (const m of text.matchAll(/haveibeenpwned\.com\/(?:PwnedWebsites#|Breach\/|breach\/|api\/v\d\/breach\/)([A-Za-z0-9_.-]+)/gi)) {
    const n = m[1]!.replace(/[.]+$/, '');
    if (n && !/^(api|v\d|faqs?|dashboard|notifyme|unsubscribe)$/i.test(n)) names.add(n);
  }
  const titleMatch = /\b(?:in|from|to) the ([^\n.]{2,80}?) (?:data )?breach\b/i.exec(text) ?? /^[ \t]*breach(?: name)?:[ \t]*["“]?([^\n"”]{2,80})/im.exec(text);
  const addresses = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const a = m[0].toLowerCase().replace(/^[.]+|[.]+$/g, '');
    const domain = a.split('@')[1] ?? '';
    if (domain === HIBP_DOMAIN || domain.endsWith(`.${HIBP_DOMAIN}`)) continue;
    addresses.add(a);
  }
  const countMatch = /\b(\d[\d,]*)\s+(?:breached\s+|pwned\s+)?(?:email\s+)?addresses?\b/i.exec(text);
  const count = countMatch ? Number(countMatch[1]!.replace(/,/g, '')) : null;
  return { names: [...names].slice(0, 10), title: titleMatch?.[1]?.trim() ?? null, addresses: [...addresses].slice(0, 50), count: Number.isFinite(count) ? count : null };
}

/** Breaches whose title or name appears in pasted text (HIBP's results page), longest first so "GameHub 2" beats "GameHub". */
export function breachesInText(text: string, catalogue: BreachInfo[]): string[] {
  let hay = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  const found = new Set<string>();
  const sorted = [...catalogue].sort((a, b) => b.title.length - a.title.length);
  for (const b of sorted) {
    for (const label of [b.title, b.name]) {
      const l = label.toLowerCase().trim();
      if (l.length < 3) continue;
      const esc = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, 'g');
      if (re.test(hay)) {
        found.add(b.name);
        // Blank it out so a shorter title inside it ("GameHub" in "GameHub 2") doesn't match too.
        hay = hay.replace(re, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
        break;
      }
    }
  }
  return [...found];
}

export interface TodoStep {
  key: string;
  text: string;
}

/** The to-do list for a breach, from what leaked and whose addresses were in it. */
export function breachTodo(b: Pick<SecurityBreach, 'info' | 'hits' | 'origin'>): TodoStep[] {
  const site = b.info.title;
  const lower = b.info.dataClasses.map((d) => d.toLowerCase());
  const has = (...words: string[]) => lower.some((d) => words.some((w) => d.includes(w)));
  const steps: TodoStep[] = [];
  if (b.origin === 'site') {
    steps.push({ key: 'check', text: `Check whether you had an account with ${site}, and change its password if you did` });
    steps.push({ key: 'scam', text: `Expect scam emails that mention ${site}` });
    return steps;
  }
  if (has('password')) {
    steps.push({ key: 'password', text: `Change your ${site} password` });
    steps.push({ key: 'reuse', text: 'Change it anywhere you used the same password' });
    steps.push({ key: '2fa', text: 'Turn on two-step sign-in where you can' });
  } else if (!b.info.spamList) {
    steps.push({ key: 'account', text: `Check your ${site} account still looks right` });
  }
  if (has('security question')) steps.push({ key: 'questions', text: 'Change the security questions and answers you used there' });
  if (has('credit card', 'bank', 'financial')) steps.push({ key: 'bank', text: 'Watch your bank and card statements; ask the bank about a new card if card numbers leaked' });
  if (has('government', 'passport', 'driver', 'national id', 'tax')) steps.push({ key: 'id', text: 'Ask the issuer about replacing the ID that leaked' });
  if (has('phone')) steps.push({ key: 'phone', text: `Expect scam texts and calls that mention ${site} (your phone number leaked)` });
  else steps.push({ key: 'scam', text: `Expect scam emails that mention ${site}` });
  if (b.hits.some((h) => h.addressId)) steps.push({ key: 'alias', text: 'Decide whether to stop accepting the newsletter address that leaked' });
  const others = [...new Set(b.hits.map((h) => h.person).filter((p): p is string => !!p && !/^me$/i.test(p)))];
  for (const p of others) steps.push({ key: `tell:${p.toLowerCase()}`, text: `Tell ${p}` });
  return steps;
}

/** Whether an address belongs to a watch entry (the address itself, or its domain). */
export function watchFor(address: string, watch: WatchEntry[]): WatchEntry | null {
  const a = address.toLowerCase();
  const exact = watch.find((w) => w.target === a);
  if (exact) return exact;
  const domain = a.startsWith('@') ? a.slice(1) : a.split('@')[1];
  if (!domain) return null;
  return watch.find((w) => !w.target.includes('@') && (domain === w.target || domain.endsWith(`.${w.target}`))) ?? null;
}

/** Shown in place of an address: "name@example.org", "addresses on example.com", or "address not named". */
export function hitLabel(h: Pick<BreachHit, 'address' | 'count'>): string {
  if (!h.address) return 'an address the alert didn’t name';
  if (h.address.startsWith('@')) {
    const d = h.address.slice(1);
    return h.count && h.count > 1 ? `${h.count} addresses on ${d}` : `address${h.count === 1 ? '' : 'es'} on ${d}`;
  }
  return h.address;
}
