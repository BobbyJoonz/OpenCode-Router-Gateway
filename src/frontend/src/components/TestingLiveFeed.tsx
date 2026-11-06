import React from 'react';
import { Activity, Clock, CheckCircle2, XCircle, AlertCircle, RefreshCw } from 'lucide-react';

export interface LiveCandidateLog {
  id: number;
  protocol: string;
  address: string;
  port: number;
  remark: string;
  security: string;
  latencyMs?: number;
  status: 'testing' | 'working' | 'failed' | 'rate_limited';
  error?: string;
  timestamp: string;
}

interface TestingLiveFeedProps {
  logs: LiveCandidateLog[];
  isTesting: boolean;
  currentMessage: string;
}

export const TestingLiveFeed: React.FC<TestingLiveFeedProps> = ({ logs, isTesting, currentMessage }) => {
  if (logs.length === 0 && !isTesting) {
    return null;
  }

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden shadow-lg">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
        <div className="flex items-center gap-2.5">
          <Activity className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-bold text-white">Live Candidate Testing Feed</h2>
        </div>
        {isTesting && (
          <div className="flex items-center gap-2 text-xs font-medium text-amber-400 bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
            <RefreshCw className="w-3 h-3 animate-spin" />
            Testing Candidates In Sequence
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/70 text-slate-400 uppercase font-semibold border-b border-slate-800">
            <tr>
              <th className="py-3 px-4">Configuration Remark</th>
              <th className="py-3 px-4">Protocol</th>
              <th className="py-3 px-4">Endpoint</th>
              <th className="py-3 px-4">Measured Latency</th>
              <th className="py-3 px-4">Status & OpenCode Test</th>
              <th className="py-3 px-4">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-mono">
            {logs.map((item, idx) => (
              <tr
                key={`${item.id}-${idx}`}
                className={`transition ${
                  item.status === 'working'
                    ? 'bg-emerald-500/10'
                    : item.status === 'testing'
                    ? 'bg-amber-500/5'
                    : 'hover:bg-slate-800/30'
                }`}
              >
                <td className="py-3 px-4 font-sans font-medium text-slate-200 max-w-[220px] truncate">
                  {item.remark}
                </td>
                <td className="py-3 px-4">
                  <span className="px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-slate-800 text-slate-300 border border-slate-700">
                    {item.protocol}
                  </span>
                </td>
                <td className="py-3 px-4 text-slate-400">
                  {item.address}:{item.port}
                </td>
                <td className="py-3 px-4">
                  {item.latencyMs && item.latencyMs > 0 ? (
                    <span
                      className={`font-semibold ${
                        item.latencyMs < 200
                          ? 'text-emerald-400'
                          : item.latencyMs < 450
                          ? 'text-amber-400'
                          : 'text-orange-400'
                      }`}
                    >
                      {item.latencyMs} ms
                    </span>
                  ) : (
                    <span className="text-slate-500">--</span>
                  )}
                </td>
                <td className="py-3 px-4 font-sans">
                  {item.status === 'testing' && (
                    <span className="inline-flex items-center gap-1.5 text-amber-400 font-semibold">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      Testing OpenCode
                    </span>
                  )}
                  {item.status === 'working' && (
                    <span className="inline-flex items-center gap-1.5 text-emerald-400 font-bold">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      CONNECTION_OK (Working)
                    </span>
                  )}
                  {item.status === 'failed' && (
                    <span className="inline-flex items-center gap-1.5 text-rose-400" title={item.error}>
                      <XCircle className="w-3.5 h-3.5" />
                      {item.error || 'Failed'}
                    </span>
                  )}
                  {item.status === 'rate_limited' && (
                    <span className="inline-flex items-center gap-1.5 text-orange-400" title={item.error}>
                      <AlertCircle className="w-3.5 h-3.5" />
                      Rate Limited (Rotating IP)
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-slate-500 text-[11px]">
                  {item.timestamp}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
