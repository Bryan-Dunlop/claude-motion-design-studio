// `npm run render -- <projectFolder> <out.mp4>` — same pipeline as the Export button, no editor UI.
import os from 'node:os';
import path from 'node:path';
import { readProjectDir } from './projects';
import { FFMPEG_HELP, ffmpegAvailable, getJob, startExport } from './exporter';
import { startServer } from './app';

const [folderArg, outArg] = process.argv.slice(2);
if (!folderArg || !outArg) {
  console.error('Usage: npm run render -- <projectFolder.motion> <out.mp4>');
  process.exit(2);
}
if (!ffmpegAvailable()) {
  console.error(FFMPEG_HELP);
  process.exit(1);
}
const projectDir = path.resolve(folderArg);
const outFile = path.resolve(outArg);
const project = readProjectDir(projectDir);
const server = await startServer({ port: 0, workspace: process.env.MOTION_WORKSPACE ?? path.join(os.tmpdir(), 'motion-studio-cli') });

let exitCode = 0;
try {
  const job = await startExport({ project, projectDir, outFile, baseUrl: server.url, resolveAsset: (a) => server.workspace.resolveAsset(projectDir, a) });
  const { width, height, fps } = project.settings;
  console.log(`Rendering ${job.total} frames at ${width}x${height} @ ${fps}fps -> ${outFile}`);
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
