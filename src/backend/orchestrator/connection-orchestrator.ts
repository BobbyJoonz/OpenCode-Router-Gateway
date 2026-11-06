import { EventEmitter } from 'events';
import { db, getSetting } from '../db/database';
import { ConfigFetcher } from '../discovery/config-fetcher';
import type { ClassificationResult } from '../opencode/error-classifier';
import { OpenCodeService } from '../opencode/opencode-service';
import { CandidateRanker, RankedConfigRow } from '../tester/candidate-ranker';
import { LatencyTester } from '../tester/latency-tester';
import { VpnEngine } from '../vpn/vpn-engine';

export interface WorkflowProgressEvent {
  phase:
    | 'idle'
    | 'discovering'
    | 'testing'
    | 'success'
    | 'rate_limited'
    | 'auth_error'
    | 'failed'
    | 'exhausted'
    | 'stopped';
  message: string;
  candidate?: {
    id: number;
    protocol: string;
    address: string;
    port: number;
    remark: string;
    security: string;
    latencyMs?: number;
    status: 'testing' | 'working' | 'failed' | 'rate_limited';
    error?: string;
  };
  stats: {
    totalConfigs: number;
    testedCount: number;
    failedCount: number;
    workingCount: number;
  };
  activeConnection?: any;
}

export class ConnectionOrchestrator extends EventEmitter {
  private static instance: ConnectionOrchestrator | null = null;
  private isRunning: boolean = false;
  private isCancelled: boolean = false;
  private currentPhase: WorkflowProgressEvent['phase'] = 'idle';
  private lastMessage: string = 'Ready to find working connection.';

  private constructor() {
    super();
  }

  public static getInstance(): ConnectionOrchestrator {
    if (!this.instance) {
      this.instance = new ConnectionOrchestrator();
    }
    return this.instance;
  }

