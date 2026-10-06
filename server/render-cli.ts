// `npm run render -- <projectFolder> <out.mp4> [--scale 0.5] [--crf 20] [--preset veryfast] [--no-audio]` — same
// pipeline as the Export button, no editor UI.
import os from 'node:os';
import path from 'node:path';
import { readProjectDir } from './projects';
import { parseRenderArgs, RENDER_USAGE, type RenderArgs } from './cliArgs';
import { FFMPEG_HELP, ffmpegAvailable, getJob, startExport } from './exporter';
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
const project = readProjectDir(projectDir);
const server = await startServer({ port: 0, workspace: process.env.MOTION_WORKSPACE ?? path.join(os.tmpdir(), 'motion-studio-cli') });

let exitCode = 0;
try {
  const { options } = args;
  const job = await startExport({ project, projectDir, outFile, baseUrl: server.url, options, resolveAsset: (a) => server.workspace.resolveAsset(projectDir, a) });
  const { width, height, fps } = project.settings;
  const { outW, outH } = job.size;
  const size = options.scale === 1 ? `${outW}x${outH}` : `${outW}x${outH} (${Math.round(options.scale * 100)}% of ${width}x${height})`;
  console.log(`Rendering ${job.total} frames at ${size} @ ${fps}fps, CRF ${options.crf} (${options.preset})${options.audio ? '' : ', no audio'} -> ${outFile}`);
  for (const w of job.warnings) console.warn(`Warning: ${w}`);
  const timer = setInterval(() => {
    const j = getJob(job.id)!;
    process.stdout.write(`\r  ${j.status} ${j.frame}/${j.total} (${Math.round((100 * j.frame) / j.total)}%)   `);
  }, 500);
  process.once('SIGINT', () => {
    console.log('\nCancelling…');
    import('./exporter').then((m) => m.cancel(getJob(job.id)!));
  });
  try {
    await job.finished;
    console.log(`\nDone: ${outFile}`);
  } finally {
    clearInterval(timer);
  }
} catch (e) {
  console.error(`\nExport failed: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await server.close();
}
process.exit(exitCode);
