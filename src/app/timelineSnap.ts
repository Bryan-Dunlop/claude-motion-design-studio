// Snapping for timeline drags (scene blocks, layer bars, audio clips, keyframes): what they snap to, and the magenta
// line shown while a drag is snapped. Holding Ctrl/⌘ (or turning Snap off) leaves whole-frame steps only.
import { create } from 'zustand';
import { usePrefs } from './prefs';
import { SNAP_PX, snapAxis, timelineTargets, type TimelineExclude } from './snapping';
import { snapToFrame, useEditor } from './store';

/** Time (s) the current timeline drag is snapped to, or null. */
export const useTimeSnapLine = create<{ at: number | null }>(() => ({ at: null }));

/** The scene whose layers the timeline shows: the selected one, else the one under the playhead. */
export function shownSceneId(): string | null {
  const { project, selection, time } = useEditor.getState();
  const scene = project.scenes.find((s) => s.id === selection.sceneId) ?? project.scenes.find((s) => time >= s.start && time < s.start + s.duration);
  return scene?.id ?? null;
}

export interface TimeSnapper {
  /** Time offset for a raw drag offset (s): onto a target within 8 px, else in whole frames. */
  offset: (raw: number, ev: PointerEvent) => number;
  /** Hide the snap line (call when the drag ends). */
  done: () => void;
}

/**
 * Snapping for one drag. `edges` are the absolute times that may snap (at the start of the drag); `exclude` lists what
 * moves with the drag. `playhead` overrides the current playhead as a target (keyframe drags move the playhead).
 * Unsnapped offsets are rounded so that `anchor + offset` falls on a frame (anchor 0 = whole-frame steps).
 */
export function timeSnapper(opts: { edges: number[]; exclude: TimelineExclude; sceneId?: string | null; playhead?: number | null; anchor?: number }): TimeSnapper {
  const { project, time, zoom } = useEditor.getState();
  const fps = project.settings.fps;
  const anchor = opts.anchor ?? 0;
  const targets = timelineTargets(project, {
    playhead: opts.playhead === undefined ? time : opts.playhead,
    sceneId: opts.sceneId === undefined ? shownSceneId() : opts.sceneId,
    exclude: opts.exclude,
  });
  return {
    offset: (raw, ev) => {
      const on = usePrefs.getState().snap && !ev.ctrlKey && !ev.metaKey;
      const s = on ? snapAxis(opts.edges.map((e) => e + raw), targets, SNAP_PX / zoom) : null;
      const at = s ? s.target : null;
      if (useTimeSnapLine.getState().at !== at) useTimeSnapLine.setState({ at });
      return s ? raw + s.delta : snapToFrame(anchor + raw, fps) - anchor;
    },
    done: () => useTimeSnapLine.setState({ at: null }),
  };
}
