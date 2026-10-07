// Preview audio (Web Audio). The playhead clock stays performance.now()-based (App's usePlayback); this engine follows
// it: usePlayback calls startAudio(t) when playback starts, loops or seeks, and stopAudio() when it stops. What plays
// comes from planAudio — the export's rules — so the preview sounds like the exported file.
// One full-rate AudioBuffer is kept per asset hash, decoded in the background after import/open and released when no
// asset uses it any more. Clips whose file isn't decoded yet are skipped ("preparing audio…") and join in when ready.
import { useEffect } from 'react';
import { create } from 'zustand';
import { audioPlanKey, planAudio, type PlannedClip } from '../../shared/audioPlan';
import { assetUrl } from '../../shared/assetUrl';
import type { Asset, Project } from '../../shared/schema';
import { usePrefs } from '../prefs';
import { useEditor } from '../store';

type Entry =
  | { status: 'loading' }
  | { status: 'ready'; buffer: AudioBuffer }
  /** `asset`/`projectName`: what was tried, so a relink (new asset object) or a save (new folder) retries it. */
  | { status: 'missing'; asset: Asset; projectName: string | null }
  | { status: 'unsupported' };

/** Shown in the playback bar. */
export const useAudioStatus = create<{ preparing: number }>(() => ({ preparing: 0 }));

const DECODE_RATE = 48000;
const entries = new Map<string, Entry>();
const warned = new Set<string>();
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Gain automation as it was issued to an AudioParam: [setValueAtTime | linearRampToValueAtTime, value, time]. */
type Automation = ['set' | 'ramp', number, number][];

interface Scheduled {
  clipId: string;
  hash: string;
  /** AudioContext time the source starts, file offset, seconds played, and the gain right at the start. */
  when: number;
  offset: number;
  duration: number;
  gain: number;
  /** What the fade-in and volume·fade-out GainNodes were really told (for tests: window.__motion.audio()). */
  automation: { in: Automation; out: Automation };
  node: AudioBufferSourceNode;
}

/**
 * Current playback session: project time `from` ↔ AudioContext time `t0`. `idle` = nothing was audible when it
 * started (no AudioContext needed); an edit that adds sound restarts it.
 */
let session: { from: number; t0: number; key: string; scheduled: Scheduled[]; generation: number; idle: boolean } | null = null;
let generation = 0;

function audioCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return ctx;
}

const audioAssets = (p: Project) => p.assets.filter((a) => a.type === 'audio');

/** What is audible + which files back it: when this doesn't change, an edit doesn't restart playback. */
function planKey(p: Project) {
  return audioPlanKey(p) + JSON.stringify(audioAssets(p).map((a) => [a.id, a.hash]));
}

/** Project time the audio is at right now (follows the AudioContext clock). */
function audioNow(): number {
  if (!session || session.idle || !ctx) return useEditor.getState().time;
  return session.from + Math.max(0, ctx.currentTime - session.t0);
}

function stopSources() {
  if (!session) return;
  for (const s of session.scheduled) {
    try {
      s.node.stop();
    } catch {
      /* never started */
    }
    s.node.disconnect();
  }
  session.scheduled = [];
}

/**
 * Gain envelope on two GainNodes (fade in × volume·fade out), like the export's afade filters, from clip time
 * `elapsed`. Returns the automation exactly as issued.
 */
function envelope(gIn: AudioParam, gOut: AudioParam, c: PlannedClip, when: number, volume: number) {
  const log = { in: [] as Automation, out: [] as Automation };
  const set = (p: AudioParam, l: Automation, v: number, t: number) => (p.setValueAtTime(v, t), l.push(['set', v, t]));
  const ramp = (p: AudioParam, l: Automation, v: number, t: number) => (p.linearRampToValueAtTime(v, t), l.push(['ramp', v, t]));
  const u0 = c.elapsed;
  if (c.fadeIn > 0 && u0 < c.fadeIn) {
    set(gIn, log.in, u0 / c.fadeIn, when);
    ramp(gIn, log.in, 1, when + (c.fadeIn - u0));
  } else set(gIn, log.in, 1, when);
  const os = Math.max(0, c.duration - c.fadeOut);
  if (c.fadeOut > 0) {
    if (u0 < os) {
      set(gOut, log.out, volume, when);
      set(gOut, log.out, volume, when + (os - u0));
    } else set(gOut, log.out, (volume * (c.duration - u0)) / c.fadeOut, when);
    ramp(gOut, log.out, 0, when + (c.duration - u0));
  } else set(gOut, log.out, volume, when);
  return log;
}

/** Schedule planned clips; `base` is the AudioContext time of the plan's start time (delay 0). */
function schedule(clips: PlannedClip[], project: Project, base: number) {
  if (!session || !ctx || !master) return;
  for (const c of clips) {
    const asset = project.assets.find((a) => a.id === c.assetId);
    const entry = asset && entries.get(asset.hash);
    if (!asset || !entry) continue;
    if (entry.status === 'unsupported') {
      if (!warned.has(asset.hash)) {
        warned.add(asset.hash);
        useEditor.getState().toast(`${asset.originalName}: can't preview this format in this browser — the export will include it.`);
      }
      continue;
    }
    if (entry.status !== 'ready') continue; // loading → joins when decoded; missing → silent (Relink in Assets)
    const buf = entry.buffer;
    const when = base + c.delay;
    const duration = Math.min(c.remaining, buf.duration - c.offset);
    if (duration <= 0) continue;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    const gIn = ctx.createGain();
    const gOut = ctx.createGain();
    // ffmpeg up-mixes mono to stereo at −3 dB per channel; Web Audio copies it at full level. Match the export.
    const volume = c.volume * (buf.numberOfChannels === 1 ? Math.SQRT1_2 : 1);
    const automation = envelope(gIn.gain, gOut.gain, c, when, volume);
    node.connect(gIn).connect(gOut).connect(master);
    node.start(when, c.offset, duration);
    const gain = automation.in[0][1] * automation.out[0][1];
    session.scheduled.push({ clipId: c.id, hash: asset.hash, when, offset: c.offset, duration, gain, automation, node });
  }
}

