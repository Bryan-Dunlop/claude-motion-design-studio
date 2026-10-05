// `npm run dev` — one local server (API + editor UI) on http://127.0.0.1:5173
import path from 'node:path';
import { ffmpegAvailable, FFMPEG_HELP } from './exporter';
import { startServer } from './app';

const port = Number(process.env.PORT ?? 5173);
const workspace = process.env.MOTION_WORKSPACE ?? path.resolve('workspace');

const server = await startServer({ port, workspace });
console.log(`\n  Motion Studio running at ${server.url}`);
console.log(`  Projects are saved in ${server.workspace.root}`);
if (!ffmpegAvailable()) console.warn(`\n  WARNING: ${FFMPEG_HELP.replace(/\n/g, '\n  ')}\n`);
