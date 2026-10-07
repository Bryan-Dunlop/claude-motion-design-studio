import { useState } from 'react';
import { staggerStarts, type StaggerParams } from '../../../shared/presets';
import type { Layer } from '../../../shared/schema';
import { useEditor } from '../../store';
import { NumberField, Row, Section, Select } from '../Fields';

export function StaggerPanel({ layers }: { layers: Layer[] }) {
  const [p, setP] = useState<StaggerParams>({ order: 'forward', interval: 0.15, seed: 1 });
  const commit = useEditor((s) => s.commit);
  const project = useEditor((s) => s.project);
  // Use z-order (top of the Layers list first) as "forward".
  const ordered = project.scenes.flatMap((s) => [...s.layers].reverse()).filter((l) => layers.some((x) => x.id === l.id));
  return (
    <Section title="Stagger">
      <p className="help">Offsets the start time of each selected layer so they appear one after another.</p>
      <Row label="Order" tip="Forward = top of the layer list first. Random uses the seed, so it's repeatable.">
        <Select
          value={p.order}
          testId="stagger-order"
          options={[
            { value: 'forward', label: 'Forward' },
            { value: 'reverse', label: 'Reverse' },
            { value: 'random', label: 'Random (seeded)' },
          ]}
          onChange={(order) => setP({ ...p, order })}
        />
      </Row>
      <Row label="Interval" tip="Seconds between each layer's start.">
        <NumberField value={p.interval} step={0.05} min={0} onCommit={(interval) => setP({ ...p, interval })} testId="stagger-interval" />
      </Row>
      {p.order === 'random' && (
        <Row label="Seed" tip="Change for a different (but repeatable) random order.">
          <NumberField value={p.seed} step={1} decimals={0} onCommit={(seed) => setP({ ...p, seed: Math.round(seed) })} />
        </Row>
      )}
      <button
        className="primary"
        data-testid="stagger-apply"
        onClick={() => {
          const starts = staggerStarts(ordered, p);
          commit((d) => {
            for (const s of d.scenes) for (const l of s.layers) if (starts.has(l.id)) l.start = starts.get(l.id)!;
          });
        }}
      >
        Apply stagger
      </button>
    </Section>
  );
}
