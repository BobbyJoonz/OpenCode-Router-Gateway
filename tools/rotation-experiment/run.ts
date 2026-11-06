#!/usr/bin/env node
/**
 * Rotation experiment — D1 "killer experiment".
 *
 * Answers one question with statistics: does rotating the egress IP actually
 * reset an IP-based rate limit, and how much better is rotating over *distinct
 * clean* IPs than rotating over public/shared-exit configs?
 *
 *   # deterministic self-test (no provider key needed)
 *   npx tsx tools/rotation-experiment/run.ts --mode mock
 *
 *   # real experiment once you have a provider key and proxy lists
 *   ROTATION_API_KEY=sk-... npx tsx tools/rotation-experiment/run.ts \
 *     --mode real --base-url https://api.openai.com/v1 --model gpt-4o-mini \
 *     --requests 200 --windows 3 \
 *     --arm-a-proxy http://user:pass@vps-1:8080 \
 *     --arm-b-file clean-proxies.txt \
 *     --arm-c-file public-proxies.txt
 *
 * Exit codes: 0 = GO, 1 = NO-GO, 2 = INCONCLUSIVE, 3 = harness error.
 */
import fs from 'fs';
import path from 'path';
import { startMockProvider } from './mock-provider';
import { startFleet } from './local-proxy-fleet';
import { fetchObservedIps, runArm } from './runner';
import { buildReport, renderMarkdown, summarize } from './report';
import { ArmDefinition, ArmSummary, ExperimentConfig } from './types';

interface Args {
  mode: 'mock' | 'real';
  requests: number;
  windows: number;
  model: string;
  baseUrl: string;
  apiKey: string;
  armAProxy: string;
  armBFile: string;
  armCFile: string;
  delayMs: number;
  timeoutMs: number;
  outDir: string;
  windowGapMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback = ''): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };
  return {
    mode: (get('mode', 'mock') as 'mock' | 'real'),
    requests: parseInt(get('requests', '200'), 10),
    windows: parseInt(get('windows', '1'), 10),
    model: get('model', 'mock-model'),
    baseUrl: get('base-url', ''),
    apiKey: get('api-key', process.env.ROTATION_API_KEY || ''),
    armAProxy: get('arm-a-proxy', ''),
    armBFile: get('arm-b-file', ''),
    armCFile: get('arm-c-file', ''),
    delayMs: parseInt(get('delay-ms', '5'), 10),
    timeoutMs: parseInt(get('timeout-ms', '15000'), 10),
    outDir: get('out-dir', path.join(__dirname, 'results')),
    windowGapMs: parseInt(get('window-gap-ms', '0'), 10)
  };
}

