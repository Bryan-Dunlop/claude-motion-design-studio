// B2 keyframe UX: selecting diamonds (click / Shift), the "Keyframe easing (n selected)" panel with Delete, keyboard
// precedence (Delete/Backspace, Esc, Ctrl+C/V, Ctrl+D), per-property keyframe rows, and keyframe / layer paste.
import { expect, test } from '@playwright/test';
import { center, drag, getState, past } from './helpers';
import { editor, layersByName, setNumber, setTime, shortcut, store, toast, track } from './app-ui-helpers';

test('select diamonds (Shift adds), set their easing, Delete / Backspace / the panel button remove keyframes but keep the layer; Esc clears keyframes first', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  const rectId = (await layersByName(page)).Rectangle.id;
  const panel = page.getByTestId('kf-selection').locator('summary');

  // ◆ adds a keyframe at the playhead and selects it.
  await page.getByTestId('kf-toggle-x').click();
  await expect(panel).toHaveText('Keyframe easing (1 selected)');
  await page.getByTestId('kf-toggle-opacity').click();
  await expect(panel).toHaveText('Keyframe easing (1 selected)');
  await setTime(page, 1);
  await setNumber(page, 'prop-x', '2400');
  await setNumber(page, 'prop-opacity', '0.5');
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920], [1, 2400]]);

  // Click a diamond: its keyframes (x and opacity at 1 s) become the selection.
  await page.getByTestId('kf-Rectangle-30').click();
  await expect(page.getByTestId('kf-Rectangle-30')).toHaveAttribute('data-selected', 'yes');
  await expect(page.getByTestId('kf-Rectangle-0')).toHaveAttribute('data-selected', 'no');
  await expect(panel).toHaveText('Keyframe easing (2 selected)');
  await expect(page.getByTestId('kf-selection')).toContainText('(X position, Opacity)');
  // Shift-click adds the ones at 0 s.
  await page.getByTestId('kf-Rectangle-0').click({ modifiers: ['Shift'] });
  await expect(panel).toHaveText('Keyframe easing (4 selected)');
  expect((await editor(page)).selectedKeys).toHaveLength(4);

  // One easing change for all four = one undo step.
  let h = await past(page);
  await page.getByTestId('kf-easing').selectOption('linear');
  const rect = (await layersByName(page)).Rectangle;
  expect([...rect.keyframes.x, ...rect.keyframes.opacity].map((k) => k.easing.type)).toEqual(['linear', 'linear', 'linear', 'linear']);
  expect(await past(page)).toBe(h + 1);

  // Shift-click on a selected diamond takes it out of the selection again.
  await page.getByTestId('kf-Rectangle-0').click({ modifiers: ['Shift'] });
  await expect(panel).toHaveText('Keyframe easing (2 selected)');
  await expect(page.getByTestId('kf-Rectangle-0')).toHaveAttribute('data-selected', 'no');

  // Delete removes the selected keyframes only: the layer stays, still selected. One undo step.
  h = await past(page);
  await shortcut(page, 'Delete');
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920]]);
  expect(await track(page, 'Rectangle', 'opacity')).toEqual([[0, 1]]);
  expect(await past(page)).toBe(h + 1);
  expect(await editor(page)).toMatchObject({ selectedKeys: [], selection: { layerIds: [rectId] } });
  await expect(page.getByTestId('kf-selection')).toHaveCount(0);

  // Undo brings them back, unselected (the selection only keeps keyframes that exist).
  await shortcut(page, 'Control+z');
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920], [1, 2400]]);
  expect((await editor(page)).selectedKeys).toEqual([]);

  // The panel's Delete button does the same.
  await page.getByTestId('kf-Rectangle-30').click();
  h = await past(page);
  await page.getByTestId('kf-delete').click();
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920]]);
  expect(await past(page)).toBe(h + 1);

  // Backspace too. With no keyframe left the property is static again.
  await page.getByTestId('kf-Rectangle-0').click();
  await shortcut(page, 'Backspace');
  expect((await layersByName(page)).Rectangle).toMatchObject({ keyframes: {}, x: 1920, opacity: 1 });

  // Nothing but the layer selected: now Delete deletes the layer.
  await shortcut(page, 'Delete');
  expect(await layersByName(page)).toEqual({});
  await shortcut(page, 'Control+z');
  expect(Object.keys(await layersByName(page))).toEqual(['Rectangle']);

  // Esc: first the keyframe selection, then the layer selection.
  await page.getByTestId('layer-item-Rectangle').locator('.name').click();
  await page.getByTestId('kf-toggle-y').click();
  expect((await editor(page)).selectedKeys).toHaveLength(1);
  await shortcut(page, 'Escape');
  expect(await editor(page)).toMatchObject({ selectedKeys: [], selection: { layerIds: [rectId] } });
  await shortcut(page, 'Escape');
  expect((await editor(page)).selection.layerIds).toEqual([]);

  // Undo of the step that created a selected keyframe drops it from the selection.
  await page.getByTestId('layer-item-Rectangle').locator('.name').click();
  await page.getByTestId('kf-toggle-scale').click();
  expect((await editor(page)).selectedKeys).toHaveLength(1);
  await shortcut(page, 'Control+z');
  expect((await editor(page)).selectedKeys).toEqual([]);
  expect(errors).toEqual([]);
});

