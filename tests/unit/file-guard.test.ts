/**
 * Coverage: src/backend/security/file-guard.ts
 *
 * - ensureSecureDirectory: creates missing directories (recursively), is a
 *   no-op when the directory already exists, and never throws on filesystems
 *   that reject chmod.
 * - safeWriteSensitiveFile: writes the exact contents, creates the parent
 *   directory tree, truncates an existing file on overwrite, enforces 0600 on
 *   POSIX, and refuses to write through a symbolic link while leaving the link
 *   target untouched. The symlink sub-assertion is skipped on Windows hosts
 *   that reject symlink creation with EPERM/EACCES.
 *
 * Everything happens under os.tmpdir(); the temp tree is removed afterwards.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ensureSecureDirectory, safeWriteSensitiveFile } from '../../src/backend/security/file-guard';

const TMP = path.join(os.tmpdir(), `orgw-file-guard-${process.pid}-${Date.now()}`);

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('ensureSecureDirectory', () => {
  it('creates a missing nested directory', () => {
    const dir = path.join(TMP, 'create', 'nested', 'deep');
    assert.equal(fs.existsSync(dir), false);
    ensureSecureDirectory(dir);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });

  it('is idempotent when the directory already exists', () => {
    const dir = path.join(TMP, 'existing');
    fs.mkdirSync(dir, { recursive: true });
    assert.doesNotThrow(() => ensureSecureDirectory(dir));
    assert.doesNotThrow(() => ensureSecureDirectory(dir));
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });
});

describe('safeWriteSensitiveFile', () => {
  it('writes the exact content to a new file', () => {
    const file = path.join(TMP, 'write', 'secret.txt');
    safeWriteSensitiveFile(file, 'api_key=unit-test\n');
    assert.equal(fs.readFileSync(file, 'utf-8'), 'api_key=unit-test\n');
    assert.equal(fs.statSync(file).isFile(), true);
  });

  it('creates the parent directory tree when missing', () => {
    const file = path.join(TMP, 'auto', 'created', 'nested', 'credentials.json');
    assert.equal(fs.existsSync(path.dirname(file)), false);
    safeWriteSensitiveFile(file, '{"token":"x"}');
    assert.equal(fs.existsSync(path.dirname(file)), true);
    assert.equal(fs.readFileSync(file, 'utf-8'), '{"token":"x"}');
  });

  it('overwrites (truncates) an existing file', () => {
    const file = path.join(TMP, 'overwrite.txt');
    safeWriteSensitiveFile(file, 'a much longer first version of the content');
    safeWriteSensitiveFile(file, 'short');
    assert.equal(fs.readFileSync(file, 'utf-8'), 'short');
  });

  it('restricts POSIX permissions to 0600', () => {
    if (process.platform === 'win32') {
      // NTFS does not expose POSIX mode bits; the implementation ignores fchmod
      // failures there, so there is nothing portable to assert.
      return;
    }
    const file = path.join(TMP, 'mode', 'secret.txt');
    safeWriteSensitiveFile(file, 'x');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('refuses to write through a symbolic link and keeps the target intact', (t) => {
    const target = path.join(TMP, 'symlink-target.txt');
    const link = path.join(TMP, 'symlink-link.txt');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(target, 'original-target-content');

    try {
      fs.symlinkSync(target, link, 'file');
    } catch (err: any) {
      const code = err?.code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN')) {
        t.skip(`symlink creation not permitted on this host (${code})`);
        return;
      }
      throw err;
    }

    assert.throws(
      () => safeWriteSensitiveFile(link, 'attacker-controlled'),
      /symbolic link/i,
      'writing through a symlink must be refused'
    );
    assert.equal(fs.readFileSync(target, 'utf-8'), 'original-target-content');
  });
});
