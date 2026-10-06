// B1 audio in the editor: import a WAV through the UI → Audio row + waveform + properties; timeline drags; clip
// selection vs layer selection; Ctrl+D / Delete; "+ at playhead"; cursor click sounds; missing file + Relink; the
// Sound toggle; and the Web Audio preview engine following playback (start, pause, seek, loop, edits).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './app-audio-helpers';
import { drag, getState, past } from './helpers';

const WS = path.resolve('.e2e-workspace');
const tone = (name: string, seconds: number, expr = '0.5*sin(2*PI*440*t)') => makeWav(test.info().outputPath(name), { expr, seconds });

const clips = async (page: Page) => (await getState(page)).project.audio;
const clipAt = async (page: Page, i: number) => (await clips(page))[i];
/** start / trimStart / duration of clip i, rounded to ms (file lengths come from a decode). */
const timing = async (page: Page, i: number) => {
  const c = await clipAt(page, i);
  const ms = (v: number) => Math.round(v * 1000) / 1000;
  return { start: ms(c.start), trimStart: ms(c.trimStart), duration: ms(c.duration) };
};
const store = (page: Page, fn: string) => page.evaluate((src) => new Function('s', src)((window as any).__motion.useEditor.getState()), fn);
const zoomOf = (page: Page) => page.evaluate(() => (window as any).__motion.useEditor.getState().zoom as number);
const engine = (page: Page) => page.evaluate(() => (window as any).__motion.audio());
const selection = (page: Page) => page.evaluate(() => (window as any).__motion.useEditor.getState().selection as { layerIds: string[]; audioIds: string[] });

