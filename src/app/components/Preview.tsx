import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolveLayer } from '../../shared/interpolate';
import {
  activeScenes,
  applyMatrix,
  cursorPosition,
  invertMatrix,
  isLayerActive,
  layerBox,
  layerMatrix,
  renderFrame,
} from '../../shared/renderFrame';
import type { CursorLayer, CursorPoint, Layer, Project, Scene } from '../../shared/schema';
import { startDrag } from '../drag';
import { useResources } from '../resources';
import { currentValue, findLayer, setProp, useEditor } from '../store';
import { importFiles } from '../actions';

const measureCtx = document.createElement('canvas').getContext('2d')!;

interface Placed {
  scene: Scene;
  layer: Layer;
  resolved: Layer;
  local: number;
  corners: [number, number][];
  matrix: ReturnType<typeof layerMatrix>;
  box: { w: number; h: number };
}

function place(scene: Scene, layer: Layer, time: number): Placed {
  const local = time - scene.start - layer.start;
  const resolved = resolveLayer(layer, local);
  if (resolved.type === 'cursor') {
    const p = cursorPosition(resolved, local);
    const s = (resolved.size / 24) * resolved.scale;
    const box = { w: 18 * s, h: 28 * s };
    const matrix: Placed['matrix'] = [1, 0, 0, 1, p.x, p.y];
    return { scene, layer, resolved, local, box, matrix, corners: [[p.x, p.y], [p.x + box.w, p.y], [p.x + box.w, p.y + box.h], [p.x, p.y + box.h]] };
  }
  const box = layerBox(measureCtx, resolved);
  const matrix = layerMatrix(resolved, box);
  const corners = ([[0, 0], [box.w, 0], [box.w, box.h], [0, box.h]] as const).map(([x, y]) => applyMatrix(matrix, x, y));
  return { scene, layer, resolved, local, box, matrix, corners };
}

function visibleLayers(project: Project, time: number): Placed[] {
  const out: Placed[] = [];
  for (const scene of activeScenes(project, time)) {
    for (const layer of scene.layers) {
      if (!layer.visible || !isLayerActive(layer, time - scene.start)) continue;
      out.push(place(scene, layer, time));
    }
  }
  return out;
}

function hitTest(p: Placed, x: number, y: number): boolean {
  const [lx, ly] = applyMatrix(invertMatrix(p.matrix), x, y);
  const pad = 4;
  return lx >= -pad && ly >= -pad && lx <= p.box.w + pad && ly <= p.box.h + pad;
}

