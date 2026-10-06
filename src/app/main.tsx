import '../shared/fonts';
import './styles.css';
import './styles-engine.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { audioDebug } from './audio/engine';
import { useEditor } from './store';

// Handle for automated tests (Playwright) to inspect editor state.
(window as unknown as { __motion: unknown }).__motion = { useEditor, audio: audioDebug };

createRoot(document.getElementById('root')!).render(<App />);