async function edgeOf(page: Page, testId: string, side: 'left' | 'right') {
  const b = (await page.getByTestId(testId).locator(`.edge.${side}`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function setNumber(page: Page, testId: string, value: string) {
  await page.getByTestId(testId).fill(value);
  await page.getByTestId(testId).press('Enter');
}

test('import a WAV through the UI: Audio row with waveform, clip properties, one undo step per edit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('add-text').click();
  // Import accepts sounds, and says so.
  await expect(page.getByTestId('file-input')).toHaveAttribute('accept', /\.mp3,\.wav,\.ogg,\.m4a,\.aac,\.flac/);
  await expect(page.getByTestId('btn-import')).toHaveAttribute('title', /sounds \(MP3, WAV, OGG, M4A, AAC, FLAC\)/);

  const h0 = await past(page);
  await page.getByTestId('file-input').setInputFiles(tone('tone.wav', 2));
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  await expect(page.getByTestId('audio-toggle')).toHaveText(/Audio \(1\)/);
  await expect(page.locator('.toast').filter({ hasText: 'Added tone.wav at 0:00 — see the Audio rows' })).toBeVisible();
  // Asset + clip = ONE undo step; a 2 s sound in a 15 s project is a sound effect at the playhead, full length.
  expect(await past(page)).toBe(h0 + 1);
  let st = await getState(page);
  expect(st.project.assets).toHaveLength(1);
  expect(st.project.assets[0]).toMatchObject({ originalName: 'tone.wav', type: 'audio' });
  expect(st.project.assets[0].duration).toBeCloseTo(2, 3);
  expect(st.project.audio[0]).toMatchObject({ name: 'tone', start: 0, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
  expect(st.project.audio[0].duration).toBeCloseTo(2, 3);

  // The waveform is really drawn on its canvas.
  const wave = page.getByTestId('audio-clip-0').getByTestId('waveform');
  await expect(wave).toHaveAttribute('data-ready', 'yes');
  const inked = () =>
    wave.evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n / (c.width * c.height);
    });
  await expect.poll(inked).toBeGreaterThan(0.3); // a steady 0.5-amplitude tone fills about half the height

  // The new clip is selected, so the properties show the clip fields with plain labels.
  for (const label of ['Name', 'Starts at (s)', 'Skip into file (s)', 'Length (s)', 'Volume %', 'Fade in (s)', 'Fade out (s)', 'Mute'])
    await expect(page.locator('.audio-props .row-label', { hasText: label }).first()).toBeVisible();
  await expect(page.locator('.audio-props .row', { hasText: 'Skip into file (s)' })).toHaveAttribute('title', 'Jump past a silent intro');
  await expect(page.getByTestId('clip-volume')).toHaveValue('100');
  await expect(page.getByTestId('clip-delete')).toBeVisible();

  let h = await past(page);
  await setNumber(page, 'clip-volume', '50');
  await setNumber(page, 'clip-fadein', '0.25');
  await page.getByTestId('clip-mute').check();
  await page.getByTestId('clip-name').fill('Beep');
  await page.getByTestId('clip-name').press('Enter');
  expect(await clipAt(page, 0)).toMatchObject({ volume: 0.5, fadeIn: 0.25, muted: true, name: 'Beep' });
  expect(await past(page)).toBe(h + 4);
  await page.getByTestId('clip-mute').uncheck();
  // Skip into file keeps the clip inside the file: length shrinks to what's left.
  await setNumber(page, 'clip-trim', '0.5');
  await expect.poll(async () => (await clipAt(page, 0)).duration).toBeCloseTo(1.5, 6);
  await setNumber(page, 'clip-trim', '0');
  await setNumber(page, 'clip-length', '2');
  h = await past(page);

  // Timeline drags, each ONE undo step: move +1 s, trim the left edge +0.5 s (end stays), right edge −0.5 s.
  const zoom = await zoomOf(page);
  const bar = page.getByTestId('audio-clip-0');
  await bar.scrollIntoViewIfNeeded();
  let b = (await bar.boundingBox())!;
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, zoom, 0);
  expect(await timing(page, 0)).toEqual({ start: 1, trimStart: 0, duration: 2 });
  expect(await past(page)).toBe(h + 1);
  await drag(page, await edgeOf(page, 'audio-clip-0', 'left'), zoom / 2, 0);
  expect(await timing(page, 0)).toEqual({ start: 1.5, trimStart: 0.5, duration: 1.5 });
  expect(await past(page)).toBe(h + 2);
  await drag(page, await edgeOf(page, 'audio-clip-0', 'right'), -zoom / 2, 0);
  expect(await timing(page, 0)).toEqual({ start: 1.5, trimStart: 0.5, duration: 1 });
  // The right edge can't go past the end of the file (2 s − 0.5 s skipped = 1.5 s).
  await drag(page, await edgeOf(page, 'audio-clip-0', 'right'), zoom * 3, 0);
  expect(await timing(page, 0)).toEqual({ start: 1.5, trimStart: 0.5, duration: 1.5 });
  // The left edge can't go before the start of the file; the end stays where it was.
  await drag(page, await edgeOf(page, 'audio-clip-0', 'left'), -zoom, 0);
  expect(await timing(page, 0)).toEqual({ start: 1, trimStart: 0, duration: 2 });
  expect(await past(page)).toBe(h + 5);
  await page.locator('body').press('Control+z');
  expect(await timing(page, 0)).toEqual({ start: 1.5, trimStart: 0.5, duration: 1.5 });
  await page.locator('body').press('Control+Shift+z');

  // Selecting a layer clears the clip selection, and the other way round.
  await page.getByTestId('layer-item-Text').locator('.name').click();
  expect(await selection(page)).toMatchObject({ audioIds: [], layerIds: [expect.any(String)] });
  await expect(page.getByTestId('audio-clip-0')).not.toHaveClass(/sel/);
  b = (await bar.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  expect(await selection(page)).toMatchObject({ audioIds: [(await clipAt(page, 0)).id], layerIds: [] });
  await expect(page.getByTestId('audio-clip-0')).toHaveClass(/sel/);
  await expect(page.getByTestId('layer-item-Text')).not.toHaveClass(/sel/);

  // Ctrl+D duplicates the selected clip at the playhead; Delete removes the selection (each one undo step).
  await page.evaluate(() => (window as any).__motion.useEditor.getState().setTime(4));
  h = await past(page);
  await page.locator('body').press('Control+d');
  expect((await clips(page)).map((c) => c.start)).toEqual([1, 4]);
  expect((await clipAt(page, 1)).duration).toBe((await clipAt(page, 0)).duration);
  expect(await selection(page)).toMatchObject({ audioIds: [(await clipAt(page, 1)).id] });
  await page.locator('body').press('Delete');
  expect((await clips(page)).map((c) => c.start)).toEqual([1]);
  expect(await past(page)).toBe(h + 2);

  // "+ at playhead" on the asset adds another clip right at the playhead.
  await page.getByTestId('asset-add-tone.wav').click();
  expect((await clips(page)).map((c) => c.start)).toEqual([1, 4]);
  await expect(page.getByTestId('audio-toggle')).toHaveText(/Audio \(2\)/);

  // The block collapses (a remembered preference).
  await page.getByTestId('audio-toggle').click();
  await expect(page.getByTestId('audio-row-0')).toHaveCount(0);
  await expect(page.getByTestId('audio-toggle')).toHaveText(/▸ Audio \(2\)/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('motion-studio.prefs')!).audioCollapsed)).toBe(true);
  await page.getByTestId('audio-toggle').click();
  await expect(page.getByTestId('audio-row-1')).toBeVisible();
  expect(errors).toEqual([]);
});

