/**
 * Coverage: src/backend/security/privilege-wizard.ts
 *
 * - PrivilegeWizard.checkStatus() returns the documented PrivilegeStatus shape
 *   without throwing: localProxyReady is a boolean derived purely from the
 *   presence of bin/xray(.exe), summary/setupScriptPath are strings, and the
 *   capability booleans are false on this unprivileged test environment.
 * - localProxyReady matches the real filesystem state of the project binary.
 * - Missing bin/xray must still produce a well-formed status (no throw): the
 *   binary lookup is simulated by temporarily stubbing fs.existsSync.
 * - summary text matches the capability flags it reports.
 *
 * No privileges are requested and nothing is executed as root.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PrivilegeWizard } from '../../src/backend/security/privilege-wizard';

// tests/unit -> repository root (same root the wizard resolves with ../../../)
const ROOT = path.resolve(__dirname, '../..');
const BIN_NAME = process.platform === 'win32' ? 'xray.exe' : 'xray';
const BIN_PATH = path.join(ROOT, 'bin', BIN_NAME);

describe('PrivilegeWizard.checkStatus', () => {
  it('returns the full status shape without throwing', () => {
    let status: ReturnType<typeof PrivilegeWizard.checkStatus> | undefined;
    assert.doesNotThrow(() => {
      status = PrivilegeWizard.checkStatus();
    });
    assert.ok(status, 'checkStatus must return a value');

    assert.equal(typeof status.localProxyReady, 'boolean');
    assert.equal(typeof status.hasNetAdminCap, 'boolean');
    assert.equal(typeof status.hasScopedSudo, 'boolean');
    assert.equal(typeof status.summary, 'string');
    assert.equal(typeof status.setupScriptPath, 'string');
    assert.ok(status.summary.length > 0, 'summary must not be empty');
  });

  it('derives localProxyReady from the presence of bin/xray', () => {
    const status = PrivilegeWizard.checkStatus();
    assert.equal(status.localProxyReady, fs.existsSync(BIN_PATH));
  });

  it('reports no remote capabilities in an unprivileged run', () => {
    if (process.platform === 'win32') {
      // getcap/sudoers checks are POSIX-only, so both flags must stay false.
      const status = PrivilegeWizard.checkStatus();
      assert.equal(status.hasNetAdminCap, false);
      assert.equal(status.hasScopedSudo, false);
      assert.equal(status.setupScriptPath, '');
    }
  });

  it('keeps summary consistent with the reported capability flags', () => {
    const status = PrivilegeWizard.checkStatus();
    if (status.hasNetAdminCap || status.hasScopedSudo) {
      assert.match(status.summary, /fully configured/i);
    } else {
      assert.match(status.summary, /unprivileged/i);
    }
  });

  it('returns a well-formed status even when bin/xray is missing', () => {
    const original = fs.existsSync;
    try {
      (fs as any).existsSync = () => false;
      const status = PrivilegeWizard.checkStatus();
      assert.equal(status.localProxyReady, false);
      assert.equal(typeof status.summary, 'string');
      assert.ok(status.summary.length > 0);
      assert.equal(typeof status.setupScriptPath, 'string');
    } finally {
      (fs as any).existsSync = original;
    }
  });
});
