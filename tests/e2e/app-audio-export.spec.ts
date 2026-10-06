// B1 export: audio clips mixed into the MP4 with the verified ffmpeg command. Asserts the AAC stream starts at 0 and is
// exactly as long as the video, and measures RMS per time window to prove placement, trim, volume, mute and fades.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { makeLayer, makeProject } from '../../src/shared/factories';
import { emptyProject, type AudioClip, type Project } from '../../src/shared/schema';
import { decodeLeft, makeWav, rms, streams } from './app-audio-helpers';
import { expectExportMatchesRender, runExport, runRenderCli, saveProject, uploadAsset, WS } from './exportCompare';

const SINE = (f: number, a = 0.5) => `${a}*sin(2*PI*${f}*t)`;

/**
 * steps.wav: mono, 1 s of silence then 3 s of a 440 Hz tone at amplitude 0.5. tone.wav: stereo 880 Hz at amplitude 0.5.
 * In the export's left channel: the mono file is up-mixed at −3 dB (RMS 0.354 × 0.707 = 0.25); the stereo file at
 * volume 50% has RMS 0.354 × 0.5 = 0.177.
 */
async function sounds(request: APIRequestContext) {
  const steps = makeWav(test.info().outputPath('steps.wav'), { expr: `if(lt(t,1),0,${SINE(440)})`, seconds: 4 });
  const tone = makeWav(test.info().outputPath('tone.wav'), { expr: SINE(880), seconds: 2, rate: 48000, channels: 2 });
  const a = await uploadAsset(request, steps);
  const b = await uploadAsset(request, tone);
  return [
    { id: 'steps', originalName: 'steps.wav', relativePath: `assets/${a.hash.slice(0, 8)}-steps.wav`, type: 'audio' as const, hash: a.hash, duration: 4 },
    { id: 'tone', originalName: 'tone.wav', relativePath: `assets/${b.hash.slice(0, 8)}-tone.wav`, type: 'audio' as const, hash: b.hash, duration: 2 },
  ];
}

const clip = (c: Partial<AudioClip> & Pick<AudioClip, 'id' | 'assetId' | 'start'>): AudioClip => ({ name: c.id, trimStart: 0, duration: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false, ...c });

/** 3 s, 320×180 @ 30 fps with a moving rectangle (so frame timing is checkable) and four clips. */
async function audioProject(request: APIRequestContext): Promise<Project> {
  const assets = await sounds(request);
  return makeProject({
    ...emptyProject(),
    settings: { durationSec: 3, aspect: '16:9', width: 320, height: 180, fps: 30, background: '#14213d' },
    assets,
    scenes: [
      {
        id: 's1', name: 'Scene 1', start: 0, duration: 3,
        layers: [
          makeLayer({
            id: 'r', name: 'Rect', type: 'shape', visible: true, locked: false, start: 0, duration: 3, anchorX: 0.5, anchorY: 0.5, x: 60, y: 90, scale: 1, rotation: 0, opacity: 1,
            shape: 'rect', width: 60, height: 40, cornerRadius: 6, fill: '#fca311', stroke: '#ffffff', strokeWidth: 0,
            keyframes: { x: [{ id: 'k1', time: 0, value: 40, easing: { type: 'linear' } }, { id: 'k2', time: 3, value: 280, easing: { type: 'linear' } }] },
          }),
        ],
      },
    ],
    audio: [
      // Placed at 0.5 s, skipping the file's silent first second → tone from 0.5 to 1.5 s.
      clip({ id: 'placed', assetId: 'steps', start: 0.5, trimStart: 1, duration: 1 }),
      // Muted: must leave the 1.5–1.8 s gap silent.
      clip({ id: 'muted', assetId: 'steps', start: 1.5, trimStart: 1, duration: 0.3, muted: true }),
      // Half volume, 0.6 s fade in, 0.4 s fade out; runs past the end → cut at 3 s (fade-out ends there).
      clip({ id: 'faded', assetId: 'tone', start: 1.8, duration: 2, volume: 0.5, fadeIn: 0.6, fadeOut: 0.4 }),
      // Starts after the end: skipped.
      clip({ id: 'late', assetId: 'steps', start: 5, trimStart: 1 }),
    ],
  });
}

/** Audio stream starts at 0 and is exactly as long as the video. Returns the left channel's samples. */
function expectAudioMatchesVideo(mp4: string) {
  const [video, audio] = ['video', 'audio'].map((t) => streams(mp4).find((s) => s.codec_type === t)!);
  expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
  expect(Number(audio.start_time)).toBe(0);
  expect(Number(video.start_time)).toBe(0);
  expect(Number(audio.duration)).toBeCloseTo(Number(video.duration), 3);
  expect(Number(video.duration)).toBeCloseTo(3, 3);
  return decodeLeft(mp4);
}