export function Preview() {
  const project = useEditor((s) => s.project);
  const time = useEditor((s) => s.time);
  const selection = useEditor((s) => s.selection);
  const resources = useResources((s) => s.resources);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [dragOver, setDragOver] = useState(false);
  const { width: W, height: H } = project.settings;

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = Math.max(0.01, Math.min((size.w - 32) / W, (size.h - 32) / H));
  const cssW = Math.round(W * fit);
  const cssH = Math.round(H * fit);

  // Draw. The preview canvas is sized in device pixels, so renderFrame draws vectors at full sharpness.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d')!;
    renderFrame(project, time, ctx, pw / W, resources);
  }, [project, time, resources, cssW, cssH, W]);

  const placed = visibleLayers(project, time);
  const selected = placed.filter((p) => selection.layerIds.includes(p.layer.id));
  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H] as const;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = toProject(e);
    const hit = [...placed].reverse().find((p) => !p.layer.locked && hitTest(p, x, y));
    const st = useEditor.getState();
    if (!hit) {
      st.select({ layerIds: [] });
      return;
    }
    let ids = st.selection.layerIds;
    const wasSelected = ids.includes(hit.layer.id);
    if (e.shiftKey && !wasSelected) ids = [...ids, hit.layer.id];
    else if (!e.shiftKey && !wasSelected) ids = [hit.layer.id];
    st.select({ sceneId: hit.scene.id, layerIds: ids });
    // Shift-click on a selected layer removes it, but only if it was a click, not a Shift-constrained drag.
    startMove(e, ids, (moved) => {
      if (!moved && e.shiftKey && wasSelected) useEditor.getState().select({ layerIds: ids.filter((i) => i !== hit.layer.id) });
    });
  };

  const startMove = (e: React.PointerEvent, ids: string[], onEnd?: (moved: boolean) => void) => {
    const st = useEditor.getState();
    const t = st.time;
    const origins = ids
      .map((id) => findLayer(st.project, id))
      .filter((h): h is NonNullable<typeof h> => !!h && !h.layer.locked)
      .map(({ scene, layer }) => ({
        id: layer.id,
        x: Number(currentValue(scene, layer, 'x', t)),
        y: Number(currentValue(scene, layer, 'y', t)),
        points: layer.type === 'cursor' ? layer.points.map((p) => ({ ...p })) : null,
      }));
    const k = W / canvasRef.current!.getBoundingClientRect().width;
    startDrag(e, {
      onMove: (dx, dy, ev) => {
        let mx = dx * k;
        let my = dy * k;
        if (ev.shiftKey) {
          if (Math.abs(mx) > Math.abs(my)) my = 0;
          else mx = 0;
        }
        useEditor.getState().updateGesture((d) => {
          for (const o of origins) {
            if (o.points) {
              const hit = findLayer(d, o.id);
              if (hit?.layer.type === 'cursor') hit.layer.points = o.points.map((p) => ({ ...p, x: p.x + mx, y: p.y + my }));
            } else {
              setProp(d, o.id, 'x', round2(o.x + mx), t);
              setProp(d, o.id, 'y', round2(o.y + my), t);
            }
          }
        });
      },
      onEnd,
    });
  };

  const startScale = (e: React.PointerEvent, p: Placed) => {
    e.stopPropagation();
    const [sx, sy] = toProject(e);
    const ax = p.resolved.x;
    const ay = p.resolved.y;
    const d0 = Math.hypot(sx - ax, sy - ay) || 1;
    const s0 = p.resolved.scale;
    const t = useEditor.getState().time;
    startDrag(e, {
      threshold: 0,
      onMove: (_dx, _dy, ev) => {
        const [x, y] = toProject(ev);
        let s = (s0 * Math.hypot(x - ax, y - ay)) / d0;
        if (ev.shiftKey) s = Math.round(s * 10) / 10;
        useEditor.getState().updateGesture((d) => setProp(d, p.layer.id, 'scale', Math.max(0.01, round4(s)), t));
      },
    });
  };

  const startRotate = (e: React.PointerEvent, p: Placed) => {
    e.stopPropagation();
    const [sx, sy] = toProject(e);
    const ax = p.resolved.x;
    const ay = p.resolved.y;
    const a0 = Math.atan2(sy - ay, sx - ax);
    const r0 = p.resolved.rotation;
    const t = useEditor.getState().time;
    startDrag(e, {
      threshold: 0,
      onMove: (_dx, _dy, ev) => {
        const [x, y] = toProject(ev);
        let r = r0 + ((Math.atan2(y - ay, x - ax) - a0) * 180) / Math.PI;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        useEditor.getState().updateGesture((d) => setProp(d, p.layer.id, 'rotation', round2(r), t));
      },
    });
  };

  const startPointDrag = (e: React.PointerEvent, layer: CursorLayer, point: CursorPoint) => {
    e.stopPropagation();
    const k = W / canvasRef.current!.getBoundingClientRect().width;
    startDrag(e, {
      threshold: 0,
      onMove: (dx, dy, ev) => {
        let mx = dx * k;
        let my = dy * k;
        if (ev.shiftKey) {
          if (Math.abs(mx) > Math.abs(my)) my = 0;
          else mx = 0;
        }
        useEditor.getState().updateGesture((d) => {
          const hit = findLayer(d, layer.id);
          if (hit?.layer.type !== 'cursor') return;
          const pt = hit.layer.points.find((q) => q.id === point.id);
          if (pt) {
            pt.x = round2(point.x + mx);
            pt.y = round2(point.y + my);
          }
        });
      },
    });
  };

  const hs = 7 / fit; // handle size in project units
  const single = selected.length === 1 ? selected[0] : null;

  return (
    <div
      className={`preview ${dragOver ? 'drag-over' : ''}`}
      ref={wrapRef}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="stage" style={{ width: cssW, height: cssH }}>
        <canvas ref={canvasRef} data-testid="preview-canvas" style={{ width: cssW, height: cssH }} />
        <svg className="overlay" viewBox={`0 0 ${W} ${H}`} width={cssW} height={cssH} onPointerDown={onPointerDown} data-testid="preview-overlay">
          {selected.map((p) => (
            <polygon key={p.layer.id} points={p.corners.map((c) => c.join(',')).join(' ')} className="sel-outline" vectorEffect="non-scaling-stroke" />
          ))}
          {single && single.layer.type !== 'cursor' && !single.layer.locked && (
            <>
              {single.corners.map(([x, y], i) => (
                <rect
                  key={i}
                  data-testid={`handle-scale-${i}`}
                  x={x - hs}
                  y={y - hs}
                  width={hs * 2}
                  height={hs * 2}
                  className="handle"
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(e) => startScale(e, single)}
                >
                  <title>Drag to scale (Shift: round to 0.1)</title>
                </rect>
              ))}
              {(() => {
                const [tx, ty] = applyMatrix(single.matrix, single.box.w / 2, 0);
                const [ux, uy] = applyMatrix(single.matrix, single.box.w / 2, -1);
                const len = Math.hypot(ux - tx, uy - ty) || 1;
                const off = 36 / fit;
                const rx = tx + ((ux - tx) / len) * off;
                const ry = ty + ((uy - ty) / len) * off;
                return (
                  <>
                    <line x1={tx} y1={ty} x2={rx} y2={ry} className="sel-outline" vectorEffect="non-scaling-stroke" />
                    <circle data-testid="handle-rotate" cx={rx} cy={ry} r={hs} className="handle round" vectorEffect="non-scaling-stroke" onPointerDown={(e) => startRotate(e, single)}>
                      <title>Drag to rotate (Shift: snap to 15°)</title>
                    </circle>
                    <circle cx={single.resolved.x} cy={single.resolved.y} r={hs * 0.6} className="anchor" vectorEffect="non-scaling-stroke" />
                  </>
                );
              })()}
            </>
          )}
          {single && single.layer.type === 'cursor' && <CursorPath layer={single.layer} hs={hs} onPointDown={startPointDrag} />}
        </svg>
        {dragOver && <div className="drop-hint">Drop PNG, JPG, WebP, SVG or font files</div>}
      </div>
      {project.scenes.length === 0 && (
        <div className="empty-hint">
          Empty project. Add a scene, text, shape or cursor from the toolbar, or drop images here.
        </div>
      )}
    </div>
  );
}

