import { SAVE_LOCAL_PART, type SaveEmailLogEntry, type SavePageResult } from '@newsletterapp/shared';
import type PostalMime from 'postal-mime';
import type { Env } from './env';
import { saveEmailCopy, savePage, saveUpload } from './feeds';
import { htmlToText } from './html';
import { normalizeEmail, now } from './ids';
import { loadSettings } from './settings';

type Parsed = Awaited<ReturnType<PostalMime['parse']>>;

/** Most links taken from one email; the rest are left out. */
const MAX_LINKS = 5;
/** Most PDF attachments kept from one email. */
const MAX_FILES = 3;
const LOG_KEY = 'saveLog';
const LOG_MAX = 20;

export const isSaveAddress = (localPart: string) => localPart === SAVE_LOCAL_PART;

/** Everyone allowed to send to the save address: the sign-in emails plus the extra senders in Settings. */
export function signInEmails(env: Env): string[] {
  return env.ALLOWED_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when the receiving server (Cloudflare) vouched that the mail really
 * came from the From address's domain: DMARC passed for it, or a DKIM
 * signature from that domain checked out. Only the first verdict of each kind
 * counts; it is the one Cloudflare added on top, and anything below it could
 * have been written by the sender.
 */
export function fromIsGenuine(headers: Iterable<[string, string]>, fromEmail: string): boolean {
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const aligned = (d: string | undefined) => !!d && (domain === d || domain.endsWith(`.${d}`));
  for (const [key, value] of headers) {
    if (key.toLowerCase() !== 'authentication-results') continue;
    const v = value.toLowerCase();
    const clause = (method: string) => {
      const at = v.search(new RegExp(`(?:^|[;\\s])${method}=`));
      if (at < 0) return null;
      const end = v.indexOf(';', at + 1);
      return v.slice(at, end < 0 ? undefined : end);
    };
    const dmarc = clause('dmarc');
    if (dmarc && /dmarc=pass/.test(dmarc) && aligned(/header\.from=([a-z0-9.-]+)/.exec(dmarc)?.[1])) return true;
    // Every DKIM result Cloudflare listed (they come before its DMARC result; a
    // sender can be signed twice, e.g. by Microsoft 365 and by its own domain).
    const ours = dmarc ? v.slice(0, v.indexOf(dmarc) + dmarc.length) : (clause('dkim') ?? '');
    for (const m of ours.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)) {
      if (aligned(m[1])) return true;
    }
    return false;
  }
  return false;
}

/** Fwd: / FW: subjects, or the forwarding block Gmail and Outlook put in the body. */
export function looksForwarded(subject: string, text: string): boolean {
  if (/^\s*(fwd?|fw)\s*:/i.test(subject)) return true;
  return /-{5,}\s*forwarded message\s*-{5,}/i.test(text) || /^-{3,}\s*original message\s*-{3,}\s*$/im.test(text);
}

/** The part of the body above the signature, sign-off or company footer. */
export function bodyAboveSignature(text: string): string {
  const stops = [
    /^-- ?$/m,
    /^_{5,}\s*$/m,
    /^(kind |best |warm )?regards,?\s*$/im,
    /^(thanks|thank you|cheers|ngā mihi|nga mihi),?\s*$/im,
    /^sent from my /im,
    /^get outlook for /im,
    /^(caution|disclaimer|confidential(ity)?( notice)?)\b/im,
    /^this (e-?mail|message) (and any attachments )?(is|may be) (confidential|intended)/im,
  ];
  let end = text.length;
  for (const re of stops) {
    const m = re.exec(text);
    if (m && m.index < end) end = m.index;
  }
  return text.slice(0, end);
}

/** Undoes the link wrappers mail systems add (Outlook Safe Links, Google redirects). */
export function unwrapLink(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('safelinks.protection.outlook.com')) return u.searchParams.get('url') ?? raw;
    if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url') return u.searchParams.get('q') ?? u.searchParams.get('url') ?? raw;
    return raw;
  } catch {
    return raw;
  }
}