test('music longer than the project starts at 0, is cut to fit and fades out', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('setting-duration').fill('3');
  await page.getByTestId('setting-duration').press('Enter');
  await page.evaluate(() => (window as any).__motion.useEditor.getState().setTime(1.5));
  await page.getByTestId('file-input').setInputFiles(tone('music.wav', 5));
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  expect(await timing(page, 0)).toEqual({ start: 0, trimStart: 0, duration: 3 });
  expect((await clipAt(page, 0)).fadeOut).toBe(0.75); // min(1.5, 3/4)
  // A short sound goes to the playhead; near the end it is shortened and gets a short fade.
  await page.evaluate(() => (window as any).__motion.useEditor.getState().setTime(2.5));
  await page.getByTestId('file-input').setInputFiles(tone('whoosh.wav', 1));
  await expect(page.getByTestId('audio-row-1')).toBeVisible();
  expect(await clipAt(page, 1)).toMatchObject({ start: 2.5, duration: 0.5, fadeOut: 0.125 });
  await expect(page.locator('.toast').filter({ hasText: 'Added whoosh.wav at 0:02.5 — see the Audio rows' })).toBeVisible();
});

test('cursor click sound: picker sets it in one undo step, ● markers on the cursor row, one sound per click', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(tone('click.wav', 0.1));
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  // Keep only the asset: the click sound needs no stored clip.
  await page.getByTestId('clip-delete').click();
  await expect(page.getByTestId('audio-block')).toHaveCount(0);
  await page.getByTestId('add-cursor').click();
  // The default cursor clicks at 1.4 s: one ● marker on its timeline row.
  await expect(page.getByTestId('click-marker-Cursor-0')).toBeVisible();
  await expect(page.getByTestId('click-marker-Cursor-0')).toHaveAttribute('title', /Click at 1\.40s/);

  const h = await past(page);
  await page.getByTestId('cursor-click-sound').selectOption({ label: 'click.wav' });
  expect(await past(page)).toBe(h + 1);
  let st = await getState(page);
  const cursor = st.project.scenes[0].layers[0];
  if (cursor.type !== 'cursor') throw new Error('expected a cursor');
  expect(cursor.clickSound).toEqual({ assetId: st.project.assets[0].id, volume: 1 });
  await setNumber(page, 'cursor-click-volume', '80');
  st = await getState(page);
  expect((st.project.scenes[0].layers[0] as { clickSound: unknown }).clickSound).toMatchObject({ volume: 0.8 });
  await expect(page.getByTestId('click-marker-Cursor-0')).toHaveClass(/sound/);

  // Two more clicks → the preview schedules one sound per click, at the clicks' times.
  await page.evaluate(() => {
    const s = (window as any).__motion.useEditor.getState();
    s.commit((d: any) => void d.scenes[0].layers[0].clicks.push({ id: 'c2', time: 1.6 }, { id: 'c3', time: 0.5 }));
    s.setTime(0);
  });
  await expect(page.getByTestId('click-marker-Cursor-2')).toBeVisible();
  await expect.poll(async () => Object.values((await engine(page)).entries).map((e: any) => e.status)).toEqual(['ready']);
  await page.getByTestId('btn-play').click();
  await expect.poll(async () => (await engine(page)).scheduled.length).toBe(3);
  const when = (await engine(page)).scheduled.map((s: { when: number }) => s.when).sort((a: number, b: number) => a - b);
  [0.5, 1.4, 1.6].forEach((t, i) => expect(when[i]).toBeCloseTo(t, 2));
  await page.getByTestId('btn-play').click();

  // Back to None: one undo step, no sound.
  await page.getByTestId('layer-item-Cursor').locator('.name').click();
  await page.getByTestId('cursor-click-sound').selectOption({ label: 'None' });
  expect((((await getState(page)).project.scenes[0].layers[0]) as { clickSound: unknown }).clickSound).toBeNull();
});

