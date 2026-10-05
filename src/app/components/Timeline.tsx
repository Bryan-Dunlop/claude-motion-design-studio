import { useRef } from 'react';
import type { Layer, Scene } from '../../shared/schema';
import { startDrag } from '../drag';
import { snapToFrame, useEditor } from '../store';

const LABEL_W = 170;

/** Keyframe times of a layer, grouped per frame, with the props that have a key there. */
function keyGroups(layer: Layer, fps: number) {
  const groups = new Map<number, { time: number; props: string[] }>();
  for (const [prop, keys] of Object.entries(layer.keyframes)) {
    for (const k of keys) {
      const f = Math.round(k.time * fps);
      const g = groups.get(f) ?? { time: f / fps, props: [] };
      g.props.push(prop);
      groups.set(f, g);
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const time = useEditor((s) => s.time);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { durationSec, fps } = project.settings;
  const trackW = Math.max(200, durationSec * zoom);
  const scene: Scene | undefined =
    project.scenes.find((s) => s.id === selection.sceneId) ?? project.scenes.find((s) => time >= s.start && time < s.start + s.duration);

  const st = () => useEditor.getState();
  const xToTime = (clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return (clientX - r.left - LABEL_W + el.scrollLeft) / zoom;
  };

  const scrub = (e: React.PointerEvent) => {
    st().setPlaying(false);
    st().setTime(snapToFrame(xToTime(e.clientX), fps));
    startDrag(e, { history: false, threshold: 0, onMove: (_dx, _dy, ev) => st().setTime(snapToFrame(xToTime(ev.clientX), fps)) });
  };

  // Scene block: body moves, edges trim.
  const dragScene = (e: React.PointerEvent, s: Scene, mode: 'move' | 'start' | 'end') => {
    e.stopPropagation();
    st().select({ sceneId: s.id, layerIds: [] });
    const { start, duration } = s;
    startDrag(e, {
      onMove: (dx) => {
        const dt = snapToFrame(dx / zoom, fps);
        st().updateGesture((d) => {
          const sc = d.scenes.find((x) => x.id === s.id)!;
          if (mode === 'move') sc.start = Math.max(0, start + dt);
          if (mode === 'end') sc.duration = Math.max(1 / fps, duration + dt);
          if (mode === 'start') {
            const ns = Math.min(Math.max(0, start + dt), start + duration - 1 / fps);
            sc.duration = start + duration - ns;
            sc.start = ns;
          }
        });
      },
    });
  };

  const dragLayer = (e: React.PointerEvent, l: Layer, mode: 'move' | 'start' | 'end') => {
    e.stopPropagation();
    const ids = e.shiftKey
      ? selection.layerIds.includes(l.id)
        ? selection.layerIds
        : [...selection.layerIds, l.id]
      : selection.layerIds.includes(l.id) && mode === 'move'
        ? selection.layerIds
        : [l.id];
    st().select({ sceneId: scene?.id ?? null, layerIds: ids });
    if (l.locked) return;
    const origin = new Map(scene!.layers.filter((x) => ids.includes(x.id) && !x.locked).map((x) => [x.id, { start: x.start, duration: x.duration }]));
    startDrag(e, {
      onMove: (dx) => {
        const dt = snapToFrame(dx / zoom, fps);
        st().updateGesture((d) => {
          const sc = d.scenes.find((x) => x.id === scene!.id)!;
          for (const layer of sc.layers) {
            const o = origin.get(layer.id);
            if (!o) continue;
            if (mode === 'move') layer.start = Math.max(0, o.start + dt);
            if (mode === 'end' && layer.id === l.id) layer.duration = Math.max(1 / fps, o.duration + dt);
            if (mode === 'start' && layer.id === l.id) {
              const ns = Math.min(Math.max(0, o.start + dt), o.start + o.duration - 1 / fps);
              layer.duration = o.start + o.duration - ns;
              layer.start = ns;
            }
          }
        });
      },
    });
  };

  const dragKey = (e: React.PointerEvent, l: Layer, g: { time: number; props: string[] }) => {
    e.stopPropagation();
    st().select({ sceneId: scene?.id ?? null, layerIds: [l.id] });
    st().setTime(scene!.start + l.start + g.time);
    if (l.locked) return;
    const eps = 0.5 / fps;
    const moving = new Set(Object.values(l.keyframes).flatMap((keys) => keys.filter((k) => Math.abs(k.time - g.time) < eps).map((k) => k.id)));
    st().selectKeys(e.shiftKey ? [...new Set([...st().selectedKeys, ...moving])] : [...moving]);
    startDrag(e, {
      onMove: (dx) => {
        const nt = Math.min(Math.max(0, snapToFrame(g.time + dx / zoom, fps)), l.duration);
        st().updateGesture((d) => {
          const layer = d.scenes.find((x) => x.id === scene!.id)!.layers.find((x) => x.id === l.id)!;
          for (const keys of Object.values(layer.keyframes)) {
            for (const k of keys) if (moving.has(k.id)) k.time = nt;
            keys.sort((a, b) => a.time - b.time);
          }
        });
        st().setTime(scene!.start + l.start + nt);
      },
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    st().setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  // Ruler ticks: choose a step that leaves >= 60px between labels.
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  const step = steps.find((s) => s * zoom >= 60) ?? 60;
  const ticks: number[] = [];
  for (let t = 0; t <= durationSec + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);

  const layers = scene ? [...scene.layers].reverse() : [];

  return (
    <div className="timeline" onWheel={onWheel}>
      <div className="timeline-scroll" ref={scrollRef}>
        <div className="tl-inner" style={{ width: LABEL_W + trackW + 40 }}>
          <div className="tl-row ruler">
            <div className="tl-label">
              <span className="muted">Time</span>
            </div>
            <div className="tl-track" style={{ width: trackW }} onPointerDown={scrub} data-testid="timeline-ruler" title="Click or drag to move the playhead">
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * zoom }}>
                  <span>{t}s</span>
                </div>
              ))}
            </div>
          </div>
          <div className="tl-row scenes-row">
            <div className="tl-label">Scenes</div>
            <div className="tl-track" style={{ width: trackW }} onPointerDown={scrub}>
              {project.scenes.map((s) => (
                <div
                  key={s.id}
                  className={`scene-block ${s.id === scene?.id ? 'active' : ''}`}
                  style={{ left: s.start * zoom, width: Math.max(4, s.duration * zoom) }}
                  onPointerDown={(e) => dragScene(e, s, 'move')}
                  title={`${s.name}: ${s.start.toFixed(2)}s → ${(s.start + s.duration).toFixed(2)}s. Drag to move, drag edges to change length.`}
                  data-testid={`scene-block-${s.name}`}
                >
                  {s.transition.type !== 'none' && (
                    <div
                      className="transition-strip"
                      style={{ width: Math.min(s.transition.duration, s.duration) * zoom }}
                      title={`Transition in: ${s.transition.type}, ${Math.min(s.transition.duration, s.duration).toFixed(2)}s`}
                      data-testid={`transition-strip-${s.name}`}
                    />
                  )}
                  <div className="edge left" onPointerDown={(e) => dragScene(e, s, 'start')} />
                  <span>{s.name}</span>
                  <div className="edge right" onPointerDown={(e) => dragScene(e, s, 'end')} />
                </div>
              ))}
            </div>
          </div>
          {layers.map((l) => {
            const sel = selection.layerIds.includes(l.id);
            const abs = scene!.start + l.start;
            return (
              <div className="tl-row" key={l.id}>
                <div className={`tl-label ${sel ? 'sel' : ''}`} onPointerDown={() => st().select({ sceneId: scene!.id, layerIds: [l.id] })}>
                  {l.name}
                </div>
                <div className="tl-track" style={{ width: trackW }} onPointerDown={scrub}>
                  <div
                    className={`layer-bar ${sel ? 'sel' : ''} ${l.visible ? '' : 'hidden'} ${l.locked ? 'locked' : ''}`}
                    style={{ left: abs * zoom, width: Math.max(4, l.duration * zoom) }}
                    onPointerDown={(e) => dragLayer(e, l, 'move')}
                    title={`${l.name}: drag to move in time, drag edges to trim`}
                    data-testid={`layer-bar-${l.name}`}
                  >
                    <div className="edge left" onPointerDown={(e) => dragLayer(e, l, 'start')} />
                    <div className="edge right" onPointerDown={(e) => dragLayer(e, l, 'end')} />
                  </div>
                  {keyGroups(l, fps).map((g) => (
                    <div
                      key={g.time}
                      className="diamond"
                      style={{ left: (abs + g.time) * zoom }}
                      onPointerDown={(e) => dragKey(e, l, g)}
                      title={`Keyframe at ${g.time.toFixed(2)}s (${g.props.join(', ')}). Drag to retime.`}
                      data-testid={`kf-${l.name}-${Math.round(g.time * fps)}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="playhead" style={{ left: LABEL_W + time * zoom }} />
        </div>
      </div>
      <div className="tl-footer">
        <label title="Timeline zoom (Ctrl + mouse wheel also works)">
          Zoom
          <input type="range" min={5} max={800} value={zoom} onChange={(e) => st().setZoom(Number(e.target.value))} />
        </label>
        {!scene && project.scenes.length > 0 && <span className="muted">Select a scene to see its layers.</span>}
      </div>
    </div>
  );
}
