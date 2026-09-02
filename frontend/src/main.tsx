import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/tokens.css';   // Enterprise Design System — single source of truth
import './styles/index.css';
// WAREHOUSE OS design system: shared tokens + the two shells' themes.
import './styles/os-theme.css';
import './terminal/terminal-shell.css';
import './admin/admin-shell.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
