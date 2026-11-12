/**
 * Prompts handed to the person's own coding agent (Claude Code etc.).
 *
 * Deliberately NOT in the i18n dictionary: these are machine-facing
 * instructions around an English schema, identical for every locale — a
 * translated copy per language would only drift from the schema over time.
 * Everything a human reads around them (dialog title, description, buttons)
 * stays in i18n.
 */

export interface AgentPromptText {
  readonly intro: string;
  readonly outro: string;
}

/** The standard prompt shape: schema intro, the current JSON, the rules. */
export function agentJsonPrompt(text: AgentPromptText, value: unknown): string {
  return `${text.intro}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n${text.outro}`;
}

export const SUBTITLE_AGENT_PROMPT: AgentPromptText = {
  intro:
    'This is the current `subtitles` block of my edit.json in Leadzy Studio (schema: preset pill|2p-caps|3p-natural; minWordsPerCue/maxWordsPerCue 1–6; fontSize 10–28; marginV 10–240 at PlayResY 288; theme with fontFamily, fontWeight 400–900, fill/highlightFill {kind:"solid",color:"#RRGGBB"} or {kind:"gradient",from,to}, backgroundStyle pill|outline|none, backgroundColor, backgroundOpacity 0–1, outlineColor, outlineWidth 0–8). Create a style variation and give me back the complete block:',
  outro:
    'Rules: colors as #RRGGBB; only the pill preset colors the spoken word via highlightFill; stay within the schema limits; if "locked" is true, change nothing without telling me first.',
};

export const OVERLAY_AGENT_PROMPT: AgentPromptText = {
  intro:
    'This is a block from the elements (overlay) track of my edit.json in Leadzy Studio (fields: file relative to edit/assets/, at and duration in seconds, position top-left|top-right|bottom-left|bottom-right, scale 0–1; title blocks carry title {text, style dark|paper|plain, pos top|center}). Adjust or recreate the element and give me back the complete block:',
  outro:
    'Rules: paths always relative inside edit/; prefer WebM with alpha or PNG; never move or delete original media; apply with `studio edit apply`.',
};

export const EFFECT_AGENT_PROMPT: AgentPromptText = {
  intro:
    'This is a block from the effects track of my edit.json in Leadzy Studio (type zoom|flash|shake; at and duration in seconds; zoom has scale 1.01–2; shake has intensity 1–10). Adjust the effect and give me back the complete block:',
  outro:
    'Rules: effects come in only after the cut is locked; do not stack impacts; stay within the schema limits; apply with `studio edit apply`.',
};

export const LIBRARY_AGENT_PROMPT: AgentPromptText = {
  intro:
    'This is my personal overlay library in Leadzy Studio at `~/.leadzy-studio/library/` — reusable pieces shared across every project. Each item is a folder `<id>/` holding `item.json` (strict manifest: id kebab-case matching the folder, name ≤80 chars, kind lower-third|cta|outro|sticker|title|other, file as a plain filename, optional durationS and tags, createdAt ISO) plus the asset itself: WebM with alpha (VP9) or PNG, with a preview companion `<file>.webp` (animated) or `<file>.png` (frozen frame). A reusable piece SHOULD also be parametric, which adds three optional manifest fields: `description` (one line, ≤200 chars, when to use the piece), `template` (plain filename of the HyperFrames composition that produced the asset, kept in the same folder), and `variables` (1–8 entries `{name, label?, default}`, names UPPER_SNAKE_CASE, referenced in the template as `{{NAME}}` placeholders). These are the items I have today:',
  outro:
    'Create new pieces for my brand (ask for colors, fonts, and handle if you do not know them): size them for a 1080×1920 reel, write each one as a new folder with its strict item.json, and generate the `.png` companion (`ffmpeg -c:v libvpx-vp9 -ss 1.5 -i in.webm -frames:v 1 -update 1 out.png`). Make every piece parametric unless its content is genuinely fixed: keep the composition as `template.html` in the item folder with a TIGHT canvas and a transparent background, expose each editable string as a `{{NAME}}` placeholder with a sensible `default`, and write a one-line `description`. The template must be SELF-CONTAINED — only the template file itself travels into a project, so inline the CSS and JS and embed any image or font as a data URI instead of referencing a sibling file. Put placeholders only in element text or double-quoted attribute values, never inside `<script>`, `<style>`, or an unquoted attribute: the values are HTML-escaped, which is the wrong escaping for those places, and the Studio refuses such a template at import. The template placeholders and the declared `variables` must match exactly — an extra or missing name on either side is also refused at import. Then I can retype the text inside the Studio and it re-bakes the piece from that template, instead of coming back to you to regenerate it. `file` must differ from `template` and must not be named `template.html`. No registration step — the Studio lists the folder on the next refresh. To REMOVE a piece, delete its whole folder `~/.leadzy-studio/library/<id>/` (never individual files inside it, and never another item’s folder); removal is safe for existing projects — importing copies the asset AND the template into the project under `edit/assets/library/`, so imported blocks keep rendering and re-baking; only future imports of that item stop working.',
};

export const LAYER_AGENT_PROMPT: AgentPromptText = {
  intro:
    'This is a layer block of my edit.json in Leadzy Studio (source/in/out and at in seconds; mode fullscreen|split|pip|cell; audio mute|duck|solo; pip uses position, scale, and optional swapped true — the layer fills the frame and the base shrinks into the PiP corner; split uses {ratio 0.2–0.8, arrangement top|bottom|left|right}; cell uses {x,y,w,h} in 0–1). Adjust the layer and give me back the complete block:',
  outro:
    'Rules: the first video track is the baseline and never becomes a layer; stay within the schema limits; apply with `studio edit apply`.',
};
