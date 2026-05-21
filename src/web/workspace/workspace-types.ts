/**
 * Workspace types — multi-project storage backed by
 * `~/.localcode/workspaces.json`.
 *
 * The `WorkspaceRecord` shape is the on-disk + wire shape; it mirrors
 * `WorkspaceRecord` from `@/web/protocol/rest-types` but lives here so
 * the registry can stand alone (no protocol-layer cycle).
 */

import { z } from 'zod';

export interface WorkspaceRecord {
  /** uuid v4. */
  id: string;
  /** Absolute, normalized filesystem path. */
  root: string;
  /** Display label — defaults to the basename of `root`. */
  label: string;
  /** Epoch ms — touched whenever the workspace is opened. */
  lastUsedAt: number;
}

export const WorkspaceRecordSchema: z.ZodType<WorkspaceRecord> = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  label: z.string(),
  lastUsedAt: z.number().int().nonnegative(),
});

export interface WorkspacesFile {
  version: 1;
  workspaces: WorkspaceRecord[];
}

export const WorkspacesFileSchema: z.ZodType<WorkspacesFile> = z.object({
  version: z.literal(1),
  workspaces: z.array(WorkspaceRecordSchema),
});

/** Path relative to `os.homedir()`. */
export const WORKSPACES_FILE_PATH = '.localcode/workspaces.json';
