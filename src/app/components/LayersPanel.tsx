import { useState } from 'react';
import type { Layer } from '../../shared/schema';
import { addScene, deleteLayers, deleteScene, duplicateLayers, duplicateScene, moveLayer, moveScene, renameScene, updateLayers } from '../actions';
import { useEditor } from '../store';
import { RelinkButton } from './Properties';

function InlineName({ value, onRename, testId }: { value: string; onRename: (v: string) => void; testId?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  if (!editing)
    return (
      <span
        className="name"
        data-testid={testId}
        title="Double-click to rename"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setText(value);
          setEditing(true);
        }}
      >
        {value}
      </span>
    );
  return (
    <input
      className="rename"
      autoFocus
      value={text}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (text.trim() && text !== value) onRename(text.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(value);
          setEditing(false);
        }
      }}
    />
  );
}

const ICON: Record<Layer['type'], string> = { text: 'T', image: '▣', shape: '◼', cursor: '➚' };

export function LayersPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const missing = useEditor((s) => s.missingAssets);
  const select = useEditor((s) => s.select);
  const scene = project.scenes.find((s) => s.id === selection.sceneId);

  return (
    <div className="side">
      <div className="panel-head">
        <h3>Scenes</h3>
        <button onClick={addScene} title="Add a new scene after the last one" data-testid="add-scene">
          + Scene
        </button>
      </div>
      <ul className="list">
        {project.scenes.map((s, i) => (
          <li
            key={s.id}
            className={s.id === selection.sceneId ? 'sel' : ''}
            onClick={() => {
              select({ sceneId: s.id, layerIds: [] });
              const t = useEditor.getState().time;
              if (t < s.start || t >= s.start + s.duration) useEditor.getState().setTime(s.start);
            }}
            data-testid={`scene-item-${i}`}
          >
            <InlineName value={s.name} onRename={(v) => renameScene(s.id, v)} />
            <span className="muted small">{s.duration.toFixed(1)}s</span>
            <span className="actions">
              <button title="Move scene up (earlier in the list)" disabled={i === 0} onClick={(e) => (e.stopPropagation(), moveScene(s.id, -1))}>
                ↑
              </button>
              <button title="Move scene down" disabled={i === project.scenes.length - 1} onClick={(e) => (e.stopPropagation(), moveScene(s.id, 1))}>
                ↓
              </button>
              <button title="Duplicate scene (with all its layers)" onClick={(e) => (e.stopPropagation(), duplicateScene(s.id))}>
                ⧉
              </button>
              <button title="Delete scene and its layers" onClick={(e) => (e.stopPropagation(), deleteScene(s.id))}>
                ✕
              </button>
            </span>
          </li>
        ))}
        {project.scenes.length === 0 && <li className="muted empty">No scenes yet.</li>}
      </ul>

      <div className="panel-head">
        <h3>Layers {scene ? <span className="muted small">in {scene.name}</span> : null}</h3>
      </div>
      <ul className="list" data-testid="layers-list">
        {scene &&
          [...scene.layers].reverse().map((l, ri) => {
            const i = scene.layers.length - 1 - ri;
            const sel = selection.layerIds.includes(l.id);
            return (
              <li
                key={l.id}
                className={`${sel ? 'sel' : ''} ${l.visible ? '' : 'dim'}`}
                data-testid={`layer-item-${l.name}`}
                onClick={(e) => {
                  const ids = e.shiftKey || e.ctrlKey || e.metaKey ? (sel ? selection.layerIds.filter((x) => x !== l.id) : [...selection.layerIds, l.id]) : [l.id];
                  select({ sceneId: scene.id, layerIds: ids });
                }}
              >
                <span className="icon">{ICON[l.type]}</span>
                <InlineName value={l.name} onRename={(name) => updateLayers([l.id], (x) => void (x.name = name))} />
                <span className="actions">
                  <button title={l.visible ? 'Hide layer' : 'Show layer'} onClick={(e) => (e.stopPropagation(), updateLayers([l.id], (x) => void (x.visible = !x.visible)))}>
                    {l.visible ? '👁' : '◌'}
                  </button>
                  <button
                    title={l.locked ? 'Unlock layer' : 'Lock layer (prevents moving it in the preview and timeline)'}
                    onClick={(e) => (e.stopPropagation(), updateLayers([l.id], (x) => void (x.locked = !x.locked)))}
                  >
                    {l.locked ? '🔒' : '🔓'}
                  </button>
                  <button title="Bring forward (draw in front)" disabled={i === scene.layers.length - 1} onClick={(e) => (e.stopPropagation(), moveLayer(l.id, 1))}>
                    ↑
                  </button>
                  <button title="Send backward (draw behind)" disabled={i === 0} onClick={(e) => (e.stopPropagation(), moveLayer(l.id, -1))}>
                    ↓
                  </button>
                  <button title="Duplicate layer" onClick={(e) => (e.stopPropagation(), duplicateLayers([l.id]))}>
                    ⧉
                  </button>
                  <button title="Delete layer" onClick={(e) => (e.stopPropagation(), deleteLayers([l.id]))}>
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        {scene && scene.layers.length === 0 && <li className="muted empty">No layers. Use the toolbar to add some.</li>}
        {!scene && <li className="muted empty">Select a scene.</li>}
      </ul>

      {project.assets.length > 0 && (
        <>
          <div className="panel-head">
            <h3>Assets</h3>
          </div>
          <ul className="list assets">
            {project.assets.map((a) => (
              <li key={a.id} title={`${a.relativePath}\nsha256 ${a.hash}`}>
                <span className="icon">{a.type === 'font' ? 'Aa' : '▣'}</span>
                <span className="name">{a.type === 'font' ? `${a.fontFamily} (${a.originalName})` : a.originalName}</span>
                {missing.has(a.id) && <RelinkButton assetId={a.id} name={a.originalName} />}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