function CursorPath({ layer, hs, onPointDown }: { layer: CursorLayer; hs: number; onPointDown: (e: React.PointerEvent, l: CursorLayer, p: CursorPoint) => void }) {
  const pts = [...layer.points].sort((a, b) => a.time - b.time);
  if (pts.length === 0) return null;
  const t0 = pts[0].time;
  const t1 = pts[pts.length - 1].time;
  const samples: string[] = [];
  for (let i = 0; i <= 80; i++) {
    const p = cursorPosition(layer, t0 + ((t1 - t0) * i) / 80);
    samples.push(`${p.x},${p.y}`);
  }
  return (
    <g>
      <polyline points={samples.join(' ')} className="cursor-path" vectorEffect="non-scaling-stroke" />
      {pts.map((p, i) => (
        <g key={p.id}>
          <circle data-testid={`cursor-point-${i}`} cx={p.x} cy={p.y} r={hs * 1.2} className="handle round" vectorEffect="non-scaling-stroke" onPointerDown={(e) => onPointDown(e, layer, p)}>
            <title>{`Point ${i + 1} at ${p.time.toFixed(2)}s — drag to move (Shift: lock axis)`}</title>
          </circle>
          <text x={p.x + hs * 2} y={p.y - hs * 2} className="point-label" fontSize={hs * 2.4}>
            {i + 1}
          </text>
        </g>
      ))}
    </g>
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
