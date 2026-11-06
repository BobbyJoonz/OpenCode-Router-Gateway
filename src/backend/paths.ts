import path from 'path';

/**
 * Central path resolution.
 *
 * `DATA_DIR` lets operators (and tests) relocate runtime state — SQLite, probe
 * configs, the active xray config — without touching the source tree.
 */
export function dataDir(): string {
  if (process.env.DATA_DIR && process.env.DATA_DIR.trim().length > 0) {
    return path.resolve(process.env.DATA_DIR.trim());
  }
  return path.resolve(__dirname, '../../data');
}

export function projectRoot(): string {
  return path.resolve(__dirname, '../..');
}

export function binDir(): string {
  return path.join(projectRoot(), 'bin');
}
