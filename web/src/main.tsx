import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initToken } from './api.ts';
import './index.css';
import { applyStoredTheme } from './theme.tsx';

window.addEventListener('error', (event) => console.error(event.error ?? event.message));
initToken();
applyStoredTheme();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
