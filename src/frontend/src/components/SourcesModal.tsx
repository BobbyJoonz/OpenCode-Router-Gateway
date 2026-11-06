import React, { useState, useEffect } from 'react';
import { Database, Plus, RefreshCw, Trash2, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { SourceItem } from '../types';

interface SourcesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SourcesModal: React.FC<SourcesModalProps> = ({ isOpen, onClose }) => {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>('');
  const [newUrl, setNewUrl] = useState<string>('');
  const [refreshingId, setRefreshingId] = useState<number | null>(null);

  const fetchSources = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sources');
      const data = await res.json();
      setSources(data.sources || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) fetchSources();
  }, [isOpen]);

  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newUrl.trim()) return;
    try {
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, url: newUrl })
      });
      if (res.ok) {
        setNewName('');
        setNewUrl('');
        fetchSources();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add source');
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleRefreshSource = async (id: number) => {
    setRefreshingId(id);
    try {
      const res = await fetch(`/api/sources/${id}/refresh`, { method: 'POST' });
      const data = await res.json();
      const s = data.summary;
      alert(`Source Refreshed!\nImported: ${s.newImported}\nDuplicates: ${s.duplicates}\nInvalid: ${s.invalid}`);
      fetchSources();
    } catch (err: any) {
      alert(`Failed to refresh: ${err.message}`);
    } finally {
      setRefreshingId(null);
    }
  };

  const handleDeleteSource = async (id: number) => {
    if (!confirm('Delete this GitHub source?')) return;
    try {
      await fetch(`/api/sources/${id}`, { method: 'DELETE' });
      fetchSources();
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Database className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-bold text-white">GitHub Subscription Registry</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Source List */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {sources.map((s) => (
            <div
              key={s.id}
              className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3.5 flex items-center justify-between gap-4"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white text-xs truncate">{s.name}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-emerald-400">
                    {s.config_count} nodes
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 font-mono truncate">{s.url}</p>
                <p className="text-[10px] text-slate-400">
                  Last fetched: {s.last_fetched_at ? new Date(s.last_fetched_at).toLocaleString() : 'Never'}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleRefreshSource(s.id)}
                  disabled={refreshingId === s.id}
                  title="Fetch fresh nodes from this source"
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshingId === s.id ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => handleDeleteSource(s.id)}
                  title="Remove source"
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-400 border border-slate-700 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Add Source Form */}
        <form onSubmit={handleAddSource} className="border-t border-slate-800 pt-4 space-y-3">
          <h4 className="text-xs font-bold text-slate-300 uppercase">Register New Source</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Source Label (e.g. Community Mix)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500"
            />
            <input
              type="url"
              placeholder="Raw GitHub or Subscription URL"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs transition"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Source
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
