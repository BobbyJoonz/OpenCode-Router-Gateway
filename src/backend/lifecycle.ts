import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import { db } from './db/database';

type HookPhase = 'pre' | 'post';
type Hook = { name: string; phase: HookPhase; fn: () => Promise<void> | void };

export interface ShutdownOptions {
  /** How long to wait for in-flight requests before forcing exit. */
  timeoutMs?: number;
  /** Artificial grace period before closing the listener (used by tests). */
  drainDelayMs?: number;
  exitCode?: number;
}

/**
 * Process lifecycle: graceful shutdown with request draining.
 *
 * Order matters:
 *   1. flip to "shutting down" so new work is rejected (503)
 *   2. run `pre` hooks — these release long-lived connections (SSE, timers)
 *   3. stop accepting connections
 *   4. wait for in-flight requests to finish (bounded)
 *   5. run `post` hooks — engine teardown, tracing flush
 *   6. checkpoint SQLite and exit
 */
class Lifecycle {
  private hooks: Hook[] = [];
  private shuttingDown = false;
  private inFlight = 0;
  private drainWaiters: Array<() => void> = [];
  private server: Server | null = null;
  private exitCode = 0;
  private forcedTimer: NodeJS.Timeout | null = null;
  private shuttingDownPromise: Promise<void> | null = null;

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public getInFlight(): number {
    return this.inFlight;
  }

  public onShutdown(name: string, fn: () => Promise<void> | void, phase: HookPhase = 'post'): void {
    this.hooks.push({ name, phase, fn });
  }

  /** Express middleware: counts in-flight work and rejects new work during drain. */
  public trackInFlight = (req: Request, res: Response, next: NextFunction): void => {
    if (this.shuttingDown) {
      res.setHeader('Connection', 'close');
      res.status(503).json({ error: 'Server is shutting down', code: 'shutting_down' });
      return;
    }

    this.inFlight++;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      this.inFlight--;
      if (this.inFlight <= 0) {
        const waiters = this.drainWaiters.splice(0);
        for (const w of waiters) w();
      }
    };

    res.once('finish', done);
    res.once('close', done);
    next();
  };

  /** Attach signal handlers and remember the HTTP server for closing. */
  public install(server: Server, options: ShutdownOptions = {}): void {
    this.server = server;
    this.exitCode = options.exitCode ?? 0;
    const timeoutMs = options.timeoutMs ?? 15000;

    const handler = (signal: string) => {
      void this.shutdown({ reason: signal, timeoutMs });
    };
    process.once('SIGTERM', () => handler('SIGTERM'));
    process.once('SIGINT', () => handler('SIGINT'));

    process.on('uncaughtException', (err) => {
      // eslint-disable-next-line no-console
      console.error('[lifecycle] uncaughtException:', err?.stack || err);
      void this.shutdown({ reason: 'uncaughtException', timeoutMs: 5000, exitCode: 1 });
    });
    process.on('unhandledRejection', (reason: any) => {
      // eslint-disable-next-line no-console
      console.error('[lifecycle] unhandledRejection:', reason?.stack || reason);
      void this.shutdown({ reason: 'unhandledRejection', timeoutMs: 5000, exitCode: 1 });
    });
  }

  public shutdown(opts: ShutdownOptions & { reason?: string } = {}): Promise<void> {
    if (this.shuttingDownPromise) return this.shuttingDownPromise;
    this.shuttingDownPromise = this.runShutdown(opts);
    return this.shuttingDownPromise;
  }

  private async runShutdown(opts: ShutdownOptions & { reason?: string }): Promise<void> {
    this.shuttingDown = true;
    const timeoutMs = opts.timeoutMs ?? 15000;
    const reason = opts.reason || 'manual';
    const exitCode = opts.exitCode ?? this.exitCode;
    const startedAt = Date.now();

    // Hard stop: never hang forever.
    this.forcedTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error(`[lifecycle] shutdown exceeded ${timeoutMs}ms — forcing exit`);
      process.exit(exitCode || 1);
    }, timeoutMs + 2000);
    this.forcedTimer.unref?.();

    // eslint-disable-next-line no-console
    console.log(`[lifecycle] graceful shutdown started (reason=${reason}, in-flight=${this.inFlight})`);

    // 1) release long-lived connections first
    await this.runHooks('pre');

    // 2) stop accepting new connections
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* already closed */
      }
    }

    if (opts.drainDelayMs && opts.drainDelayMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(opts.drainDelayMs!, 10000)));
    }

    // 3) wait for in-flight requests
    await this.drain(timeoutMs);

    // 4) engine + tracing teardown
    await this.runHooks('post');

    // 5) durable state
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort */
    }

    if (this.forcedTimer) clearTimeout(this.forcedTimer);
    // eslint-disable-next-line no-console
    console.log(`[lifecycle] shutdown complete in ${Date.now() - startedAt}ms (in-flight=${this.inFlight})`);
    process.exit(exitCode);
  }

  private async drain(timeoutMs: number): Promise<void> {
    if (this.inFlight <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, timeoutMs - 1000));
      timer.unref?.();
      this.drainWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async runHooks(phase: HookPhase): Promise<void> {
    const hooks = this.hooks.filter((h) => h.phase === phase).reverse();
    for (const hook of hooks) {
      try {
        await hook.fn();
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error(`[lifecycle] hook "${hook.name}" failed:`, err?.message || err);
      }
    }
  }

  /** Test helper: reset state between runs (never used in production). */
  public _resetForTests(): void {
    this.hooks = [];
    this.shuttingDown = false;
    this.inFlight = 0;
    this.drainWaiters = [];
    this.server = null;
    this.shuttingDownPromise = null;
    if (this.forcedTimer) clearTimeout(this.forcedTimer);
  }
}

export const lifecycle = new Lifecycle();