function readProxyFile(file: string): string[] {
  if (!file) return [];
  const full = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) {
    throw new Error(`proxy file not found: ${full}`);
  }
  return fs
    .readFileSync(full, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMock(args: Args): Promise<number> {
  const mock = await startMockProvider({ limitPerWindow: 20, windowMs: 60_000, latencyMs: 8 });

  // Disjoint IP ranges per arm so one arm can never poison another's window.
  const fleetA = await startFleet({ count: 1, firstIp: 100 });
  const fleetB = await startFleet({ count: 10, firstIp: 110 });
  const fleetC = await startFleet({ count: 10, sharedExit: true, firstIp: 130 });

  const arms: ArmDefinition[] = [
    { id: 'A', label: 'pinned single exit IP', proxies: fleetA.proxies },
    { id: 'B', label: 'rotating 10 distinct clean exit IPs', proxies: fleetB.proxies },
    { id: 'C', label: 'rotating 10 public/shared-exit nodes (1 real IP)', proxies: fleetC.proxies, sharedExit: true }
  ];

  const config: ExperimentConfig = {
    baseUrl: mock.baseUrl,
    apiKey: 'mock-key',
    model: args.model,
    requestsPerArm: args.requests,
    timeoutMs: args.timeoutMs,
    delayMs: args.delayMs,
    windows: args.windows,
    arms
  };

  const windowSummaries: ArmSummary[][] = [];

  try {
    for (let w = 0; w < args.windows; w++) {
      const summaries: ArmSummary[] = [];
      for (const arm of arms) {
        mock.reset();
        process.stdout.write(`  window ${w + 1}/${args.windows} arm ${arm.id}: `);
        const result = await runArm(arm, config);
        const statsUrl = `http://127.0.0.1:${mock.port}/__stats`;
        const observed = await fetchObservedIps(statsUrl);
        const summary = summarize(result, observed);
        summaries.push(summary);
        console.log(
          `${summary.successes}/${summary.requests} ok, ${summary.rateLimited} x 429, ${observed.length} observed IPs`
        );
      }
      windowSummaries.push(summaries);
      if (args.windowGapMs > 0 && w < args.windows - 1) await sleep(args.windowGapMs);
    }
  } finally {
    await Promise.all([fleetA.close(), fleetB.close(), fleetC.close(), mock.close()]);
  }

  const report = buildReport({
    mode: 'mock',
    config,
    windowSummaries,
    notes: [
      'Mock mode is a deterministic self-test of the harness, not evidence about any real provider.',
      'Arm C models public subscriptions: many nodes, one shared exit IP.',
      'A GO here only proves the instrument works; the real verdict requires --mode real with a provider key.'
    ]
  });

  writeOutputs(report, args.outDir);
  console.log(`\nverdict: ${report.overallVerdict}`);
  return report.overallVerdict === 'GO' ? 0 : report.overallVerdict === 'NO-GO' ? 1 : 2;
}

async function runReal(args: Args): Promise<number> {
  if (!args.baseUrl) throw new Error('--base-url is required in real mode');
  if (!args.apiKey) throw new Error('--api-key (or ROTATION_API_KEY) is required in real mode');

  const clean = readProxyFile(args.armBFile);
  const publicProxies = readProxyFile(args.armCFile);

  const arms: ArmDefinition[] = (
    [
      { id: 'A', label: 'pinned single exit IP', proxies: args.armAProxy ? [args.armAProxy] : [] },
      { id: 'B', label: `rotating ${clean.length} clean exit IPs`, proxies: clean },
      { id: 'C', label: `rotating ${publicProxies.length} public/shared-exit nodes`, proxies: publicProxies, sharedExit: true }
    ] as ArmDefinition[]
  ).filter((arm) => arm.id === 'A' || arm.proxies.length > 0);

  const config: ExperimentConfig = {
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    requestsPerArm: args.requests,
    timeoutMs: args.timeoutMs,
    delayMs: args.delayMs,
    windows: args.windows,
    arms
  };

  const windowSummaries: ArmSummary[][] = [];
  for (let w = 0; w < args.windows; w++) {
    const summaries: ArmSummary[] = [];
    for (const arm of arms) {
      process.stdout.write(`  window ${w + 1}/${args.windows} arm ${arm.id}: `);
      const result = await runArm(arm, config);
      const summary = summarize(result, []);
      summaries.push(summary);
      console.log(`${summary.successes}/${summary.requests} ok, ${summary.rateLimited} x 429`);
    }
    windowSummaries.push(summaries);
    if (args.windowGapMs > 0 && w < args.windows - 1) {
      console.log(`  waiting ${args.windowGapMs} ms before the next window...`);
      await sleep(args.windowGapMs);
    }
  }

  const report = buildReport({
    mode: 'real',
    config,
    windowSummaries,
    notes: [
      'Arm A must use a single, clean, dedicated IP — not a public config.',
      'Arm C should use the public subscription nodes the project normally discovers.',
      'Run at least three windows at different times of day before trusting the verdict.'
    ]
  });

  writeOutputs(report, args.outDir);
  console.log(`\nverdict: ${report.overallVerdict}`);
  return report.overallVerdict === 'GO' ? 0 : report.overallVerdict === 'NO-GO' ? 1 : 2;
}

function writeOutputs(report: ReturnType<typeof buildReport>, outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(outDir, `rotation-${report.mode}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  const markdown = renderMarkdown(report);
  fs.writeFileSync(`${base}.md`, markdown);
  console.log(`\nwrote ${base}.json`);
  console.log(`wrote ${base}.md\n`);
  console.log(markdown);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`rotation experiment — mode=${args.mode}, requests/arm=${args.requests}, windows=${args.windows}`);
  const code = args.mode === 'mock' ? await runMock(args) : await runReal(args);
  process.exit(code);
}

main().catch((err) => {
  console.error('experiment failed:', err?.message || err);
  process.exit(3);
});
