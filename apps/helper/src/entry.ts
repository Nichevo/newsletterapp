import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UPDATED_EXIT_CODE } from './constants';
import { log } from './log';

// Windows' scheduled task runs this file with no arguments. That process only
// supervises: it runs the real helper as a child (--worker) and starts it
// again when it exits, straight away after a self-update and after a minute
// otherwise. So the task itself never ends, and an update never needs a
// detached process that Windows might stop with the task.

const args = process.argv.slice(2);

function supervise() {
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, '--worker', ...args], { stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => {
    if (code === UPDATED_EXIT_CODE) return supervise();
    log(`helper stopped (exit ${code ?? 'signal'}); starting it again in a minute`);
    setTimeout(supervise, 60_000);
  });
}

if (args.includes('--worker') || args.includes('--once')) await import('./main');
else supervise();
