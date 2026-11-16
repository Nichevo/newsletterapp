import type { HelperLogEvent, LogLevel } from '@newsletterapp/shared';
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

const MAX_BYTES = 1_000_000;
const file = () => join(dataDir(), 'helper.log');
/** Warnings and errors not yet sent to the app, kept on disk so a restart doesn't lose them. */
const pendingFile = () => join(dataDir(), 'pending-log.json');
const MAX_PENDING = 200;

/** Logs to the console and to helper.log next to the config, keeping one old file. */
export function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.message : String(p))).join(' ')}`;
  console.log(line);
  try {
    if ((statSync(file(), { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file(), `${file()}.1`);
    appendFileSync(file(), line + '\n');
  } catch {
    // Logging must never stop the helper.
  }
}

let pending: HelperLogEvent[] | null = null;

function loadPending(): HelperLogEvent[] {
  if (pending) return pending;
  try {
    const raw = JSON.parse(readFileSync(pendingFile(), 'utf8')) as unknown;
    pending = Array.isArray(raw) ? (raw as HelperLogEvent[]).slice(-MAX_PENDING) : [];
  } catch {
    pending = [];
  }
  return pending;
}

function savePending(): void {
  try {
    writeFileSync(pendingFile(), JSON.stringify(pending ?? []));
  } catch {
    // The log file still has the line.
  }
}

/**
 * Logs a line and also sends it to the app with the next heartbeat, for the
 * app's log and its problems on System status. The same line repeated before it
 * is sent is folded into one, with a count.
 */
export function report(level: LogLevel, area: string, message: string, extra: { site?: string | null; sourceId?: string | null } = {}): void {
  log(level === 'info' ? '' : `${level}:`, message);
  const list = loadPending();
  const same = list.find((e) => e.level === level && e.area === area && e.message === message && (e.site ?? null) === (extra.site ?? null) && (e.sourceId ?? null) === (extra.sourceId ?? null));
  if (same) same.count = (same.count ?? 1) + 1;
  else {
    list.push({ at: Date.now(), level, area, message: message.slice(0, 600), site: extra.site ?? null, sourceId: extra.sourceId ?? null, count: 1 });
    if (list.length > MAX_PENDING) list.splice(0, list.length - MAX_PENDING);
  }
  savePending();
}

/** The lines to send with this heartbeat. Call sentEvents() once the app has them. */
export function pendingEvents(): HelperLogEvent[] {
  return loadPending().slice();
}

export function sentEvents(sent: HelperLogEvent[]): void {
  const list = loadPending();
  pending = list.filter((e) => !sent.includes(e));
  savePending();
}
