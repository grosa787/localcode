/**
 * Composer — sticky-bottom input bar with rich-text + multimodal input.
 *
 * Spec:
 *   - Auto-grow textarea 1→6 lines, padding 12px 16px, radius 20px
 *     (pill until first newline, then rounded-12).
 *   - Below textarea (36px row): ProviderChip · ModelChip · Slash · Paperclip · Send.
 *   - Backend label between chips: tiny 11px --text-faint.
 *   - Cmd/Ctrl+Enter sends. Shift+Enter inserts newline.
 *   - Disabled state during streaming.
 *   - When the draft matches `/^/[A-Za-z0-9_-]*$/`, an inline
 *     <SlashAutocomplete> popup appears above the textarea. ↑/↓ navigate,
 *     Tab/Enter inserts, Escape closes (without clearing the input).
 *   - Submitting `/<knownCommand>` is intercepted: it never goes to the
 *     LLM. If `onSlashSubmit` is provided, it gets called; otherwise we
 *     surface a toast and open the SlashCommandsOverlay.
 *
 * Multimodal extensions:
 *   - Paperclip → opens a hidden <input type="file"> for image attach.
 *   - Paste image / drag-and-drop image → adds to local `attachedImages`.
 *   - Visible thumbnail row above the input with remove buttons.
 *   - Drop-zone overlay while dragging files onto the composer.
 *   - `@<query>` triggers FileMentionAutocomplete (file tree → REST).
 *   - Markdown keyboard shortcuts: Cmd/Ctrl+B / I / K / E.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';

import type {
  SetProviderRequest,
  SetProviderResponse,
} from '../../../src/web/protocol/rest-types.js';
import { useApiClients } from '../App';
import { useT } from '../i18n';
import { Loader2, Paperclip, Plus, Send, Slash, Square } from '../icons';
import { useStore, type CommandSummary } from '../state/store';
// RESPONSIVE-SECTION
import { useViewport } from '../util/use-viewport';
// /RESPONSIVE-SECTION
import {
  classifyDroppedFile,
  MAX_INLINE_TEXT_BYTES,
  readBlobAsText,
  readFilePath,
  relativeToProject,
} from '../util/file-attachment';
// SLASH-EXEC-SECTION
import {
  executeSlashCommand,
  KNOWN_EXEC_COMMANDS,
  type SlashExecCtx,
} from '../util/slash-executor';
import type { WireChatMessage } from '../../../src/web/protocol/messages.js';
// /SLASH-EXEC-SECTION

import { DropOverlay } from './DropOverlay';
import {
  FileMentionAutocomplete,
  type FileMentionEntry,
} from './FileMentionAutocomplete';
import {
  ImageAttachmentPreview,
  type ComposerImageAttachment,
} from './ImageAttachmentPreview';
import { ModelChip } from './ModelChip';
import { PlusMenu } from './PlusMenu';
import { ProviderChip } from './ProviderChip';
import { ProfileChip } from './ProfileChip';
import { SlashAutocomplete } from './SlashAutocomplete';
import { StyleChip } from './StyleChip';
import { VoiceInputButton } from './VoiceInputButton';

import styles from './Composer.module.css';

/** Public shape of the typed-out submission. */
export interface ComposerSubmission {
  text: string;
  /** Empty unless the user attached images this turn. */
  images: ComposerImageAttachment[];
}

export interface ComposerProps {
  /** True while a stream is in progress; Send is replaced with Cancel. */
  streaming: boolean;
  /** True while waiting for the server to acknowledge a `send_message`. */
  sending: boolean;
  /** True when no session is active — input is disabled. */
  disabled: boolean;
  /**
   * Send the current draft. The legacy signature accepted `(text)` only;
   * the new shape additionally surfaces image attachments via an optional
   * second argument so a future wire upgrade can opt into multimodal.
   *
   * For now the wire `send_message` payload only carries text, so the
   * parent (ChatView) sees `(text)` and ignores the attachments arg.
   * The Composer keeps the images in local state until that arg is
   * consumed by an upgraded parent.
   */
  onSend: (
    text: string,
    extras?: { images: ComposerImageAttachment[] },
  ) => void | Promise<void>;
  /**
   * Queue the current draft for auto-send after the in-flight turn
   * finishes. Called instead of `onSend` whenever `streaming === true`
   * and the input is plain text (slash commands take their own path).
   */
  onQueue: (text: string) => void;
  /** Cancel the in-flight stream. */
  onCancel?: () => void;
  /** Backend display label (e.g. "openai @ api.openai.com"). */
  backendLabel?: string | null;
  /** Switch provider (delegated to RestClient by the parent). */
  onSwitchProvider: (req: SetProviderRequest) => Promise<SetProviderResponse>;
  /** Switch model — typically `restClient.setModel({ model })`. */
  onSwitchModel?: (model: string) => void | Promise<void>;
  /**
   * Optional handler invoked when the user submits `/<knownCommand> [args]`.
   * If absent, the Composer falls back to opening the slash-commands
   * overlay and emitting a toast — it must NOT silently forward the
   * raw text to the LLM via `onSend`.
   */
  onSlashSubmit?: (name: string, args: string) => void;
  // AGENT-REPLY-SECTION
  /**
   * Agent reply-mode hook. When `target` is non-null the Composer
   * renders a small banner above the textarea ("→ Replying to: <label>"
   * with an × exit button) and Enter routes the typed text via
   * `onAgentReply(text)` INSTEAD of the regular `onSend`. Slash and
   * attachments still take their normal paths — reply-mode never
   * silently swallows a slash command.
   */
  agentReply?: {
    target: { agentId: string; label: string; parentSessionId: string };
    onAgentReply: (text: string) => void | Promise<void>;
    onExitReply: () => void;
  } | null;
  // /AGENT-REPLY-SECTION
}

