const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a value for injection into an HTML template. Quotes are escaped too:
 * a placeholder may sit inside a quoted attribute, not only in element text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]{0,31})\}\}/g;

/**
 * Fills `{{NAME}}` placeholders from `values`. Substitution goes through a
 * replacer callback so a `$&` or `$1` inside a value stays literal, and a
 * placeholder with no value collapses to nothing instead of rendering its own
 * braces on screen. Callers escape the values they pass — see `escapeHtml`.
 */
export function substituteTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? '');
}

/**
 * Every placeholder the template declares, deduplicated. Callers use it to
 * refuse a substitution that would silently blank part of the composition.
 */
export function templatePlaceholders(template: string): readonly string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER), ([, name]) => name ?? ''))];
}

const RAW_TEXT_TAG = /<\/?(script|style)\b[^>]*>/gi;

// From the last `=` before the placeholder, only unquoted value characters may
// follow: catches `={{X}}`, `= {{X}}`, and the prefixed `=box{{X}}`, where a
// value with a space would still inject an attribute.
const UNQUOTED_ATTRIBUTE_TAIL = /=\s*[^\s"'<>]*$/;

/**
 * Placeholders sitting where HTML entity escaping is the wrong escaping:
 * inside a `<script>` or `<style>` element, or right after `=` as an unquoted
 * attribute value. A value substituted there renders its entities literally
 * (`'` shows up as `&#39;`) or truncates the attribute at the first space —
 * and the bake still reports success. Callers refuse these templates.
 */
export function unsafePlaceholders(template: string): readonly string[] {
  const rawSpans: { start: number; end: number }[] = [];
  let open: { tag: string; end: number } | null = null;
  for (const match of template.matchAll(RAW_TEXT_TAG)) {
    const tag = (match[1] ?? '').toLowerCase();
    if (match[0].startsWith('</')) {
      if (open !== null && open.tag === tag) {
        rawSpans.push({ start: open.end, end: match.index });
        open = null;
      }
    } else {
      open ??= { tag, end: match.index + match[0].length };
    }
  }
  if (open !== null) rawSpans.push({ start: open.end, end: template.length });

  const unsafe = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name === undefined) continue;
    const at = match.index;
    const inRawText = rawSpans.some((span) => at >= span.start && at < span.end);
    const before = template.slice(0, at);
    // `=` only means "attribute" inside an open tag — `<p>Total = {{PRICE}}</p>`
    // is element text and safe. Quoted attribute values are blanked before the
    // comparison: a legal `>` inside one (`data-a="a>b"`) must not read as the
    // end of the tag and hide a later unquoted attribute from the guard.
    const beforeBlanked = before.replace(/"[^"]*"|'[^']*'/g, '""');
    const insideTag = beforeBlanked.lastIndexOf('<') > beforeBlanked.lastIndexOf('>');
    const unquotedAttribute = insideTag && UNQUOTED_ATTRIBUTE_TAIL.test(before);
    if (inRawText || unquotedAttribute) unsafe.add(name);
  }
  return [...unsafe];
}
