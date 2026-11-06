import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { Dashboard } from './components/Dashboard';
import { TestingLiveFeed, LiveCandidateLog } from './components/TestingLiveFeed';
import { EgressPoolPanel } from './components/EgressPoolPanel';
import { ConfigTable } from './components/ConfigTable';
import { SourcesModal } from './components/SourcesModal';
import { DiagnosticsModal } from './components/DiagnosticsModal';
import { PrivilegeSetupModal } from './components/PrivilegeSetupModal';
import { SystemStatus } from './types';

export const App: React.FC = () => {
  const [status, setStatus] = useState<SystemStatus>({
    phase: 'idle',
    isRunning: false,
    message: 'System active. Ready to route OpenCode traffic.',
    activeConnection: {
      id: 456,
      protocol: 'vless',
      address: '198.51.100.15',
      port: 8445,
      remark: '🇩🇪 Frankfurt Fast-Track Node',
      security: 'reality',
      network: 'tcp',
      latency_ms: 187,
      egress_ip: '198.51.100.117',
      connected_at: new Date().toISOString()
    },
    opencode: {
      installed: true,
      version: '1.19.5',
      binaryPath: '/usr/local/bin/opencode',
      configPath: '~/.config/opencode/opencode.json',
      defaultModel: 'opencode/deepseek-v4.1-flash-free'
    },
    stats: {
      totalConfigs: 3977,
      workingCount: 14,
      failedCount: 42,
      untestedCount: 3921
    },
    normalIp: 'Direct OS Network',
    socksPort: '10808',
    httpPort: '10809'
  });
  const [activeTab, setActiveTab] = useState<'dashboard' | 'configs'>('dashboard');
  const [liveLogs, setLiveLogs] = useState<LiveCandidateLog[]>([]);
  const [actionLoading, setActionLoading] = useState<boolean>(false);

  // Modal states
  const [sourcesOpen, setSourcesOpen] = useState<boolean>(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean>(false);
  const [privilegesOpen, setPrivilegesOpen] = useState<boolean>(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch status:', e);
    }
  };

  useEffect(() => {
    fetchStatus();

    // Connect to Server-Sent Events (SSE)
    const eventSource = new EventSource('/api/events');

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        // Update overall status
        setStatus((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            phase: payload.phase || prev.phase,
            isRunning: payload.phase === 'testing' || payload.phase === 'discovering',
            message: payload.message || prev.message,
            activeConnection: payload.activeConnection !== undefined ? payload.activeConnection : prev.activeConnection,
            stats: payload.stats || prev.stats
          };
        });

        // If candidate log is present, append to live table
        if (payload.candidate) {
          const c = payload.candidate;
          setLiveLogs((prev) => {
            const time = new Date().toLocaleTimeString();
            const existingIdx = prev.findIndex((item) => item.id === c.id);
            if (existingIdx !== -1) {
              const updated = [...prev];
              updated[existingIdx] = {
                ...updated[existingIdx],
                ...c,
                timestamp: time
              };
              return updated;
            } else {
              return [
                {
                  id: c.id,
                  protocol: c.protocol,
                  address: c.address,
                  port: c.port,
                  remark: c.remark,
                  security: c.security,
                  latencyMs: c.latencyMs,
                  status: c.status,
                  error: c.error,
                  timestamp: time
                },
                ...prev.slice(0, 49) // Keep last 50
              ];
            }
          });
        }
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      // Reconnection handled automatically by EventSource
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const handleStartWorkflow = async (forceRefresh = false) => {
    setActionLoading(true);
    setLiveLogs([]); // Clear logs for new session
    try {
      await fetch('/api/workflow/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRefresh })
      });
      fetchStatus();
    } catch (e: any) {
      alert(`Error starting workflow: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStopWorkflow = async () => {
    try {
      await fetch('/api/workflow/stop', { method: 'POST' });
      fetchStatus();
    } catch (e: any) {
      alert(`Error stopping workflow: ${e.message}`);
    }
  };

  const handleDisconnectVpn = async () => {
    try {
      await fetch('/api/vpn/disconnect', { method: 'POST' });
      fetchStatus();
    } catch (e: any) {
      alert(`Error disconnecting: ${e.message}`);
    }
  };

  const handleTestCurrent = async () => {
    setActionLoading(true);
    try {
      const res = await fetch('/api/vpn/test-current', { method: 'POST' });
      const data = await res.json();
      alert(`Current Connection Verification:\nProxy Latency: ${data.proxyTest?.latencyMs || '--'}ms\nOpenCode Test Result: ${data.opencodeTest?.category} - ${data.opencodeTest?.userMessage}`);
      fetchStatus();
    } catch (e: any) {
      alert(`Error: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRefreshSources = async () => {
    setActionLoading(true);
    try {
      await fetch('/api/sources/refresh-all', { method: 'POST' });
      alert('GitHub sources updated and synchronized successfully!');
      fetchStatus();
    } catch (e: any) {
      alert(`Failed to refresh sources: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleImportConfigs = async (rawText: string) => {
    try {
      const res = await fetch('/api/configs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText })
      });
      const data = await res.json();
      alert(`Configurations Imported!\nImported: ${data.imported}\nDuplicates: ${data.duplicates}\nInvalid: ${data.invalid}`);
      fetchStatus();
    } catch (e: any) {
      alert(`Failed to import: ${e.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Navbar
        status={status}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenSources={() => setSourcesOpen(true)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        onOpenPrivileges={() => setPrivilegesOpen(true)}
      />

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 space-y-6">
        {activeTab === 'dashboard' ? (
          <>
            <Dashboard
              status={status}
              onStartWorkflow={handleStartWorkflow}
              onStopWorkflow={handleStopWorkflow}
              onDisconnectVpn={handleDisconnectVpn}
              onTestCurrent={handleTestCurrent}
              onRefreshSources={handleRefreshSources}
              actionLoading={actionLoading}
            />

            <TestingLiveFeed
              logs={liveLogs}
              isTesting={status?.isRunning || false}
              currentMessage={status?.message || ''}
            />
          </>
        ) : (
          <ConfigTable
            onRefreshSources={handleRefreshSources}
            onImportConfigs={handleImportConfigs}
          />
        )}
        <EgressPoolPanel />
      </main>

      {/* Modals */}
      <SourcesModal isOpen={sourcesOpen} onClose={() => setSourcesOpen(false)} />
      <DiagnosticsModal isOpen={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
      <PrivilegeSetupModal isOpen={privilegesOpen} onClose={() => setPrivilegesOpen(false)} />

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/90 py-5 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-300">OpenCode Router</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400 font-mono">v1.0.0</span>
            <span>&bull;</span>
            <span>Isolated User-Space Proxy for Ubuntu</span>
          </div>
          <div className="flex items-center gap-1.5 text-slate-400">
            <span>Created by</span>
            <span className="font-semibold text-slate-200">Ehsan Shahriyari</span>
            <span>&bull;</span>
            <a
              href="https://github.com/EhsanCreator"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:text-emerald-300 font-medium transition inline-flex items-center gap-1"
            >
              @EhsanCreator
            </a>
            <span>&bull;</span>
            <a
              href="https://github.com/EhsanCreator/OpenCode-Router"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300 font-medium transition"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};
