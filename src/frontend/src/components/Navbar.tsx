import React from 'react';
import { Shield, Cpu, RefreshCw, Settings, Database, Activity, Terminal } from 'lucide-react';
import { SystemStatus } from '../types';

interface NavbarProps {
  status: SystemStatus | null;
  activeTab: 'dashboard' | 'configs';
  setActiveTab: (tab: 'dashboard' | 'configs') => void;
  onOpenSources: () => void;
  onOpenDiagnostics: () => void;
  onOpenPrivileges: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  status,
  activeTab,
  setActiveTab,
  onOpenSources,
  onOpenDiagnostics,
  onOpenPrivileges
}) => {
  const isVpnActive = Boolean(status?.activeConnection);

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Shield className="w-5 h-5 text-slate-950 font-bold" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg text-white tracking-tight">OpenCode Router</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">v1.0.0</span>
            </div>
            <p className="text-xs text-slate-400">Targeted OpenCode Proxy & Rate-Limit Router</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              activeTab === 'dashboard'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('configs')}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              activeTab === 'configs'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Configurations ({status?.stats.totalConfigs || 0})
          </button>
        </div>

        {/* Action icons & Status indicators */}
        <div className="flex items-center gap-3">
          {/* OpenCode Status Badge */}
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs">
            <Cpu className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-slate-300">OpenCode:</span>
            <span className="font-semibold text-sky-300">{status?.opencode.version ? `v${status.opencode.version}` : 'Ready'}</span>
          </div>

          {/* VPN State Indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs">
            <span className={`w-2.5 h-2.5 rounded-full ${isVpnActive ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50 animate-pulse' : 'bg-slate-500'}`} />
            <span className="text-slate-300">VPN:</span>
            <span className={`font-semibold ${isVpnActive ? 'text-emerald-400' : 'text-slate-400'}`}>
              {isVpnActive ? 'Active (Isolated)' : 'Disconnected'}
            </span>
          </div>

          {/* Quick Action Buttons */}
          <button
            onClick={onOpenSources}
            title="GitHub Subscription Sources"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition border border-slate-700/60"
          >
            <Database className="w-4 h-4" />
          </button>

          <button
            onClick={onOpenDiagnostics}
            title="System Diagnostics & Logs"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition border border-slate-700/60"
          >
            <Activity className="w-4 h-4" />
          </button>

          <button
            onClick={onOpenPrivileges}
            title="Security & Permissions Wizard"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition border border-slate-700/60"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
