import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

const MAX_BYTES = 1_000_000;
const file = () => join(dataDir(), 'helper.log');

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