/** Web addresses in the subject and the body above the signature, in order, without repeats. */
export function linksIn(subject: string, text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of [subject, bodyAboveSignature(text)]) {
    for (const m of part.matchAll(/https?:\/\/[^\s<>"'\])]+/gi)) {
      const link = unwrapLink(m[0].replace(/[.,;:!?]+$/, ''));
      if (!/^https?:\/\//i.test(link)) continue;
      const key = link.replace(/#.*$/, '').replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(link);
      if (out.length >= MAX_LINKS) return out;
    }
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text as paragraphs, for an email with no HTML part. */
const textAsHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

/** Who wrote a forwarded email, from the forwarding block ("From: Name <a@b.c>"). */
function forwardedAuthor(text: string): string | null {
  const m = /^\s*\*?from:\*?\s*(.+)$/im.exec(text);
  if (!m) return null;
  const line = m[1]!.trim();
  const name = line.replace(/<[^>]*>/, '').replace(/["*]/g, '').trim();
  return (name || line).slice(0, 200) || null;
}

async function addToLog(env: Env, entry: SaveEmailLogEntry): Promise<void> {
  const log = await readSaveLog(env);
  log.unshift(entry);
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3',
  )
    .bind(LOG_KEY, JSON.stringify(log.slice(0, LOG_MAX)), now())
    .run();
}

export async function readSaveLog(env: Env): Promise<SaveEmailLogEntry[]> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(LOG_KEY).first<{ value: string }>();
  try {
    const log = row ? (JSON.parse(row.value) as SaveEmailLogEntry[]) : [];
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

/**
 * Mail to save@: saves the links in it, its PDF attachments, or (for a
 * forwarded email or a note with no link) the email itself, under Saved pages.
 * Only the sign-in emails and the extra senders in Settings may use it, and only
 * when the mail provably came from them. Nothing here makes an address, a
 * sender or a newsletter source.
 */
export async function handleSaveEmail(
  env: Env,
  headers: Iterable<[string, string]>,
  parsed: Parsed | null,
  envelopeFrom: string | null,
): Promise<void> {
  const fromEmail = normalizeEmail(parsed?.from?.address) ?? envelopeFrom ?? '';
  const subject = (parsed?.subject ?? '').trim();
  const base = { at: now(), from: fromEmail || '(unknown)', subject: subject.slice(0, 200), itemIds: [] as string[] };

  const settings = await loadSettings(env);
  const allowed = new Set([...signInEmails(env), ...settings.saveSenders]);
  if (!fromEmail || !allowed.has(fromEmail)) {
    console.log(`save address: refused mail from ${fromEmail || 'unknown'}`);
    await addToLog(env, { ...base, outcome: 'refused', detail: 'Not on the list of addresses that can send here' });
    return;
  }
  if (!fromIsGenuine(headers, fromEmail)) {
    await addToLog(env, {
      ...base,
      outcome: 'refused',
      detail: "Your mail provider's signature didn't check out (DKIM/DMARC), so it may not really be from you",
    });
    return;
  }
  if (!parsed) {
    await addToLog(env, { ...base, outcome: 'refused', detail: "The email couldn't be read" });
    return;
  }

  const html = parsed.html ?? null;
  const text = parsed.text ?? (html ? htmlToText(html) : '');
  const saved: SavePageResult[] = [];
  const failures: string[] = [];

  // PDFs attached to the email: kept, and the PC reads their text (it fetches them from the app).
  const pdfs = (parsed.attachments ?? [])
    .filter((a) => (a.mimeType ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(a.filename ?? ''))
    .slice(0, MAX_FILES);
  const origin = env.APP_HOSTNAME?.trim() ? `https://${env.APP_HOSTNAME.trim()}` : null;
  for (const a of pdfs) {
    if (!origin) {
      failures.push(`${a.filename ?? 'PDF'} (app address not set)`);
      continue;
    }
    try {
      const content = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : a.content;
      saved.push(await saveUpload(env, origin, new File([content], a.filename || 'attachment.pdf', { type: 'application/pdf' })));
    } catch (err) {
      failures.push(`${a.filename ?? 'PDF'} (${err instanceof Error ? err.message : 'failed'})`);
    }
  }

  const forwarded = looksForwarded(subject, text);
  const links = forwarded ? [] : linksIn(subject, text);
  for (const link of links) {
    try {
      saved.push(await savePage(env, link));
    } catch (err) {
      console.error('save address: page failed', link, err);
      failures.push(link);
    }
  }

  // A forwarded email, or a note with nothing else to save: keep the email itself.
  if (forwarded || (links.length === 0 && pdfs.length === 0)) {
    const title = subject.replace(/^\s*((fwd?|fw)\s*:\s*)+/i, '').trim() || 'Note sent to the save address';
    const key = `email:${parsed.messageId ?? `${fromEmail}:${subject}:${text.length}`}`;
    saved.push(
      await saveEmailCopy(env, {
        key,
        title: title.slice(0, 500),
        author: (forwarded ? forwardedAuthor(text) : null) ?? parsed.from?.name ?? fromEmail,
        html: html ?? textAsHtml(text),
        text: text.replace(/\s+/g, ' ').trim() || null,
      }),
    );
  }

  const added = saved.filter((s) => !s.already).length;
  const already = saved.length - added;
  const parts = [
    added ? `Saved ${added === 1 ? `"${saved.find((s) => !s.already)!.title}"` : `${added} items`}` : null,
    already ? `${already} already in the app` : null,
    failures.length ? `couldn't save ${failures.join(', ')}` : null,
  ].filter(Boolean);
  await addToLog(env, {
    ...base,
    outcome: saved.length ? 'saved' : 'refused',
    detail: parts.join('; ') || 'Nothing to save',
    itemIds: saved.map((s) => s.itemId),
  });
}
