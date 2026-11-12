import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale, t, tf } from './index.js';

afterEach(() => {
  setLocale('pt-BR');
});

describe('client locale', () => {
  it('uses Portuguese by default and switches supported shell copy to English', () => {
    expect(getLocale()).toBe('pt-BR');
    expect(t('settings.title')).toBe('Configurações');

    setLocale('en');
    expect(t('settings.title')).toBe('Settings');
    expect(t('settings.language.label')).toBe('Studio language');
  });

  it('preserves placeholders in the selected locale', () => {
    setLocale('en');
    expect(tf('settings.export.filename.hint', { project: 'demo' })).toContain('demo');
  });

  it('falls back to Portuguese while an English product string is not translated yet', () => {
    setLocale('en');
    expect(t('app.agentEdited')).toBe('editado por agente');
  });
});
