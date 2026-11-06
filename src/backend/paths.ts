import fs from 'fs';
import path from 'path';

/**
 * Single source of truth for project paths.
 *
 * The original code used `path.resolve(__dirname, '../../../')`, which only
 * works when the file runs from `src/backend/**` (via tsx). Once the server is
 * compiled to `dist/backend/**` that expression resolves one level too high, so
 * every path is derived from a root discovered by walking up to package.json.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : findProjectRoot(__dirname);

export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
export const FRONTEND_DIST = path.join(PROJECT_ROOT, 'src', 'frontend', 'dist');
export const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
