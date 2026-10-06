// Properties of the selected audio clip(s). Every change is one undo step.
import { videoEnd } from '../../../shared/audioPlan';
import { deleteClips, updateClips } from '../../actions';
import { clockLabel, round6 } from '../../audio/clips';
import { useEditor } from '../../store';
import { NumberField, Row, Section, TextField } from '../Fields';

export function AudioClipProps({ clipIds }: { clipIds: string[] }) {
  const project = useEditor((s) => s.project);
  const missing = useEditor((s) => s.missingAudio);
  const clips = project.audio.filter((c) => clipIds.includes(c.id));
  if (clips.length === 0) return null;
  const minLen = 1 / project.settings.fps;

  if (clips.length > 1) {
    const ids = clips.map((c) => c.id);
    const allMuted = clips.every((c) => c.muted);
    return (
      <div className="props audio-props">
        <h3>{clips.length} audio clips selected</h3>
        <Section title="Audio clips">
          <Row label="Volume %" tip="Loudness of all selected clips. 100% = as recorded.">
            <NumberField value={clips[0].volume} displayScale={100} decimals={0} step={5} min={0} max={400} onCommit={(v) => updateClips(ids, (c) => void (c.volume = v))} testId="clip-volume" />
          </Row>
          <Row label="Mute" tip="Silence the selected clips without deleting them.">
            <input type="checkbox" checked={allMuted} onChange={(e) => updateClips(ids, (c) => void (c.muted = e.target.checked))} data-testid="clip-mute" />
          </Row>
          <div className="btn-row">
            <button className="danger" onClick={() => deleteClips(ids)} title="Delete the selected clips (Delete key)" data-testid="clip-delete">
              Delete clips
            </button>
          </div>
        </Section>
      </div>
    );
  }

  const clip = clips[0];
  const asset = project.assets.find((a) => a.id === clip.assetId);
  const fileLen = asset?.duration;
  const set = (recipe: Parameters<typeof updateClips>[1]) => updateClips([clip.id], recipe);
  return (
    <div className="props audio-props">
      <h3>
        {clip.name} <span className="muted">· audio</span>
      </h3>
      {asset && missing.has(asset.id) && <p className="warn">The file {asset.originalName} is missing — relink it in the Assets list.</p>}
      {clip.start >= videoEnd(project) && <p className="warn">This clip starts after the end of the video, so it won't be heard.</p>}
      <Section title="Audio clip">
        <Row label="Name" tip="Name shown in the timeline's Audio rows.">
          <TextField value={clip.name} onCommit={(v) => set((c) => void (c.name = v.trim() || clip.name))} testId="clip-name" />
        </Row>
        <Row label="Starts at (s)" tip="When the sound starts, in seconds from the start of the video.">
          <NumberField value={clip.start} step={0.1} min={0} onCommit={(v) => set((c) => void (c.start = round6(v)))} testId="clip-start" />
        </Row>
        <Row label="Skip into file (s)" tip="Jump past a silent intro">
          <NumberField
            value={clip.trimStart}
            step={0.1}
            min={0}
            max={fileLen !== undefined ? Math.max(0, fileLen - minLen) : undefined}
            onCommit={(v) =>
              set((c) => {
                c.trimStart = round6(v);
                if (fileLen !== undefined) c.duration = round6(Math.max(minLen, Math.min(c.duration, fileLen - c.trimStart)));
              })
            }
            testId="clip-trim"
          />
        </Row>
        <Row label="Length (s)" tip={`How long the clip plays, in seconds${fileLen !== undefined ? ` (at most ${(fileLen - clip.trimStart).toFixed(2)} s: the rest of the file)` : ''}.`}>
          <NumberField
            value={clip.duration}
            step={0.1}
            min={minLen}
            max={fileLen !== undefined ? Math.max(minLen, fileLen - clip.trimStart) : undefined}
            onCommit={(v) => set((c) => void (c.duration = round6(v)))}
            testId="clip-length"
          />
        </Row>
        <Row label="Volume %" tip="Loudness. 100% = as recorded, 200% = twice as loud.">
          <NumberField value={clip.volume} displayScale={100} decimals={0} step={5} min={0} max={400} onCommit={(v) => set((c) => void (c.volume = v))} testId="clip-volume" />
        </Row>
        <Row label="Fade in (s)" tip="Seconds to fade up from silence at the start of the clip.">
          <NumberField value={clip.fadeIn} step={0.1} min={0} max={clip.duration} onCommit={(v) => set((c) => void (c.fadeIn = round6(v)))} testId="clip-fadein" />
        </Row>
        <Row label="Fade out (s)" tip="Seconds to fade down to silence at the end of the clip.">
          <NumberField value={clip.fadeOut} step={0.1} min={0} max={clip.duration} onCommit={(v) => set((c) => void (c.fadeOut = round6(v)))} testId="clip-fadeout" />
        </Row>
        <Row label="Mute" tip="Silence this clip without deleting it.">
          <input type="checkbox" checked={clip.muted} onChange={(e) => set((c) => void (c.muted = e.target.checked))} data-testid="clip-mute" />
        </Row>
        {asset && (
          <p className="help">
            From {asset.originalName}
            {fileLen !== undefined ? ` (${clockLabel(fileLen)} long)` : ''}.
          </p>
        )}
        <div className="btn-row">
          <button
            onClick={() => useEditor.getState().previewRange(clip.start, clip.start + clip.duration)}
            title="Play just this clip (turn Sound on to hear it)"
            data-testid="clip-preview"
          >
            ▶ Preview
          </button>
          <button className="danger" onClick={() => deleteClips([clip.id])} title="Delete this clip (Delete key). The file stays in Assets." data-testid="clip-delete">
            Delete
          </button>
        </div>
      </Section>
    </div>
  );
}
