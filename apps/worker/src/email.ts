import PostalMime from 'postal-mime';
import type { Env } from './env';
import { findWebVersionUrl, htmlToText, snippetOf } from './html';
import { localPartOf, newId, normalizeEmail, now } from './ids';
import { categoryFromRules, quickSummary } from './quick';
import { parseAuthResults, screen } from './screening';
import { loadSettings } from './settings';

/**
 * Entry point for every email sent to the domain (catch-all rule -> this Worker).
 *
 * Kept deliberately small for the free plan's CPU budget: screen the sender,
 * save the raw message to R2, parse it once, and write one item row. Anything
 * heavier (AI summaries, ad stripping) happens later from the job queue.
 */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const envelopeTo = normalizeEmail(message.to);
  const envelopeFrom = normalizeEmail(message.from);
  if (!envelopeTo) return; // nothing sensible to do; accept and drop

  const auth = parseAuthResults(message.headers);
  const raw = await new Response(message.raw).arrayBuffer();

  // Parse first so screening can use the human-readable From address, which is
  // what newsletters keep stable (the envelope sender is often a bounce address).
  let parsed: Awaited<ReturnType<PostalMime['parse']>> | null = null;
  try {
    parsed = await new PostalMime().parse(raw);
  } catch (err) {
    console.error('postal-mime failed, storing headers only', err);
  }

  const fromEmail = normalizeEmail(parsed?.from?.address) ?? envelopeFrom;
  if (!fromEmail) return;
  const fromName = parsed?.from?.name?.trim() || null;
  const localPart = localPartOf(envelopeTo);

  const decision = await screen(env, localPart, fromEmail, fromName, auth);
  if (decision.action === 'drop') {
    console.log(`dropped mail to ${localPart} from ${fromEmail}: ${decision.reason}`);
    return;
  }

  const t = now();
  const id = newId();
  const subject = (parsed?.subject ?? message.headers.get('subject') ?? '').trim() || '(no subject)';
  const html = parsed?.html ?? null;
  const text = parsed?.text ?? (html ? htmlToText(html) : null);
  const snippet = text ? snippetOf(text) : null;
  const quick = quickSummary(html, text);
  const receivedAt = parsed?.date ? Date.parse(parsed.date) || t : t;
  const date = new Date(t);
  const prefix = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

  const rawKey = `raw/${prefix}/${id}.eml`;
  const htmlKey = html ? `items/${id}/body.html` : null;
  const textKey = text ? `items/${id}/body.txt` : null;

  await Promise.all([
    env.RAW.put(rawKey, raw, { httpMetadata: { contentType: 'message/rfc822' } }),
    htmlKey ? env.RAW.put(htmlKey, html!, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }) : null,
    textKey ? env.RAW.put(textKey, text!, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }) : null,
  ]);

  // One source per (sender, address) pair, named after the sender.
  const sourceName = fromName ?? fromEmail;
  let source = await env.DB.prepare('SELECT id FROM sources WHERE sender_email = ? AND address_id = ?')
    .bind(fromEmail, decision.address.id)
    .first<{ id: string }>();
  // A keyword rule match wins over the source's default category, which is
  // applied at read time so changing it re-files older issues too.
  const settings = await loadSettings(env);
  const category = categoryFromRules(settings.keywordRules, subject, quick.preheader);
  if (!source) {
    source = { id: newId() };
    await env.DB.prepare(
      `INSERT INTO sources (id, kind, name, sender_email, address_id, created_at) VALUES (?, 'newsletter', ?, ?, ?, ?)`,
    )
      .bind(source.id, sourceName, fromEmail, decision.address.id, t)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO items (
       id, source_id, sender_id, address_id, kind, status, subject, from_name, from_email, to_address,
       snippet, received_at, message_id, raw_key, html_key, text_key, raw_size, has_html,
       list_unsubscribe, auth_spf, auth_dkim, auth_dmarc, web_url, created_at,
       preheader, word_count, category, sponsored
     ) VALUES (?, ?, ?, ?, 'newsletter', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      source.id,
      decision.sender.id,
      decision.address.id,
      decision.action === 'inbox' ? 'inbox' : 'screening',
      subject,
      fromName,
      fromEmail,
      envelopeTo,
      snippet,
      receivedAt,
      parsed?.messageId ?? message.headers.get('message-id'),
      rawKey,
      htmlKey,
      textKey,
      message.rawSize,
      html ? 1 : 0,
      message.headers.get('list-unsubscribe'),
      auth.spf,
      auth.dkim,
      auth.dmarc,
      html ? findWebVersionUrl(html) : null,
      t,
      quick.preheader,
      quick.wordCount,
      category,
      quick.sponsored ? 1 : 0,
    )
    .run();
}
