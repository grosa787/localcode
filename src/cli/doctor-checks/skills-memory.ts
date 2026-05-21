/**
 * Check #9 — Skills + memory.
 *
 * - Counts `.md` files under `~/.localcode/skills/`.
 * - Reports last modified timestamp of the most recent skill (so users
 *   notice when their skills haven't been updated in months).
 * - Same treatment for `~/.localcode/memory.jsonl` if present.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { DoctorCheckEnv, DoctorCheckResult } from './types';

function formatRelativeTime(ts: number, now: number): string {
  const deltaSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export async function checkSkillsMemory(
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  const home = env.homedir ?? homedir;
  const skillsDir = path.join(home(), '.localcode', 'skills');
  const memoryFile = path.join(home(), '.localcode', 'memory.jsonl');

  let skillCount = 0;
  let lastSkillMtime = 0;
  if (existsSync(skillsDir)) {
    try {
      const entries = readdirSync(skillsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        skillCount += 1;
        try {
          const st = statSync(path.join(skillsDir, entry));
          const mtime = st.mtimeMs;
          if (mtime > lastSkillMtime) lastSkillMtime = mtime;
        } catch {
          /* swallow per-file errors */
        }
      }
    } catch {
      // Unreadable dir — fall through with skillCount = 0.
    }
  }

  let memoryMtime = 0;
  let memoryBytes = 0;
  if (existsSync(memoryFile)) {
    try {
      const st = statSync(memoryFile);
      memoryMtime = st.mtimeMs;
      memoryBytes = st.size;
    } catch {
      /* swallow */
    }
  }

  const durationMs = Date.now() - startedAt;
  const now = Date.now();
  const parts: string[] = [];
  parts.push(`${skillCount} skill${skillCount === 1 ? '' : 's'}`);
  if (skillCount > 0 && lastSkillMtime > 0) {
    parts.push(`updated ${formatRelativeTime(lastSkillMtime, now)}`);
  }
  if (memoryBytes > 0) {
    const kb = Math.max(1, Math.round(memoryBytes / 1024));
    parts.push(`memory ${kb} KB (${formatRelativeTime(memoryMtime, now)})`);
  }
  // Skills + memory presence is never a hard failure — both are
  // entirely optional features.
  return {
    name: 'Skills + memory',
    status: 'ok',
    message: parts.join(', '),
    durationMs,
  };
}
