import { useState } from 'react';
import { resizeComposition, updateSettings } from '../../actions';
import { useEditor } from '../../store';
import { FormatCopyDialog } from '../Dialogs';
import { ColorField, NumberField, Row, Section, Select } from '../Fields';

export function ProjectSettings() {
  const st = useEditor((s) => s.project.settings);
  const [copying, setCopying] = useState(false);
  return (
    <Section title="Project settings">
      <Row label="Duration" tip="Total length of the video in seconds. Shortening never deletes layers.">
        <NumberField value={st.durationSec} step={1} min={0.1} max={3600} onCommit={(v) => updateSettings({ durationSec: v })} testId="setting-duration" />
      </Row>
      <Row label="Aspect" tip="Frame shape. Keeps the long edge and adjusts the other one. Layers are kept.">
        <Select
          value={st.aspect}
          testId="setting-aspect"
          options={[
            { value: '16:9', label: '16:9 landscape' },
            { value: '9:16', label: '9:16 vertical' },
            { value: '1:1', label: '1:1 square' },
            { value: '4:5', label: '4:5 portrait' },
            { value: 'custom', label: 'Custom' },
          ]}
          onChange={(aspect) => updateSettings({ aspect })}
        />
      </Row>
      <Row label="Width" tip="Output width in pixels (even numbers encode best). Layers are not scaled: they keep their size and position. To scale everything with the frame, use Resolution.">
        <NumberField value={st.width} min={16} max={7680} decimals={0} onCommit={(v) => updateSettings({ width: Math.round(v) })} testId="setting-width" />
      </Row>
      <Row label="Height" tip="Output height in pixels. Layers are not scaled: they keep their size and position. To scale everything with the frame, use Resolution.">
        <NumberField value={st.height} min={16} max={7680} decimals={0} onCommit={(v) => updateSettings({ height: Math.round(v) })} testId="setting-height" />
      </Row>
      <Row
        label="Resolution"
        tip="Frame size presets for the long edge, keeping the shape. Every layer is scaled with the frame, so the picture stays the same. For a smaller video file only, use Export MP4 → Size instead."
      >
        <Select
          value={'' as string}
          testId="setting-resolution"
          options={[
            { value: '', label: 'Preset…' },
            { value: '1280', label: '720p' },
            { value: '1920', label: '1080p' },
            { value: '2560', label: '1440p' },
            { value: '3840', label: '4K' },
          ]}
          onChange={(v) => {
            if (!v) return;
            const long = Number(v);
            const r = st.width / st.height;
            const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
            if (r >= 1) resizeComposition(long, even(long / r));
            else resizeComposition(even(long * r), long);
          }}
        />
      </Row>
      <Row label="FPS" tip="Frames per second of the exported video.">
        <Select
          value={String(st.fps)}
          testId="setting-fps"
          options={['24', '25', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` }))}
          onChange={(v) => updateSettings({ fps: Number(v) })}
        />
      </Row>
      <Row label="Background" tip="Colour behind all layers.">
        <ColorField value={st.background} onLive={(background) => useEditor.getState().commit((d) => void (d.settings.background = background))} />
      </Row>
      <div className="btn-row left">
        <button
          onClick={() => setCopying(true)}
          title="Make a copy of this project in another shape (e.g. 9:16 for Reels). Layers are scaled to fit; this project stays as it is."
          data-testid="format-copy"
        >
          Make a copy in another format…
        </button>
      </div>
      {copying && <FormatCopyDialog onClose={() => setCopying(false)} />}
    </Section>
  );
}
