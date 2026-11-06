/**
 * Optional multi-process launcher.
 *
 * Node is single-threaded; at a few thousand requests/second one core becomes the
 * ceiling. This forks N workers that share the listening socket (Node cluster
 * distributes connections) and gives each worker its own egress-pool port slice.
 *
 *   WEB_CONCURRENCY=4 node dist/backend/cluster.js      # or: npm run start:cluster
 *
 * Important limits (read docs/HA.md before using this):
 *   - SQLite allows one writer at a time. WAL + busy_timeout makes concurrent
 *     writers wait instead of failing, but throughput per write is bounded.
 *   - Per-process state (rate-limit windows, concurrency counters, TPM tracker,
 *     egress sticky map) becomes per-worker. Effective limits are therefore
 *     N x the configured value unless you divide them by the worker count.
 *   - Management endpoints that mutate the engine (workflow start, engine
 *     control) should be called with a single worker in mind.
 */
import cluster from 'cluster';
import os from 'os';

const requested = parseInt(process.env.WEB_CONCURRENCY || '0', 10);
const workers = Math.max(1, Math.min(requested > 0 ? requested : Math.min(4, os.cpus().length || 1), 16));

if (cluster.isPrimary) {
  console.log(`[cluster] primary ${process.pid}: forking ${workers} worker(s)`);

  for (let i = 0; i < workers; i++) {
    cluster.fork({ WORKER_INDEX: String(i) });
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[cluster] worker ${worker.process.pid} exited (code=${code} signal=${signal}); restarting`);
    const index = (worker as any).workerIndex ?? 0;
    cluster.fork({ WORKER_INDEX: String(index) });
  });

  const shutdown = () => {
    console.log('[cluster] shutting down workers');
    for (const worker of Object.values(cluster.workers || {})) {
      try {
        worker?.process.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} else {
  // The worker runs the exact same bootstrap as the single-process server.
  const index = parseInt(process.env.WORKER_INDEX || '0', 10) || 0;
  (cluster.worker as any).workerIndex = index;

  const { bootstrap, startServer } = require('./server');
  bootstrap();
  startServer();
  console.log(`[cluster] worker ${process.pid} (index ${index}) listening`);
}
