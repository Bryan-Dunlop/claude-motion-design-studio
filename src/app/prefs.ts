// Editor preferences that survive reloads (localStorage) and are not part of the project file.
import { create } from 'zustand';

export interface Prefs {
  /** Play audio clips during preview playback (never affects the export). */
  soundOn: boolean;
  /** The timeline's "Audio (n)" block is collapsed. */
  audioCollapsed: boolean;
}

const KEY = 'motion-studio.prefs';
const DEFAULTS: Prefs = { soundOn: true, audioCollapsed: false };

function load(): Prefs {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    for (const k of Object.keys(DEFAULTS) as (keyof Prefs)[]) if (typeof raw[k] === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = raw[k];
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