test('missing WAV: Relink appears in Assets, the export warns about it, relinking fixes it', async ({ page }) => {
  await page.goto('/');
  // Small and short so the export below is quick.
  for (const [id, v] of [['setting-duration', '1'], ['setting-width', '320'], ['setting-height', '180']] as const) await setNumber(page, id, v);
  const wav = tone('lost.wav', 1);
  await page.getByTestId('file-input').setInputFiles(wav);
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  const name = `Missing audio ${Date.now()}`;
  await page.getByTestId('btn-save').click();
  await page.getByTestId('save-name').fill(name);
  await page.getByTestId('save-confirm').click();
  await expect(page.getByTestId('dirty-dot')).toHaveCount(0);
  const asset = (await getState(page)).project.assets[0];
  fs.rmSync(path.join(WS, `${name}.motion`, asset.relativePath));
  for (const f of fs.readdirSync(path.join(WS, '.scratch'))) if (f.startsWith(asset.hash)) fs.rmSync(path.join(WS, '.scratch', f));

  await page.reload();
  await page.getByTestId('btn-open').click();
  await page.getByTestId(`open-${name}`).click();
  await expect(page.getByTestId('relink-lost.wav')).toBeVisible();
  await expect(page.getByTestId('relink-lost.wav').locator('input')).toHaveAttribute('accept', '.mp3,.wav,.ogg,.m4a,.aac,.flac');
  await expect(page.getByTestId('audio-clip-0')).toHaveClass(/missing/);

  // Exporting anyway works, without the sound, and the dialog says why.
  await page.getByTestId('btn-export').click();
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-status')).toContainText('done', { timeout: 60_000 });
  await expect(page.getByTestId('export-warnings')).toContainText('Audio file missing: lost.wav — exported without it.');
  await page.keyboard.press('Escape');

  // Relink with the same sound: the missing state clears and the clip keeps its settings.
  const before = await clipAt(page, 0);
  await page.getByTestId('relink-lost.wav').locator('input').setInputFiles(wav);
  await expect(page.getByTestId('relink-lost.wav')).toHaveCount(0);
  await expect(page.getByTestId('audio-clip-0')).not.toHaveClass(/missing/);
  expect(await clipAt(page, 0)).toEqual(before);
  // An image can't replace a sound.
  expect((await getState(page)).project.assets[0]).toMatchObject({ type: 'audio' });
});

