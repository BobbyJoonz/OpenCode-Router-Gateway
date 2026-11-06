import fs from 'fs';
import path from 'path';

/**
 * Ensure a directory exists and has restricted user-only permissions (0700).
 */
export function ensureSecureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch (err: any) {
    // Non-fatal if filesystem does not support chmod (e.g. some virtual mounts)
  }
}

/**
 * Safely write sensitive configuration or credential data to disk.
 *
 * Guarantees:
 * 1. Checks for symbolic links via lstat and refuses to write if the path is a symlink.
 * 2. Opens using O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW to prevent TOCTOU symlink races.
 * 3. Enforces user-only read/write permissions (0600) via fchmod, correcting any pre-existing permissive modes.
 * 4. Ensures the parent directory has restrictive permissions (0700).
 */
export function safeWriteSensitiveFile(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  ensureSecureDirectory(dir);

  // 1. Inspect existing path safely to reject symbolic links
  try {
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink()) {
      throw new Error(`[SECURITY ERROR] Refusing to write through symbolic link: ${filePath}`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  // 2. Open file with safe flags: O_NOFOLLOW prevents kernel from following symlinks
  const oNoFollow = fs.constants.O_NOFOLLOW !== undefined ? fs.constants.O_NOFOLLOW : 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | oNoFollow;

  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    // Write content
    fs.writeSync(fd, data, 0, 'utf-8');

    // 3. Explicitly fchmod to 0600 to correct existing files (POSIX open doesn't chmod existing files)
    //    Non-fatal on platforms/filesystems without POSIX permission bits (e.g. Windows NTFS).
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // ignore
    }
  } finally {
    fs.closeSync(fd);
  }
}
