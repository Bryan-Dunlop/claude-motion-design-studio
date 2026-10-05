import { useState } from 'react';
import { BUILTIN_FONTS } from '../../shared/loadResources';
import { applyPreset, DEFAULT_PRESET, makeId, staggerStarts, type PresetParams, type StaggerParams } from '../../shared/presets';
import { cursorPosition } from '../../shared/renderFrame';
import { ANIMATABLE, type Easing, type Layer, type Scene } from '../../shared/schema';
import { relinkAsset, updateLayers, updateSettings } from '../actions';
import { currentValue, findLayer, keyAt, layerLocalTime, setProp, toggleKeyframe, useEditor } from '../store';
import { ColorField, EasingPicker, NumberField, Row, Section, Select, TextField } from './Fields';

const TIPS: Record<string, string> = {
  x: 'Horizontal position of the anchor point, in project pixels from the left edge.',
  y: 'Vertical position of the anchor point, in project pixels from the top edge.',
  scale: 'Size multiplier. 1 = original size, 2 = double, 0.5 = half.',
  rotation: 'Rotation in degrees around the anchor point. Positive = clockwise.',
  opacity: 'How see-through the layer is. 1 = solid, 0 = invisible.',
  fontSize: 'Text height in project pixels.',
  letterSpacing: 'Extra space between letters, in pixels. Negative tightens.',
  color: 'Text colour.',
  width: 'Width in project pixels (before scale).',
  height: 'Height in project pixels (before scale).',
  cornerRadius: 'Rounds the rectangle corners, in pixels.',
  fill: 'Fill colour of the shape.',
};

function KfToggle({ scene, layer, prop }: { scene: Scene; layer: Layer; prop: string }) {
  const time = useEditor((s) => s.time);
  const fps = useEditor((s) => s.project.settings.fps);
  const keys = layer.keyframes[prop];
  const local = layerLocalTime(scene, layer, time);
  const on = !!keyAt(keys, local, fps);
  const animated = !!keys?.length;
  return (
    <button
      className={`kf-toggle ${on ? 'on' : animated ? 'animated' : ''}`}
      data-testid={`kf-toggle-${prop}`}
      title={
        on
          ? 'Remove the keyframe at the playhead'
          : animated
            ? 'Add a keyframe at the playhead (this property is animated)'
            : 'Start animating: add a keyframe for this property at the playhead'
      }
      onClick={() => useEditor.getState().commit((d) => toggleKeyframe(d, layer.id, prop, useEditor.getState().time))}
    >
      ◆
    </button>
  );
}

export function Properties() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const time = useEditor((s) => s.time);
  const selected = selection.layerIds.map((id) => findLayer(project, id)).filter((x): x is NonNullable<typeof x> => !!x);
  const scene = project.scenes.find((s) => s.id === selection.sceneId);

  if (selected.length === 1) return <LayerProps scene={selected[0].scene} layer={selected[0].layer} time={time} />;
  if (selected.length > 1)
    return (
      <div className="props">
        <h3>{selected.length} layers selected</h3>
        <PresetPanel layerIds={selected.map((s) => s.layer.id)} />
        <StaggerPanel layers={selected.map((s) => s.layer)} />
      </div>
    );
  return (
    <div className="props">
      {scene && <SceneProps scene={scene} />}
      <ProjectSettings />
    </div>
  );
}

