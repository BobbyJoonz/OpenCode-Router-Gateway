import React, { useState, useEffect } from 'react';
import {
  Search,
  Filter,
  Play,
  Trash2,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Layers
} from 'lucide-react';
import { CandidateItem } from '../types';

interface ConfigTableProps {
  onRefreshSources: () => void;
  onImportConfigs: (text: string) => void;
}

const initialSampleItems: CandidateItem[] = [
  {
    id: 456,
    protocol: 'vless',
    address: '198.51.100.15',
    port: 8445,
    remark: '🇩🇪 Frankfurt Fast-Track Node',
    security: 'reality',
    network: 'tcp',
    last_latency_ms: 187,
    last_status: 'working'
  },
  {
    id: 112,
    protocol: 'trojan',
    address: '192.0.2.88',
    port: 443,
    remark: '🇳🇱 Amsterdam Cloud Router',
    security: 'tls',
    network: 'ws',
    last_latency_ms: 224,
    last_status: 'working'
  },
  {
    id: 89,
    protocol: 'vmess',
    address: '198.51.100.72',
    port: 443,
    remark: '🇫🇷 Paris Low-Ping Egress',
    security: 'tls',
    network: 'ws',
    last_latency_ms: 251,
    last_status: 'working'
  },
  {
    id: 310,
    protocol: 'ss',
    address: '203.0.113.24',
    port: 8388,
    remark: '🇬🇧 London Edge Proxy',
    security: 'aes-256-gcm',
    network: 'tcp',
    last_latency_ms: 480,
    last_status: 'failed'
  },
  {
    id: 504,
    protocol: 'vless',
    address: '192.0.2.77',
    port: 443,
    remark: '🇺🇸 Ashburn High-Speed Node',
    security: 'reality',
    network: 'grpc',
    last_status: 'untested'
  }
];

export const ConfigTable: React.FC<ConfigTableProps> = ({ onRefreshSources, onImportConfigs }) => {
  const [items, setItems] = useState<CandidateItem[]>(initialSampleItems);
  const [loading, setLoading] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [protocolFilter, setProtocolFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [manualTestingId, setManualTestingId] = useState<number | null>(null);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [importText, setImportText] = useState<string>('');

  const fetchConfigs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: '15',
        protocol: protocolFilter,
        status: statusFilter,
        search: searchQuery
      });
      const res = await fetch(`/api/configs?${params}`);
      const data = await res.json();
      setItems(data.items || []);
      setTotalPages(data.pagination?.totalPages || 1);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfigs();
  }, [page, protocolFilter, statusFilter, searchQuery]);

  const handleManualTest = async (id: number) => {
    setManualTestingId(id);
    try {
      const res = await fetch('/api/configs/test-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const result = await res.json();
      alert(`Test Result for node #${id}:\nSuccess: ${result.success}\nStep: ${result.step || 'Completed'}\n${result.error || 'OpenCode responded OK'}`);
      fetchConfigs();
    } catch (err: any) {
      alert(`Test failed: ${err.message}`);
    } finally {
      setManualTestingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this configuration?')) return;
    try {
      await fetch(`/api/configs/${id}`, { method: 'DELETE' });
      fetchConfigs();
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`);
    }
  };

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!importText.trim()) return;
    onImportConfigs(importText);
    setImportText('');
    setShowImportModal(false);
    setTimeout(fetchConfigs, 500);
  };

  return (
    <div className="space-y-4">
      {/* Header Controls */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="relative min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search remarks, endpoints..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
            />
          </div>

          {/* Protocol Filter */}
          <select
            value={protocolFilter}
            onChange={(e) => { setProtocolFilter(e.target.value); setPage(1); }}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500 transition"
          >
            <option value="">All Protocols</option>
            <option value="vless">VLESS</option>
            <option value="vmess">VMess</option>
            <option value="trojan">Trojan</option>
            <option value="ss">Shadowsocks</option>
          </select>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500 transition"
          >
            <option value="">All Statuses</option>
            <option value="working">Working Only</option>
            <option value="untested">Untested</option>
            <option value="failed">Failed</option>
            <option value="rate_limited">Rate Limited</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImportModal(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs transition"
          >
            <Plus className="w-3.5 h-3.5" />
            Import Configs
          </button>
          <button
            onClick={fetchConfigs}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-xs transition"
            title="Refresh Table"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Configurations Table */}
      <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden shadow-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Remark / Server</th>
                <th className="py-3 px-4">Protocol</th>
                <th className="py-3 px-4">Endpoint</th>
                <th className="py-3 px-4">Security / Net</th>
                <th className="py-3 px-4">Last Latency</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {items.map((c) => (
                <tr
                  key={c.id}
                  className={`transition ${c.is_active ? 'bg-emerald-500/10' : 'hover:bg-slate-800/30'}`}
                >
                  <td className="py-3 px-4 font-sans font-medium text-slate-200 max-w-[200px] truncate">
                    <div className="flex items-center gap-2">
                      {c.is_active === 1 && (
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" title="Active Connection" />
                      )}
                      <span className="truncate">{c.remark}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className="px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-slate-800 text-slate-300 border border-slate-700">
                      {c.protocol}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-400">
                    {c.address}:{c.port}
                  </td>
                  <td className="py-3 px-4 text-slate-400 font-sans text-[11px]">
                    <span className="uppercase text-slate-300">{c.security}</span> / {c.network}
                  </td>
                  <td className="py-3 px-4">
                    {c.last_latency_ms && c.last_latency_ms > 0 ? (
                      <span className="text-emerald-400 font-semibold">{c.last_latency_ms} ms</span>
                    ) : (
                      <span className="text-slate-500">--</span>
                    )}
                  </td>
                  <td className="py-3 px-4 font-sans">
                    {c.last_status === 'working' && (
                      <span className="inline-flex items-center gap-1 text-emerald-400 font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Working
                      </span>
                    )}
                    {c.last_status === 'failed' && (
                      <span className="inline-flex items-center gap-1 text-rose-400">
                        <XCircle className="w-3.5 h-3.5" /> Failed ({c.consecutive_failures})
                      </span>
                    )}
                    {c.last_status === 'rate_limited' && (
                      <span className="inline-flex items-center gap-1 text-orange-400">
                        Rate Limited
                      </span>
                    )}
                    {c.last_status === 'untested' && (
                      <span className="text-slate-500">Untested</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right space-x-2 font-sans">
                    <button
                      onClick={() => handleManualTest(c.id)}
                      disabled={manualTestingId === c.id}
                      title="Test this node individually"
                      className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition disabled:opacity-50"
                    >
                      <Play className={`w-3.5 h-3.5 ${manualTestingId === c.id ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      title="Delete configuration"
                      className="p-1.5 rounded bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-400 border border-slate-700 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500 font-sans">
                    No configurations found matching current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-4 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between text-xs text-slate-400">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-lg font-bold text-white">Import Configurations or Subscription</h3>
            <p className="text-xs text-slate-400">
              Paste raw VLESS, VMess, Trojan, or Shadowsocks links, or Base64 subscription blocks.
            </p>
            <form onSubmit={handleImportSubmit} className="space-y-4">
              <textarea
                rows={6}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="vless://...&#10;vmess://...&#10;trojan://...&#10;ss://..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500"
              />
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-slate-950 transition"
                >
                  Import Now
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
