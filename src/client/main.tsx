import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setLocale, type AppLocale } from './i18n/index.js';
import { applyTheme, readTheme } from './theme/theme.js';
import './index.css';

applyTheme(readTheme());

async function start(): Promise<void> {
  const locale = await fetch('/api/settings')
    .then((response) => response.json() as Promise<{ preferences?: { locale?: AppLocale } }>)
    .then((settings) => settings.preferences?.locale ?? 'pt-BR')
    .catch(() => 'pt-BR' as const);
  setLocale(locale);

  // App modules contain a few menu descriptors resolved at module load. Load
  // them only after the machine locale is known so the first paint is coherent.
  const { App } = await import('./App.js');
  const container = document.getElementById('root');
  if (!container) throw new Error('missing #root element');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
