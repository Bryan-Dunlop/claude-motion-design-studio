// `npm run dev` — one local server (API + editor UI) on http://127.0.0.1:5173
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { ffmpegAvailable, FFMPEG_HELP } from './exporter';
import { startServer } from './app';

const port = Number(process.env.PORT ?? 5173);
const workspace = process.env.MOTION_WORKSPACE ?? path.resolve('workspace');

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

const server = await startServer({ port, workspace });
console.log(`\n  Motion Studio running at ${server.url}`);
console.log(`  Projects are saved in ${server.workspace.root}`);
if (!ffmpegAvailable()) console.warn(`\n  WARNING: ${FFMPEG_HELP.replace(/\n/g, '\n  ')}\n`);
