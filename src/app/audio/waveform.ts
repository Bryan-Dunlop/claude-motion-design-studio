// Length + waveform peaks of audio assets, cached per content hash. Uses a cheap 8 kHz decode
// (OfflineAudioContext(1, 1, 8000): a 5-min MP3 takes ~0.8 s / 19 MB instead of 1.5 s / 115 MB at full rate). Formats the
// browser can't decode (AAC in Chromium builds without proprietary codecs) are decoded by the server's ffmpeg instead.
import { create } from 'zustand';
import { assetUrl } from '../../shared/assetUrl';
import type { Asset } from '../../shared/schema';

export interface AudioInfo {
  /** Seconds. */
  duration: number;
  /** Max |sample| (0..1) per 1/peaksPerSecond seconds, all channels. */
  peaks: Float32Array;
  peaksPerSecond: number;
}

const PEAKS_PER_SECOND = 100;

/** Peaks per asset hash, for components (re-render when one arrives). */
export const useWaveforms = create<{ infos: Record<string, AudioInfo> }>(() => ({ infos: {} }));

const loading = new Map<string, Promise<AudioInfo | null>>();
/** hash → project the load failed for (a later save or relink can make the file reachable again). */
const failedFor = new Map<string, string | null>();

function peaksOf(channels: Float32Array[], rate: number): Float32Array {
  const per = rate / PEAKS_PER_SECOND;
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(Math.ceil(length / per));
  for (const ch of channels) {
    for (let b = 0; b < out.length; b++) {
      const end = Math.min(length, Math.round((b + 1) * per));
      let m = out[b];
      for (let i = Math.round(b * per); i < end; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > m) m = v;
      }
      out[b] = m;
    }
  }
  return out;
}

/** Decode at 8 kHz and reduce to peaks. Throws when the browser can't decode the format. */
export async function decodeLowRate(bytes: ArrayBuffer): Promise<AudioInfo> {
  const buf = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes);
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  return { duration: buf.duration, peaks: peaksOf(channels, buf.sampleRate), peaksPerSecond: PEAKS_PER_SECOND };
}

/** Ask the server to decode the file with ffmpeg (same query as /api/asset). */
async function serverInfo(projectName: string | null, asset: Pick<Asset, 'relativePath' | 'hash'>): Promise<AudioInfo | null> {
  const r = await fetch(assetUrl(projectName, asset).replace('/api/asset?', '/api/audio-info?'));
  if (!r.ok) return null;
  const j = (await r.json()) as { duration: number; peaks: number[]; peaksPerSecond: number };
  return { duration: j.duration, peaks: Float32Array.from(j.peaks), peaksPerSecond: j.peaksPerSecond };
}

/**
 * Length + peaks of an audio file: from `bytes` (just imported) or fetched from the server. Browser decode first,
 * ffmpeg on the server as the fallback. Results are cached by hash; null when neither can read it.
 */
export function loadAudioInfo(asset: Pick<Asset, 'relativePath' | 'hash'>, projectName: string | null, bytes?: ArrayBuffer): Promise<AudioInfo | null> {
  const known = useWaveforms.getState().infos[asset.hash];
  if (known) return Promise.resolve(known);
  const inFlight = loading.get(asset.hash);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      let data = bytes;
      if (!data) {
        const r = await fetch(assetUrl(projectName, asset));
        if (!r.ok) return null;
        data = await r.arrayBuffer();
      }
      return await decodeLowRate(data);
    } catch {
      try {
        return await serverInfo(projectName, asset);
      } catch {
        return null;
      }
    }
  })().then((info) => {
    loading.delete(asset.hash);
    if (info) {
      failedFor.delete(asset.hash);
      useWaveforms.setState((s) => ({ infos: { ...s.infos, [asset.hash]: info } }));
    } else failedFor.set(asset.hash, projectName);
    return info;
  });
  loading.set(asset.hash, p);
  return p;
}

/** Start loading peaks for the timeline unless they are loaded, loading, or already failed for this project. */
export function ensureWaveform(asset: Pick<Asset, 'relativePath' | 'hash'>, projectName: string | null) {
  if (useWaveforms.getState().infos[asset.hash] || loading.has(asset.hash)) return;
  if (failedFor.has(asset.hash) && failedFor.get(asset.hash) === projectName) return;
  void loadAudioInfo(asset, projectName);
}

/**
 * Draw the peaks of [from, from + length) seconds of the file, stretched over the whole canvas, mirrored around the
 * middle. The canvas is sized in device pixels by the caller.
 */
export function drawWaveform(canvas: HTMLCanvasElement, info: AudioInfo, from: number, length: number, color: string) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (length <= 0 || w === 0) return;
  ctx.fillStyle = color;
  const mid = h / 2;
  const pps = info.peaksPerSecond;
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor((from + (x / w) * length) * pps);
    const b1 = Math.max(b0 + 1, Math.floor((from + ((x + 1) / w) * length) * pps));
    let m = 0;
    for (let b = b0; b < b1 && b < info.peaks.length; b++) if (info.peaks[b] > m) m = info.peaks[b];
    const half = Math.max(0.5, m * (mid - 1));
    ctx.fillRect(x, mid - half, 1, half * 2);
  }
}
