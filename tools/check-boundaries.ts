/**
 * Architecture boundary checker.
 *
 * Enforces the three-layer split without a heavy dependency:
 *   engine        (vpn, tester, parser, discovery, db, security, opencode, orchestrator)
 *   gateway       (OpenAI-compatible surface)
 *   observability (logging, metrics, tracing, lifecycle)
 *
 * Rules:
 *   1. No circular imports anywhere under src/backend.
 *   2. The gateway must not depend on the OpenCode CLI layer (opencode/,
 *      orchestrator/) — it has to run on a server without opencode installed.
 *   3. Observability must stay leaf-like: no imports from gateway/ or vpn/.
 *
 * Exit code 1 on any violation, so CI fails.
 */
import fs from 'fs';
import path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '../src/backend');

interface Edge {
  from: string;
  to: string;
  spec: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

function rel(p: string): string {
  return path.relative(BACKEND_ROOT, p).split(path.sep).join('/');
}

const STATIC_IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) specs.add(m[1]);
  }
  return [...specs];
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // package import, ignore
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''));
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const FORBIDDEN: Array<{ from: string; to: string[]; why: string }> = [
  {
    from: 'gateway/',
    to: ['opencode/', 'orchestrator/'],
    why: 'the gateway must run on a server without the OpenCode CLI'
  },
  {
    from: 'observability/',
    to: ['gateway/', 'vpn/', 'tester/', 'orchestrator/'],
    why: 'observability must stay a leaf dependency'
  }
];

function main(): void {
  const files = walk(BACKEND_ROOT);
  const edges: Edge[] = [];
  const fileSet = new Set(files);

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8');
    for (const spec of extractSpecifiers(source)) {
      const target = resolveSpecifier(file, spec);
      if (target && fileSet.has(target)) {
        edges.push({ from: rel(file), to: rel(target), spec });
      }
    }
  }

  const violations: string[] = [];

  for (const edge of edges) {
    for (const rule of FORBIDDEN) {
      if (edge.from.startsWith(rule.from) && rule.to.some((t) => edge.to.startsWith(t))) {
        violations.push(`${edge.from} -> ${edge.to}  (${rule.why})`);
      }
    }
  }

  // Cycle detection (DFS with colouring).
  const graph = new Map<string, string[]>();
  for (const e of edges) {
    if (!graph.has(e.from)) graph.set(e.from, []);
    graph.get(e.from)!.push(e.to);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    colour.set(node, GREY);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      const c = colour.get(next) ?? WHITE;
      if (c === GREY) {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next]);
      } else if (c === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(node, BLACK);
  };

  for (const node of graph.keys()) {
    if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
  }

  console.log(`[boundaries] scanned ${files.length} files, ${edges.length} internal edges`);

  if (cycles.length) {
    console.error(`\n[boundaries] ${cycles.length} circular import(s):`);
    for (const cycle of cycles) console.error('  ' + cycle.join(' -> '));
  }

  if (violations.length) {
    console.error(`\n[boundaries] ${violations.length} forbidden edge(s):`);
    for (const v of violations) console.error('  ' + v);
  }

  if (!cycles.length && !violations.length) {
    console.log('[boundaries] OK — no cycles, no forbidden edges');
    process.exit(0);
  }

  process.exit(1);
}

main();
