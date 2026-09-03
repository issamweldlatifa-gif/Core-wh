import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
// WAREHOUSE OS design system: shared tokens + the two shells' themes.
import './styles/os-theme.css';
import './terminal/terminal-shell.css';
import './admin/admin-shell.css';

// Dev/benchmark affordance (runbook §7): loading ANY page with ?ocr=ppocr (or
// ?ocr=tesseract) persists that engine choice for this browser/device, so no JS
// console is needed on a phone. Never changes the product default (tesseract).
try {
  const q = new URLSearchParams(window.location.search).get('ocr');
  if (q === 'ppocr' || q === 'tesseract') {
    localStorage.setItem('ayrovi.ocrEngine', q);
  }
} catch { /* ignore */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