test('▸ shows one row per animated property with plain labels; dragging a diamond there moves only that keyframe', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await page.getByTestId('kf-toggle-x').click();
  await page.getByTestId('kf-toggle-opacity').click();
  await setTime(page, 1);
  await setNumber(page, 'prop-x', '2400');
  await setNumber(page, 'prop-opacity', '0.5');
  // Effects / trim keyframes get their labels from the shared table too.
  await store(page, `s.commit((d) => { const l = d.scenes[0].layers[0]; l.keyframes.shadowBlur = [{ id: 'sb', time: 0.5, value: 4, easing: { type: 'linear' } }]; l.keyframes.trimEnd = [{ id: 'te', time: 0.5, value: 1, easing: { type: 'linear' } }]; })`);

  await expect(page.getByTestId('kf-row-Rectangle-x')).toHaveCount(0);
  await page.getByTestId('tl-expand-Rectangle').click();
  await expect(page.locator('[data-testid^="kf-row-Rectangle-"] .tl-label')).toHaveText(['X position', 'Opacity', 'Trim end', 'Shadow softness']);

  // Drag the x keyframe at 1 s (frame 30) one second later: opacity's key at 1 s stays. One undo step.
  const zoom = (await editor(page)).zoom;
  const h = await past(page);
  await drag(page, await center(page, 'kf-Rectangle-x-30'), zoom, 0);
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920], [2, 2400]]);
  expect(await track(page, 'Rectangle', 'opacity')).toEqual([[0, 1], [1, 0.5]]);
  expect(await past(page)).toBe(h + 1);
  // It is the selection now, alone; the layer row shows a diamond for each time.
  const xKey = (await layersByName(page)).Rectangle.keyframes.x[1];
  expect((await editor(page)).selectedKeys).toEqual([xKey.id]);
  await expect(page.getByTestId('kf-Rectangle-x-60')).toHaveAttribute('data-selected', 'yes');
  for (const f of [0, 15, 30, 60]) await expect(page.getByTestId(`kf-Rectangle-${f}`)).toBeVisible();

  // Dragging a selected diamond moves the whole selection by the same amount.
  await page.getByTestId('kf-Rectangle-opacity-30').click({ modifiers: ['Shift'] });
  expect((await editor(page)).selectedKeys).toHaveLength(2);
  await drag(page, await center(page, 'kf-Rectangle-opacity-30'), zoom / 2, 0);
  expect(await track(page, 'Rectangle', 'x')).toEqual([[0, 1920], [2.5, 2400]]);
  expect(await track(page, 'Rectangle', 'opacity')).toEqual([[0, 1], [1.5, 0.5]]);

  // Clicking a row's label selects all of that property's keyframes.
  await page.getByTestId('kf-row-label-Rectangle-x').click();
  const x = (await layersByName(page)).Rectangle.keyframes.x;
  expect((await editor(page)).selectedKeys).toEqual(x.map((k) => k.id));
  await page.getByTestId('kf-row-label-Rectangle-opacity').click({ modifiers: ['Shift'] });
  expect((await editor(page)).selectedKeys).toHaveLength(4);

  await page.getByTestId('tl-expand-Rectangle').click();
  await expect(page.getByTestId('kf-row-Rectangle-x')).toHaveCount(0);
});

