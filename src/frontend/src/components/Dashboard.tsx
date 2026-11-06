import React from 'react';
import {
  Play,
  Square,
  PowerOff,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Radio,
  Globe,
  Zap,
  Server,
  Layers,
  Terminal,
  ExternalLink
} from 'lucide-react';
import { SystemStatus } from '../types';

interface DashboardProps {
  status: SystemStatus | null;
  onStartWorkflow: (forceRefresh?: boolean) => void;
  onStopWorkflow: () => void;
  onDisconnectVpn: () => void;
  onTestCurrent: () => void;
  onRefreshSources: () => void;
  actionLoading: boolean;
}

export const Dashboard: React.FC<DashboardProps> = ({
  status,
  onStartWorkflow,
  onStopWorkflow,
  onDisconnectVpn,
  onTestCurrent,
  onRefreshSources,
  actionLoading
}) => {
  const isTesting = status?.isRunning || false;
  const activeConn = status?.activeConnection;

  return (
    <div className="space-y-6">
      {/* Hero Control Card */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-800/80 border border-slate-800 p-6 md:p-8 shadow-xl">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -left-16 -bottom-16 w-64 h-64 bg-sky-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              Isolated OpenCode Proxy Engine
            </div>
            <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
              Automated VPN Auto-Switching & Rate-Limit Router
            </h1>
            <p className="text-slate-400 text-sm max-w-2xl">
              Discovers verified V2Ray/Xray nodes from GitHub, executes deterministic OpenCode verification prompts,
              and locks in the best low-latency connection strictly for OpenCode without disrupting other applications or your OS network.
            </p>
          </div>

          {/* Main Action Buttons */}
          <div className="flex flex-wrap items-center gap-3">
            {!isTesting ? (
              <button
                onClick={() => onStartWorkflow(false)}
                disabled={actionLoading}
                className="flex items-center gap-2.5 px-6 py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-slate-950 font-bold text-base shadow-lg shadow-emerald-500/25 transition transform active:scale-95 disabled:opacity-50"
              >
                <Zap className="w-5 h-5 fill-current" />
                Find Working Connection
              </button>
            ) : (
              <button
                onClick={onStopWorkflow}
                className="flex items-center gap-2 px-6 py-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-base shadow-lg shadow-rose-600/30 transition transform active:scale-95 animate-pulse"
              >
                <Square className="w-5 h-5 fill-current" />
                Stop Testing
              </button>
            )}

            {activeConn && (
              <button
                onClick={onDisconnectVpn}
                disabled={isTesting}
                className="flex items-center gap-2 px-4 py-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-400 hover:text-rose-300 font-semibold text-sm border border-slate-700 transition"
              >
                <PowerOff className="w-4 h-4" />
                Disconnect VPN
              </button>
            )}

            <button
              onClick={() => onRefreshSources()}
              disabled={isTesting || actionLoading}
              title="Refresh VPN Configurations from GitHub"
              className="flex items-center gap-2 px-4 py-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-semibold text-sm border border-slate-700 transition disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${actionLoading ? 'animate-spin' : ''}`} />
              Refresh Nodes
            </button>
          </div>
        </div>

        {/* Live Workflow Status Message Bar */}
        <div className="mt-6 pt-5 border-t border-slate-800/80 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isTesting ? 'bg-amber-500/10 text-amber-400 animate-spin' : activeConn ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
              <Radio className="w-4 h-4" />
            </div>
            <div>
              <p className="text-xs text-slate-400 font-medium">Status Monitor</p>
              <p className="text-sm font-semibold text-slate-200">
                {status?.message || 'Ready'}
              </p>
            </div>
          </div>

          {activeConn && (
            <div className="flex items-center gap-2">
              <button
                onClick={onTestCurrent}
                className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 text-xs font-semibold transition"
              >
                Verify Current Connection
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Grid: 4 Essential Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: VPN Engine State */}
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">VPN Engine</span>
            <div className={`w-2.5 h-2.5 rounded-full ${activeConn ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-white">
              {activeConn ? 'Xray-Core' : 'Idle'}
            </span>
            <span className="text-xs text-slate-400">
              {activeConn ? '(Local Proxy Mode)' : 'Stopped'}
            </span>
          </div>
          <div className="pt-2 border-t border-slate-800 text-xs text-slate-400 space-y-1">
            <div className="flex justify-between">
              <span>SOCKS5 Proxy:</span>
              <span className="font-mono text-slate-200">127.0.0.1:{status?.socksPort || 10808}</span>
            </div>
            <div className="flex justify-between">
              <span>HTTP Proxy:</span>
              <span className="font-mono text-slate-200">127.0.0.1:{status?.httpPort || 10809}</span>
            </div>
          </div>
        </div>

        {/* Card 2: OpenCode Integration */}
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">OpenCode Target</span>
            <CheckCircle2 className="w-4 h-4 text-sky-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-white">
              {status?.opencode.version ? `v${status.opencode.version}` : 'Installed'}
            </span>
            <span className="text-xs text-emerald-400 font-medium">Native Proxy Ready</span>
          </div>
          <div className="pt-2 border-t border-slate-800 text-xs text-slate-400 space-y-1">
            <div className="flex justify-between truncate">
              <span>Model:</span>
              <span className="font-mono text-slate-200 truncate max-w-[140px]">
                {status?.opencode.defaultModel || 'Default'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Launcher:</span>
              <span className="font-mono text-sky-400">opencode-vpn</span>
            </div>
          </div>
        </div>

        {/* Card 3: Network Isolation & Public IP */}
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Network Routing</span>
            <Globe className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="text-xs text-slate-400">Proxy Egress IP:</div>
            <div className="text-base font-bold font-mono text-emerald-300">
              {activeConn?.egress_ip || 'None (Direct)'}
            </div>
          </div>
          <div className="pt-2 border-t border-slate-800 text-xs text-slate-400 flex justify-between">
            <span>Direct OS IP:</span>
            <span className="font-mono text-slate-300">{status?.normalIp || 'Direct'}</span>
          </div>
        </div>

        {/* Card 4: Nodes & Cache Metrics */}
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Node Database</span>
            <Layers className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {status?.stats.totalConfigs || 0}
            </span>
            <span className="text-xs text-slate-400">Cached Nodes</span>
          </div>
          <div className="pt-2 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
            <span className="text-emerald-400 font-semibold">{status?.stats.workingCount || 0} Working</span>
            <span className="text-slate-500">|</span>
            <span className="text-rose-400 font-semibold">{status?.stats.failedCount || 0} Failed</span>
            <span className="text-slate-500">|</span>
            <span className="text-slate-400">{status?.stats.untestedCount || 0} Untested</span>
          </div>
        </div>
      </div>

      {/* Active Selected Configuration Banner */}
      {activeConn && (
        <div className="rounded-xl bg-emerald-950/40 border border-emerald-500/30 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-base">{activeConn.remark}</span>
                <span className="px-2 py-0.5 rounded text-xs font-bold uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  {activeConn.protocol}
                </span>
                <span className="px-2 py-0.5 rounded text-xs font-mono bg-slate-800 text-slate-300">
                  {activeConn.address}:{activeConn.port}
                </span>
              </div>
              <p className="text-xs text-emerald-400/90 font-medium">
                {activeConn.reason || 'Verified working with OpenCode'}
              </p>
              <p className="text-xs text-slate-400">
                Connected at: {new Date(activeConn.connected_at).toLocaleTimeString()}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-slate-400">Verified Latency</div>
              <div className="text-lg font-bold font-mono text-emerald-400">
                {activeConn.latency_ms ? `${activeConn.latency_ms} ms` : 'Active'}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300">
                Terminal: <span className="text-sky-400 font-bold">opencode-vpn</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
