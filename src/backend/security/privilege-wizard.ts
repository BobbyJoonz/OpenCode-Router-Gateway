import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface PrivilegeStatus {
  localProxyReady: boolean;
  hasNetAdminCap: boolean;
  hasScopedSudo: boolean;
  summary: string;
  setupScriptPath: string;
}

export class PrivilegeWizard {
  public static checkStatus(): PrivilegeStatus {
    const projectRoot = path.resolve(__dirname, '../../../');
    const isWin = process.platform === 'win32';
    const xrayBin = path.join(projectRoot, 'bin', isWin ? 'xray.exe' : 'xray');
    const setupScriptPath = isWin ? '' : path.join(projectRoot, 'scripts', 'setup-privileges.sh');

    // Local proxy is always ready without privileges (ports > 1024)
    const localProxyReady = fs.existsSync(xrayBin);

    let hasNetAdminCap = false;
    let hasScopedSudo = false;

    // POSIX-only privilege checks (getcap / sudoers do not exist on Windows)
    if (!isWin) {
      // Check capabilities
      try {
        const getcapOut = execSync(`getcap "${xrayBin}" 2>/dev/null`, { encoding: 'utf-8' });
        if (getcapOut.includes('cap_net_admin')) {
          hasNetAdminCap = true;
        }
      } catch {
        // ignore
      }

      // Check sudoers
      try {
        if (fs.existsSync('/etc/sudoers.d/opencode-vpn')) {
          hasScopedSudo = true;
        }
      } catch {
        // ignore
      }
    }

    let summary = 'Local SOCKS5/HTTP Proxy Mode is 100% active and unprivileged (Zero Root Required).';
    if (hasNetAdminCap || hasScopedSudo) {
      summary = 'Passwordless execution & network capabilities are fully configured.';
    }

    return {
      localProxyReady,
      hasNetAdminCap,
      hasScopedSudo,
      summary,
      setupScriptPath
    };
  }
}