function ProjectSettings() {
  const st = useEditor((s) => s.project.settings);
  return (
    <Section title="Project settings">
      <Row label="Duration" tip="Total length of the video in seconds. Shortening never deletes layers.">
        <NumberField value={st.durationSec} step={1} min={0.1} max={3600} onCommit={(v) => updateSettings({ durationSec: v })} testId="setting-duration" />
      </Row>
      <Row label="Aspect" tip="Frame shape. Keeps the long edge and adjusts the other one. Layers are kept.">
        <Select
          value={st.aspect}
          testId="setting-aspect"
          options={[
            { value: '16:9', label: '16:9 landscape' },
            { value: '9:16', label: '9:16 vertical' },
            { value: '1:1', label: '1:1 square' },
            { value: '4:5', label: '4:5 portrait' },
            { value: 'custom', label: 'Custom' },
          ]}
          onChange={(aspect) => updateSettings({ aspect })}
        />
      </Row>
      <Row label="Width" tip="Output width in pixels (even numbers encode best).">
        <NumberField value={st.width} min={16} max={7680} decimals={0} onCommit={(v) => updateSettings({ width: Math.round(v) })} testId="setting-width" />
      </Row>
      <Row label="Height" tip="Output height in pixels.">
        <NumberField value={st.height} min={16} max={7680} decimals={0} onCommit={(v) => updateSettings({ height: Math.round(v) })} testId="setting-height" />
      </Row>
      <Row label="Resolution" tip="Quick presets for the long edge. Keeps the aspect ratio.">
        <Select
          value={'' as string}
          options={[
            { value: '', label: 'Preset…' },
            { value: '1280', label: '720p' },
            { value: '1920', label: '1080p' },
            { value: '2560', label: '1440p' },
            { value: '3840', label: '4K' },
          ]}
          onChange={(v) => {
            if (!v) return;
            const long = Number(v);
            const r = st.width / st.height;
            const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
            updateSettings(r >= 1 ? { width: long, height: even(long / r) } : { height: long, width: even(long * r) });
          }}
        />
      </Row>
      <Row label="FPS" tip="Frames per second of the exported video.">
        <Select
          value={String(st.fps)}
          testId="setting-fps"
          options={['24', '25', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` }))}
          onChange={(v) => updateSettings({ fps: Number(v) })}
        />
      </Row>
      <Row label="Background" tip="Colour behind all layers.">
        <ColorField value={st.background} onLive={(background) => useEditor.getState().commit((d) => void (d.settings.background = background))} />
      </Row>
    </Section>
  );
}

function SceneProps({ scene }: { scene: Scene }) {
  const commit = useEditor((s) => s.commit);
  const fps = useEditor((s) => s.project.settings.fps);
  const set = (k: 'start' | 'duration', v: number) =>
    commit((d) => {
      const s = d.scenes.find((x) => x.id === scene.id);
      if (s) s[k] = k === 'duration' ? Math.max(1 / fps, v) : Math.max(0, v);
    });
  return (
    <Section title={`Scene: ${scene.name}`}>
      <Row label="Name" tip="Scene name (also editable in the Scenes list).">
        <TextField value={scene.name} onCommit={(v) => commit((d) => void (d.scenes.find((x) => x.id === scene.id)!.name = v || scene.name))} />
      </Row>
      <Row label="Start" tip="When the scene begins, in seconds from the start of the video.">
        <NumberField value={scene.start} step={0.1} min={0} onCommit={(v) => set('start', v)} />
      </Row>
      <Row label="Duration" tip="How long the scene lasts, in seconds.">
        <NumberField value={scene.duration} step={0.1} min={0.01} onCommit={(v) => set('duration', v)} />
      </Row>
    </Section>
  );
}

function LayerProps({ scene, layer, time }: { scene: Scene; layer: Layer; time: number }) {
  const commit = useEditor((s) => s.commit);
  const fps = useEditor((s) => s.project.settings.fps);
  const assets = useEditor((s) => s.project.assets);
  const missing = useEditor((s) => s.missingAssets);
  const animatable = ANIMATABLE[layer.type];
  const val = (p: string) => currentValue(scene, layer, p, time);
  const setP = (p: string, v: number | string) => commit((d) => setProp(d, layer.id, p, v, useEditor.getState().time));
  const setStatic = (patch: Record<string, unknown>) => updateLayers([layer.id], (l) => void Object.assign(l, patch));
  const local = layerLocalTime(scene, layer, time);
  const active = local >= 0 && local < layer.duration;

  const num = (p: string, label: string, opts: { step?: number; min?: number; max?: number; decimals?: number } = {}) => (
    <Row label={label} tip={TIPS[p] ?? label} kf={animatable.includes(p) ? <KfToggle scene={scene} layer={layer} prop={p} /> : null}>
      <NumberField value={Number(val(p))} step={opts.step ?? 1} min={opts.min} max={opts.max} decimals={opts.decimals} onCommit={(v) => setP(p, v)} testId={`prop-${p}`} />
    </Row>
  );
  const color = (p: string, label: string) => (
    <Row label={label} tip={TIPS[p] ?? label} kf={animatable.includes(p) ? <KfToggle scene={scene} layer={layer} prop={p} /> : null}>
      <ColorField
        value={String(val(p))}
        testId={`prop-${p}`}
        onLive={(v) => commit((d) => setProp(d, layer.id, p, v, useEditor.getState().time))}
      />
    </Row>
  );

  // Keyframes sitting at the playhead (for the easing picker).
  const keysHere = Object.entries(layer.keyframes).flatMap(([prop, keys]) => {
    const k = keyAt(keys, local, fps);
    return k ? [{ prop, k }] : [];
  });

  return (
    <div className="props">
      <h3>
        {layer.name} <span className="muted">· {layer.type}</span>
      </h3>
      {!active && <p className="warn">The playhead is outside this layer's time range, so it isn't visible right now.</p>}
      <Section title="Layer">
        <Row label="Name" tip="Layer name shown in the Layers list and timeline.">
          <TextField value={layer.name} onCommit={(v) => setStatic({ name: v || layer.name })} testId="prop-name" />
        </Row>
        <Row label="Start" tip="When the layer appears, in seconds after its scene starts.">
          <NumberField value={layer.start} step={0.1} min={0} onCommit={(v) => setStatic({ start: v })} testId="prop-start" />
        </Row>
        <Row label="Duration" tip="How long the layer stays on screen, in seconds.">
          <NumberField value={layer.duration} step={0.1} min={1 / fps} onCommit={(v) => setStatic({ duration: v })} testId="prop-duration" />
        </Row>
      </Section>

      <Section title="Transform">
        {layer.type !== 'cursor' && num('x', 'X', { step: 1 })}
        {layer.type !== 'cursor' && num('y', 'Y', { step: 1 })}
        {num('scale', 'Scale', { step: 0.05, min: 0, decimals: 3 })}
        {layer.type !== 'cursor' && num('rotation', 'Rotation', { step: 1 })}
        {num('opacity', 'Opacity', { step: 0.05, min: 0, max: 1, decimals: 3 })}
        {layer.type !== 'cursor' && (
          <Row label="Anchor" tip="The pivot point for rotation and scaling, as a fraction of the layer box (0.5, 0.5 = centre).">
            <span className="pair">
              <NumberField value={layer.anchorX} step={0.1} decimals={3} onCommit={(v) => setStatic({ anchorX: v })} />
              <NumberField value={layer.anchorY} step={0.1} decimals={3} onCommit={(v) => setStatic({ anchorY: v })} />
            </span>
          </Row>
        )}
      </Section>

      {layer.type === 'text' && (
        <Section title="Typography">
          <Row label="Text" tip="The words shown. Press Enter for a new line.">
            <TextField multiline value={layer.content} onCommit={(v) => setStatic({ content: v })} testId="prop-content" />
          </Row>
          <Row label="Font" tip="Font family. Import TTF/OTF/WOFF files to add more.">
            <Select
              value={layer.fontFamily}
              testId="prop-fontFamily"
              options={[...BUILTIN_FONTS, ...assets.filter((a) => a.type === 'font').map((a) => a.fontFamily!)]
                .filter((v, i, a) => a.indexOf(v) === i)
                .map((f) => ({ value: f, label: f }))}
              onChange={(fontFamily) => setStatic({ fontFamily })}
            />
          </Row>
          {num('fontSize', 'Size', { step: 2, min: 1 })}
          <Row label="Weight" tip="How bold the text is (100 thin – 900 black).">
            <Select
              value={String(layer.fontWeight)}
              options={['300', '400', '500', '600', '700', '800', '900'].map((w) => ({ value: w, label: w }))}
              onChange={(w) => setStatic({ fontWeight: Number(w) })}
            />
          </Row>
          <Row label="Line height" tip="Space between lines, as a multiple of the font size.">
            <NumberField value={layer.lineHeight} step={0.05} min={0.5} max={4} onCommit={(v) => setStatic({ lineHeight: v })} />
          </Row>
          {num('letterSpacing', 'Spacing', { step: 0.5 })}
          <Row label="Align" tip="How lines line up with each other.">
            <Select
              value={layer.align}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Centre' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(align) => setStatic({ align })}
            />
          </Row>
          {color('color', 'Colour')}
        </Section>
      )}

      {layer.type === 'shape' && (
        <Section title="Shape">
          <Row label="Type" tip="Rectangle or ellipse.">
            <Select
              value={layer.shape}
              options={[
                { value: 'rect', label: 'Rectangle' },
                { value: 'ellipse', label: 'Ellipse' },
              ]}
              onChange={(shape) => setStatic({ shape })}
            />
          </Row>
          {num('width', 'Width', { min: 1 })}
          {num('height', 'Height', { min: 1 })}
          {layer.shape === 'rect' && num('cornerRadius', 'Corners', { min: 0 })}
          {color('fill', 'Fill')}
          <Row label="Stroke" tip="Outline colour.">
            <ColorField value={layer.stroke} onLive={(stroke) => commit((d) => void Object.assign(findLayer(d, layer.id)!.layer, { stroke }))} />
          </Row>
          <Row label="Stroke width" tip="Outline thickness in pixels. 0 = no outline.">
            <NumberField value={layer.strokeWidth} min={0} onCommit={(v) => setStatic({ strokeWidth: v })} />
          </Row>
        </Section>
      )}

      {layer.type === 'image' && (
        <Section title="Image">
          {(() => {
            const asset = assets.find((a) => a.id === layer.assetId);
            const isMissing = !asset || missing.has(layer.assetId);
            return (
              <>
                <p className="muted">{asset?.originalName ?? 'Unknown asset'}</p>
                {isMissing && asset && <RelinkButton assetId={asset.id} name={asset.originalName} />}
                {num('width', 'Width', { min: 1 })}
                {num('height', 'Height', { min: 1 })}
                {asset?.width && (
                  <button
                    title="Reset width/height to the file's natural pixel size"
                    onClick={() => setStatic({ width: asset.width, height: asset.height })}
                  >
                    Natural size
                  </button>
                )}
              </>
            );
          })()}
        </Section>
      )}

      {layer.type === 'cursor' && <CursorPanel layer={layer} scene={scene} />}

      {keysHere.length > 0 && (
        <Section title={`Keyframe easing at ${local.toFixed(2)}s`}>
          <p className="help">Controls how the value travels from this keyframe to the next one ({keysHere.map((k) => k.prop).join(', ')}).</p>
          <EasingPicker
            value={keysHere[0].k.easing}
            testId="kf-easing"
            onChange={(easing: Easing) =>
              commit((d) => {
                const l = findLayer(d, layer.id)!.layer;
                for (const { prop, k } of keysHere) {
                  const target = l.keyframes[prop]?.find((x) => x.id === k.id);
                  if (target) target.easing = easing;
                }
              })
            }
          />
        </Section>
      )}

      <PresetPanel layerIds={[layer.id]} />
    </div>
  );
}

export function RelinkButton({ assetId, name }: { assetId: string; name: string }) {
  return (
    <label className="button danger" title="The original file is missing. Pick a replacement file; layers using it keep their settings.">
      Missing: {name} — Relink…
      <input type="file" hidden accept=".png,.jpg,.jpeg,.webp,.svg,.ttf,.otf,.woff,.woff2" onChange={(e) => e.target.files?.[0] && relinkAsset(assetId, e.target.files[0])} />
    </label>
  );
}

function CursorPanel({ layer, scene }: { layer: Extract<Layer, { type: 'cursor' }>; scene: Scene }) {
  const commit = useEditor((s) => s.commit);
  const time = useEditor((s) => s.time);
  const local = Math.min(Math.max(0, layer.duration > 0 ? time - scene.start - layer.start : 0), layer.duration);
  const edit = (fn: (l: Extract<Layer, { type: 'cursor' }>) => void) =>
    commit((d) => {
      const l = findLayer(d, layer.id)?.layer;
      if (l?.type === 'cursor') fn(l);
    });
  const pts = [...layer.points].sort((a, b) => a.time - b.time);
  return (
    <Section title="Cursor">
      <Row label="Size" tip="Pointer size in project pixels.">
        <NumberField value={layer.size} min={4} onCommit={(v) => edit((l) => void (l.size = v))} />
      </Row>
      <Row label="Colour" tip="Pointer fill colour.">
        <ColorField value={layer.color} onLive={(v) => edit((l) => void (l.color = v))} />
      </Row>
      <Row label="Ripple" tip="Colour of the click ripple (use alpha, e.g. #ffffff66).">
        <ColorField value={layer.rippleColor} onLive={(v) => edit((l) => void (l.rippleColor = v))} />
      </Row>
      <Row label="Smoothing" tip="0 = straight lines between points, 1 = smooth curved path.">
        <NumberField value={layer.smoothing} step={0.1} min={0} max={1} onCommit={(v) => edit((l) => void (l.smoothing = v))} testId="cursor-smoothing" />
      </Row>
      <h4>Path points</h4>
      <p className="help">The pointer arrives at each point at its time. Drag points in the preview to move them.</p>
      {pts.map((p, i) => (
        <div className="list-row" key={p.id}>
          <span>{i + 1}</span>
          <label title="Arrival time (seconds after the layer starts)">
            t
            <NumberField value={p.time} step={0.1} min={0} onCommit={(v) => edit((l) => void (l.points.find((q) => q.id === p.id)!.time = v))} />
          </label>
          <label title="Target X position">
            x
            <NumberField value={p.x} decimals={0} onCommit={(v) => edit((l) => void (l.points.find((q) => q.id === p.id)!.x = v))} />
          </label>
          <label title="Target Y position">
            y
            <NumberField value={p.y} decimals={0} onCommit={(v) => edit((l) => void (l.points.find((q) => q.id === p.id)!.y = v))} />
          </label>
          <button title="Delete this point" disabled={layer.points.length <= 1} onClick={() => edit((l) => void (l.points = l.points.filter((q) => q.id !== p.id)))}>
            ✕
          </button>
        </div>
      ))}
      <button
        title="Add a path point at the playhead time, at the cursor's current position (then drag it)"
        onClick={() =>
          edit((l) => {
            const pos = cursorPosition(layer, local);
            l.points.push({ id: makeId('pt'), x: pos.x + 80, y: pos.y + 40, time: Math.round(local * 100) / 100 });
            l.points.sort((a, b) => a.time - b.time);
          })
        }
      >
        + Point at playhead
      </button>
      <h4>Clicks</h4>
      {layer.clicks.map((c) => (
        <div className="list-row" key={c.id}>
          <label title="Click time (seconds after the layer starts). Shows a press + ripple.">
            t
            <NumberField value={c.time} step={0.1} min={0} onCommit={(v) => edit((l) => void (l.clicks.find((q) => q.id === c.id)!.time = v))} />
          </label>
          <button title="Delete this click" onClick={() => edit((l) => void (l.clicks = l.clicks.filter((q) => q.id !== c.id)))}>
            ✕
          </button>
        </div>
      ))}
      <button title="Add a click (press + ripple) at the playhead time" onClick={() => edit((l) => void l.clicks.push({ id: makeId('click'), time: Math.round(local * 100) / 100 }))}>
        + Click at playhead
      </button>
    </Section>
  );
}

function PresetPanel({ layerIds }: { layerIds: string[] }) {
  const [p, setP] = useState<PresetParams>(DEFAULT_PRESET);
  const commit = useEditor((s) => s.commit);
  const apply = () =>
    commit((d) => {
      for (const id of layerIds) {
        const hit = findLayer(d, id);
        if (hit) hit.layer.keyframes = applyPreset(hit.layer, p);
      }
    });
  const remove = () =>
    commit((d) => {
      for (const id of layerIds) {
        const l = findLayer(d, id)?.layer;
        if (!l) continue;
        for (const [prop, keys] of Object.entries(l.keyframes)) {
          const kept = keys.filter((k) => k.source !== `preset:${p.phase}`);
          if (kept.length) l.keyframes[prop] = kept;
          else delete l.keyframes[prop];
        }
      }
    });
  return (
    <Section title="Animation presets" defaultOpen={false}>
      <p className="help">Generates normal keyframes you can edit afterwards. Applying again replaces the previous preset of the same phase.</p>
      <Row label="Effect" tip="What changes: position (slide), opacity (fade) or size (scale).">
        <Select
          value={p.kind}
          testId="preset-kind"
          options={[
            { value: 'fade', label: 'Fade' },
            { value: 'slide', label: 'Slide' },
            { value: 'scale', label: 'Scale' },
          ]}
          onChange={(kind) => setP({ ...p, kind })}
        />
      </Row>
      <Row label="Phase" tip="In = at the layer's start, Out = at the layer's end.">
        <Select
          value={p.phase}
          testId="preset-phase"
          options={[
            { value: 'in', label: 'In (entrance)' },
            { value: 'out', label: 'Out (exit)' },
          ]}
          onChange={(phase) => setP({ ...p, phase })}
        />
      </Row>
      {p.kind === 'slide' && (
        <>
          <Row label="Direction" tip="Direction of travel.">
            <Select
              value={p.direction}
              options={[
                { value: 'up', label: 'Up' },
                { value: 'down', label: 'Down' },
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(direction) => setP({ ...p, direction })}
            />
          </Row>
          <Row label="Distance" tip="How far it travels, in project pixels.">
            <NumberField value={p.distance} step={10} min={0} onCommit={(distance) => setP({ ...p, distance })} />
          </Row>
        </>
      )}
      <Row label="Delay" tip="Seconds after the layer starts (in) or before it ends (out).">
        <NumberField value={p.delay} step={0.1} min={0} onCommit={(delay) => setP({ ...p, delay })} />
      </Row>
      <Row label="Duration" tip="How long the animation takes, in seconds.">
        <NumberField value={p.duration} step={0.1} min={0.01} onCommit={(duration) => setP({ ...p, duration })} testId="preset-duration" />
      </Row>
      <EasingPicker value={p.easing} onChange={(easing) => setP({ ...p, easing })} />
      <div className="btn-row">
        <button className="primary" onClick={apply} data-testid="preset-apply" title="Generate keyframes on the selected layer(s)">
          Apply
        </button>
        <button onClick={remove} title="Remove keyframes created by this phase's preset">
          Remove {p.phase} preset
        </button>
      </div>
    </Section>
  );
}

function StaggerPanel({ layers }: { layers: Layer[] }) {
  const [p, setP] = useState<StaggerParams>({ order: 'forward', interval: 0.15, seed: 1 });
  const commit = useEditor((s) => s.commit);
  const project = useEditor((s) => s.project);
  // Use z-order (top of the Layers list first) as "forward".
  const ordered = project.scenes.flatMap((s) => [...s.layers].reverse()).filter((l) => layers.some((x) => x.id === l.id));
  return (
    <Section title="Stagger">
      <p className="help">Offsets the start time of each selected layer so they appear one after another.</p>
      <Row label="Order" tip="Forward = top of the layer list first. Random uses the seed, so it's repeatable.">
        <Select
          value={p.order}
          testId="stagger-order"
          options={[
            { value: 'forward', label: 'Forward' },
            { value: 'reverse', label: 'Reverse' },
            { value: 'random', label: 'Random (seeded)' },
          ]}
          onChange={(order) => setP({ ...p, order })}
        />
      </Row>
      <Row label="Interval" tip="Seconds between each layer's start.">
        <NumberField value={p.interval} step={0.05} min={0} onCommit={(interval) => setP({ ...p, interval })} testId="stagger-interval" />
      </Row>
      {p.order === 'random' && (
        <Row label="Seed" tip="Change for a different (but repeatable) random order.">
          <NumberField value={p.seed} step={1} decimals={0} onCommit={(seed) => setP({ ...p, seed: Math.round(seed) })} />
        </Row>
      )}
      <button
        className="primary"
        data-testid="stagger-apply"
        onClick={() => {
          const starts = staggerStarts(ordered, p);
          commit((d) => {
            for (const s of d.scenes) for (const l of s.layers) if (starts.has(l.id)) l.start = starts.get(l.id)!;
          });
        }}
      >
        Apply stagger
      </button>
    </Section>
  );
}