function expectWindows(s: Float32Array) {
  const w = (a: number, b: number) => rms(s, a, b);
  const report = Object.fromEntries([[0, 0.45], [0.55, 1.45], [1.55, 1.75], [1.8, 1.9], [2.0, 2.1], [2.3, 2.4], [2.4, 2.6], [2.7, 2.8], [2.9, 3]].map(([a, b]) => [`${a}-${b}`, +w(a, b).toFixed(4)]));
  console.log('RMS windows', JSON.stringify(report));
  expect(w(0, 0.45)).toBeLessThan(0.003); // silence before the first clip
  expect(w(0.55, 1.45)).toBeGreaterThan(0.23); // placed + trimmed: the tone (untrimmed, this would be the silent intro)
  expect(w(0.55, 1.45)).toBeLessThan(0.27);
  expect(w(1.55, 1.75)).toBeLessThan(0.003); // gap with the muted clip
  expect(w(1.8, 1.9)).toBeLessThan(0.03); // fade in starts from silence…
  expect(w(1.8, 1.9)).toBeLessThan(w(2.0, 2.1));
  expect(w(2.0, 2.1)).toBeLessThan(w(2.3, 2.4)); // …and rises
  expect(w(2.4, 2.6)).toBeGreaterThan(0.16); // full level: 0.354 × volume 0.5
  expect(w(2.4, 2.6)).toBeLessThan(0.19);
  expect(w(2.7, 2.8)).toBeLessThan(w(2.4, 2.6)); // fade out from 2.6 s…
  expect(w(2.9, 3)).toBeLessThan(w(2.7, 2.8)); // …to silence at the end
  expect(w(2.9, 3)).toBeLessThan(0.04);
}

test('export mixes audio clips: AAC from 0, as long as the video, placed/trimmed/faded as set', async ({ page, request }) => {
  const project = await audioProject(request);
  const name = `Audio export ${Date.now()}`;
  await saveProject(request, name, project);
  const job = await runExport(request, { project, name }, 60_000);
  expect(job.warnings).toEqual([]);
  expectWindows(expectAudioMatchesVideo(job.outFile));
  // The picture is unaffected by the extra inputs: frames still match renderFrame at the same times.
  await expectExportMatchesRender(page, { project, projectName: name, mp4: job.outFile, frames: [0, 45, 89], wrongFrame: (f) => (f === 0 ? 89 : 0) });
});

test('CLI export includes the same audio', async ({ request }) => {
  const project = await audioProject(request);
  const name = `Audio CLI ${Date.now()}`;
  await saveProject(request, name, project);
  const out = test.info().outputPath('cli-audio.mp4');
  // A fresh workspace: the CLI must find the sounds in the project folder itself.
  const r = await runRenderCli([path.join(WS, `${name}.motion`), out], { ...process.env, MOTION_WORKSPACE: test.info().outputPath('cli-ws') });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  expectWindows(expectAudioMatchesVideo(out));
});

test('missing audio files are skipped with a warning; no audible clips → no audio stream', async ({ request }) => {
  const project = await audioProject(request);
  project.assets.push({ id: 'ghost', originalName: 'ghost.wav', relativePath: 'assets/00000000-ghost.wav', type: 'audio', hash: '0'.repeat(64), duration: 2 });
  project.audio = [clip({ id: 'gone', assetId: 'ghost', start: 0 }), clip({ id: 'gone2', assetId: 'ghost', start: 1 }), clip({ id: 'placed', assetId: 'steps', start: 0.5, trimStart: 1 })];
  const job = await runExport(request, { project }, 60_000);
  expect(job.warnings).toEqual(['Audio file missing: ghost.wav — exported without it.']);
  const s = expectAudioMatchesVideo(job.outFile);
  expect(rms(s, 0, 0.45)).toBeLessThan(0.003);
  expect(rms(s, 0.55, 1.45)).toBeGreaterThan(0.23);

  project.audio = [clip({ id: 'gone', assetId: 'ghost', start: 0 }), clip({ id: 'quiet', assetId: 'steps', start: 0, volume: 0 })];
  const silent = await runExport(request, { project }, 60_000);
  expect(silent.warnings).toHaveLength(1);
  expect(streams(silent.outFile).map((s) => s.codec_type)).toEqual(['video']);
});

test('watchdog: an ffmpeg that never exits after the last frame is killed and the export fails', async () => {
  test.skip(process.platform === 'win32', 'uses a POSIX shell script as a fake ffmpeg');
  const dir = test.info().outputPath('fake');
  fs.mkdirSync(dir, { recursive: true });
  const fake = path.join(dir, 'ffmpeg');
  const pidFile = path.join(dir, 'pid');
  // Answers -version; otherwise swallows the frames, then hangs ignoring SIGTERM (like the real hang case).
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo fake; exit 0; fi\necho $$ > "${pidFile}"\ntrap '' TERM\ncat > /dev/null\nexec sleep 600\n`, { mode: 0o755 });
  const projectDir = path.join(dir, 'Tiny.motion');
  fs.mkdirSync(projectDir);
  const tiny = makeProject({ ...emptyProject(), settings: { durationSec: 0.2, aspect: 'custom', width: 64, height: 64, fps: 10, background: '#000000' } });
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(tiny));
  const t0 = Date.now();
  const r = await runRenderCli([projectDir, path.join(dir, 'out.mp4')], { ...process.env, FFMPEG_PATH: fake, MOTION_FFMPEG_EXIT_TIMEOUT_MS: '1500', MOTION_WORKSPACE: path.join(dir, 'ws') }, 60_000);
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toContain('ffmpeg did not finish within 1.5 s after the last frame');
  expect(Date.now() - t0).toBeLessThan(30_000);
  // The stuck process is really gone (SIGKILL, since it ignores SIGTERM). If the CLI exited before reaping it, it can
  // briefly linger as a zombie (state Z) — dead, just not cleaned up yet.
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const running = () => {
    try {
      process.kill(pid, 0);
      return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z');
    } catch {
      return false;
    }
  };
  await expect.poll(running, { timeout: 10_000 }).toBe(false);
});
