// Starting and stopping the server the way people do: starting it a second time, a port another program holds, Ctrl+C
// or closing its window during an export, or the computer stopping it hard. Each case gets a plain message, and no
// half-made MP4 ever carries a finished video's name.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeProject } from '../../src/shared/factories';
import { emptyProject } from '../../src/shared/schema';
import type { Job } from './exportCompare';

const E2E_PORT = Number(process.env.E2E_PORT ?? 5199);
const PORT = E2E_PORT + 10;

/** `npm run dev` on `port` in a process of its own (`detached`, POSIX: its own process group, like a terminal tab). */
function startDev(port: number, workspace: string, detached = false, args: string[] = []) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/dev.ts', ...args], { env: { ...process.env, PORT: String(port), MOTION_WORKSPACE: workspace }, detached });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, output: () => output, exited, url: `http://127.0.0.1:${port}` };
}
type Dev = ReturnType<typeof startDev>;

/** A 2-minute 320×180 export started on `dev`, once ffmpeg is writing its file. */
async function exporting(dev: Dev): Promise<Job> {
  await expect.poll(dev.output, { timeout: 60_000 }).toContain('Motion Studio running at');
  const project = makeProject({ ...emptyProject(), settings: { durationSec: 120, aspect: 'custom', width: 320, height: 180, fps: 30, background: '#14213d' } });
  const r = await fetch(`${dev.url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
  expect(r.ok, await r.clone().text()).toBe(true);
  let job = (await r.json()) as Job;
  await expect.poll(async () => (job = (await (await fetch(`${dev.url}/api/jobs/${job.id}`)).json()) as Job).frame, { timeout: 60_000 }).toBeGreaterThan(10);
  await expect.poll(() => fs.existsSync(`${job.outFile}.part`), { timeout: 10_000 }).toBe(true);
  return job;
}

/** ffmpeg processes still writing `file` (POSIX). */
const ffmpegsWriting = (file: string) =>
  execFileSync('ps', ['-eww', '-o', 'args='])
    .toString()
    .split('\n')
    .filter((l) => /ffmpeg /.test(l) && l.includes(file));

test('npm start\'s mode (the built editor): it exports, and a server restart never reloads the editor and loses work', async ({ page }) => {
  const ws = test.info().outputPath('ws');
  let dev = startDev(PORT + 4, ws, false, ['--built']);
  try {
    await expect.poll(dev.output, { timeout: 60_000 }).toContain('Motion Studio running at');
    expect(dev.output()).toContain(`Projects are saved in ${ws}`);
    let loads = 0;
    page.on('load', () => loads++);
    await page.goto(dev.url);
    // No live-reload code in the page (Vite's client reloads the page when its server comes back).
    expect(await page.locator('script[src*="@vite/client"]').count()).toBe(0);
    await page.getByTestId('add-rect').click();
    const layers = () => page.evaluate(() => (window as any).__motion.useEditor.getState().project.scenes[0].layers.length as number);
    await expect.poll(layers).toBe(1);

    const project = makeProject({ ...emptyProject(), settings: { durationSec: 1, aspect: 'custom', width: 320, height: 180, fps: 30, background: '#14213d' } });
    let job = (await (await fetch(`${dev.url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) })).json()) as Job;
    await expect.poll(async () => (job = (await (await fetch(`${dev.url}/api/jobs/${job.id}`)).json()) as Job).status, { timeout: 60_000 }).toBe('done');
    expect(fs.statSync(job.outFile).size).toBeGreaterThan(1000);
    expect(fs.existsSync(`${job.outFile}.part`)).toBe(false);

    // The window closed, then started again: the tab keeps its unsaved work, and Save works again.
    dev.child.kill('SIGKILL');
    await dev.exited;
    dev = startDev(PORT + 4, ws, false, ['--built']);
    await expect.poll(dev.output, { timeout: 60_000 }).toContain('Motion Studio running at');
    await page.waitForTimeout(2000); // Vite's client would have reloaded the page by now
    expect(loads).toBe(1);
    expect(await layers()).toBe(1);
  } finally {
    dev.child.kill('SIGKILL');
    await dev.exited;
  }
});

test('starting it a second time points to the one already running, and exits cleanly', async () => {
  // The test server is already running on E2E_PORT.
  const second = startDev(E2E_PORT, test.info().outputPath('ws'));
  expect((await second.exited).code, second.output()).toBe(0);
  expect(second.output()).toContain(`Motion Studio is already running at http://127.0.0.1:${E2E_PORT} (in another window).`);
});

test('a port another program holds gives a plain message and exit code 1, not a stack trace', async () => {
  const blocker = http.createServer((_req, res) => res.end('not Motion Studio'));
  await new Promise<void>((resolve) => blocker.listen(PORT + 1, '127.0.0.1', () => resolve()));
  try {
    const dev = startDev(PORT + 1, test.info().outputPath('ws'));
    expect((await dev.exited).code, dev.output()).toBe(1);
    expect(dev.output()).toContain(`Port ${PORT + 1} is already in use by another program, so Motion Studio could not start.`);
    expect(dev.output()).toContain(process.platform === 'win32' ? `set PORT=${PORT + 2}` : `PORT=${PORT + 2} npm start`);
    expect(dev.output()).not.toMatch(/\n\s+at |Unhandled 'error' event/);
  } finally {
    blocker.close();
  }
});

test.describe('stopping the server during an export cancels it and deletes the unfinished file', () => {
  test.skip(process.platform === 'win32', 'sends POSIX signals and finds ffmpeg with ps');

  const cases = [
    { name: 'Ctrl+C in its terminal (SIGINT to the whole process group, ffmpeg included)', signal: 'SIGINT', group: true },
    { name: 'closing its window (SIGHUP)', signal: 'SIGHUP', group: false },
    { name: 'kill (SIGTERM)', signal: 'SIGTERM', group: false },
  ] as const;
  for (const c of cases) {
    test(c.name, async () => {
      const ws = test.info().outputPath('ws');
      const dev = startDev(PORT + 2, ws, c.group);
      try {
        const job = await exporting(dev);
        process.kill(c.group ? -dev.child.pid! : dev.child.pid!, c.signal);
        const { code } = await dev.exited;
        expect(code, dev.output()).toBe(128 + os.constants.signals[c.signal]);
        expect(dev.output()).toContain('Stopped the export in progress; the unfinished file was deleted.');
        expect(fs.readdirSync(path.join(ws, 'exports'))).toEqual([]);
        await expect.poll(() => ffmpegsWriting(job.outFile), { timeout: 10_000 }).toEqual([]);
      } finally {
        if (dev.child.exitCode === null) dev.child.kill('SIGKILL');
      }
    });
  }
});

test('even a hard stop (the process killed, the PC switched off) never leaves a file with the finished video\'s name', async () => {
  const ws = test.info().outputPath('ws');
  const dev = startDev(PORT + 3, ws);
  const job = await exporting(dev);
  dev.child.kill('SIGKILL'); // TerminateProcess on Windows: no handler runs
  await dev.exited;
  // ffmpeg sees its input end and finishes what it has; that stays clearly unfinished (<name>.mp4.part).
  for (let i = 0; i < 30; i++) {
    expect(fs.readdirSync(path.join(ws, 'exports')).filter((f) => !f.endsWith('.mp4.part'))).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(fs.existsSync(job.outFile)).toBe(false);
});
