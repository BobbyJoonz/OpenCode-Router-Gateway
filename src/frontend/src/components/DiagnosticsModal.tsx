import React, { useState, useEffect } from 'react';
import { Activity, X, Terminal, CheckCircle2, XCircle, AlertCircle, Copy, Check } from 'lucide-react';

interface DiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const initialDiagnosticsData = {
  opencode: {
    installed: true,
    version: '1.19.5',
    binaryPath: '/usr/local/bin/opencode',
    configPath: '~/.config/opencode/opencode.json',
    defaultModel: 'opencode/deepseek-v4.1-flash-free'
  },
  privilege: {
    localProxyReady: true,
    hasNetAdminCap: false,
    hasScopedSudo: false,
    summary: 'Local SOCKS5/HTTP Proxy Mode is active and unprivileged (Zero Root Required).'
  },
  history: [
    {
      id: 1,
      remark: '🇩🇪 Frankfurt Fast-Track Node',
      protocol: 'vless',
      address: '198.51.*.*',
      port: 8445,
      timestamp: new Date().toISOString(),
      latency_ms: 187,
      opencode_success: 1
    },
    {
      id: 2,
      remark: '🇳🇱 Amsterdam Cloud Router',
      protocol: 'trojan',
      address: '192.0.*.*',
      port: 443,
      timestamp: new Date(Date.now() - 30000).toISOString(),
      latency_ms: 224,
      opencode_success: 1
    },
    {
      id: 3,
      remark: '🇬🇧 London Edge Proxy',
      protocol: 'ss',
      address: '203.0.*.*',
      port: 8388,
      timestamp: new Date(Date.now() - 60000).toISOString(),
      latency_ms: 480,
      opencode_success: 0,
      error_category: 'PROXY_CONNECTIVITY_FAILED',
      error_message: 'TCP Handshake Timeout'
    }
  ]
};

export const DiagnosticsModal: React.FC<DiagnosticsModalProps> = ({ isOpen, onClose }) => {
  const [data, setData] = useState<any>(initialDiagnosticsData);
  const [loading, setLoading] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetch('/api/diagnostics')
        .then((r) => r.json())
        .then((d) => {
          setData(d);
          setLoading(false);
        })
        .catch((e) => {
          console.error(e);
          setLoading(false);
        });
    }
  }, [isOpen]);

  const copyLauncher = () => {
    navigator.clipboard.writeText('opencode-vpn');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 space-y-5 shadow-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Activity className="w-5 h-5 text-sky-400" />
            <h2 className="text-lg font-bold text-white">OpenCode Integration & Diagnostics</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
          {/* OpenCode Environment Card */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase flex items-center gap-2">
              <Terminal className="w-4 h-4 text-sky-400" />
              OpenCode Target Runtime
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80 space-y-1">
                <span className="text-slate-500 block">Binary Executable:</span>
                <span className="font-mono text-slate-200">{data?.opencode?.binaryPath || '/usr/local/bin/opencode'}</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80 space-y-1">
                <span className="text-slate-500 block">Version:</span>
                <span className="font-mono text-emerald-400 font-semibold">{data?.opencode?.version || '1.19.5'}</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80 space-y-1">
                <span className="text-slate-500 block">Configuration Path:</span>
                <span className="font-mono text-slate-300 truncate block">{data?.opencode?.configPath || '~/.config/opencode/opencode.json'}</span>
              </div>
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800/80 space-y-1">
                <span className="text-slate-500 block">Configured Model:</span>
                <span className="font-mono text-sky-300 font-semibold">{data?.opencode?.defaultModel || 'Default Model'}</span>
              </div>
            </div>
          </div>

          {/* Dedicated Launcher Card */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase">Dedicated Launcher Command</h3>
            <p className="text-xs text-slate-400">
              When a connection is active, launch OpenCode with its dedicated isolated proxy using this command.
              It sets local HTTP/SOCKS proxy environment variables strictly for OpenCode without affecting other apps:
            </p>
            <div className="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 font-mono text-xs text-sky-400">
              <span>opencode-vpn</span>
              <button
                onClick={copyLauncher}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Recent Test History Logs */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase">Recent OpenCode Test Sessions</h3>
            <div className="space-y-2">
              {data?.history?.map((h: any) => (
                <div
                  key={h.id}
                  className="bg-slate-900 border border-slate-800/80 rounded-lg p-3 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-white">{h.remark}</span>
                    <span className="text-slate-500 font-mono text-[11px]">{new Date(h.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="font-mono text-slate-400">{h.protocol.toUpperCase()} ({h.address}:{h.port})</span>
                    <span className="text-slate-500">|</span>
                    <span className="text-slate-300">Latency: <strong className="text-emerald-400">{h.latency_ms ? `${h.latency_ms}ms` : '--'}</strong></span>
                    <span className="text-slate-500">|</span>
                    <span className="font-semibold">
                      {h.opencode_success === 1 ? (
                        <span className="text-emerald-400">SUCCESS</span>
                      ) : (
                        <span className="text-rose-400">{h.error_category || 'FAILED'}</span>
                      )}
                    </span>
                  </div>
                  {h.error_message && (
                    <p className="text-slate-400 text-[11px] bg-slate-950 p-2 rounded border border-slate-800/60 font-mono">
                      {h.error_message}
                    </p>
                  )}
                </div>
              ))}
              {(!data?.history || data.history.length === 0) && (
                <p className="text-xs text-slate-500 text-center py-4">No test history recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
