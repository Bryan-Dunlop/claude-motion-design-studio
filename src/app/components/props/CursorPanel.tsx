import { makeId } from '../../../shared/presets';
import { cursorPosition } from '../../../shared/renderFrame';
import type { CursorLayer, Scene } from '../../../shared/schema';
import { AUDIO_EXTS, importClickSound } from '../../actions';
import { findLayer, useEditor } from '../../store';
import { ColorField, NumberField, Row, Section, Select } from '../Fields';

export function CursorPanel({ layer, scene }: { layer: CursorLayer; scene: Scene }) {
  const commit = useEditor((s) => s.commit);
  const time = useEditor((s) => s.time);
  const assets = useEditor((s) => s.project.assets);
  const sounds = assets.filter((a) => a.type === 'audio');
  const local = Math.min(Math.max(0, layer.duration > 0 ? time - scene.start - layer.start : 0), layer.duration);
  const edit = (fn: (l: CursorLayer) => void) =>
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
      <Row label="Click sound" tip="A sound played at every click (one per click; it follows the clicks when you move them). Pick one of the project's sounds, or add a file with Import sound… below.">
        <Select
          value={layer.clickSound?.assetId ?? ''}
          testId="cursor-click-sound"
          tip="Sound played at every click. Import sound… below adds a new one."
          options={[{ value: '', label: sounds.length ? 'None' : 'None (add one below)' }, ...sounds.map((a) => ({ value: a.id, label: a.originalName }))]}
          onChange={(id) => edit((l) => void (l.clickSound = id ? { assetId: id, volume: l.clickSound?.volume ?? 1 } : null))}
        />
      </Row>
      <div className="btn-row left">
        <label
          className="button"
          title="Add a sound file (MP3, WAV, OGG, M4A, AAC or FLAC) and use it as this cursor's click sound. It is not added to the Audio rows, so it only plays at the clicks."
          data-testid="cursor-import-sound"
        >
          Import sound…
          <input
            type="file"
            hidden
            accept={AUDIO_EXTS}
            data-testid="cursor-import-sound-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importClickSound(layer.id, file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {layer.clickSound && (
        <Row label="Volume %" tip="Loudness of the click sound. 100% = as recorded.">
          <NumberField
            value={layer.clickSound.volume}
            displayScale={100}
            decimals={0}
            step={5}
            min={0}
            max={400}
            onCommit={(v) => edit((l) => void (l.clickSound && (l.clickSound.volume = v)))}
            testId="cursor-click-volume"
          />
        </Row>
      )}
    </Section>
  );
}