const MAX_LINES = 10;
const SLASH_QUERY_RE = /^\/([A-Za-z0-9_-]*)$/;
const MENTION_TOKEN_RE = /@([A-Za-z0-9_/.\-]*)$/;
const MAX_ATTACHED_IMAGES = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MENTION_DEBOUNCE_MS = 100;
const MENTION_MAX_RESULTS = 30;
const MENTION_TREE_DEPTH = 2;

function makeAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `att-${Math.random().toString(36).slice(2)}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected reader result'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = (): void => reject(reader.error ?? new Error('Read failed'));
    reader.readAsDataURL(blob);
  });
}

function probeImageDimensions(
  url: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = (): void => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = (): void => resolve(null);
    img.src = url;
  });
}

export function Composer(props: ComposerProps): JSX.Element {
  const t = useT();
  const clients = useApiClients();
  // RESPONSIVE-SECTION
  // Mobile breakpoint folds the chip cluster into a single overflow
  // menu so the tool row doesn't wrap below the textarea. Send +
  // paperclip + send-status stay primary; everything else routes
  // through the overflow popover.
  const viewport = useViewport();
  const isMobile = viewport.breakpoint === 'mobile';
  const [chipOverflowOpen, setChipOverflowOpen] = useState(false);
  // /RESPONSIVE-SECTION
  const [draft, setDraft] = useState('');
  const [acIndex, setAcIndex] = useState(0);
  const [attachedImages, setAttachedImages] = useState<ComposerImageAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionEntries, setMentionEntries] = useState<FileMentionEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const slashCommands = useStore((s) => s.slashCommands);
  const openSlashCommands = useStore((s) => s.openSlashCommands);
  const composerDraft = useStore((s) => s.composerDraft);
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const pushToast = useStore((s) => s.pushToast);
  const plusMenuOpen = useStore((s) => s.plusMenuOpen);
  const openPlusMenu = useStore((s) => s.openPlusMenu);
  const closePlusMenu = useStore((s) => s.closePlusMenu);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  // SLASH-EXEC-SECTION — extra store slices the executor needs.
  const openOverlay = useStore((s) => s.openOverlay);
  const openWhiteboard = useStore((s) => s.openWhiteboard);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const clearSessionMessages = useStore((s) => s.clearSessionMessages);
  const appendSessionMessage = useStore((s) => s.appendSessionMessage);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeBackend = useStore((s) => s.activeBackend);
  const currentModel = useStore((s) => s.currentModel);
  // /SLASH-EXEC-SECTION
  const activeProjectRoot = useMemo<string | null>(() => {
    if (activeProjectId === null) return null;
    const proj = projects.find((p) => p.id === activeProjectId);
    return proj === undefined ? null : proj.root;
  }, [activeProjectId, projects]);

  // External drafts (e.g. from the SlashCommandsOverlay): seed once,
  // then clear the store slot so the effect doesn't fire repeatedly.
  useEffect(() => {
    if (composerDraft.length > 0) {
      setDraft(composerDraft);
      setComposerDraft('');
      // Move caret to end after the textarea has rendered.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el !== null) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    }
  }, [composerDraft, setComposerDraft]);

  // Revoke object URLs on unmount and whenever an attachment is removed.
  useEffect(() => {
    return () => {
      for (const att of attachedImages) {
        if (att.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WHITEBOARD-SECTION — consume the whiteboard's pending export.
  // When the Whiteboard panel publishes a PNG into the shared store
  // slot, we treat it like any other attached image (data: URL preview
  // so we don't need to manage an object-URL lifecycle).
  const whiteboardPendingImage = useStore((s) => s.whiteboardPendingImage);
  const setWhiteboardPendingImage = useStore(
    (s) => s.setWhiteboardPendingImage,
  );
  useEffect(() => {
    if (whiteboardPendingImage === null) return;
    const att: ComposerImageAttachment = {
      id: makeAttachmentId(),
      mimeType: whiteboardPendingImage.mimeType,
      base64: whiteboardPendingImage.base64,
      sizeBytes: whiteboardPendingImage.sizeBytes,
      previewUrl: `data:${whiteboardPendingImage.mimeType};base64,${whiteboardPendingImage.base64}`,
      name: whiteboardPendingImage.name,
      width: whiteboardPendingImage.width,
      height: whiteboardPendingImage.height,
    };
    setAttachedImages((cur) => {
      // Respect the same MAX_ATTACHED_IMAGES cap as user-pasted images;
      // silently drop on overflow because the toast already fired in the
      // Whiteboard.
      if (cur.length >= MAX_ATTACHED_IMAGES) return cur;
      return [...cur, att];
    });
    // Clear the slot so the same export isn't re-injected on next
    // render — and so a second "Send to chat" click works.
    setWhiteboardPendingImage(null);
    // Focus the composer textarea so the user can immediately type
    // the question that goes alongside the drawing.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [whiteboardPendingImage, setWhiteboardPendingImage]);
  // /WHITEBOARD-SECTION

  const hasNewline = draft.includes('\n');
  const trimmed = draft.trim();
  // While `streaming` is true the user can still type to queue the
  // next message. `sending` (the brief WS ack window) and `disabled`
  // (no active session) still block submission.
  const canSend =
    !props.disabled &&
    !props.sending &&
    (trimmed.length > 0 || attachedImages.length > 0);

  // Slash-autocomplete query detection: only when the entire draft is
  // a single-line `/foo` token (no newline, no space).
  const slashMatch = useMemo(() => {
    if (hasNewline) return null;
    const m = SLASH_QUERY_RE.exec(draft);
    if (m === null) return null;
    return { query: m[1] ?? '' };
  }, [draft, hasNewline]);

  const filteredCommands = useMemo<CommandSummary[]>(() => {
    if (slashMatch === null) return [];
    const q = slashMatch.query.toLowerCase();
    const sorted = [...slashCommands].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (q.length === 0) return sorted;
    return sorted.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [slashMatch, slashCommands]);

  const acOpen = slashMatch !== null;

  // ---- @-mention detection ----

  /** Find the active `@token` immediately before the caret, if any. */
  const computeMentionToken = useCallback(
    (value: string, caret: number): { start: number; query: string } | null => {
      if (slashMatch !== null) return null;
      const prefix = value.slice(0, caret);
      const m = MENTION_TOKEN_RE.exec(prefix);
      if (m === null) return null;
      // Reject when `@` follows a word char (likely an email pattern).
      const at = prefix.lastIndexOf('@');
      if (at > 0) {
        const before = prefix.charAt(at - 1);
        if (/[A-Za-z0-9_]/.test(before)) return null;
      }
      return { start: at, query: m[1] ?? '' };
    },
    [slashMatch],
  );

  const [mentionToken, setMentionToken] = useState<{
    start: number;
    query: string;
  } | null>(null);

  const mentionOpen = mentionToken !== null;

  // Re-evaluate the mention token on every draft change.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) {
      setMentionToken(null);
      return;
    }
    const caret = el.selectionStart ?? draft.length;
    const next = computeMentionToken(draft, caret);
    setMentionToken(next);
  }, [draft, computeMentionToken]);

  // Keep the mention highlighted index in range.
  useEffect(() => {
    if (!mentionOpen) {
      setMentionIndex(0);
      return;
    }
    setMentionIndex((cur) => {
      if (mentionEntries.length === 0) return 0;
      if (cur >= mentionEntries.length) return 0;
      return cur;
    });
  }, [mentionOpen, mentionEntries.length]);

  // Debounced fetch of file tree → flatten + filter for the popup.
  useEffect(() => {
    if (!mentionOpen || activeProjectId === null) {
      setMentionEntries([]);
      setMentionLoading(false);
      return;
    }
    let cancelled = false;
    setMentionLoading(true);
    const q = (mentionToken?.query ?? '').toLowerCase();
    const handle = window.setTimeout(async () => {
      try {
        // Recursively walk a small depth so mid-sized projects surface
        // the common files without a full-tree fetch. Showing hidden
        // files is intentionally false — users rarely @-mention dotfiles.
        const res = await clients.rest.fileTree({
          projectId: activeProjectId,
          subpath: '',
          depth: 1,
          showHidden: false,
        });
        if (cancelled) return;
        // Flatten the top-level listing. Child dirs are surfaced as
        // entries; the user can refine via the trailing slash.
        const flat: FileMentionEntry[] = [];
        const stack: { path: string; depth: number }[] = [];
        for (const entry of res.entries) {
          flat.push({
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
          });
          if (entry.kind === 'dir') {
            stack.push({ path: entry.path, depth: 1 });
          }
        }
        // Walk shallow children for one more level so common files
        // (src/foo.ts) appear without manual expansion.
        const childFetches = stack
          .slice(0, 12)
          .map(async ({ path, depth }) => {
            if (depth >= MENTION_TREE_DEPTH) return [] as FileMentionEntry[];
            try {
              const child = await clients.rest.fileTree({
                projectId: activeProjectId,
                subpath: path,
                depth: 1,
                showHidden: false,
              });
              return child.entries.map<FileMentionEntry>((e) => ({
                path: e.path,
                name: e.name,
                kind: e.kind,
              }));
            } catch {
              return [] as FileMentionEntry[];
            }
          });
        const more = await Promise.all(childFetches);
        if (cancelled) return;
        for (const arr of more) flat.push(...arr);
        const filtered = (
          q.length === 0
            ? flat
            : flat.filter((e) => e.path.toLowerCase().includes(q))
        ).slice(0, MENTION_MAX_RESULTS);
        // Files first within otherwise-stable order.
        filtered.sort((a, b) => {
          if (a.kind === b.kind) return a.path.localeCompare(b.path);
          return a.kind === 'file' ? -1 : 1;
        });
        setMentionEntries(filtered);
      } catch {
        if (!cancelled) setMentionEntries([]);
      } finally {
        if (!cancelled) setMentionLoading(false);
      }
    }, MENTION_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [mentionOpen, mentionToken, activeProjectId, clients.rest]);

  // Keep the slash highlighted index in range as the filter changes.
  useEffect(() => {
    if (!acOpen) {
      setAcIndex(0);
      return;
    }
    setAcIndex((cur) => {
      if (filteredCommands.length === 0) return 0;
      if (cur >= filteredCommands.length) return 0;
      return cur;
    });
  }, [acOpen, filteredCommands.length]);

  // Auto-grow up to MAX_LINES, then scroll internally. Cached after first
  // measurement; re-derived only if the cached value was the `normal`
  // keyword fallback (rare; safe to recompute once styles settle).
  const lineHeightRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const cs = window.getComputedStyle(el);
    let lineHeight = lineHeightRef.current;
    if (lineHeight === null) {
      const parsed = parseFloat(cs.lineHeight);
      if (Number.isFinite(parsed) && parsed > 0) {
        lineHeight = parsed;
      } else {
        // `normal` keyword — fall back to fontSize * 1.4.
        const fs = parseFloat(cs.fontSize);
        lineHeight = (Number.isFinite(fs) && fs > 0 ? fs : 16) * 1.4;
      }
      lineHeightRef.current = lineHeight;
    }
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const cap = lineHeight * MAX_LINES + padTop + padBot;
    el.style.height = `${Math.min(cap, el.scrollHeight)}px`;
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
  }, [draft]);

  // Focus the composer on mount whenever it becomes enabled.
  useEffect(() => {
    if (!props.disabled) {
      textareaRef.current?.focus();
    }
  }, [props.disabled]);

  const knownCommandNames = useMemo<Set<string>>(
    () => new Set(slashCommands.map((c) => c.name)),
    [slashCommands],
  );

  /** Parse `/name args…` if present; null otherwise. */
  const parseSlashSubmission = useCallback(
    (text: string): { name: string; args: string } | null => {
      if (!text.startsWith('/')) return null;
      const firstSpace = text.indexOf(' ');
      const name = firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace);
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
      if (!knownCommandNames.has(name)) return null;
      const args = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();
      return { name, args };
    },
    [knownCommandNames],
  );

  // ---- Image attachment helpers ----

  const removeAttachment = useCallback((id: string) => {
    setAttachedImages((prev) => {
      const next = prev.filter((a) => {
        if (a.id !== id) return true;
        if (a.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(a.previewUrl);
        }
        return false;
      });
      return next;
    });
  }, []);

  const addImageBlob = useCallback(
    async (blob: Blob, name?: string): Promise<void> => {
      if (!blob.type.startsWith('image/')) {
        pushToast({
          level: 'warning',
          message: t('composer.attach.notImage'),
        });
        return;
      }
      if (blob.size > MAX_IMAGE_BYTES) {
        pushToast({
          level: 'warning',
          message: t('composer.attach.tooLarge'),
        });
        return;
      }
      let overflowed = false;
      setAttachedImages((cur) => {
        if (cur.length >= MAX_ATTACHED_IMAGES) {
          overflowed = true;
          return cur;
        }
        return cur;
      });
      if (overflowed) {
        pushToast({
          level: 'warning',
          message: t('composer.attach.tooManyImages'),
        });
        return;
      }
      try {
        const base64 = await blobToBase64(blob);
        const previewUrl = URL.createObjectURL(blob);
        const dims = await probeImageDimensions(previewUrl);
        const att: ComposerImageAttachment = {
          id: makeAttachmentId(),
          mimeType: blob.type,
          base64,
          sizeBytes: blob.size,
          previewUrl,
          ...(name !== undefined ? { name } : {}),
          ...(dims !== null
            ? { width: dims.width, height: dims.height }
            : {}),
        };
        setAttachedImages((prev) => {
          if (prev.length >= MAX_ATTACHED_IMAGES) {
            URL.revokeObjectURL(previewUrl);
            return prev;
          }
          return [...prev, att];
        });
      } catch {
        // ignore: best-effort attach
      }
    },
    [pushToast, t],
  );

  // ---- Submit ----

  const submit = useCallback(async () => {
    if (!canSend) return;
    const text = trimmed;

    // Intercept slash commands so they never reach the LLM.
    const slash = parseSlashSubmission(text);
    if (slash !== null) {
      setDraft('');
      // SLASH-EXEC-SECTION — proper execution layer.
      // 1. Pure-UI `/whiteboard` is still handled inline (no overlay).
      if (slash.name === 'whiteboard') {
        openWhiteboard();
        return;
      }
      // 2. Known executable commands → dispatch via the executor.
      if (KNOWN_EXEC_COMMANDS.has(slash.name)) {
        const fullLine = slash.args.length > 0
          ? `/${slash.name} ${slash.args}`
          : `/${slash.name}`;
        const ctx: SlashExecCtx = {
          rest: clients.rest,
          store: {
            openOverlay,
            openWhiteboard,
            setActiveSession,
            clearSessionMessages,
            pushToast,
          },
          sessionId: activeSessionId,
          projectId: activeProjectId,
          backend: activeBackend,
          model: currentModel,
          commands: slashCommands,
        };
        const result = await executeSlashCommand(fullLine, ctx);
        if (result.kind === 'inline-system-message' && result.text !== undefined) {
          // Inject as a synthetic system message into the active session
          // chat so the output sits in the scrollback.
          if (activeSessionId !== null) {
            const msg: WireChatMessage = {
              id: `slash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: 'system',
              content: result.text,
              createdAt: Date.now(),
            };
            appendSessionMessage(activeSessionId, msg);
          } else {
            pushToast({ level: 'info', message: result.text });
          }
        } else if (result.kind === 'config-changed' && result.text !== undefined) {
          pushToast({ level: 'success', message: result.text });
        } else if (result.kind === 'error' && result.text !== undefined) {
          pushToast({ level: 'error', message: result.text });
        }
        return;
      }
      // 3. Fallback for commands known to the registry but unmapped in
      //    the executor — call the parent handler if provided, otherwise
      //    surface a clear hint and open the slash-commands overlay.
      if (props.onSlashSubmit !== undefined) {
        props.onSlashSubmit(slash.name, slash.args);
      } else {
        pushToast({
          level: 'info',
          message: t('composer.commandUnwired', { name: slash.name }),
        });
        openSlashCommands();
      }
      // /SLASH-EXEC-SECTION
      return;
    }

    const images = attachedImages;
    setDraft('');
    setAttachedImages([]);
    // AGENT-REPLY-SECTION — when reply-mode is active, plain text is
    // forwarded directly to the worker via TeamBus (no LLM stream is
    // started on the lead session). Attachments are dropped — the
    // TeamBus envelope is text-only. We release any object-URLs first.
    if (props.agentReply !== undefined && props.agentReply !== null) {
      for (const att of images) {
        if (att.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl);
        }
      }
      try {
        await props.agentReply.onAgentReply(text);
      } catch {
        setDraft(text);
      }
      return;
    }
    // /AGENT-REPLY-SECTION
    // QUEUE-NEXT-SECTION — start
    // While a turn is streaming, plain text is queued instead of sent.
    // Attachments are dropped on queue because the queue API is text-only;
    // we keep the URLs alive only briefly. Slash commands (`/<name>`)
    // have already been handled above and never reach this branch — they
    // always execute immediately, even mid-stream.
    if (props.streaming) {
      for (const att of images) {
        if (att.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl);
        }
      }
      props.onQueue(text);
      return;
    }
    // QUEUE-NEXT-SECTION — end
    try {
      if (images.length > 0) {
        await props.onSend(text, { images });
      } else {
        await props.onSend(text);
      }
      // After hand-off, the parent has consumed the data. Object-URLs
      // are no longer needed here; let the GC clean them.
      for (const att of images) {
        if (att.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl);
        }
      }
    } catch {
      // Restore the draft so the user doesn't lose it.
      setDraft(text);
      setAttachedImages(images);
    }
  }, [
    canSend,
    trimmed,
    attachedImages,
    props,
    parseSlashSubmission,
    pushToast,
    openSlashCommands,
    t,
    // SLASH-EXEC-SECTION
    openOverlay,
    openWhiteboard,
    setActiveSession,
    clearSessionMessages,
    appendSessionMessage,
    activeSessionId,
    activeProjectId,
    activeBackend,
    currentModel,
    slashCommands,
    clients.rest,
    // /SLASH-EXEC-SECTION
  ]);

  /** Replace the current `/foo` token with the picked command + space. */
  const insertCommand = useCallback((name: string) => {
    setDraft(`/${name} `);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, []);

  /** Replace the active `@<token>` with the picked file path. */
  const insertMention = useCallback(
    (entry: FileMentionEntry) => {
      const tok = mentionToken;
      if (tok === null) return;
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? draft.length;
      // The token spans from `tok.start` (the `@`) up to caret. Replace
      // with `@<path>` + trailing space.
      const before = draft.slice(0, tok.start);
      const after = draft.slice(caret);
      const insertion = `@${entry.path} `;
      const nextValue = `${before}${insertion}${after}`;
      setDraft(nextValue);
      const nextCaret = before.length + insertion.length;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node !== null) {
          node.focus();
          node.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [draft, mentionToken],
  );

  const onPick = useCallback(
    (name: string) => {
      insertCommand(name);
    },
    [insertCommand],
  );

  // ---- Markdown keyboard shortcuts ----

  /**
   * Wrap the current selection in `prefix` + `suffix`. If the user has
   * no selection, the wrappers are inserted and the caret lands between
   * them so they can keep typing.
   */
  const wrapSelection = useCallback(
    (prefix: string, suffix: string) => {
      const el = textareaRef.current;
      if (el === null) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      const before = draft.slice(0, start);
      const sel = draft.slice(start, end);
      const after = draft.slice(end);
      const nextValue = `${before}${prefix}${sel}${suffix}${after}`;
      setDraft(nextValue);
      const caret =
        sel.length === 0
          ? before.length + prefix.length
          : before.length + prefix.length + sel.length + suffix.length;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node !== null) {
          node.focus();
          if (sel.length === 0) {
            node.setSelectionRange(caret, caret);
          } else {
            node.setSelectionRange(
              before.length + prefix.length,
              before.length + prefix.length + sel.length,
            );
          }
        }
      });
    },
    [draft],
  );

  const promptForLink = useCallback(() => {
    const el = textareaRef.current;
    if (el === null) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const sel = draft.slice(start, end);
    const url =
      typeof window === 'undefined'
        ? null
        : window.prompt(t('composer.shortcut.linkUrl'), 'https://');
    if (url === null || url.length === 0) return;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const linkText = sel.length === 0 ? url : sel;
    const insertion = `[${linkText}](${url})`;
    const nextValue = `${before}${insertion}${after}`;
    setDraft(nextValue);
    const caret = before.length + insertion.length;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node !== null) {
        node.focus();
        node.setSelectionRange(caret, caret);
      }
    });
  }, [draft, t]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Markdown shortcuts take priority — they should work even while the
    // slash / mention popups are open.
    const modKey = e.metaKey || e.ctrlKey;
    if (modKey && !e.altKey && !e.shiftKey) {
      const lower = e.key.toLowerCase();
      if (lower === 'b') {
        e.preventDefault();
        wrapSelection('**', '**');
        return;
      }
      if (lower === 'i') {
        e.preventDefault();
        wrapSelection('*', '*');
        return;
      }
      if (lower === 'e') {
        e.preventDefault();
        wrapSelection('`', '`');
        return;
      }
      if (lower === 'k') {
        e.preventDefault();
        promptForLink();
        return;
      }
    }

    if (mentionOpen && mentionEntries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionEntries.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionEntries.length) % mentionEntries.length,
        );
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const entry = mentionEntries[mentionIndex];
        if (entry !== undefined) {
          insertMention(entry);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionToken(null);
        return;
      }
    }

    if (acOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex(
          (i) => (i - 1 + filteredCommands.length) % filteredCommands.length,
        );
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const cmd = filteredCommands[acIndex];
        if (cmd !== undefined) {
          insertCommand(cmd.name);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Closing the autocomplete without clearing the input — the
        // popup is driven by `slashMatch`, so we append a sentinel
        // space to break the regex (and let the user keep typing).
        setDraft((d) => `${d} `);
        return;
      }
    }

    // ESC-CANCEL-SECTION — start
    // While streaming, Esc cancels the in-flight turn so the user can
    // start a new one immediately. The slash / mention popups consume
    // Escape ahead of this branch (returning early above), so we only
    // reach here when no popup owns the keystroke. After the parent's
    // `cancel_stream` ack the runtime flips streaming → false and is
    // immediately reusable (X5 disconnect-recovery invariant).
    if (e.key === 'Escape' && props.streaming) {
      e.preventDefault();
      if (props.onCancel !== undefined) props.onCancel();
      return;
    }
    // ESC-CANCEL-SECTION — end

    // SHIFT-ENTER-SECTION — start
    // Cmd/Ctrl+Enter or Enter (without shift) → send.
    // Shift+Enter falls through to the browser's native textarea
    // behaviour, which inserts a literal newline at the caret. We
    // explicitly DO NOT preventDefault() here so the modifier is
    // honoured; testing `!e.shiftKey` is what gates the submit.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
    // SHIFT-ENTER-SECTION — end
  };

  const onCancelClick = (): void => {
    if (props.onCancel !== undefined) props.onCancel();
  };

  // ---- Clipboard paste ----

  // AUTO-IMAGE-PROMOTE-SECTION — detect bare image paths in pasted
  // text. The browser sandbox can't read arbitrary filesystem paths,
  // so we can't auto-attach the way the TUI does. Instead we surface a
  // toast directing the user to drop the file or use the paperclip,
  // and suppress inserting the raw path into the textarea (which the
  // model would otherwise see as plain text). When the paste contains
  // EITHER a path-like single line OR a real File item, we never insert
  // the path string itself.
  const WEB_IMAGE_PATH_RE = /^[\s]*(['"]?)([~./]|[A-Za-z]:[\\/]|\/)[^\n]*\.(?:png|jpg|jpeg|webp|gif|heic)\1[\s]*$/i;
  const isLikelyImagePathPaste = (text: string): boolean => {
    if (typeof text !== 'string') return false;
    if (text.length === 0 || text.length > 4096) return false;
    if (text.includes('\n')) return false;
    return WEB_IMAGE_PATH_RE.test(text);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const cd = e.clipboardData;
    if (cd === null) return;
    const items = cd.items;
    if (items === null || items.length === 0) return;
    let consumed = false;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it === undefined) continue;
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file !== null) {
          consumed = true;
          void addImageBlob(file, file.name);
        }
      }
    }
    if (!consumed) {
      // AUTO-IMAGE-PROMOTE-SECTION — fall back to text inspection.
      const raw = cd.getData('text/plain');
      if (isLikelyImagePathPaste(raw)) {
        consumed = true;
        pushToast({
          level: 'info',
          message: 'Drop the image file or use the paperclip to attach.',
        });
      }
    }
    if (consumed) {
      e.preventDefault();
    }
  };

  // DRAGDROP-SECTION
  // ---- Drag and drop (OS files: image / text / unsupported routing) ----

  /**
   * Insert text into the composer at the current caret (or end). Used by
   * the text-file drop lane to seed `@path` references or inline content.
   * Adds a trailing space so the user can keep typing.
   */
  const insertTextAtCaret = useCallback(
    (insertion: string): void => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? draft.length;
      const end = el?.selectionEnd ?? caret;
      setDraft((cur) => {
        const before = cur.slice(0, caret);
        const after = cur.slice(end);
        const pad = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
        return `${before}${pad}${insertion} ${after}`;
      });
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node !== null) {
          const next = caret + insertion.length + 2;
          node.focus();
          node.setSelectionRange(next, next);
        }
      });
    },
    [draft],
  );

  /**
   * Route a single dropped file through the classifier. Image lane reuses
   * the existing `addImageBlob`; text lane uses `@path` references when
   * possible, otherwise inlines content up to MAX_INLINE_TEXT_BYTES;
   * unsupported files raise a toast and are dropped.
   */
  const ingestDroppedFile = useCallback(
    async (f: File): Promise<void> => {
      const c = classifyDroppedFile(f);
      if (c.kind === 'image') {
        await addImageBlob(f, f.name);
        return;
      }
      if (c.kind === 'unsupported') {
        pushToast({
          level: 'warning',
          message: t('composer.drop.unsupported', { mime: c.reason }),
        });
        return;
      }
      // Text lane. Prefer @path reference when the OS-reported absolute
      // path lives under the active project root (security: never produce
      // @paths for files outside projectRoot — the model would interpret
      // them as in-project references).
      const abs = readFilePath(f);
      if (abs !== null && activeProjectRoot !== null) {
        const rel = relativeToProject(abs, activeProjectRoot);
        if (rel !== null && rel.length > 0) {
          insertTextAtCaret(`@${rel}`);
          pushToast({
            level: 'info',
            message: t('composer.drop.textReferenced', { path: rel }),
          });
          return;
        }
      }
      // Inline fallback. Cap size so a 200 MB log doesn't blow up the
      // composer; the user can always save it under projectRoot first.
      if (f.size > MAX_INLINE_TEXT_BYTES) {
        pushToast({
          level: 'warning',
          message: t('composer.drop.tooLargeText'),
        });
        return;
      }
      try {
        const text = await readBlobAsText(f);
        const fence = '```';
        const ext = (() => {
          const i = f.name.lastIndexOf('.');
          return i === -1 ? '' : f.name.slice(i + 1).toLowerCase();
        })();
        const block = `${fence}${ext}\n${text}\n${fence}`;
        insertTextAtCaret(block);
        const size = f.size < 1024
          ? `${f.size} B`
          : f.size < 1024 * 1024
            ? `${(f.size / 1024).toFixed(1)} KB`
            : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
        pushToast({
          level: 'info',
          message: t('composer.drop.textInlined', { name: f.name, size }),
        });
      } catch {
        pushToast({
          level: 'warning',
          message: t('composer.drop.unsupported', {
            mime: f.type.length > 0 ? f.type : 'unreadable',
          }),
        });
      }
    },
    [
      addImageBlob,
      activeProjectRoot,
      insertTextAtCaret,
      pushToast,
      t,
    ],
  );

  const onDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    if (props.disabled) return;
    // `dataTransfer.items` is more reliable than `types` for distinguishing
    // file drags from text drags; fall back to `types` for browsers that
    // don't populate `items` during dragenter.
    const items = e.dataTransfer?.items;
    const types = e.dataTransfer?.types;
    const hasFiles =
      (items !== undefined &&
        Array.from(items).some((it) => it.kind === 'file')) ||
      (types !== undefined && Array.from(types).includes('Files'));
    if (!hasFiles) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragActive(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (props.disabled) return;
    const types = e.dataTransfer?.types;
    if (types === undefined) return;
    if (!Array.from(types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (props.disabled) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setDragActive(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (props.disabled) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    const files = e.dataTransfer?.files;
    if (files === undefined || files.length === 0) return;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      if (f === undefined) continue;
      void ingestDroppedFile(f);
    }
  };
  // /DRAGDROP-SECTION

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files;
    if (files === null) return;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      if (f === undefined) continue;
      void addImageBlob(f, f.name);
    }
    // Reset so picking the same file twice re-fires `change`.
    e.target.value = '';
  };

  const sendButton = (() => {
    if (props.streaming) {
      return (
        <button
          type="button"
          className={`${styles.sendBtn} ${styles.sendBtnCancel}`}
          onClick={onCancelClick}
          aria-label={t('composer.stop')}
          title={t('composer.stop')}
        >
          <Square size={16} strokeWidth={1.5} />
        </button>
      );
    }
    if (props.sending) {
      return (
        <button
          type="button"
          className={styles.sendBtn}
          disabled
          aria-label={t('composer.sending')}
        >
          <Loader2 size={16} strokeWidth={1.5} className={styles.spin} />
        </button>
      );
    }
    return (
      <button
        type="button"
        className={styles.sendBtn}
        onClick={() => void submit()}
        disabled={!canSend}
        aria-label={t('composer.send.aria')}
        title={`${t('composer.send')} (⌘/Ctrl + Enter)`}
        data-active={canSend ? 'true' : 'false'}
      >
        <Send size={16} strokeWidth={1.5} />
      </button>
    );
  })();

  return (
    <div
      className={styles.root}
      data-disabled={props.disabled ? 'true' : 'false'}
      data-drop-active={dragActive ? 'true' : 'false'}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* DRAGDROP-SECTION */}
      <DropOverlay visible={dragActive} />
      {/* /DRAGDROP-SECTION */}

      {plusMenuOpen ? (
        <PlusMenu anchor={plusBtnRef.current} onClose={closePlusMenu} />
      ) : null}

      {attachedImages.length > 0 ? (
        <ImageAttachmentPreview
          attachments={attachedImages}
          onRemove={removeAttachment}
        />
      ) : null}

      {/* AGENT-REPLY-SECTION — reply-mode header. Sits between the
          attachments preview and the input wrap so it never collides
          with the slash/mention popovers. */}
      {props.agentReply !== undefined && props.agentReply !== null ? (
        <div
          className={styles.agentReplyHeader}
          data-testid="composer-agent-reply-header"
        >
          <span className={styles.agentReplyLabel}>
            {t('composer.agentReply.header', {
              label: props.agentReply.target.label,
            })}
          </span>
          <button
            type="button"
            className={styles.agentReplyExitBtn}
            onClick={props.agentReply.onExitReply}
            aria-label={t('composer.agentReply.exitAria')}
            title={t('composer.agentReply.exitAria')}
            data-testid="composer-agent-reply-exit"
          >
            {`× ${t('composer.agentReply.exit')}`}
          </button>
        </div>
      ) : null}
      {/* /AGENT-REPLY-SECTION */}

      <div className={styles.inputWrap}>
        {acOpen ? (
          <SlashAutocomplete
            commands={filteredCommands}
            selectedIndex={acIndex}
            query={slashMatch?.query ?? ''}
            onPick={onPick}
            onHoverIndex={setAcIndex}
          />
        ) : null}
        {mentionOpen ? (
          <FileMentionAutocomplete
            entries={mentionEntries}
            selectedIndex={mentionIndex}
            query={mentionToken?.query ?? ''}
            loading={mentionLoading}
            onPick={insertMention}
            onHoverIndex={setMentionIndex}
          />
        ) : null}
        <div className={styles.inputRow}>
          <button
            ref={plusBtnRef}
            type="button"
            className={styles.plusBtn}
            onClick={() => {
              if (plusMenuOpen) {
                closePlusMenu();
              } else {
                openPlusMenu();
              }
            }}
            aria-label={t('composer.actions.menu')}
            aria-haspopup="menu"
            aria-expanded={plusMenuOpen}
            title={t('composer.actions.tooltip')}
            disabled={props.disabled}
          >
            <Plus size={16} strokeWidth={1.75} />
          </button>
          <textarea
            ref={textareaRef}
            className={`${styles.textarea} ${hasNewline ? styles.multiline : ''}`}
            placeholder={
              props.disabled
                ? t('composer.placeholder.disabled')
                : // AGENT-REPLY-SECTION — distinct placeholder
                  // when the composer is bound to a worker so the
                  // user can't confuse it with the lead chat path.
                  props.agentReply !== undefined && props.agentReply !== null
                  ? t('composer.agentReply.placeholder')
                  : props.streaming
                    ? t('composer.placeholder.streaming')
                    : t('composer.placeholder')
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={props.disabled}
            rows={1}
            aria-label={t('composer.message.aria')}
            aria-autocomplete={acOpen || mentionOpen ? 'list' : undefined}
            aria-expanded={acOpen || mentionOpen}
            /* RESPONSIVE-SECTION — hint mobile keyboards. */
            inputMode="text"
            autoCapitalize="sentences"
            autoCorrect="on"
            /* /RESPONSIVE-SECTION */
          />
        </div>
      </div>
      <div className={styles.toolRow} data-viewport={viewport.breakpoint}>
        {/* RESPONSIVE-SECTION — chip cluster. On non-mobile breakpoints
            we render the full row inline; on mobile only the ModelChip
            stays inline and the rest collapse into a "⋯" overflow
            popover so the row never wraps below the textarea. */}
        {!isMobile ? (
          <>
            <ProviderChip onSwitch={props.onSwitchProvider} disabled={props.disabled} />
            {props.backendLabel !== undefined && props.backendLabel !== null ? (
              <span className={styles.backendLabel}>{props.backendLabel}</span>
            ) : null}
            <ModelChip onSelect={props.onSwitchModel} disabled={props.disabled} />
            <ProfileChip disabled={props.disabled} />
            <StyleChip disabled={props.disabled} />
            <button
              type="button"
              className={styles.slashBtn}
              onClick={openSlashCommands}
              aria-label={t('composer.browse.aria')}
              title={t('slash.openConsole')}
            >
              <Slash size={14} strokeWidth={1.5} />
            </button>
          </>
        ) : (
          <>
            <ModelChip onSelect={props.onSwitchModel} disabled={props.disabled} />
            <button
              type="button"
              className={styles.chipOverflowBtn}
              onClick={() => setChipOverflowOpen((v) => !v)}
              aria-label={t('composer.actions.menu')}
              aria-haspopup="menu"
              aria-expanded={chipOverflowOpen}
              data-testid="composer-chip-overflow"
            >
              <span aria-hidden="true">{'⋯'}</span>
            </button>
            {chipOverflowOpen ? (
              <div
                className={styles.chipOverflowMenu}
                role="menu"
                data-testid="composer-chip-overflow-menu"
                onClick={() => setChipOverflowOpen(false)}
              >
                <ProviderChip
                  onSwitch={props.onSwitchProvider}
                  disabled={props.disabled}
                />
                <ProfileChip disabled={props.disabled} />
                <StyleChip disabled={props.disabled} />
                <button
                  type="button"
                  className={styles.slashBtn}
                  onClick={openSlashCommands}
                  aria-label={t('composer.browse.aria')}
                  title={t('slash.openConsole')}
                >
                  <Slash size={14} strokeWidth={1.5} />
                </button>
              </div>
            ) : null}
          </>
        )}
        {/* /RESPONSIVE-SECTION */}
        <span className={styles.spacer} />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className={styles.hiddenInput}
          onChange={onFileInputChange}
          aria-hidden="true"
          tabIndex={-1}
        />
        <button
          type="button"
          className={styles.attachBtn}
          onClick={() => fileInputRef.current?.click()}
          aria-label={t('composer.attach.imageAria')}
          title={t('composer.attach.image')}
          disabled={props.disabled}
        >
          <Paperclip size={16} strokeWidth={1.5} />
        </button>
        {/* VOICE-INPUT-SECTION */}
        <VoiceInputButton
          draft={draft}
          onTranscript={setDraft}
          disabled={props.disabled}
        />
        {/* /VOICE-INPUT-SECTION */}
        {sendButton}
      </div>
    </div>
  );
}
