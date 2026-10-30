import type { HelperLoad } from '@newsletterapp/shared';
import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';

let last = snapshot();

function snapshot() {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function nvidiaSmi(): Promise<Pick<HelperLoad, 'gpuPercent' | 'vramUsedMb' | 'vramTotalMb' | 'gpuWatts'>> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total,power.draw', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({});
        const [gpu, used, total, watts] = stdout.split('\n')[0]!.split(',').map((v) => Number(v.trim()));
        resolve({ gpuPercent: gpu, vramUsedMb: used, vramTotalMb: total, gpuWatts: Number.isFinite(watts) ? watts : undefined });
      },
    );
  });
}

/**
 * Samples the GPU's power draw every couple of seconds while a model runs.
 * stop() returns the average in watts, or undefined without nvidia-smi.
 */
export function powerMeter(everyMs = 2000): { stop: () => number | undefined } {
  const samples: number[] = [];
  const sample = () =>
    void nvidiaSmi().then(({ gpuWatts }) => {
      if (gpuWatts !== undefined) samples.push(gpuWatts);
    });
  sample();
  const timer = setInterval(sample, everyMs);
  return {
    stop() {
      clearInterval(timer);
      return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : undefined;
    },
  };
}

/** CPU since the last call, RAM now, and the GPU if nvidia-smi is available. */
export async function currentLoad(): Promise<HelperLoad> {
  const now = snapshot();
  const total = now.total - last.total;
  const cpuPercent = total > 0 ? Math.round(100 * (1 - (now.idle - last.idle) / total)) : undefined;
  last = now;
  return {
    cpuPercent,
    ramUsedMb: Math.round((totalmem() - freemem()) / 1_048_576),
    ramTotalMb: Math.round(totalmem() / 1_048_576),
    ...(await nvidiaSmi()),
  };
}
