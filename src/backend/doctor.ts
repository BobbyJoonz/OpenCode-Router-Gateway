import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { db, getSetting } from './db/database';
import { egressPool } from './vpn/egress-pool';
import { UpstreamClient } from './gateway/upstream-client';
import { EphemeralTunnelTester } from './tester/ephemeral-tunnel';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** true when a failure makes the gateway unusable */
  fatal: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  at: string;
  checks: DoctorCheck[];
  summary: string;
  counts: {
    configs: number;
    working: number;
    tcpAlive: number;
    keys: number;
    poolReady: number;
    poolSize: number;
  };
}

/**
 * One command that answers "is this deployment actually able to serve?".
 *
 * Every check is read-only. `live: true` additionally makes one real call to the
 * configured upstream through a pool slot — that is the only way to prove the
 * whole chain (xray -> node -> provider) works.
 */
export class Doctor {
  public static async run(opts: { live?: boolean } = {}): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];

    // ---------------------------------------------------------- database
    let counts = { configs: 0, working: 0, tcpAlive: 0, keys: 0, poolReady: 0, poolSize: 0 };
    try {
      const c = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM configs) AS configs,
             (SELECT COUNT(*) FROM configs WHERE last_status = 'working') AS working,
             (SELECT COUNT(*) FROM configs WHERE tcp_alive = 1) AS tcpAlive,
             (SELECT COUNT(*) FROM api_keys WHERE enabled = 1) AS keys`
        )
        .get() as any;
      counts = { ...counts, ...c };
      checks.push({
        name: 'database',
        ok: true,
        fatal: true,
        detail: `${counts.configs} nodes, ${counts.working} working, ${counts.tcpAlive} TCP-alive, ${counts.keys} active key(s)`
      });
    } catch (err: any) {
      checks.push({ name: 'database', ok: false, fatal: true, detail: err?.message || 'database error' });
    }

    // ---------------------------------------------------------- xray binary
    try {
      const bin = EphemeralTunnelTester.resolveBinary();
      let version = 'unknown';
      try {
        version = execSync(`"${bin}" version`, { encoding: 'utf-8', timeout: 5000 }).split('\n')[0].trim();
      } catch {
        /* version is cosmetic */
      }
      const executable = process.platform === 'win32' ? bin.endsWith('.exe') : fs.existsSync(bin);
      checks.push({
        name: 'xray',
        ok: executable,
        fatal: true,
        detail: `${bin} — ${version}`,
        hint: executable ? undefined : 'Set XRAY_BIN or place the binary in ./bin'
      });
    } catch (err: any) {
      checks.push({
        name: 'xray',
        ok: false,
        fatal: true,
        detail: err?.message || 'xray not found',
        hint: 'Run deploy/install.sh or start.ps1 to download Xray'
      });
    }

    // ---------------------------------------------------------- node inventory
    checks.push({
      name: 'nodes',
      ok: counts.configs > 0,
      fatal: true,
      detail:
        counts.configs === 0
          ? 'No configurations imported'
          : `${counts.configs} configs (${counts.working} verified, ${counts.tcpAlive} TCP-alive)`,
      hint: counts.configs === 0 ? 'POST /api/sources/refresh-all then POST /api/configs/prescreen' : undefined
    });

    // ---------------------------------------------------------- pool capacity
    const pool = egressPool.status();
    counts.poolReady = pool.ready;
    counts.poolSize = pool.size;
    checks.push({
      name: 'egress_pool',
      ok: pool.ready > 0,
      fatal: true,
      detail: pool.capacityNote,
      hint:
        pool.ready > 0
          ? undefined
          : 'POST /api/egress/ensure — if it still fails, import a subscription or run a pre-screen'
    });
    if (pool.stuck.length > 0) {
      checks.push({
        name: 'egress_pool_integrity',
        ok: false,
        fatal: false,
        detail: pool.stuck.join('; ')
      });
    }

    // ---------------------------------------------------------- upstream config
    const upstream = UpstreamClient.resolveConfig();
    checks.push({
      name: 'upstream_config',
      ok: upstream.baseUrl.length > 0,
      fatal: true,
      detail: upstream.baseUrl
        ? `${upstream.baseUrl}${upstream.apiKey ? ' (key present)' : ' (NO KEY — set GATEWAY_UPSTREAM_API_KEY)'}`
        : 'GATEWAY_UPSTREAM_BASE_URL is empty',
      hint: upstream.baseUrl ? undefined : 'Set GATEWAY_UPSTREAM_BASE_URL in .env and restart'
    });

    // ---------------------------------------------------------- live probe
    if (opts.live) {
      if (pool.ready === 0) {
        checks.push({ name: 'upstream_live', ok: false, fatal: true, detail: 'Skipped: no ready egress slot' });
      } else {
        const slot = await egressPool.acquire(null);
        if (!slot) {
          checks.push({ name: 'upstream_live', ok: false, fatal: true, detail: 'Could not acquire a slot' });
        } else {
          egressPool.track(slot);
          const t0 = Date.now();
          try {
            const forwarded = await UpstreamClient.forward({
              method: 'GET',
              path: '/models',
              httpProxyPort: slot.httpPort,
              timeoutMs: 20000
            });
            try {
              await UpstreamClient.readAll(forwarded.body);
            } catch {
              /* ignore */
            }
            forwarded.cleanup();
            const ms = Date.now() - t0;
            checks.push({
              name: 'upstream_live',
              ok: forwarded.statusCode >= 200 && forwarded.statusCode < 300,
              fatal: true,
              detail: `HTTP ${forwarded.statusCode} via slot ${slot.index} in ${ms}ms`
            });
          } catch (err: any) {
            checks.push({
              name: 'upstream_live',
              ok: false,
              fatal: true,
              detail: `live call failed: ${err?.message || err}`,
              hint: 'Check the provider key, the model name and the node'
            });
          } finally {
            egressPool.release(slot);
          }
        }
      }
    }

    const fatalFailures = checks.filter((c) => !c.ok && c.fatal);
    const ok = fatalFailures.length === 0;

    return {
      ok,
      at: new Date().toISOString(),
      checks,
      counts,
      summary: ok
        ? opts.live
          ? 'READY — all checks passed, including a live upstream call'
          : 'READY — all local checks passed (run with live=true for a real upstream call)'
        : `NOT READY — ${fatalFailures.map((c) => c.name).join(', ')}`
    };
  }

  /** Resolve the gateway's public base URL for copy-paste snippets. */
  public static publicBaseUrl(): string {
    const port = process.env.PORT || getSetting('port', '3000');
    return process.env.GATEWAY_PUBLIC_URL || `http://127.0.0.1:${port}/v1`;
  }
}
