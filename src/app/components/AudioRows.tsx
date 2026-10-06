// Timeline "Audio (n)" block: one row per clip with its waveform. Drag a clip to move it, its left edge to trim the
// start (start and "skip into file" move together, the end stays), its right edge to change the length. Each drag is
// one undo step. Clicking a clip selects it (and clears the layer selection).
import { useEffect, useRef } from 'react';
import type { Asset, AudioClip } from '../../shared/schema';
import { moveClip, trimClipLeft, trimClipRight } from '../audio/clips';
import { drawWaveform, ensureWaveform, useWaveforms } from '../audio/waveform';
import { startDrag } from '../drag';
import { usePrefs } from '../prefs';
import { snapToFrame, useEditor } from '../store';

/** Canvas width cap (device px); longer bars stretch the drawing (peaks are 1/100 s anyway). */
const MAX_CANVAS = 8192;

function Waveform({ asset, from, length, widthPx }: { asset: Asset | undefined; from: number; length: number; widthPx: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const projectName = useEditor((s) => s.projectName);
  const info = useWaveforms((s) => (asset ? s.infos[asset.hash] : undefined));
  useEffect(() => {
    if (asset) ensureWaveform(asset, projectName);
  }, [asset, projectName]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !info) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(MAX_CANVAS, Math.round(widthPx * dpr)));
    const h = Math.max(1, Math.round((c.clientHeight || 18) * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    drawWaveform(c, info, from, length, '#a7d8ff');
  }, [info, from, length, widthPx]);
  return <canvas ref={ref} className="waveform" data-testid="waveform" data-ready={info ? 'yes' : 'no'} />;
}

export function AudioRows({ trackW, onScrub }: { trackW: number; onScrub: (e: React.PointerEvent) => void }) {
  const audio = useEditor((s) => s.project.audio);
  const assets = useEditor((s) => s.project.assets);
  const fps = useEditor((s) => s.project.settings.fps);
  const zoom = useEditor((s) => s.zoom);
  const selected = useEditor((s) => s.selection.audioIds);
  const missing = useEditor((s) => s.missingAudio);
  const collapsed = usePrefs((s) => s.audioCollapsed);
  const setPref = usePrefs((s) => s.setPref);
  if (audio.length === 0) return null;
  const st = () => useEditor.getState();
  const assetOf = (c: AudioClip) => assets.find((a) => a.id === c.assetId);

  const pick = (e: React.PointerEvent, clip: AudioClip, mode: 'move' | 'start' | 'end') => {
    const sel = st().selection.audioIds;
    const ids = e.shiftKey ? (sel.includes(clip.id) ? sel : [...sel, clip.id]) : sel.includes(clip.id) && mode === 'move' ? sel : [clip.id];
    st().select({ audioIds: ids });
    return ids;
  };

  const dragClip = (e: React.PointerEvent, clip: AudioClip, mode: 'move' | 'start' | 'end') => {
    e.stopPropagation();
    const ids = pick(e, clip, mode);
    const origin = new Map(st().project.audio.filter((c) => ids.includes(c.id)).map((c) => [c.id, { ...c }]));
    const fileLen = assetOf(clip)?.duration;
    const minLen = 1 / fps;
    startDrag(e, {
      onMove: (dx) => {
        const dt = snapToFrame(dx / zoom, fps);
        st().updateGesture((d) => {
          for (const c of d.audio) {
            const o = origin.get(c.id);
            if (!o) continue;
            if (mode === 'move') Object.assign(c, moveClip(o, dt));
            else if (c.id === clip.id) Object.assign(c, mode === 'start' ? trimClipLeft(o, dt, minLen) : trimClipRight(o, dt, minLen, fileLen));
          }
        });
      },
    });
  };

  return (
    <div className="audio-block" data-testid="audio-block">
      <div className="tl-row audio-head">
        <div
          className="tl-label"
          onPointerDown={() => setPref({ audioCollapsed: !collapsed })}
          title={collapsed ? 'Show the audio clips' : 'Hide the audio clips'}
          data-testid="audio-toggle"
        >
          {collapsed ? '▸' : '▾'} Audio ({audio.length})
        </div>
        <div className="tl-track" style={{ width: trackW }} onPointerDown={onScrub}>
          {collapsed &&
            audio.map((c) => <div key={c.id} className={`clip-summary ${c.muted ? 'muted' : ''}`} style={{ left: c.start * zoom, width: Math.max(2, c.duration * zoom) }} />)}
        </div>
      </div>
      {!collapsed &&
        audio.map((c, i) => {
          const asset = assetOf(c);
          const sel = selected.includes(c.id);
          const lost = !!asset && missing.has(asset.id);
          const widthPx = Math.max(4, c.duration * zoom);
          return (
            <div className="tl-row audio-row" key={c.id} data-testid={`audio-row-${i}`}>
              <div className={`tl-label ${sel ? 'sel' : ''}`} onPointerDown={(e) => pick(e, c, 'move')} title={`${c.name} — click to select`}>
                <span className="clip-icon">♪</span> {c.name}
              </div>
              <div className="tl-track" style={{ width: trackW }} onPointerDown={onScrub}>
                <div
                  className={`clip-bar ${sel ? 'sel' : ''} ${c.muted ? 'muted' : ''} ${lost ? 'missing' : ''}`}
                  style={{ left: c.start * zoom, width: widthPx }}
                  onPointerDown={(e) => dragClip(e, c, 'move')}
                  title={`${c.name}: ${c.start.toFixed(2)}s → ${(c.start + c.duration).toFixed(2)}s${c.muted ? ' (muted)' : ''}${lost ? ' — file missing, relink it in Assets' : ''}. Drag to move, drag the edges to trim.`}
                  data-testid={`audio-clip-${i}`}
                >
                  <Waveform asset={asset} from={c.trimStart} length={c.duration} widthPx={widthPx} />
                  <span className="clip-name">{c.name}</span>
                  <div className="edge left" onPointerDown={(e) => dragClip(e, c, 'start')} title="Drag to trim the start" />
                  <div className="edge right" onPointerDown={(e) => dragClip(e, c, 'end')} title="Drag to change the length" />
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}
