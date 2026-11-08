// Drawing PDF pages (for charts and tables) needs a canvas library with a
// native part, which can't go inside the helper's single file. The helper
// installs it next to itself with npm the first time a PDF needs it.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { dataDir } from './config';
import { log } from './log';

/** The parts of @napi-rs/canvas the PDF reader uses. */
export interface CanvasModule {
  createCanvas(width: number, height: number): {
    getContext(kind: '2d'): {
      fillStyle: string;
      fillRect(x: number, y: number, w: number, h: number): void;
      drawImage(img: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
    };
    toBuffer(type: 'image/png'): Buffer;
  };
  loadImage(src: Buffer): Promise<{ width: number; height: number }>;
}

const PACKAGE = '@napi-rs/canvas';
const VERSION = '1.0.12';

let loading: Promise<CanvasModule> | null = null;

function folder(): string {
  return process.env.NEWSLETTER_CANVAS_DIR || join(dataDir(), 'pdf-drawing');
}

function tryLoad(dir: string): CanvasModule | null {
  try {
    const req = createRequire(join(dir, 'package.json'));
    return req(PACKAGE) as CanvasModule;
  } catch {
    return null;
  }
}

function npmInstall(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new Promise((resolve, reject) => {
    execFile(
      npm,
      ['install', `${PACKAGE}@${VERSION}`, '--no-audit', '--no-fund', '--omit=dev', '--prefix', dir],
      { timeout: 300_000, windowsHide: true, shell: process.platform === 'win32' },
      (err, _out, stderr) => (err ? reject(new Error(`npm install ${PACKAGE} failed: ${String(stderr || err.message).slice(0, 300)}`)) : resolve()),
    );
  });
}

/** The canvas library, installed on first use (about 10 MB, once). */
export function loadCanvas(): Promise<CanvasModule> {
  loading ??= (async () => {
    const dir = folder();
    const ready = tryLoad(dir);
    if (ready) return ready;
    log(`installing ${PACKAGE} ${VERSION} for drawing PDF charts and tables (once)`);
    await npmInstall(dir);
    const mod = tryLoad(dir);
    if (!mod) throw new Error(`${PACKAGE} installed but could not be loaded`);
    return mod;
  })().catch((err: unknown) => {
    // Try again next time (say, the network was down), but not on every page of this PDF.
    setTimeout(() => (loading = null), 60 * 60_000).unref();
    throw err;
  });
  return loading;
}
