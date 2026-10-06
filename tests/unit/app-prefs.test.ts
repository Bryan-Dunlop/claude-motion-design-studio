// Editor preferences (src/app/prefs.ts): defaults and the timeline splitter's limits.
import { describe, expect, it } from 'vitest';
import { clampTimelineHeight, TIMELINE_DEFAULT, TIMELINE_MIN, usePrefs } from '../../src/app/prefs';

describe('prefs', () => {
  it('Snap is on and Guides off by default; the timeline starts at 240 px', () => {
    const p = usePrefs.getState();
    expect({ snap: p.snap, guides: p.guides, timelineHeight: p.timelineHeight, soundOn: p.soundOn }).toEqual({ snap: true, guides: false, timelineHeight: 240, soundOn: true });
    expect(TIMELINE_DEFAULT).toBe(240);
  });

  it('the timeline is at least 160 px and at most 60% of the window', () => {
    expect(TIMELINE_MIN).toBe(160);
    expect(clampTimelineHeight(100, 950)).toBe(160);
    expect(clampTimelineHeight(340, 950)).toBe(340);
    expect(clampTimelineHeight(900, 950)).toBe(570);
    expect(clampTimelineHeight(300.6, 1200)).toBe(301);
    // A tiny window: the minimum wins over 60%.
    expect(clampTimelineHeight(200, 200)).toBe(160);
  });
});
