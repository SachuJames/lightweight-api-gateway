import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

/**
 * Load a `.env` file from the closest directory at or above this module that
 * contains one (so both repo-root and per-package `.env` files work no matter
 * which directory a script is launched from). Existing environment variables
 * always win over file values. Skipped in test mode so tests stay hermetic
 * and are not affected by a developer's local `.env`.
 */
export function loadEnvFile(): void {
  if (process.env['NODE_ENV'] === 'test') return;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
