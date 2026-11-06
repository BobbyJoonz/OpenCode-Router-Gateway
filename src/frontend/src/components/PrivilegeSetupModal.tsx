import React, { useState, useEffect } from 'react';
import { ShieldCheck, X, Copy, Check, Terminal, Info, Lock } from 'lucide-react';

interface PrivilegeSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PrivilegeSetupModal: React.FC<PrivilegeSetupModalProps> = ({ isOpen, onClose }) => {
  const [data, setData] = useState<any>(null);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/diagnostics')
        .then((r) => r.json())
        .then((d) => setData(d.privilege))
        .catch(console.error);
    }
  }, [isOpen]);

  const copyScript = () => {
    navigator.clipboard.writeText('./scripts/setup-privileges.sh');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 space-y-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-bold text-white">Privilege & Security Architecture</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 text-xs">
          {/* Status highlight */}
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 space-y-2">
            <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
              <Check className="w-4 h-4" />
              Local Proxy Mode: Zero Root Required
            </div>
            <p className="text-slate-300">
              The primary engine runs entirely in user-space as an unprivileged process binding to high ports (10808/10809).
              It will <strong>never ask for your Ubuntu root password</strong> during normal operation or node rotation.
            </p>
          </div>

          {/* Principle of least privilege */}
          <div className="space-y-2 text-slate-300">
            <h4 className="font-bold text-white uppercase text-[11px] flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-sky-400" />
              Security Principles Enforced
            </h4>
            <ul className="list-disc list-inside space-y-1 text-slate-400">
              <li>Never stores passwords in plaintext.</li>
              <li>Never grants unrestricted passwordless sudo to node or user.</li>
              <li>Leaves IDEs, SSH sessions, browsers, and system traffic completely untouched.</li>
              <li>Only OpenCode receives proxy injection via <code className="text-sky-300 font-mono">opencode-vpn</code>.</li>
            </ul>
          </div>

          {/* Optional Helper Setup */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2.5">
            <h4 className="font-bold text-white uppercase text-[11px]">
              Optional: Setup Narrow Privileges (for TUN / Network Capabilities)
            </h4>
            <p className="text-slate-400">
              If you ever wish to enable low-level Linux packet capabilities (<code className="text-slate-200">cap_net_admin</code>)
              for TUN interfaces without unrestricted root, run our verified least-privilege script:
            </p>
            <div className="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 font-mono text-emerald-400">
              <span>./scripts/setup-privileges.sh</span>
              <button
                onClick={copyScript}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition text-[11px]"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
