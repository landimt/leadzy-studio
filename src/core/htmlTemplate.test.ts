import { describe, expect, it } from 'vitest';
import { escapeHtml, substituteTemplate, unsafePlaceholders } from './htmlTemplate.js';

describe('escapeHtml', () => {
  it('neutralizes a value that tries to break out of a style block into a script', () => {
    const escaped = escapeHtml('</style><script>alert(1)</script>');
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('</style>');
    expect(escaped).toBe('&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes so a value cannot escape a quoted attribute', () => {
    expect(escapeHtml('" onload="alert(1)')).toBe('&quot; onload=&quot;alert(1)');
    expect(escapeHtml("' onload='x")).toBe('&#39; onload=&#39;x');
  });

  it('escapes ampersands first so an escape sequence is not double-decoded', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });

  it('leaves ordinary ad copy untouched', () => {
    expect(escapeHtml('Compre agora: 50% OFF')).toBe('Compre agora: 50% OFF');
  });
});

describe('substituteTemplate', () => {
  it('fills every occurrence of a placeholder', () => {
    expect(substituteTemplate('<p>{{NAME}}</p><h1>{{NAME}}</h1>', { NAME: 'Leadzy' })).toBe(
      '<p>Leadzy</p><h1>Leadzy</h1>',
    );
  });

  it('collapses a placeholder with no value instead of leaving braces on screen', () => {
    expect(substituteTemplate('<p>{{MISSING}}</p>', { NAME: 'x' })).toBe('<p></p>');
  });

  it('treats a dollar sequence inside a value as literal text', () => {
    // A string replacement would expand `$&` into the matched placeholder.
    expect(substituteTemplate('<p>{{PRICE}}</p>', { PRICE: 'R$& 10' })).toBe('<p>R$& 10</p>');
    expect(substituteTemplate('<p>{{PRICE}}</p>', { PRICE: '$1' })).toBe('<p>$1</p>');
  });

  it('ignores placeholder shapes the manifest cannot declare', () => {
    expect(substituteTemplate('{{lower}} {{With_Case}}', { lower: 'a', With_Case: 'b' })).toBe(
      '{{lower}} {{With_Case}}',
    );
  });

  it('does not substitute a second time into an already-substituted value', () => {
    expect(substituteTemplate('{{A}}', { A: '{{B}}', B: 'boom' })).toBe('{{B}}');
  });
});

describe('unsafePlaceholders', () => {
  it('flags a placeholder inside a script element', () => {
    expect(unsafePlaceholders('<script>const t = "{{NAME}}";</script>')).toEqual(['NAME']);
  });

  it('flags a placeholder inside a style element', () => {
    expect(unsafePlaceholders('<style>.x::after { content: "{{NAME}}"; }</style>')).toEqual([
      'NAME',
    ]);
  });

  it('flags a placeholder in a script that is never closed', () => {
    expect(unsafePlaceholders('<div></div><script>run("{{NAME}}")')).toEqual(['NAME']);
  });

  it('flags an unquoted attribute value, spaces around the equals included', () => {
    expect(unsafePlaceholders('<div data-name={{NAME}}></div>')).toEqual(['NAME']);
    expect(unsafePlaceholders('<div data-name = {{NAME}}></div>')).toEqual(['NAME']);
  });

  it('flags an unquoted attribute value the placeholder only completes', () => {
    expect(unsafePlaceholders('<div class=box{{NAME}}></div>')).toEqual(['NAME']);
  });

  it('accepts an equals sign in element text before a placeholder', () => {
    expect(unsafePlaceholders('<p>Total = {{PRICE}}</p>')).toEqual([]);
    expect(unsafePlaceholders('<p>{{A}}={{B}}</p>')).toEqual([]);
  });

  it('is not fooled by a legal > inside an earlier quoted attribute value', () => {
    expect(unsafePlaceholders('<div data-a="a>b" class={{NAME}}>')).toEqual(['NAME']);
    expect(unsafePlaceholders('<p>"a>b" = {{PRICE}}</p>')).toEqual([]);
  });

  it('accepts placeholders in element text and quoted attributes', () => {
    expect(unsafePlaceholders('<p title="{{HINT}}">{{NAME}}</p><img alt=\'{{ALT}}\' />')).toEqual(
      [],
    );
  });

  it('accepts text placeholders that merely follow a closed script block', () => {
    expect(unsafePlaceholders('<script>init()</script><p>{{NAME}}</p>')).toEqual([]);
  });

  it('does not let a stray closing tag of the other kind end a script block', () => {
    expect(unsafePlaceholders('<script>a</style>{{NAME}}</script>')).toEqual(['NAME']);
  });
});
