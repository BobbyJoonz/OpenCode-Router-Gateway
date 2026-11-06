import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';

interface PoolSlot {
  index: number;
  state: string;
  socksPort: number;
  httpPort: number;
  pid: number | null;
  node: { id: number; address: string; port: number; remark: string } | null;
  inFlight: number;
  totalRequests: number;
  uptimeMs: number | null;
  lastError: string | null;
}

interface PoolEvent {
  at: string;
  slot: number;
  type: string;
  message: string;
}

interface PoolStatus {
  size: number;
  ready: number;
  slots: PoolSlot[];
  metrics: {
    rotations: number;
    failovers: number;
    drainTimeouts: number;
    starts: number;
    startFailures: number;
    churnPerHour: number;
    avgStartMs: number;
  };
  events: PoolEvent[];
  stuck: string[];
}

function formatUptime(ms: number | null): string {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const stateStyles: Record<string, string> = {
  ready: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  starting: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  draining: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  stopped: 'bg-rose-500/15 text-rose-300 border-rose-500/30'
};

/**
 * B4 — diagnostic panel: what the egress pool is actually doing, why a slot was
 * rejected, and which node serves which slot.
 */
export const EgressPoolPanel: React.FC = () => {
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/egress/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'cannot reach the backend');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const rotate = async (slot: number) => {
    setBusy(slot);
    try {
      await fetch(`/api/egress/rotate/${slot}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!status && !error) return null;

  return (
    <section className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-slate-200">Egress pool</h2>
            <span className="text-xs text-slate-500">
              {status ? `${status.ready}/${status.size} slots ready` : 'offline'}
            </span>
          </div>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" /> refresh
          </button>
        </div>

        {error && (
          <div className="px-5 py-3 text-xs text-rose-300 bg-rose-500/10 border-b border-rose-500/20 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </div>
        )}

        {status?.stuck?.length ? (
          <div className="px-5 py-2 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/20">
            {status.stuck.join(' • ')}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500 bg-slate-900/80">
              <tr>
                <th className="text-left font-medium px-5 py-2">Slot</th>
                <th className="text-left font-medium px-3 py-2">State</th>
                <th className="text-left font-medium px-3 py-2">Node</th>
                <th className="text-left font-medium px-3 py-2">Ports</th>
                <th className="text-right font-medium px-3 py-2">In flight</th>
                <th className="text-right font-medium px-3 py-2">Uptime</th>
                <th className="text-left font-medium px-3 py-2">Last error</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(status?.slots || []).map((s) => (
                <tr key={s.index} className="border-t border-slate-800/60">
                  <td className="px-5 py-2 font-mono text-slate-400">#{s.index}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full border text-[11px] ${stateStyles[s.state] || stateStyles.stopped}`}>
                      {s.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {s.node ? (
                      <span title={s.node.remark}>
                        <span className="font-mono">{s.node.address}:{s.node.port}</span>
                        <span className="text-slate-500"> · #{s.node.id}</span>
                      </span>
                    ) : (
                      <span className="text-slate-500">none</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500">{s.socksPort}/{s.httpPort}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{s.inFlight}</td>
                  <td className="px-3 py-2 text-right text-slate-400">{formatUptime(s.uptimeMs)}</td>
                  <td className="px-3 py-2 text-rose-300/80 max-w-[280px] truncate" title={s.lastError || ''}>
                    {s.lastError || '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => rotate(s.index)}
                      disabled={busy !== null || s.state !== 'ready'}
                      className="text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:border-emerald-500/60 hover:text-emerald-300 disabled:opacity-40"
                    >
                      {busy === s.index ? 'rotating…' : 'rotate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {status && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-3 border-t border-slate-800 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1"><Activity className="w-3 h-3" /> starts {status.metrics.starts}</span>
            <span>failures {status.metrics.startFailures}</span>
            <span>rotations {status.metrics.rotations}</span>
            <span>failovers {status.metrics.failovers}</span>
            <span>drain timeouts {status.metrics.drainTimeouts}</span>
            <span>churn/h {status.metrics.churnPerHour}</span>
            <span>avg start {status.metrics.avgStartMs}ms</span>
          </div>
        )}

        {status?.events?.length ? (
          <div className="px-5 py-3 border-t border-slate-800">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Recent events</div>
            <ul className="space-y-0.5 max-h-32 overflow-y-auto text-[11px] font-mono text-slate-400">
              {status.events.slice(-8).reverse().map((e, i) => (
                <li key={i}>
                  <span className="text-slate-600">{e.at.slice(11, 19)}</span>{' '}
                  <span className={
                    e.type === 'failover' || e.type === 'death' || e.type === 'error'
                      ? 'text-rose-300'
                      : e.type === 'rotate'
                        ? 'text-sky-300'
                        : 'text-emerald-300'
                  }>{e.type}</span>{' '}
                  <span className="text-slate-500">slot {e.slot}</span> {e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
};
