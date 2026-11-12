import { isStudioTheme, THEME_STORAGE_KEY } from './theme.js';

try {
  const theme = localStorage.getItem(THEME_STORAGE_KEY);
  if (isStudioTheme(theme)) document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be unavailable in hardened or private browser contexts. The
  // default light theme remains usable without persistence.
  document.documentElement.dataset.theme = 'light';
}
