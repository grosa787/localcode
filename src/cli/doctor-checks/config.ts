/**
 * Check #3 — `~/.localcode/config.toml` exists and Zod-parses.
 *
 * Uses `ConfigManager` directly so the same parse path the running app
 * exercises is the one the doctor verifies.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import {
  ConfigManager,
  ConfigReadError,
  ConfigValidationError,
} from '@/config/config-manager';
import type { Config } from '@/config/types';
import type { DoctorCheckEnv, DoctorCheckResult } from './types';

export interface ConfigCheckResult extends DoctorCheckResult {
  /** Parsed config (when status is ok). Used by downstream checks. */
  readonly config: Config | null;
  /** Resolved path of the config file (regardless of success). */
  readonly configPath: string;
}

export async function checkConfig(
  env: DoctorCheckEnv = {},
): Promise<ConfigCheckResult> {
  const startedAt = Date.now();
  const home = env.homedir ?? homedir;
  const configPath = path.join(home(), '.localcode', 'config.toml');

  if (!existsSync(configPath)) {
    return {
      name: 'Config',
      status: 'fail',
      message: `Missing ${configPath}. Run \`localcode\` to onboard.`,
      durationMs: Date.now() - startedAt,
      config: null,
      configPath,
    };
  }

  const manager = new ConfigManager(configPath);
  try {
    const cfg = manager.read();
    return {
      name: 'Config',
      status: 'ok',
      message: `Parsed ${configPath}`,
      durationMs: Date.now() - startedAt,
      config: cfg,
      configPath,
    };
  } catch (cause) {
    const message =
      cause instanceof ConfigValidationError
        ? `Config validation failed: ${cause.message}`
        : cause instanceof ConfigReadError
          ? `Config read failed: ${cause.message}`
          : `Config error: ${cause instanceof Error ? cause.message : String(cause)}`;
    return {
      name: 'Config',
      status: 'fail',
      message,
      durationMs: Date.now() - startedAt,
      config: null,
      configPath,
    };
  }
}
