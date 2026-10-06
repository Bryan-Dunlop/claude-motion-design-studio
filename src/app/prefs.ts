// Editor preferences that survive reloads (localStorage) and are not part of the project file.
import { create } from 'zustand';

export interface Prefs {
  /** Play audio clips during preview playback (never affects the export). */
  soundOn: boolean;
  /** The timeline's "Audio (n)" block is collapsed. */
  audioCollapsed: boolean;
  /** Snap moves in the preview and drags in the timeline (hold Ctrl/⌘ to drag freely). */
  snap: boolean;
  /** Show centre lines, thirds and the safe box over the preview (never exported). */
  guides: boolean;
  /** Height of the timeline panel in CSS px (the splitter above it). */
  timelineHeight: number;
}

const KEY = 'motion-studio.prefs';
export const TIMELINE_DEFAULT = 240;
export const TIMELINE_MIN = 160;
const DEFAULTS: Prefs = { soundOn: true, audioCollapsed: false, snap: true, guides: false, timelineHeight: TIMELINE_DEFAULT };

/** The timeline is at least 160 px and at most 60% of the window. */
export function clampTimelineHeight(h: number, windowHeight: number): number {
  return Math.round(Math.max(TIMELINE_MIN, Math.min(h, 0.6 * windowHeight)));
}

function load(): Prefs {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    for (const k of Object.keys(DEFAULTS) as (keyof Prefs)[]) if (typeof raw[k] === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = raw[k];
    if (!Number.isFinite(out.timelineHeight)) out.timelineHeight = TIMELINE_DEFAULT;
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  return out;
}

export const usePrefs = create<Prefs & { setPref: (p: Partial<Prefs>) => void }>((set, get) => ({
  ...load(),
  setPref: (p) => {
    set(p);
    const { setPref: _, ...prefs } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode: keep it for this session only */
    }
  },
}));
