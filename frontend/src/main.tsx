import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
// WAREHOUSE OS design system: shared tokens + the shells' themes.
import './styles/os-theme.css';
import './styles/global-shell.css';
import './terminal/terminal-shell.css';
import './admin/admin-shell.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