/** (Re)start preview audio from project time `from` — playback start, loop wrap, seek, or an audio edit. */
export function startAudio(from: number) {
  stopAudio();
  if (!usePrefs.getState().soundOn) return;
  const project = useEditor.getState().project;
  const plan = planAudio(project, from);
  const key = planKey(project);
  if (plan.length === 0) {
    session = { from, t0: 0, key, scheduled: [], generation: ++generation, idle: true };
    return;
  }
  const c = audioCtx();
  void c.resume().catch(() => undefined);
  session = { from, t0: c.currentTime, key, scheduled: [], generation: ++generation, idle: false };
  schedule(plan, project, session.t0);
}

export function stopAudio() {
  stopSources();
  session = null;
}

/** A file finished decoding while playing: add just its clips, from where the audio is now. */
function joinDecoded(hash: string) {
  if (!session) return;
  if (session.idle) return startAudio(useEditor.getState().time);
  const project = useEditor.getState().project;
  const ids = new Set(project.assets.filter((a) => a.hash === hash).map((a) => a.id));
  const now = audioNow();
  schedule(planAudio(project, now).filter((c) => ids.has(c.assetId)), project, session.t0 + (now - session.from));
}

function publishStatus() {
  const project = useEditor.getState().project;
  const assets = audioAssets(project);
  const preparing = assets.filter((a) => entries.get(a.hash)?.status === 'loading').length;
  if (useAudioStatus.getState().preparing !== preparing) useAudioStatus.setState({ preparing });
  const missing = new Set(assets.filter((a) => entries.get(a.hash)?.status === 'missing').map((a) => a.id));
  const prev = useEditor.getState().missingAudio;
  if (missing.size !== prev.size || [...missing].some((id) => !prev.has(id))) useEditor.getState().setMissingAudio(missing);
}

async function decode(asset: Asset, projectName: string | null) {
  const hash = asset.hash;
  const loading: Entry = { status: 'loading' };
  entries.set(hash, loading);
  publishStatus();
  let next: Entry;
  try {
    const r = await fetch(assetUrl(projectName, asset));
    if (!r.ok) next = { status: 'missing', asset, projectName };
    else {
      const bytes = await r.arrayBuffer();
      try {
        // Decoded on an offline context so no (autoplay-restricted) AudioContext is needed before the first Play.
        next = { status: 'ready', buffer: await new OfflineAudioContext(2, 1, DECODE_RATE).decodeAudioData(bytes) };
      } catch {
        next = { status: 'unsupported' };
      }
    }
  } catch {
    next = { status: 'missing', asset, projectName };
  }
  if (entries.get(hash) !== loading) return; // released (asset removed) or retried meanwhile
  entries.set(hash, next);
  publishStatus();
  if (next.status === 'ready') joinDecoded(hash);
}

/** Keep decoded buffers in step with the project's audio assets (decode new ones, release unused ones). */
function syncAssets(project: Project, projectName: string | null) {
  const assets = audioAssets(project);
  const hashes = new Set(assets.map((a) => a.hash));
  for (const h of [...entries.keys()]) if (!hashes.has(h)) entries.delete(h);
  for (const a of assets) {
    const e = entries.get(a.hash);
    // A missing file may be reachable after a relink (new asset object, maybe the same bytes) or a save.
    if (!e || (e.status === 'missing' && (e.asset !== a || e.projectName !== projectName))) void decode(a, projectName);
  }
  publishStatus();
}

/** Mount once (App): background decoding, missing-file detection, restarts on audio edits and Sound on/off. */
export function useAudioEngine() {
  const assets = useEditor((s) => s.project.assets);
  const projectName = useEditor((s) => s.projectName);
  useEffect(() => syncAssets(useEditor.getState().project, projectName), [assets, projectName]);
  useEffect(() => {
    const unsubEditor = useEditor.subscribe((s, prev) => {
      // Only edits that change what is heard restart the audio (dragging layers during playback doesn't glitch it).
      if (s.project !== prev.project && session && planKey(s.project) !== session.key) startAudio(s.time);
    });
    const unsubPrefs = usePrefs.subscribe((p, prev) => {
      if (p.soundOn === prev.soundOn) return;
      const st = useEditor.getState();
      if (!p.soundOn) stopAudio();
      else if (st.playing) startAudio(st.time);
    });
    return () => {
      unsubEditor();
      unsubPrefs();
      stopAudio();
    };
  }, []);
}

/** For tests (window.__motion.audio): what is scheduled right now. */
export function audioDebug() {
  return {
    contextState: ctx?.state ?? null,
    playing: !!session,
    idle: session?.idle ?? null,
    from: session?.from ?? null,
    generation: session?.generation ?? generation,
    scheduled: (session?.scheduled ?? []).map(({ node: _n, ...s }) => {
      const t0 = session?.t0 ?? 0;
      const rel = (a: Automation) => a.map(([op, v, t]) => [op, v, t - t0]);
      return { ...s, when: s.when - t0, automation: { in: rel(s.automation.in), out: rel(s.automation.out) } };
    }),
    entries: Object.fromEntries([...entries].map(([h, e]) => [h, e.status === 'ready' ? { status: e.status, channels: e.buffer.numberOfChannels, duration: e.buffer.duration } : { status: e.status }])),
  };
}