test('Ctrl+C / Ctrl+V keyframes: x/y relative to each target, every selected layer, skipped properties, Ctrl+Shift+V absolute', async ({ page }) => {
  await page.goto('/');
  // Source motion on a rectangle: x +400, y +200 and opacity 1 → 0.5 between 0 s and 1 s.
  await page.getByTestId('add-rect').click();
  for (const p of ['x', 'y', 'opacity']) await page.getByTestId(`kf-toggle-${p}`).click();
  await setTime(page, 1);
  await setNumber(page, 'prop-x', '2320');
  await setNumber(page, 'prop-y', '1280');
  await setNumber(page, 'prop-opacity', '0.5');
  await page.getByTestId('kf-Rectangle-0').click();
  await page.getByTestId('kf-Rectangle-30').click({ modifiers: ['Shift'] });
  expect((await editor(page)).selectedKeys).toHaveLength(6);
  await shortcut(page, 'Control+c');
  await toast(page, 'Copied 6 keyframes. Select a layer and press Ctrl+V to paste them at the playhead.');

  // A text layer somewhere else; paste at 2 s: the motion starts where the text is.
  await page.getByTestId('add-text').click();
  await setNumber(page, 'prop-x', '1000');
  await setNumber(page, 'prop-y', '500');
  await setTime(page, 2);
  let h = await past(page);
  await shortcut(page, 'Control+v');
  await toast(page, 'Pasted 6 keyframes');
  expect(await past(page)).toBe(h + 1);
  expect(await track(page, 'Text', 'x')).toEqual([[2, 1000], [3, 1400]]);
  expect(await track(page, 'Text', 'y')).toEqual([[2, 500], [3, 700]]);
  expect(await track(page, 'Text', 'opacity')).toEqual([[2, 1], [3, 0.5]]);
  // The pasted keyframes are selected.
  const text = (await layersByName(page)).Text;
  expect((await editor(page)).selectedKeys.sort()).toEqual(Object.values(text.keyframes).flat().map((k) => k.id).sort());

  // Ctrl+Shift+V pastes the copied values as they are (replacing the keys on the same frames).
  await shortcut(page, 'Control+Shift+v');
  expect(await track(page, 'Text', 'x')).toEqual([[2, 1920], [3, 2320]]);
  expect(await track(page, 'Text', 'y')).toEqual([[2, 1080], [3, 1280]]);
  await shortcut(page, 'Control+z');
  expect(await track(page, 'Text', 'x')).toEqual([[2, 1000], [3, 1400]]);

  // Onto two layers at once (text + cursor): a cursor has no x/y keyframes, so those are skipped and reported.
  await page.getByTestId('add-cursor').click();
  await page.getByTestId('layer-item-Text').locator('.name').click({ modifiers: ['Shift'] });
  await setTime(page, 4);
  h = await past(page);
  await shortcut(page, 'Control+v');
  await toast(page, 'Pasted 8 keyframes (4 skipped: not available on cursor)');
  expect(await past(page)).toBe(h + 1);
  expect(await track(page, 'Cursor', 'opacity')).toEqual([[4, 1], [5, 0.5]]);
  // The pasted keyframes (on two layers) are the selection, editable together.
  await expect(page.getByTestId('kf-selection').locator('summary')).toHaveText('Keyframe easing (8 selected)');
  await expect(page.locator('.props h3').first()).toHaveText('2 layers selected');
  expect(Object.keys((await layersByName(page)).Cursor.keyframes)).toEqual(['opacity']);
  // On the text, x continues from where it is at 4 s (1400, the end of the first paste).
  expect(await track(page, 'Text', 'x')).toEqual([[2, 1000], [3, 1400], [4, 1400], [5, 1800]]);

  // The playhead outside the layer: nothing is pasted, and the toast says why.
  await page.getByTestId('layer-item-Text').locator('.name').click();
  await setNumber(page, 'prop-start', '10');
  await setTime(page, 2);
  h = await past(page);
  await shortcut(page, 'Control+v');
  await toast(page, 'Move the playhead inside "Text" to paste keyframes there.');
  expect(await past(page)).toBe(h);
});

test('Ctrl+C / Ctrl+V layers into the selected scene at the same timing; Esc first so Ctrl+C takes the layer; Ctrl+D duplicates', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-rect').click();
  await setNumber(page, 'prop-start', '1.5');
  await page.getByTestId('kf-toggle-x').click(); // a selected keyframe: Ctrl+C would copy it
  await shortcut(page, 'Escape');
  expect((await editor(page)).selectedKeys).toEqual([]);
  await shortcut(page, 'Control+c');
  await toast(page, 'Copied 1 layer. Ctrl+V pastes into the selected scene.');

  await page.getByTestId('add-scene').click(); // Scene 2 becomes the selected scene
  await store(page, 's.commit((d) => { d.scenes[1].start = 5; d.scenes[1].duration = 5; })');
  const h = await past(page);
  await shortcut(page, 'Control+v');
  expect(await past(page)).toBe(h + 1);
  let st = await getState(page);
  const [src] = st.project.scenes[0].layers;
  const [copy] = st.project.scenes[1].layers;
  expect(copy).toMatchObject({ name: 'Rectangle', start: 1.5, duration: src.duration, x: src.x });
  expect(copy.id).not.toBe(src.id);
  expect(copy.keyframes.x[0].id).not.toBe(src.keyframes.x[0].id);
  expect((await editor(page)).selection).toMatchObject({ sceneId: st.project.scenes[1].id, layerIds: [copy.id] });

  // Pasting again into the same scene: the name says it's a copy.
  await shortcut(page, 'Control+v');
  st = await getState(page);
  expect(st.project.scenes[1].layers.map((l) => l.name)).toEqual(['Rectangle', 'Rectangle copy']);

  // Ctrl+D duplicates the selected layer (with keyframes selected too, it's still the layer).
  await page.getByTestId('kf-Rectangle copy-0').click();
  expect((await editor(page)).selectedKeys).toHaveLength(1);
  await shortcut(page, 'Control+d');
  st = await getState(page);
  expect(st.project.scenes[1].layers.map((l) => l.name)).toEqual(['Rectangle', 'Rectangle copy', 'Rectangle copy copy']);

  // Nothing copied yet in a fresh page: Ctrl+V explains.
  await page.reload();
  await shortcut(page, 'Control+v');
  await toast(page, 'Nothing to paste yet: select keyframes, layers or audio clips and press Ctrl+C first.');
});
