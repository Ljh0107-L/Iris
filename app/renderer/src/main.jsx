import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles.css';
import './workspace.css';
import { getState, setAppearance } from './store.js';
import { watchSystemAppearance } from './appearance.js';
import { slowLoopingAnimations } from './slow-animations.js';

setAppearance(getState().appearance, { persist: false });
watchSystemAppearance(theme => setAppearance(theme, { persist: false }));
slowLoopingAnimations();
createRoot(document.getElementById('root')).render(<App />);