  public getStatus() {
    const vpn = VpnEngine.getInstance();
    // The OpenCode CLI is optional for the gateway path: never let a missing
    // binary break /api/status.
    let opencodeInfo: any = { installed: false, binaryPath: '' };
    try {
      opencodeInfo = OpenCodeService.getInstance().getInfo();
    } catch {
      // CLI not installed / not executable
    }
    const counts = db
      .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN last_status = 'working' THEN 1 ELSE 0 END) as working,
        SUM(CASE WHEN last_status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN last_status = 'untested' THEN 1 ELSE 0 END) as untested
      FROM configs
    `)
      .get() as any;

    return {
      phase: this.currentPhase,
      isRunning: this.isRunning,
      message: this.lastMessage,
      activeConnection: vpn.getActiveConfig(),
      opencode: opencodeInfo,
      stats: {
        totalConfigs: counts?.total || 0,
        workingCount: counts?.working || 0,
        failedCount: counts?.failed || 0,
        untestedCount: counts?.untested || 0
      }
    };
  }

  public stopTesting(): void {
    if (this.isRunning) {
      this.isCancelled = true;
      this.lastMessage = 'Testing stopped by user.';
      this.emitProgress('stopped', this.lastMessage);
    }
  }

  /**
   * Main Core Workflow: Find Working Connection
   */
  public async findWorkingConnection(forceRefreshSources: boolean = false): Promise<boolean> {
    if (this.isRunning) {
      return false;
    }

    this.isRunning = true;
    this.isCancelled = false;
    const vpn = VpnEngine.getInstance();
    const opencode = OpenCodeService.getInstance();

    const socksPort = parseInt(getSetting('socks_port', '10808'), 10);
    const httpPort = parseInt(getSetting('http_port', '10809'), 10);
    const maxAttempts = parseInt(getSetting('max_test_attempts', '25'), 10);
    const opencodeTimeout = parseInt(getSetting('opencode_timeout_seconds', '18'), 10);

    try {
      // Step 1: Ensure we have configurations cached
      const existingCount = (db.prepare('SELECT COUNT(*) as count FROM configs').get() as any)?.count || 0;
      if (existingCount === 0 || forceRefreshSources) {
        this.emitProgress('discovering', 'Discovering and updating VPN configurations from GitHub sources...');
        await ConfigFetcher.fetchAllSources();
      }

      if (this.isCancelled) {
        this.cleanupAndFinish('stopped', 'Workflow cancelled.');
        return false;
      }

      // Step 2 & 5: Retrieve Ranked Candidates
      const candidates = CandidateRanker.getRankedCandidates(maxAttempts);
      if (candidates.length === 0) {
        this.emitProgress('exhausted', 'No candidate configurations available. Please refresh or add sources.');
        this.cleanupAndFinish('exhausted', 'No candidates available.');
        return false;
      }

      let testedInRun = 0;

      for (const candidate of candidates) {
        if (this.isCancelled) {
          await vpn.stop();
          this.cleanupAndFinish('stopped', 'Testing cancelled by user.');
          return false;
        }

        testedInRun++;
        this.emitProgress('testing', `Testing configuration ${testedInRun}/${candidates.length}: ${candidate.remark}`, {
          id: candidate.id,
          protocol: candidate.protocol,
          address: candidate.address,
          port: candidate.port,
          remark: candidate.remark,
          security: candidate.security,
          status: 'testing'
        });

        // Stage 1: Fast TCP pre-flight check
        const tcpResult = await LatencyTester.testRemoteTcp(candidate.address, candidate.port, 1800);
        if (!tcpResult.reachable) {
          this.recordCandidateResult(candidate.id, -1, 0, 0, 'TCP_UNREACHABLE', tcpResult.error);
          this.emitProgress('testing', `Remote host unreachable: ${candidate.address}:${candidate.port}`, {
            id: candidate.id,
            protocol: candidate.protocol,
            address: candidate.address,
            port: candidate.port,
            remark: candidate.remark,
            security: candidate.security,
            status: 'failed',
            error: 'TCP Unreachable'
          });
          continue;
        }

        if (this.isCancelled) break;

        // Stage 2: Start local proxy with candidate
        this.emitProgress('testing', `Starting VPN proxy engine for ${candidate.remark}...`);
        const started = await vpn.start(candidate, socksPort, httpPort);
        if (!started) {
          this.recordCandidateResult(candidate.id, -1, 0, 0, 'ENGINE_START_FAILED', 'Proxy port failed to bind');
          continue;
        }

        if (this.isCancelled) {
          await vpn.stop();
          break;
        }

        // Stage 3: Test Proxy HTTP Latency & Egress IP
        this.emitProgress('testing', `Verifying proxy tunnel connectivity & latency...`);
        const proxyTest = await LatencyTester.testProxyHttp(httpPort, 4000);
        if (!proxyTest.success) {
          await vpn.stop();
          this.recordCandidateResult(candidate.id, -1, 0, 0, 'PROXY_CONNECTIVITY_FAILED', proxyTest.error);
          this.emitProgress('testing', `Proxy tunnel failed verification: ${proxyTest.error}`, {
            id: candidate.id,
            protocol: candidate.protocol,
            address: candidate.address,
            port: candidate.port,
            remark: candidate.remark,
            security: candidate.security,
            latencyMs: -1,
            status: 'failed',
            error: proxyTest.error
          });
          continue;
        }

        if (this.isCancelled) {
          await vpn.stop();
          break;
        }

        // Stage 4: Test OpenCode session itself (The Central Test)
        this.emitProgress('testing', `Executing OpenCode verification session (Latency: ${proxyTest.latencyMs}ms)...`, {
          id: candidate.id,
          protocol: candidate.protocol,
          address: candidate.address,
          port: candidate.port,
          remark: candidate.remark,
          security: candidate.security,
          latencyMs: proxyTest.latencyMs,
          status: 'testing'
        });

        const opencodeResult: ClassificationResult = await opencode.testOpenCodeConnection(
          httpPort,
          socksPort,
          opencodeTimeout
        );

        if (opencodeResult.category === 'SUCCESS') {
          // Success! Keep connection active and finish!
          this.recordCandidateResult(candidate.id, proxyTest.latencyMs, 1, 1, 'SUCCESS', 'OpenCode session confirmed');

          // NOTE: string literals must use single quotes — modern SQLite builds
          // (better-sqlite3 v12+) disable double-quoted string literals, so
          // last_status = "working" is parsed as a column reference and throws.
          db.prepare(
            `UPDATE configs SET is_active = 1, success_count = success_count + 1, last_status = 'working', consecutive_failures = 0 WHERE id = ?`
          ).run(candidate.id);

          const activeInfo = vpn.getActiveConfig();
          if (activeInfo) {
            activeInfo.latency_ms = proxyTest.latencyMs;
            activeInfo.egress_ip = proxyTest.egressIp;
            activeInfo.reason = `Verified working with OpenCode (${proxyTest.latencyMs}ms latency)`;
          }

          this.emitProgress('success', `Found working connection! OpenCode verified through ${candidate.remark}.`, {
            id: candidate.id,
            protocol: candidate.protocol,
            address: candidate.address,
            port: candidate.port,
            remark: candidate.remark,
            security: candidate.security,
            latencyMs: proxyTest.latencyMs,
            status: 'working'
          });

          this.cleanupAndFinish('success', `Working connection activated: ${candidate.remark}`);
          return true;
        } else if (opencodeResult.category === 'RATE_LIMIT') {
          this.recordCandidateResult(candidate.id, proxyTest.latencyMs, 1, 0, 'RATE_LIMIT', opencodeResult.userMessage);

          if (!opencodeResult.isRecoverableBySwitchingVpn) {
            // Account-level rate limit: stop unnecessary rotation
            await vpn.stop();
            this.emitProgress('rate_limited', opencodeResult.userMessage);
            this.cleanupAndFinish('rate_limited', opencodeResult.userMessage);
            return false;
          } else {
            // Free model IP rate limit: rotate to next VPN endpoint
            await vpn.stop();
            this.emitProgress(
              'testing',
              `IP rate limit encountered. Switching to next VPN configuration to obtain fresh IP...`
            );
          }
        } else if (opencodeResult.category === 'AUTH_ERROR') {
          await vpn.stop();
          this.recordCandidateResult(candidate.id, proxyTest.latencyMs, 1, 0, 'AUTH_ERROR', opencodeResult.userMessage);
          this.emitProgress('auth_error', opencodeResult.userMessage);
          this.cleanupAndFinish('auth_error', opencodeResult.userMessage);
          return false;
        } else {
          // Network or other error: rotate
          await vpn.stop();
          this.recordCandidateResult(
            candidate.id,
            proxyTest.latencyMs,
            1,
            0,
            'NETWORK_ERROR',
            opencodeResult.userMessage
          );
          this.emitProgress('testing', `OpenCode network test failed through ${candidate.remark}. Rotating...`, {
            id: candidate.id,
            protocol: candidate.protocol,
            address: candidate.address,
            port: candidate.port,
            remark: candidate.remark,
            security: candidate.security,
            latencyMs: proxyTest.latencyMs,
            status: 'failed',
            error: opencodeResult.userMessage
          });
        }
      }

      // If we exit the loop without success
      await vpn.stop();
      this.emitProgress('exhausted', 'All tested configurations exhausted without a successful OpenCode connection.');
      this.cleanupAndFinish('exhausted', 'Configurations exhausted.');
      return false;
    } catch (err: any) {
      await vpn.stop();
      this.emitProgress('failed', `Unexpected error during testing: ${err.message}`);
      this.cleanupAndFinish('failed', err.message);
      return false;
    }
  }

  private recordCandidateResult(
    configId: number,
    latencyMs: number,
    proxySuccess: number,
    opencodeSuccess: number,
    errorCategory: string,
    errorMessage?: string
  ): void {
    const isWorking = opencodeSuccess === 1;
    const status = isWorking ? 'working' : errorCategory === 'RATE_LIMIT' ? 'rate_limited' : 'failed';

    db.prepare(`
      UPDATE configs SET
        last_tested_at = datetime('now'),
        last_latency_ms = ?,
        last_status = ?,
        consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END
      WHERE id = ?
    `).run(latencyMs > 0 ? latencyMs : null, status, opencodeSuccess, configId);

    db.prepare(`
      INSERT INTO test_history (config_id, latency_ms, proxy_success, opencode_success, error_category, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      configId,
      latencyMs > 0 ? latencyMs : null,
      proxySuccess,
      opencodeSuccess,
      errorCategory,
      errorMessage || null
    );
  }

  private emitProgress(
    phase: WorkflowProgressEvent['phase'],
    message: string,
    candidate?: WorkflowProgressEvent['candidate']
  ): void {
    this.currentPhase = phase;
    this.lastMessage = message;

    const status = this.getStatus();
    const eventData: WorkflowProgressEvent = {
      phase,
      message,
      candidate,
      stats: {
        totalConfigs: status.stats.totalConfigs,
        testedCount: status.stats.failedCount + status.stats.workingCount,
        failedCount: status.stats.failedCount,
        workingCount: status.stats.workingCount
      },
      activeConnection: status.activeConnection
    };

    this.emit('progress', eventData);
  }

  private cleanupAndFinish(phase: WorkflowProgressEvent['phase'], message: string): void {
    this.isRunning = false;
    this.currentPhase = phase;
    this.lastMessage = message;
    this.emitProgress(phase, message);
  }
}
