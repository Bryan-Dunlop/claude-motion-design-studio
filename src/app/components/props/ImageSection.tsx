import type { ImageLayer, Scene } from '../../../shared/schema';
import { useEditor } from '../../store';
import { Section } from '../Fields';
import { RelinkButton, type LayerFields } from './common';

export function ImageSection({ layer, fields }: { scene: Scene; layer: ImageLayer; fields: LayerFields }) {
  const assets = useEditor((s) => s.project.assets);
  const missing = useEditor((s) => s.missingAssets);
  const { num, setStatic } = fields;
  const asset = assets.find((a) => a.id === layer.assetId);
  const isMissing = !asset || missing.has(layer.assetId);
  return (
    <Section title="Image">
      <p className="muted">{asset?.originalName ?? 'Unknown asset'}</p>
      {isMissing && asset && <RelinkButton assetId={asset.id} name={asset.originalName} />}
      {num('width', 'Width', { min: 1 })}
      {num('height', 'Height', { min: 1 })}
      {asset?.width && (
        <button title="Reset width/height to the file's natural pixel size" onClick={() => setStatic({ width: asset.width, height: asset.height })}>
          Natural size
        </button>
      )}
    </Section>
  );
}
