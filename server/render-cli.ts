// `npm run render -- <projectFolder> <out.mp4> [--scale 0.5] [--crf 20] [--preset veryfast] [--no-audio]` — same
// pipeline as the Export button, no editor UI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project } from '../src/shared/schema';
import { readProjectDir } from './projects';
import { parseRenderArgs, RENDER_USAGE, type RenderArgs } from './cliArgs';
import { cancel, FFMPEG_HELP, ffmpegAvailable, getJob, startExport, type ExportJob } from './exporter';
import { startServer } from './app';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(RENDER_USAGE);
  process.exit(0);
}
let args: RenderArgs;
try {
  args = parseRenderArgs(argv);
} catch (e) {
  console.error(`${(e as Error).message}\n\n${RENDER_USAGE}`);
  process.exit(2);
}
if (!ffmpegAvailable()) {
  console.error(FFMPEG_HELP);
  process.exit(1);
}
const projectDir = path.resolve(args.folder);
const outFile = path.resolve(args.out);
let project: Project;
try {
  if (!fs.existsSync(projectDir)) throw new Error(`${projectDir} does not exist`);
  project = readProjectDir(projectDir);
} catch (e) {
  // A wrong folder (none, or one without project.json) also gets the usage; a broken project.json just its problem.
  const wrongFolder = !fs.existsSync(path.join(projectDir, 'project.json'));
  console.error(`Cannot open the project: ${(e as Error).message}${wrongFolder ? `\n\n${RENDER_USAGE}` : ''}`);
  process.exit(2);
}
const server = await startServer({ port: 0, workspace: process.env.MOTION_WORKSPACE ?? path.join(os.tmpdir(), 'motion-studio-cli') });

let exitCode = 0;
let job: ExportJob | undefined;
try {
  const { options } = args;
  // handleSIGINT false: Ctrl+C is ours (cancel, then wait for the cleanup), not Playwright's (close Chromium, exit).
  job = await startExport({ project, projectDir, outFile, baseUrl: server.url, options, resolveAsset: (a) => server.workspace.resolveAsset(projectDir, a), handleSIGINT: false });
  const { width, height, fps } = project.settings;
  const { outW, outH } = job.size;
  const size = options.scale === 1 ? `${outW}x${outH}` : `${outW}x${outH} (${Math.round(options.scale * 100)}% of ${width}x${height})`;
  console.log(`Rendering ${job.total} frames at ${size} @ ${fps}fps, CRF ${options.crf} (${options.preset})${options.audio ? '' : ', no audio'} -> ${outFile}`);
  for (const w of job.warnings) console.warn(`Warning: ${w}`);
  const id = job.id;
  const timer = setInterval(() => {
    const j = getJob(id)!;
    process.stdout.write(`\r  ${j.status} ${j.frame}/${j.total} (${Math.round((100 * j.frame) / j.total)}%)   `);
  }, 500);
  let cancelling = false;
  process.on('SIGINT', () => {
    // A second Ctrl+C leaves at once (Playwright's exit handler still kills Chromium).
    if (cancelling) process.exit(130);
    cancelling = true;
    console.log('\nCancelling…');
    cancel(getJob(id)!);
  });
  const shown = job.warnings.length;
  try {
    await job.finished;
    // Problems found while rendering (an image or font that could not be loaded).
    for (const w of job.warnings.slice(shown)) console.warn(`\nWarning: ${w}`);
    console.log(`\nDone: ${outFile}`);
  } finally {
    clearInterval(timer);
  }
} catch (e) {
  console.error(`\nExport failed: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  // Exit only once ffmpeg has stopped and the unfinished file of a failed or cancelled export is deleted.
  await job?.cleanedUp;
  await server.close();
}
process.exit(exitCode);
