import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

// Remove SEO fallback before React mounts so prerendered HTML doesn't flash.
const fallback = document.getElementById('seo-fallback');
if (fallback) fallback.remove();

const root = document.getElementById('root');
if (root === null) throw new Error('Root element missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
