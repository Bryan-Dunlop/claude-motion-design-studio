// `npm run dev` / `npm start` — one local server (API + editor UI) on http://127.0.0.1:5173
// --built: serve the editor built into dist/, building it first when the source changed (npm start). Without it: the
//          Vite dev server with live reload, for developers — its page reloads itself when the server comes back after
//          a restart, which would lose unsaved work for everyone else.
// --open:  open the editor in the default browser once the server is ready (npm start, Start Motion Studio.cmd);
//          BROWSER=none turns that off (CI).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { cancelAll, ffmpegAvailable, FFMPEG_HELP, STOP_SIGNALS } from './exporter';
import { ROOT, startServer, type StartedServer } from './app';
import { defaultWorkspace, ensureBuilt, motionStudioAt, openInBrowser, startupProblem } from './startup';

const port = Number(process.env.PORT ?? 5173);
const workspace = process.env.MOTION_WORKSPACE ?? defaultWorkspace();
const flags = new Set(process.argv.slice(2));
const open = flags.has('--open') && process.env.BROWSER !== 'none';

// MOTION_LOG_FILE: also append everything the server prints (and crashes) to this file — CI uploads it when tests fail.
const logFile = process.env.MOTION_LOG_FILE;
if (logFile) {
  fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
  const write = (level: string, text: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${text}\n`);
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level, format(...args));
    };
  }
  process.on('uncaughtExceptionMonitor', (err) => write('crash', err.stack ?? String(err)));
}

/** Started twice (e.g. the launcher double-clicked again): show the one that is running, and leave. */
async function exitIfRunning() {
  const url = `http://127.0.0.1:${port}`;
  if (!(await motionStudioAt(url))) return;
  console.log(`\n  Motion Studio is already running at ${url} (in another window).`);
  if (open) openInBrowser(url);
  process.exit(0);
}

await exitIfRunning();
const built = flags.has('--built');
if (built) {
  try {
    await ensureBuilt(ROOT);
  } catch (e) {
    console.error(`\n  Could not prepare the editor: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

let server: StartedServer;
try {
  server = await startServer({ port, workspace, built });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') await exitIfRunning();
  const problem = startupProblem(err, port);
  if (!problem) throw e;
  console.error(`\n  ${problem.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

console.log(`\n  Motion Studio running at ${server.url}`);
console.log(`  Projects are saved in ${server.workspace.root}`);
if (!ffmpegAvailable()) console.warn(`\n  WARNING: ${FFMPEG_HELP.replace(/\n/g, '\n  ')}\n`);
console.log('\n  Keep this window open while you work. To stop Motion Studio, close it or press Ctrl+C.');
if (open) openInBrowser(server.url);

// Ctrl+C, the window closing or `kill`: cancel running exports first, so their unfinished files are deleted (Windows
// gives a closing window about 10 s). Never longer than 8 s.
let stopping = false;
for (const signal of STOP_SIGNALS) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const code = 128 + (os.constants.signals[signal as keyof typeof os.constants.signals] ?? 2);
    setTimeout(() => process.exit(code), 8000).unref();
    void cancelAll().then((n) => {
      if (n) console.log(`\n  Stopped ${n === 1 ? 'the export' : `${n} exports`} in progress; the unfinished file was deleted.`);
      process.exit(code);
    });
  });
}
