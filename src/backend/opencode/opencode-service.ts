import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ErrorClassifier, ClassificationResult } from './error-classifier';
import { getSetting } from '../db/database';
import { PROJECT_ROOT } from '../paths';

export interface OpenCodeInfo {
  installed: boolean;
  version?: string;
  binaryPath: string;
  configPath?: string;
  defaultModel?: string;
}

export class OpenCodeService {
  private static instance: OpenCodeService | null = null;
  private binaryPath: string = process.platform === 'win32' ? 'opencode.exe' : '/usr/local/bin/opencode';
  private launcherPath: string;
  private readonly isWin = process.platform === 'win32';

  private constructor() {
    const projectRoot = PROJECT_ROOT;
    // The launcher is written at startup. Under systemd hardening the project
    // directory is read-only, so allow an explicit writable location.
    const launcherDir = process.env.OPENCODE_LAUNCHER_DIR || path.join(projectRoot, 'bin');
    this.launcherPath = path.join(launcherDir, this.isWin ? 'opencode-vpn.cmd' : 'opencode-vpn');

    this.resolveBinaryPath();

    this.ensureLauncherScript();
  }

  /**
   * Locate the OpenCode executable in a cross-platform way.
   * Prefers OPENCODE_BIN, then the real .exe shipped by the npm package (Windows),
   * then `where` / `which`, then the historical /usr/local/bin path.
   */
  private resolveBinaryPath(): void {
    const candidates: string[] = [];

    if (process.env.OPENCODE_BIN) candidates.push(process.env.OPENCODE_BIN);

    if (this.isWin) {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      candidates.push(path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
    }

    try {
      const whichCmd = this.isWin ? 'where opencode' : 'which opencode';
      const out = execSync(whichCmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // On Windows prefer a real .exe over the .cmd/.ps1 shims (spawn can't run .cmd without a shell)
      const preferred = this.isWin ? lines.filter((l) => l.toLowerCase().endsWith('.exe')) : lines;
      candidates.push(...preferred, ...lines);
    } catch {
      // keep fallbacks
    }

    candidates.push(this.binaryPath);

    const found = candidates.find((c) => c && fs.existsSync(c));
    if (found) this.binaryPath = found;
  }

  public static getInstance(): OpenCodeService {
    if (!this.instance) {
      this.instance = new OpenCodeService();
    }
    return this.instance;
  }

  public getInfo(): OpenCodeInfo {
    const installed = fs.existsSync(this.binaryPath);
    let version: string | undefined;
    let configPath: string | undefined;
    let defaultModel: string | undefined;

    if (installed) {
      try {
        version = execSync(`"${this.binaryPath}" --version`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        // ignore
      }

      const home = process.env.HOME || os.homedir();
      const configCandidates = [
        path.join(home, '.config', 'opencode', 'opencode.json'),
        ...(this.isWin
          ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'opencode', 'opencode.json')]
          : [])
      ];
      const userConfig = configCandidates.find((p) => fs.existsSync(p));
      if (userConfig) {
        configPath = userConfig;
        try {
          const cfg = JSON.parse(fs.readFileSync(userConfig, 'utf-8'));
          defaultModel = cfg.model;
        } catch {
          // ignore
        }
      }
    }

    return {
      installed,
      version,
      binaryPath: this.binaryPath,
      configPath,
      defaultModel
    };
  }

  public getLauncherPath(): string {
    return this.launcherPath;
  }

  /**
   * Read the proxy ports the app is actually configured to use, so the generated
   * launcher stays in sync with the dashboard settings (instead of assuming 10808/10809).
   */
  private resolveProxyPorts(): { http: string; socks: string } {
    try {
      return {
        http: getSetting('http_port', '10809'),
        socks: getSetting('socks_port', '10808')
      };
    } catch {
      return { http: '10809', socks: '10808' };
    }
  }

  public ensureLauncherScript(): void {
    const launcherDir = path.dirname(this.launcherPath);
    if (!fs.existsSync(launcherDir)) {
      fs.mkdirSync(launcherDir, { recursive: true });
    }

    const script = this.isWin ? this.buildWindowsLauncher() : this.buildPosixLauncher();

    fs.writeFileSync(this.launcherPath, script, { encoding: 'utf-8', mode: 0o755 });

    // Also link to ~/.local/bin/opencode-vpn if directory exists (POSIX only)
    if (!this.isWin) {
      const userLocalBin = path.join(process.env.HOME || os.homedir(), '.local', 'bin');
      if (fs.existsSync(userLocalBin)) {
        const userLink = path.join(userLocalBin, 'opencode-vpn');
        try {
          if (!fs.existsSync(userLink)) {
            fs.symlinkSync(this.launcherPath, userLink);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  private buildPosixLauncher(): string {
    const { http, socks } = this.resolveProxyPorts();
    return `#!/usr/bin/env bash
# Dedicated OpenCode VPN Launcher
# Injects the active local proxy specifically for OpenCode without system-wide routing changes.

HTTP_PORT="\${OPENCODE_HTTP_PROXY_PORT:-${http}}"
SOCKS_PORT="\${OPENCODE_SOCKS_PROXY_PORT:-${socks}}"

# NOTE: OpenCode's LLM runtime breaks on an HTTP(S) proxy env (ECONNREFUSED);
# SOCKS5 via ALL_PROXY works for both the model catalog and the completion stream.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export all_proxy="socks5://127.0.0.1:\${SOCKS_PORT}"
export ALL_PROXY="socks5://127.0.0.1:\${SOCKS_PORT}"

OPENCODE_BIN="${this.binaryPath}"
if [ ! -x "\$OPENCODE_BIN" ]; then
  OPENCODE_BIN=\$(which opencode 2>/dev/null || echo "opencode")
fi

exec "\$OPENCODE_BIN" "\$@"
`;
  }

  private buildWindowsLauncher(): string {
    const { http, socks } = this.resolveProxyPorts();
    return `@echo off
REM Dedicated OpenCode VPN Launcher (Windows)
REM Injects the active local proxy specifically for OpenCode without system-wide routing changes.

if "%OPENCODE_HTTP_PROXY_PORT%"=="" set "OPENCODE_HTTP_PROXY_PORT=${http}"
if "%OPENCODE_SOCKS_PROXY_PORT%"=="" set "OPENCODE_SOCKS_PROXY_PORT=${socks}"

REM OpenCode's LLM runtime breaks on HTTP(S) proxy env vars (ECONNREFUSED).
REM SOCKS5 via ALL_PROXY works for the model catalog and the completion stream.
set "http_proxy="
set "https_proxy="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "all_proxy=socks5://127.0.0.1:%OPENCODE_SOCKS_PROXY_PORT%"
set "ALL_PROXY=socks5://127.0.0.1:%OPENCODE_SOCKS_PROXY_PORT%"

set "OPENCODE_BIN=${this.binaryPath}"
if not exist "%OPENCODE_BIN%" set "OPENCODE_BIN=opencode"

"%OPENCODE_BIN%" %*
`;
  }

  /**
   * Run a controlled, non-interactive OpenCode test through the specific candidate proxy
   */
  public async testOpenCodeConnection(
    httpPort: number = 10809,
    socksPort: number = 10808,
    timeoutSeconds: number = 18
  ): Promise<ClassificationResult> {
    const prompt = 'Reply with exactly: CONNECTION_OK';
    const args = ['run', prompt, '--pure', '--format', 'json', '--print-logs'];

    // Proxy settings injected exclusively into this process.
    //
    // IMPORTANT: OpenCode's LLM runtime (AI SDK on Bun) fails with
    // "ECONNREFUSED" when an HTTP(S) proxy is supplied via http_proxy/https_proxy,
    // even though plain fetches through that proxy work. SOCKS5 via ALL_PROXY
    // works reliably for both the model catalog and the completion stream.
    // So we deliberately expose ONLY the SOCKS5 endpoint here.
    const proxyEnv: NodeJS.ProcessEnv = {
      ...process.env,
      all_proxy: `socks5://127.0.0.1:${socksPort}`,
      ALL_PROXY: `socks5://127.0.0.1:${socksPort}`
    };
    // Make sure an inherited HTTP proxy from the parent shell cannot leak in and
    // trigger the ECONNREFUSED failure mode.
    delete proxyEnv.http_proxy;
    delete proxyEnv.https_proxy;
    delete proxyEnv.HTTP_PROXY;
    delete proxyEnv.HTTPS_PROXY;

    return new Promise<ClassificationResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let isDone = false;

      const child = spawn(this.binaryPath, args, {
        env: proxyEnv,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          try {
            child.kill('SIGKILL');
          } catch {}
          resolve({
            category: 'NETWORK_ERROR',
            isRecoverableBySwitchingVpn: true,
            userMessage: `OpenCode test timed out after ${timeoutSeconds}s through proxy.`,
            rawDetails: stderr || stdout
          });
        }
      }, timeoutSeconds * 1000);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });

      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        if (!isDone) {
          isDone = true;
          clearTimeout(timer);
          resolve({
            category: 'CONFIG_ERROR',
            isRecoverableBySwitchingVpn: false,
            userMessage: `Failed to execute OpenCode binary: ${err.message}`,
            rawDetails: err.stack
          });
        }
      });

      child.on('exit', (code) => {
        if (!isDone) {
          isDone = true;
          clearTimeout(timer);
          const classification = ErrorClassifier.classify(code, stdout, stderr);
          classification.rawDetails = stderr.slice(0, 1000) || stdout.slice(0, 1000);
          resolve(classification);
        }
      });
    });
  }
}
