import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_PATH = '.claude/skills/leadzy-studio/SKILL.md';
const GUIDE_PATH = 'templates/creative-agent-guide.md';

// Read synchronously at collection time: `it.each` builds its table before any
// hook runs, so documents loaded in `beforeAll` would give it nothing to check.
const skill = readFileSync(join(repoRoot, SKILL_PATH), 'utf8');
const guide = readFileSync(join(repoRoot, GUIDE_PATH), 'utf8');
const documents = [
  { path: SKILL_PATH, content: skill },
  { path: GUIDE_PATH, content: guide },
] as const;

interface CliCommand {
  /** Words after `studio`, e.g. `library bake`. */
  readonly path: string;
  /** Long option names, e.g. `--expect-hash`. */
  readonly flags: readonly string[];
}

interface ChainCall {
  readonly method: string;
  readonly args: readonly ts.Expression[];
}

/** Flattens `root.a(...).b(...)` into its root identifier and the calls in source order. */
function fluentChain(expression: ts.Expression): { root: string; calls: ChainCall[] } | null {
  const calls: ChainCall[] = [];
  let node = expression;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    calls.unshift({ method: node.expression.name.text, args: node.arguments });
    node = node.expression.expression;
  }
  return ts.isIdentifier(node) ? { root: node.text, calls } : null;
}

function stringArgument(call: ChainCall): string | null {
  const [first] = call.args;
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : null;
}

/**
 * Every command registered in `main.ts`, read from the Commander definition
 * itself: a statement `<receiver>.command('name')…` hangs `name` under the
 * receiver, which is `program` or a variable holding a command group.
 */
function registeredCommands(source: string): CliCommand[] {
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const receivers = new Map<string, string>([['program', '']]);
  const commands: CliCommand[] = [];
  for (const statement of file.statements) {
    let expression: ts.Expression | undefined;
    let variable: string | undefined;
    if (ts.isExpressionStatement(statement)) {
      expression = statement.expression;
    } else if (ts.isVariableStatement(statement)) {
      const [declared] = statement.declarationList.declarations;
      if (declared !== undefined && ts.isIdentifier(declared.name)) {
        expression = declared.initializer;
        variable = declared.name.text;
      }
    }
    if (expression === undefined) continue;
    const chain = fluentChain(expression);
    if (chain === null) continue;
    const parent = receivers.get(chain.root);
    const commandCall = chain.calls.find((call) => call.method === 'command');
    const signature = commandCall === undefined ? null : stringArgument(commandCall);
    if (parent === undefined || signature === null) continue;
    // Commander accepts `'name <arg>'`; only the first word is the command.
    const [name = signature] = signature.split(' ');
    const path = parent === '' ? name : `${parent} ${name}`;
    if (variable !== undefined) receivers.set(variable, path);
    const flags = chain.calls
      .filter((call) => call.method === 'option' || call.method === 'requiredOption')
      .map((call) => /--[a-z][a-z-]*/.exec(stringArgument(call) ?? '')?.[0])
      .filter((flag): flag is string => flag !== undefined);
    commands.push({ path, flags });
  }
  return commands;
}

const registered = registeredCommands(readFileSync(join(repoRoot, 'src/cli/main.ts'), 'utf8'));
/** Commands an agent actually runs: a group such as `studio library` is only a prefix. */
const runnable = registered.filter(
  (command) => !registered.some((other) => other.path.startsWith(`${command.path} `)),
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The guide lines that name `studio <path>` — whole words, so `studio open` never matches `studio opened`. */
function guideLinesFor(path: string): string[] {
  const mention = new RegExp(`studio ${escapeRegExp(path)}(?![\\w-])`);
  return guide.split('\n').filter((line) => mention.test(line));
}

function headings(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.replace(/^#+ /, '').trim());
}

describe('portable agent contract', () => {
  it.each(documents)(
    '$path uses only the globally available, reproducible workflow',
    ({ content }) => {
      expect(content).not.toContain('pnpm studio');
      expect(content).not.toMatch(/~\/dev\//);
      expect(content).not.toContain('npx --yes');
      expect(content).not.toContain('leadzy-outro-hf');
      expect(content).toContain('studio status');
      expect(content).toContain('studio edit apply');
      expect(content).toContain('studio validate');
      expect(content).toContain('studio audio preview');
    },
  );

  it.each(documents)('$path names only HyperFrames skills that still ship', ({ content }) => {
    // HyperFrames folded these into `/hyperframes`; a fresh install has neither.
    expect(content).not.toContain('motion-graphics');
    expect(content).not.toContain('general-video');
    expect(content).toContain('/hyperframes');
  });

  it('keeps the audio A/B proof files in the guide', () => {
    expect(guide).toContain('edit/audio-preview-before.m4a');
    expect(guide).toContain('edit/audio-preview.m4a');
  });
});

describe('the skill is a router into the project guide', () => {
  it('sends the agent to the managed guide', () => {
    expect(skill).toContain('edit/agent/leadzy-studio.md');
  });

  it('stays short enough to load on every trigger', () => {
    expect(skill.split('\n').length).toBeLessThanOrEqual(120);
  });

  const routes = skill
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map((cells) => cells[2] ?? '')
    .filter((section) => section !== '' && section !== 'Guide section' && !/^-+$/.test(section));

  it('has a routing table to check', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(routes)('routes to an existing guide section: %s', (section) => {
    expect(headings(guide)).toContain(section);
  });
});

describe('the guide documents the CLI as it is', () => {
  it('reads a real command list out of main.ts', () => {
    const paths = runnable.map((command) => command.path);
    expect(paths.length).toBeGreaterThanOrEqual(20);
    expect(paths).toEqual(
      expect.arrayContaining(['open', 'status', 'edit apply', 'audio preview', 'library bake']),
    );
    expect(paths).not.toContain('library');
    expect(runnable.find((command) => command.path === 'edit apply')?.flags).toEqual([
      '--file',
      '--expect-hash',
      '--json',
    ]);
  });

  it('sees the same top-level commands as `studio --help`', async () => {
    const { stdout } = await execa('node', [join(repoRoot, 'bin', 'studio.js'), '--help']);
    const listed = stdout
      .slice(stdout.indexOf('Commands:'))
      .split('\n')
      .map((line) => /^ {2}([a-z][\w-]*)/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined && name !== 'help');
    const parsed = [...new Set(registered.map((command) => command.path.split(' ')[0]))];
    expect(listed.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...parsed].sort());
  }, 30_000);

  it.each(runnable)('documents `studio $path` with every flag', ({ path, flags }) => {
    const lines = guideLinesFor(path);
    expect(lines, `the guide never mentions "studio ${path}"`).not.toHaveLength(0);
    const mentions = lines.join('\n');
    for (const flag of flags) {
      expect(
        new RegExp(`${escapeRegExp(flag)}(?![\\w-])`).test(mentions),
        `"studio ${path}" is documented without ${flag}`,
      ).toBe(true);
    }
  });
});