test('Sound toggle is a remembered preference; the preview engine follows play, pause, seek, loop and audio edits', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(tone('bed.wav', 2));
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  await expect.poll(async () => Object.values((await engine(page)).entries).map((e: any) => e.status)).toEqual(['ready']);
  // Play (a real click: browsers only let audio start after a user gesture). The project is 15 s long, so playback
  // keeps running through the checks below unless a step stops it.
  await page.getByTestId('btn-play').click();
  await expect.poll(async () => (await engine(page)).playing).toBe(true);
  let e = await engine(page);
  expect(e.contextState).not.toBeNull();
  expect(e.scheduled).toHaveLength(1);
  expect(e.scheduled[0]).toMatchObject({ offset: 0, when: 0 });
  expect(e.scheduled[0].duration).toBeCloseTo(2, 3);
  // A mono file plays at −3 dB per channel, like ffmpeg's stereo up-mix in the export.
  expect(e.scheduled[0].gain).toBeCloseTo(Math.SQRT1_2, 6);

  // Edits that change what is heard restart the audio; adding and moving layers doesn't.
  const g0 = e.generation;
  await store(page, 's.commit((d) => void (d.audio[0].volume = 0.5))');
  await expect.poll(async () => (await engine(page)).generation).toBe(g0 + 1);
  expect((await engine(page)).scheduled[0].gain).toBeCloseTo(0.5 * Math.SQRT1_2, 6);
  await page.getByTestId('add-rect').click();
  await store(page, 's.commit((d) => void (d.scenes[0].layers[0].x += 100))');
  expect((await engine(page)).generation).toBe(g0 + 1);
  expect((await engine(page)).playing).toBe(true);

  // Pause stops it; playing from 1.2 s starts 1.2 s into the clip.
  await store(page, 's.setPlaying(false)');
  await expect.poll(async () => (await engine(page)).playing).toBe(false);
  await store(page, 's.setTime(1.2); s.setPlaying(true)');
  await expect.poll(async () => (await engine(page)).playing).toBe(true);
  e = await engine(page);
  expect(e.from).toBeCloseTo(1.2, 6);
  expect(e.scheduled[0].offset).toBeCloseTo(1.2, 6);
  expect(e.scheduled[0].duration).toBeCloseTo(0.8, 3);

  // Seek while playing: the clock and the audio carry on from the new time.
  const g1 = e.generation;
  await store(page, 's.setTime(0.25)');
  await expect.poll(async () => (await engine(page)).generation).toBeGreaterThan(g1);
  e = await engine(page);
  expect(e.from).toBeCloseTo(0.25, 6);
  expect(e.scheduled[0].offset).toBeCloseTo(0.25, 6);
  await expect.poll(async () => (await getState(page)).time).toBeGreaterThan(0.25);

  // Loop: seek near the end (one restart), then wrapping past the end restarts the audio from the top (another one).
  const g2 = (await engine(page)).generation;
  await store(page, 's.setLoop(true); s.setTime(14.8)');
  await expect.poll(async () => ((e = await engine(page)).generation >= g2 + 2 ? e.from : null), { timeout: 5000 }).toBeLessThan(0.5);
  expect(e.scheduled[0].offset).toBeLessThan(0.5);
  await store(page, 's.setPlaying(false)');

  // Sound off: nothing is scheduled while playing, and the choice survives a reload.
  await page.getByTestId('btn-sound').click();
  await expect(page.getByTestId('btn-sound')).toHaveAttribute('aria-pressed', 'false');
  await store(page, 's.setTime(0); s.setPlaying(true)');
  await expect.poll(async () => (await getState(page)).time).toBeGreaterThan(0);
  expect((await engine(page)).playing).toBe(false);
  // Turning it back on while playing starts the sound right away.
  await page.getByTestId('btn-sound').click();
  await expect.poll(async () => (await engine(page)).playing).toBe(true);
  await page.getByTestId('btn-sound').click();
  await store(page, 's.setPlaying(false)');
  await page.reload();
  await expect(page.getByTestId('btn-sound')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('btn-sound').click();
  await expect(page.getByTestId('btn-sound')).toHaveAttribute('aria-pressed', 'true');
});

test('formats the browser cannot decode (AAC here) still import via the server, and say so on Play', async ({ page }) => {
  await page.goto('/');
  const m4a = test.info().outputPath('voice.m4a');
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'aac', '-b:a', '96k', m4a]);
  await page.getByTestId('file-input').setInputFiles(m4a);
  await expect(page.getByTestId('audio-row-0')).toBeVisible();
  const asset = (await getState(page)).project.assets[0];
  expect(asset.duration).toBeGreaterThan(1.95);
  expect(asset.duration).toBeLessThan(2.1);
  await expect(page.getByTestId('audio-clip-0').getByTestId('waveform')).toHaveAttribute('data-ready', 'yes');
  const decodable = await page.evaluate(async () => {
    try {
      await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await (await fetch(`/api/asset?${new URLSearchParams({ path: 'x', hash: (window as any).__motion.useEditor.getState().project.assets[0].hash })}`)).arrayBuffer());
      return true;
    } catch {
      return false;
    }
  });
  test.skip(decodable, 'this Chromium decodes AAC itself');
  await expect.poll(async () => Object.values((await engine(page)).entries).map((e: any) => e.status)).toEqual(['unsupported']);
  await page.getByTestId('btn-play').click();
  await expect(page.locator('.toast').filter({ hasText: "voice.m4a: can't preview this format in this browser — the export will include it." })).toBeVisible();
  await page.getByTestId('btn-play').click();
});
