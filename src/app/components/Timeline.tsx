import { useEffect, useRef, useState } from 'react';
import { propLabel } from '../../shared/propLabels';
import { ANIMATABLE, type Layer, type Scene } from '../../shared/schema';
import { startDrag } from '../drag';
import { clampTimelineHeight, usePrefs } from '../prefs';
import { resizeScene } from '../sceneTiming';
import { dropKeysUnderMoved, snapToFrame, useEditor } from '../store';
import { timeSnapper, useTimeSnapLine } from '../timelineSnap';
import { AudioRows } from './AudioRows';
import { TransitionStrip } from './TransitionStrip';

const LABEL_W = 170;

interface KeyGroup {
  frame: number;
  /** Layer-local time of the frame. */
  time: number;
  ids: string[];
  props: string[];
}

/** Keyframes of a layer grouped per frame (the diamonds on the layer's own row), with the props that have a key there. */
function keyGroups(layer: Layer, fps: number): KeyGroup[] {
  const groups = new Map<number, KeyGroup>();
  for (const [prop, keys] of Object.entries(layer.keyframes)) {
    for (const k of keys) {
      const f = Math.round(k.time * fps);
      const g = groups.get(f) ?? { frame: f, time: f / fps, ids: [], props: [] };
      g.ids.push(k.id);
      if (!g.props.includes(prop)) g.props.push(prop);
      groups.set(f, g);
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

/** Animated properties in the order the Properties panel lists them. */
function animatedProps(layer: Layer): string[] {
  const order = ANIMATABLE[layer.type];
  const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
  return Object.keys(layer.keyframes)
    .filter((p) => layer.keyframes[p].length > 0)
    .sort((a, b) => rank(a) - rank(b));
}

const labelsOf = (props: string[]) => props.map((p) => propLabel(p).long).join(', ');

export function Timeline() {
  const project = useEditor((s) => s.project);
  const time = useEditor((s) => s.time);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const snapAt = useTimeSnapLine((s) => s.at);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { durationSec, fps } = project.settings;
  const trackW = Math.max(200, durationSec * zoom);
  const scene: Scene | undefined =
    project.scenes.find((s) => s.id === selection.sceneId) ?? project.scenes.find((s) => time >= s.start && time < s.start + s.duration);
  const selectedSet = new Set(selectedKeys);

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

  // Splitter above the timeline: drag to resize it (remembered).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const h0 = rootRef.current!.getBoundingClientRect().height;
    startDrag(e, {
      history: false,
      threshold: 0,
      onMove: (_dx, dy) => usePrefs.getState().setPref({ timelineHeight: clampTimelineHeight(h0 - dy, window.innerHeight) }),
    });
  };

  // Scene block: body moves, edges trim. Its layers move with its start, so they aren't snap targets then. A trim also
  // takes the layers' ends along (resizeScene), always worked out from the scene as it was when the drag started.
  const dragScene = (e: React.PointerEvent, s: Scene, mode: 'move' | 'start' | 'end') => {
    e.stopPropagation();
    st().select({ sceneId: s.id, layerIds: [], audioIds: [] });
    const { start, duration } = s;
    const own = new Set(s.layers.map((l) => l.id));
    const snap = timeSnapper({
      edges: mode === 'move' ? [start, start + duration] : mode === 'start' ? [start] : [start + duration],
      sceneId: s.id,
      exclude: mode === 'end' ? { sceneId: s.id } : { sceneId: s.id, layerBars: own, layerContent: own },
    });
    startDrag(e, {
      onMove: (dx, _dy, ev) => {
        const dt = snap.offset(dx / zoom, ev);
        st().updateGesture((d) => {
          const sc = d.scenes.find((x) => x.id === s.id)!;
          if (mode === 'move') sc.start = Math.max(0, start + dt);
          if (mode === 'end') resizeScene(sc, Math.max(1 / fps, duration + dt), fps, s);
          if (mode === 'start') {
            const ns = Math.min(Math.max(0, start + dt), start + duration - 1 / fps);
            resizeScene(sc, start + duration - ns, fps, s);
            sc.start = ns;
          }
        });
      },
      onEnd: snap.done,
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
    const sc = scene!;
    const moving = sc.layers.filter((x) => ids.includes(x.id) && !x.locked);
    const origin = new Map(moving.map((x) => [x.id, { start: x.start, duration: x.duration }]));
    const abs = (x: Layer) => sc.start + x.start;
    // Keyframes and clicks are layer-relative: they move with a moved bar or a trimmed start.
    const bars = new Set(mode === 'move' ? moving.map((x) => x.id) : [l.id]);
    const snap = timeSnapper({
      edges: mode === 'move' ? moving.flatMap((x) => [abs(x), abs(x) + x.duration]) : mode === 'start' ? [abs(l)] : [abs(l) + l.duration],
      sceneId: sc.id,
      exclude: { layerBars: bars, layerContent: mode === 'end' ? undefined : bars },
    });
    startDrag(e, {
      onMove: (dx, _dy, ev) => {
        const dt = snap.offset(dx / zoom, ev);
        st().updateGesture((d) => {
          const dsc = d.scenes.find((x) => x.id === sc.id)!;
          for (const layer of dsc.layers) {
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
      onEnd: snap.done,
    });
  };

  /** Select only these keys (and their layer). */
  const selectOnly = (l: Layer, ids: string[]) => {
    st().select({ sceneId: scene?.id ?? null, layerIds: [l.id] });
    st().selectKeys(ids);
  };

  /**
   * Press on a diamond: `ids` are its keyframes (every key on that frame for the layer row, one key on a property row).
   * Click selects them (Shift adds; Shift-click on a selected diamond removes it); dragging moves every selected
   * keyframe by the same amount, snapping the pressed one. The playhead follows the pressed diamond.
   */
  const dragKeys = (e: React.PointerEvent, l: Layer, ids: string[], localTime: number) => {
    e.stopPropagation();
    const sc = scene!;
    const before = st().selectedKeys;
    const wasSelected = ids.every((id) => before.includes(id));
    if (e.shiftKey) st().selectKeys([...new Set([...before, ...ids])]);
    else if (!wasSelected) selectOnly(l, ids);
    const playhead = st().time;
    st().setTime(sc.start + l.start + localTime);
    if (l.locked) return;
    const moving = new Set(st().selectedKeys);
    const origin = new Map<string, number>();
    for (const s of st().project.scenes)
      for (const layer of s.layers) {
        if (layer.locked) continue;
        for (const keys of Object.values(layer.keyframes)) for (const k of keys) if (moving.has(k.id)) origin.set(k.id, k.time);
      }
    const snap = timeSnapper({ edges: [sc.start + l.start + localTime], sceneId: sc.id, playhead, anchor: localTime, exclude: { keyIds: new Set(origin.keys()) } });
    startDrag(e, {
      onMove: (dx, _dy, ev) => {
        const dt = snap.offset(dx / zoom, ev);
        st().updateGesture((d) => {
          for (const s of d.scenes)
            for (const layer of s.layers)
              for (const keys of Object.values(layer.keyframes)) {
                let changed = false;
                for (const k of keys) {
                  const o = origin.get(k.id);
                  if (o === undefined) continue;
                  k.time = Math.min(Math.max(0, o + dt), layer.duration);
                  changed = true;
                }
                if (changed) keys.sort((a, b) => a.time - b.time);
              }
        });
        st().setTime(sc.start + l.start + Math.min(Math.max(0, localTime + dt), l.duration));
      },
      // Dropped onto another key of the same property: the moved key replaces it (same undo step as the drag).
      beforeEnd: (moved) => moved && st().updateGesture((d) => dropKeysUnderMoved(d, new Set(origin.keys()))),
      onEnd: (moved) => {
        snap.done();
        if (moved) return;
        // A plain click ends with just this diamond selected; Shift-click on a selected one unselects it.
        if (!e.shiftKey) selectOnly(l, ids);
        else if (wasSelected) st().selectKeys(before.filter((id) => !ids.includes(id)));
      },
    });
  };

  const toggleExpanded = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Ctrl/⌘ + wheel zooms the timeline. A native listener: React's onWheel is passive, so it could not stop the browser
  // from zooming the whole page at the same time.
  useEffect(() => {
    const el = rootRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      st().setZoom(st().zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Ruler ticks: choose a step that leaves >= 60px between labels.
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  const step = steps.find((s) => s * zoom >= 60) ?? 60;
  const ticks: number[] = [];
  for (let t = 0; t <= durationSec + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);

  const layers = scene ? [...scene.layers].reverse() : [];

  return (
    <div className="timeline" ref={rootRef}>
      <div className="tl-splitter" onPointerDown={startResize} title="Drag to make the timeline taller or shorter" data-testid="timeline-splitter" />
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
          <div className="tl-row scenes-row" data-testid="scenes-row">
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
                  <TransitionStrip project={project} scene={s} zoom={zoom} />
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
            const props = animatedProps(l);
            const open = props.length > 0 && expanded.has(l.id);
            return (
              <div className="tl-layer" key={l.id}>
                <div className="tl-row">
                  <div className={`tl-label ${sel ? 'sel' : ''}`} onPointerDown={() => st().select({ sceneId: scene!.id, layerIds: [l.id] })}>
                    {props.length > 0 ? (
                      <button
                        className="tl-expand"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => toggleExpanded(l.id)}
                        title={open ? 'Hide the keyframe rows' : 'Show one row per animated property'}
                        data-testid={`tl-expand-${l.name}`}
                        aria-expanded={open}
                      >
                        {open ? '▾' : '▸'}
                      </button>
                    ) : (
                      <span className="tl-expand-space" />
                    )}
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
                    {l.type === 'cursor' &&
                      l.clicks
                        // Same rule as the click sounds (audioPlan): only clicks inside the layer and its scene happen.
                        .filter((c) => c.time < l.duration && l.start + c.time < scene!.duration)
                        .map((c, i) => (
                          <div
                            key={c.id}
                            className={`click-marker ${l.clickSound ? 'sound' : ''}`}
                            style={{ left: (abs + c.time) * zoom }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              st().select({ sceneId: scene!.id, layerIds: [l.id] });
                              st().setTime(abs + c.time);
                            }}
                            title={`Click at ${(abs + c.time).toFixed(2)}s${l.clickSound ? ' — plays the click sound' : ''}. Edit clicks in the Cursor panel.`}
                            data-testid={`click-marker-${l.name}-${i}`}
                          >
                            ●
                          </div>
                        ))}
                    {keyGroups(l, fps).map((g) => {
                      const n = g.ids.filter((id) => selectedSet.has(id)).length;
                      return (
                        <div
                          key={g.frame}
                          className={`diamond ${n === g.ids.length ? 'sel' : n > 0 ? 'part' : ''}`}
                          style={{ left: (abs + g.time) * zoom }}
                          onPointerDown={(e) => dragKeys(e, l, g.ids, g.time)}
                          title={`Keyframe at ${(abs + g.time).toFixed(2)}s (${labelsOf(g.props)}). Click to select (Shift adds), drag to move in time.`}
                          data-testid={`kf-${l.name}-${g.frame}`}
                          data-selected={n === g.ids.length ? 'yes' : n > 0 ? 'part' : 'no'}
                        />
                      );
                    })}
                  </div>
                </div>
                {open &&
                  props.map((prop) => (
                    <div className="tl-row prop-row" key={prop} data-testid={`kf-row-${l.name}-${prop}`}>
                      <div
                        className={`tl-label prop-label ${sel ? 'sel' : ''}`}
                        onPointerDown={(e) => {
                          const ids = l.keyframes[prop].map((k) => k.id);
                          if (e.shiftKey) st().selectKeys([...new Set([...st().selectedKeys, ...ids])]);
                          else selectOnly(l, ids);
                        }}
                        title={`${propLabel(prop).tip} Click to select all its keyframes (Shift adds).`}
                        data-testid={`kf-row-label-${l.name}-${prop}`}
                      >
                        {propLabel(prop).long}
                      </div>
                      <div className="tl-track" style={{ width: trackW }} onPointerDown={scrub}>
                        {l.keyframes[prop].map((k) => {
                          const on = selectedSet.has(k.id);
                          return (
                            <div
                              key={k.id}
                              className={`diamond small ${on ? 'sel' : ''}`}
                              style={{ left: (abs + k.time) * zoom }}
                              onPointerDown={(e) => dragKeys(e, l, [k.id], k.time)}
                              title={`${propLabel(prop).long} keyframe at ${(abs + k.time).toFixed(2)}s: ${typeof k.value === 'number' ? Math.round(k.value * 100) / 100 : k.value}. Click to select (Shift adds), drag to move just this one.`}
                              data-testid={`kf-${l.name}-${prop}-${Math.round(k.time * fps)}`}
                              data-selected={on ? 'yes' : 'no'}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            );
          })}
          <AudioRows trackW={trackW} onScrub={scrub} />
          <div className="playhead" style={{ left: LABEL_W + time * zoom }} />
          {snapAt !== null && <div className="tl-snap-line" style={{ left: LABEL_W + snapAt * zoom }} data-testid="tl-snap-line" />}
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
