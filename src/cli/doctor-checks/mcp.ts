/**
 * Check #11 — MCP servers configured + structural validity.
 *
 * Reports the count and any obvious config-level issues (missing
 * `command` for stdio, missing `url` for http). We deliberately do
 * NOT spawn the servers here — that would take seconds per entry and
 * `doctor` is meant to be fast.
 */

import type { Config } from '@/config/types';
import type { DoctorCheckResult } from './types';

export async function checkMcp(
  config: Config | null,
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  if (config === null) {
    return {
      name: 'MCP servers',
      status: 'warn',
      message: 'Skipped — no parsed config.',
      durationMs: Date.now() - startedAt,
    };
  }
  const servers = config.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    return {
      name: 'MCP servers',
      status: 'ok',
      message: 'No MCP servers configured.',
      durationMs: Date.now() - startedAt,
    };
  }
  const issues: string[] = [];
  for (const name of names) {
    const s = servers[name];
    if (s === undefined) continue;
    if (s.type === 'stdio' && (s.command === undefined || s.command.length === 0)) {
      issues.push(`${name}: stdio entry missing command`);
    }
    if (s.type === 'http' && (s.url === undefined || s.url.length === 0)) {
      issues.push(`${name}: http entry missing url`);
    }
  }
  const durationMs = Date.now() - startedAt;
  if (issues.length === 0) {
    return {
      name: 'MCP servers',
      status: 'ok',
      message: `${names.length} configured: ${names.join(', ')}.`,
      durationMs,
    };
  }
  return {
    name: 'MCP servers',
    status: 'warn',
    message: `${names.length} configured, ${issues.length} issue${issues.length === 1 ? '' : 's'}.`,
    durationMs,
    detail: issues.join('; '),
  };
}
