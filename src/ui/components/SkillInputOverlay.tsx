/**
 * Modal overlay invoked by `/new-skill`. Collects either a chunk of
 * text (to be saved as a new skill file), an existing file path to
 * copy in, or — Round 11 (Agent 4) — an AI-generated skill driven by
 * the local LLM.
 *
 * State machine:
 *   1. mode-select          → user picks [P]aste / [F]ile / [A]I /
 *                              Esc cancels. The [A] entry is hidden if
 *                              the parent did not wire `onAiWriterGenerate`.
 *   2a. paste-filename      → enters a filename (prefilled
 *                              `skill-<ts>.md`).
 *   2b. paste-body          → multi-line body. Submit via Enter on a
 *                              blank line; single Enter commits a line.
 *   3. file-path            → enters a path. Enter submits.
 *   4. ai-writer-prompt     → multi-line prompt describing the skill.
 *                              Submit via Enter on a blank line (same
 *                              "double-Enter to submit" idiom as paste-body
 *                              so users have one less idiom to learn).
 *   5. ai-writer-generating → spinner + live token preview. Esc / `c`
 *                              aborts via `AbortController`.
 *   6. ai-writer-preview    → full content in a scrollable viewport
 *                              with [a]pprove / [r]egenerate / [e]dit
 *                              prompt / [c|esc] cancel.
 *
 * The component is purely presentational — the caller wires `onSubmit`
 * to SkillsManager.addFromText / add. Because useInput is active, the
 * caller MUST render this overlay on top of the chat input area so the
 * two don't compete for keystrokes; ChatScreen does that by suspending
 * the main InputBar render while `skillOverlay === true`.
 *
 * Backward-compatibility note: the legacy `SkillOverlaySubmission`
 * union (no `kind` discriminator) is still exported and is the *shape*
 * the existing onSubmit consumers rely on (they branch on `'sourcePath'
 * in payload`). The new `SkillSubmitPayload` shape is a strict
 * superset that adds a `kind` discriminator alongside the same fields,
 * so existing callers keep working unchanged while new callers can opt
 * into the typed union.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { dimSeparator, noxPalette, spinnerFrames, textMuted, theme } from '../theme.js';

// ---------- Public payload types ---------------------------------------

/**
 * Round 11 (Agent 4): tagged union with an explicit `kind` field. New
 * code should prefer this type. Existing callers that do
 * `if ('sourcePath' in payload)` keep working because the runtime
 * shape is a strict superset (the `kind` field is additive).
 */
export type SkillSubmitPayload =
  | { readonly kind: 'paste'; readonly filename: string; readonly content: string }
  | { readonly kind: 'file'; readonly sourcePath: string }
  | { readonly kind: 'ai-writer'; readonly filename: string; readonly content: string };

/**
 * Legacy shape — unchanged from earlier rounds. Kept as a separate
 * exported type because `app.tsx` and `ChatScreen.tsx` import it by
 * name. The runtime values handed back via `onSubmit` always satisfy
 * BOTH this type and `SkillSubmitPayload` (the new `kind` field is
 * just an extra property the legacy structural check ignores).
 */
export type SkillOverlaySubmission =
  | { readonly filename: string; readonly content: string }
  | { readonly sourcePath: string };

export interface SkillInputOverlayProps {
  readonly onSubmit: (payload: SkillOverlaySubmission) => void;
  readonly onCancel: () => void;
  /**
   * Optional. When provided, the [A] AI Writer mode appears in the
   * mode-select menu. The overlay calls this with the user's prompt
   * and a chunk callback that streams generated text into the live
   * preview. The promise resolves with the *full* generated content
   * (markdown, frontmatter included). The optional `signal` lets the
   * overlay abort the in-flight call when the user hits Esc / `c`.
   */
  readonly onAiWriterGenerate?: (
    prompt: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ) => Promise<string>;
}

// ---------- Internal step type -----------------------------------------

type Step =
  | 'choose'
  | 'paste-filename'
  | 'paste-body'
  | 'file-path'
  | 'ai-writer-prompt'
  | 'ai-writer-generating'
  | 'ai-writer-preview';

// Keys: how many lines of preview to render at once. Tied to the
// terminal height when available, with a comfortable default for the
// common 24-row terminal.
const DEFAULT_PREVIEW_HEIGHT = 15;
const PREVIEW_PAGE_LINES = 10;

// ---------- Helpers ----------------------------------------------------

function defaultFilename(): string {
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `skill-${stamp}.md`;
}

/**
 * Best-effort filename derivation for AI-generated skills:
 *   1. Try the frontmatter `name:` line (with or without quotes).
 *   2. Otherwise, slugify the first ~5 words of the user's prompt.
 *   3. Fall back to a timestamped placeholder.
 *
 * Always returns a `.md` filename; the slug is bounded at 60 chars so
 * a runaway frontmatter value doesn't produce a 200-char filename.
 */
export function extractFilename(content: string, fallbackPrompt: string): string {
  const fm = content.match(/^---\s*\n[\s\S]*?\bname\s*:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/);
  let base: string;
  if (fm !== null && fm[1] !== undefined) {
    base = fm[1].trim();
  } else {
    base = fallbackPrompt.split(/\s+/).filter((w) => w.length > 0).slice(0, 5).join(' ');
  }
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 60);
  if (slug.length === 0) return `ai-skill-${Date.now()}.md`;
  return `${slug}.md`;
}

/**
 * Compute the preview viewport height. Reads `process.stdout.rows`
 * and reserves ~10 rows for the surrounding chrome (title, scrollbar
 * indicator, action buttons, hints). Bounded at [6..30] so a tiny or
 * absurdly tall terminal still produces a usable window.
 */
function computePreviewHeight(): number {
  const raw = typeof process !== 'undefined' ? process.stdout?.rows : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PREVIEW_HEIGHT;
  }
  const usable = raw - 10;
  if (usable < 6) return 6;
  if (usable > 30) return 30;
  return usable;
}

// ---------- Component --------------------------------------------------

function SkillInputOverlay({
  onSubmit,
  onCancel,
  onAiWriterGenerate,
}: SkillInputOverlayProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('choose');

  // Paste-mode state ----------------------------------------------------
  const [filename, setFilename] = useState<string>(() => defaultFilename());
  const [bodyLines, setBodyLines] = useState<readonly string[]>([]);
  // Current line being edited (not yet committed to bodyLines).
  const [activeLine, setActiveLine] = useState<string>('');
  // Remount key for TextInput when we manually reset its buffer.
  const [activeKey, setActiveKey] = useState<number>(0);

  // File-path mode state ------------------------------------------------
  const [pathDraft, setPathDraft] = useState<string>('');
  const [pathKey, setPathKey] = useState<number>(0);

  // AI-writer mode state ------------------------------------------------
  const [promptLines, setPromptLines] = useState<readonly string[]>([]);
  const [promptActive, setPromptActive] = useState<string>('');
  const [promptKey, setPromptKey] = useState<number>(0);
  // The *finalized* prompt sent to the model — kept around so [r]
  // regenerate and [e] edit-prompt can both reference it.
  const [submittedPrompt, setSubmittedPrompt] = useState<string>('');
  const [generatedContent, setGeneratedContent] = useState<string>('');
  // Streaming buffer used during ai-writer-generating; mirrored into
  // generatedContent on completion. Separate state so a partial stream
  // doesn't leak into the preview state if the user aborts midway.
  const [streamBuffer, setStreamBuffer] = useState<string>('');
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState<number>(0);
  const [previewHeight, setPreviewHeight] = useState<number>(() => computePreviewHeight());
  // Spinner frame index — advanced by a setInterval while in the
  // generating state.
  const [spinnerIndex, setSpinnerIndex] = useState<number>(0);
  // Held in a ref because the abort signal needs to outlive renders;
  // creating a new controller each generation kicks off a fresh stream.
  const abortRef = useRef<AbortController | null>(null);

  // ---- Derived helpers ------------------------------------------------

  const aiWriterEnabled = onAiWriterGenerate !== undefined;

  const promptText = useMemo(
    () => [...promptLines, promptActive].filter((l) => l.length > 0).join('\n'),
    [promptLines, promptActive],
  );

  const previewLines = useMemo<readonly string[]>(
    () => generatedContent.split('\n'),
    [generatedContent],
  );

  const totalPreviewLines = previewLines.length;

  // Visible window — clamped on every render in case the content
  // shrunk between scrolls (e.g. on regenerate).
  const visibleSlice = useMemo<readonly string[]>(() => {
    const start = Math.max(
      0,
      Math.min(scrollOffset, Math.max(0, totalPreviewLines - previewHeight)),
    );
    return previewLines.slice(start, start + previewHeight);
  }, [previewLines, scrollOffset, previewHeight, totalPreviewLines]);

  // ---- Reset helpers --------------------------------------------------

  const resetPasteState = useCallback((): void => {
    setFilename(defaultFilename());
    setBodyLines([]);
    setActiveLine('');
    setActiveKey((k) => k + 1);
  }, []);

  const resetFilePathState = useCallback((): void => {
    setPathDraft('');
    setPathKey((k) => k + 1);
  }, []);

  const resetAiWriterState = useCallback((): void => {
    setPromptLines([]);
    setPromptActive('');
    setPromptKey((k) => k + 1);
    setSubmittedPrompt('');
    setGeneratedContent('');
    setStreamBuffer('');
    setGenerationError(null);
    setScrollOffset(0);
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const resetAll = useCallback((): void => {
    setStep('choose');
    resetPasteState();
    resetFilePathState();
    resetAiWriterState();
  }, [resetAiWriterState, resetFilePathState, resetPasteState]);

  // ---- Spinner animation ---------------------------------------------

  useEffect(() => {
    if (step !== 'ai-writer-generating') return;
    const id = setInterval(() => {
      setSpinnerIndex((i) => (i + 1) % spinnerFrames.length);
    }, 80);
    return () => clearInterval(id);
  }, [step]);

  // ---- Terminal-resize awareness for the preview viewport -----------

  useEffect(() => {
    if (step !== 'ai-writer-preview') return;
    const handler = (): void => setPreviewHeight(computePreviewHeight());
    process.stdout.on('resize', handler);
    return () => {
      process.stdout.off('resize', handler);
    };
  }, [step]);

  // ---- Generation driver ---------------------------------------------

  /**
   * Kicks off a fresh AI generation with `submittedPrompt`. Aborts any
   * previous run, resets the stream buffer, and transitions through
   * generating → preview (or back to prompt on error/abort). All side-
   * effects are corralled here so the keyboard handler stays purely
   * dispatch-y.
   */
  const startGeneration = useCallback(
    (prompt: string): void => {
      if (onAiWriterGenerate === undefined) return;
      const trimmed = prompt.trim();
      if (trimmed.length === 0) return;

      // Abort any in-flight generation before kicking off a new one.
      if (abortRef.current !== null) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSubmittedPrompt(trimmed);
      setGeneratedContent('');
      setStreamBuffer('');
      setGenerationError(null);
      setScrollOffset(0);
      setStep('ai-writer-generating');

      void (async () => {
        try {
          const result = await onAiWriterGenerate(
            trimmed,
            (chunk) => {
              // The signal may have aborted between chunks — guard so
              // we don't leak text into the preview after cancel.
              if (controller.signal.aborted) return;
              setStreamBuffer((prev) => prev + chunk);
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setGeneratedContent(result);
          setStep('ai-writer-preview');
          setPreviewHeight(computePreviewHeight());
        } catch (err) {
          if (controller.signal.aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          setGenerationError(msg);
          // Fall back to the prompt so the user can retry without
          // retyping. The prompt buffer is reseeded below.
          setPromptLines(trimmed.split('\n'));
          setPromptActive('');
          setPromptKey((k) => k + 1);
          setStep('ai-writer-prompt');
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
        }
      })();
    },
    [onAiWriterGenerate],
  );

  // ---- Submission helpers --------------------------------------------

  const bodyText = useMemo(() => bodyLines.join('\n'), [bodyLines]);

  const submitPaste = useCallback((): void => {
    const content = bodyText;
    const name = filename.trim().length > 0 ? filename.trim() : defaultFilename();
    onSubmit({ filename: name, content });
    resetAll();
  }, [bodyText, filename, onSubmit, resetAll]);

  const submitPath = useCallback(
    (value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      onSubmit({ sourcePath: trimmed });
      resetAll();
    },
    [onSubmit, resetAll],
  );

  const handleFilenameSubmit = useCallback((value: string): void => {
    const trimmed = value.trim();
    setFilename(trimmed.length > 0 ? trimmed : defaultFilename());
    setStep('paste-body');
  }, []);

  const handleBodyLineSubmit = useCallback(
    (value: string): void => {
      // Empty line on an already-started body → submit. First-ever
      // empty line (no lines yet) should also submit (nothing to save
      // means the user is abandoning input, treat as empty content).
      if (value.length === 0) {
        submitPaste();
        return;
      }
      setBodyLines((prev) => [...prev, value]);
      setActiveLine('');
      setActiveKey((k) => k + 1);
    },
    [submitPaste],
  );

  const handlePromptLineSubmit = useCallback(
    (value: string): void => {
      // Empty line + non-empty buffer ⇒ submit. Empty line + empty
      // buffer ⇒ no-op (we don't fire a generate with no description).
      if (value.length === 0) {
        if (promptLines.length === 0) return;
        const finalPrompt = promptLines.join('\n');
        startGeneration(finalPrompt);
        return;
      }
      setPromptLines((prev) => [...prev, value]);
      setPromptActive('');
      setPromptKey((k) => k + 1);
    },
    [promptLines, startGeneration],
  );

  const approveGenerated = useCallback((): void => {
    const content = generatedContent;
    const name = extractFilename(content, submittedPrompt);
    onSubmit({ filename: name, content });
    resetAll();
  }, [generatedContent, onSubmit, resetAll, submittedPrompt]);

  const cancelGeneration = useCallback((): void => {
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Restore the prompt buffer so the user can iterate without
    // retyping.
    if (submittedPrompt.length > 0) {
      setPromptLines(submittedPrompt.split('\n'));
    }
    setPromptActive('');
    setPromptKey((k) => k + 1);
    setStep('ai-writer-prompt');
    setStreamBuffer('');
  }, [submittedPrompt]);

  const editPromptFromPreview = useCallback((): void => {
    setPromptLines(submittedPrompt.split('\n'));
    setPromptActive('');
    setPromptKey((k) => k + 1);
    setGeneratedContent('');
    setStreamBuffer('');
    setScrollOffset(0);
    setStep('ai-writer-prompt');
  }, [submittedPrompt]);

  const regenerate = useCallback((): void => {
    if (submittedPrompt.length === 0) return;
    startGeneration(submittedPrompt);
  }, [startGeneration, submittedPrompt]);

  // ---- Scroll helpers (preview state) --------------------------------

  const scrollBy = useCallback(
    (delta: number): void => {
      setScrollOffset((cur) => {
        const max = Math.max(0, totalPreviewLines - previewHeight);
        const next = cur + delta;
        if (next < 0) return 0;
        if (next > max) return max;
        return next;
      });
    },
    [previewHeight, totalPreviewLines],
  );

  // ---- Top-level keyboard handler ------------------------------------

  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          return?: boolean;
          tab?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          pageUp?: boolean;
          pageDown?: boolean;
          ctrl?: boolean;
          meta?: boolean;
        },
      ): void => {
        // ----- Mode select --------------------------------------------
        if (step === 'choose') {
          if (key.escape === true) {
            resetAll();
            onCancel();
            return;
          }
          const ch = input.toLowerCase();
          if (ch === 'p') {
            setStep('paste-filename');
            return;
          }
          if (ch === 'f') {
            setStep('file-path');
            return;
          }
          if (ch === 'a' && aiWriterEnabled) {
            setStep('ai-writer-prompt');
            return;
          }
          return;
        }

        // ----- Paste flow: TextInput owns input, Esc cancels ----------
        if (step === 'paste-filename' || step === 'paste-body' || step === 'file-path') {
          if (key.escape === true) {
            resetAll();
            onCancel();
          }
          return;
        }

        // ----- AI writer prompt: TextInput owns input, Esc cancels ----
        if (step === 'ai-writer-prompt') {
          if (key.escape === true) {
            // If the user is in the middle of editing a prompt and
            // hits Esc, send them back to mode-select (less jarring
            // than fully closing the overlay; a second Esc from there
            // closes for good).
            resetAiWriterState();
            setStep('choose');
          }
          return;
        }

        // ----- AI writer generating: only abort on Esc / c ------------
        if (step === 'ai-writer-generating') {
          if (key.escape === true || input.toLowerCase() === 'c') {
            cancelGeneration();
          }
          return;
        }

        // ----- AI writer preview: scroll + actions --------------------
        if (step === 'ai-writer-preview') {
          if (key.escape === true) {
            resetAll();
            onCancel();
            return;
          }
          if (key.upArrow === true) {
            scrollBy(-1);
            return;
          }
          if (key.downArrow === true) {
            scrollBy(1);
            return;
          }
          if (key.pageUp === true) {
            scrollBy(-PREVIEW_PAGE_LINES);
            return;
          }
          if (key.pageDown === true) {
            scrollBy(PREVIEW_PAGE_LINES);
            return;
          }
          // `g` → top, `G` (Shift+g) → bottom. We branch on the raw
          // input character because Ink reports Shift via case rather
          // than a separate flag.
          if (input === 'g') {
            setScrollOffset(0);
            return;
          }
          if (input === 'G') {
            const max = Math.max(0, totalPreviewLines - previewHeight);
            setScrollOffset(max);
            return;
          }
          // Action keys.
          const ch = input.toLowerCase();
          if (ch === 'a' || key.return === true) {
            approveGenerated();
            return;
          }
          if (ch === 'r') {
            regenerate();
            return;
          }
          if (ch === 'e') {
            editPromptFromPreview();
            return;
          }
          if (ch === 'c') {
            resetAll();
            onCancel();
            return;
          }
          return;
        }
      },
      [
        aiWriterEnabled,
        approveGenerated,
        cancelGeneration,
        editPromptFromPreview,
        onCancel,
        previewHeight,
        regenerate,
        resetAiWriterState,
        resetAll,
        scrollBy,
        step,
        totalPreviewLines,
      ],
    ),
  );

  // ---- Render --------------------------------------------------------

  const renderModeSelect = (): React.JSX.Element => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={textMuted}>How do you want to provide the skill?</Text>
      <Text>
        <Text color={noxPalette.light}>[P]</Text>
        <Text color={noxPalette.white}> paste text inline</Text>
      </Text>
      <Text>
        <Text color={noxPalette.light}>[F]</Text>
        <Text color={noxPalette.white}> read from a file path</Text>
      </Text>
      {aiWriterEnabled && (
        <Text>
          <Text color={noxPalette.light}>[A]</Text>
          <Text color={noxPalette.white}> AI Writer </Text>
          <Text color={textMuted}>(generate from a description)</Text>
        </Text>
      )}
      <Text color={textMuted}>Esc to cancel</Text>
    </Box>
  );

  const renderPasteFilename = (): React.JSX.Element => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={textMuted}>Filename (Enter to accept default):</Text>
      <Box paddingX={1} borderStyle="round" borderColor={dimSeparator}>
        <TextInput
          defaultValue={filename}
          placeholder={filename}
          onChange={setFilename}
          onSubmit={handleFilenameSubmit}
        />
      </Box>
    </Box>
  );

  const renderPasteBody = (): React.JSX.Element => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={textMuted}>
        Skill content — Enter adds a newline, double-Enter on a blank line submits.
      </Text>
      {bodyLines.length > 0 && (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle="round"
          borderColor={dimSeparator}
        >
          {bodyLines.map((line, i) => (
            <Text key={`bl-${i}`}>{line.length === 0 ? ' ' : line}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} paddingX={1} borderStyle="round" borderColor={noxPalette.light}>
        <Text>{theme.prompt} </Text>
        <Box flexGrow={1}>
          <TextInput
            key={activeKey}
            defaultValue={activeLine}
            placeholder="(type next line; Enter to commit, empty Enter to submit)"
            onChange={setActiveLine}
            onSubmit={handleBodyLineSubmit}
          />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={textMuted}>
          Saving as: <Text color={noxPalette.light}>{filename}</Text>
        </Text>
      </Box>
    </Box>
  );

  const renderFilePath = (): React.JSX.Element => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={textMuted}>Path to skill file (absolute or relative):</Text>
      <Box paddingX={1} borderStyle="round" borderColor={noxPalette.light}>
        <TextInput
          key={pathKey}
          defaultValue={pathDraft}
          placeholder="/path/to/skill.md"
          onChange={setPathDraft}
          onSubmit={submitPath}
        />
      </Box>
      <Text color={textMuted}>Esc to cancel</Text>
    </Box>
  );

  const renderAiWriterPrompt = (): React.JSX.Element => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={textMuted}>
        Describe the skill — Enter adds a newline, blank Enter submits.
      </Text>
      {promptLines.length > 0 && (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle="round"
          borderColor={dimSeparator}
        >
          {promptLines.map((line, i) => (
            <Text key={`pl-${i}`}>{line.length === 0 ? ' ' : line}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} paddingX={1} borderStyle="round" borderColor={noxPalette.light}>
        <Text>{theme.prompt} </Text>
        <Box flexGrow={1}>
          <TextInput
            key={promptKey}
            defaultValue={promptActive}
            placeholder="Describe the skill you want — e.g. 'Frontend expertise focused on React Server Components, no boilerplate'"
            onChange={setPromptActive}
            onSubmit={handlePromptLineSubmit}
          />
        </Box>
      </Box>
      {generationError !== null && (
        <Box marginTop={1}>
          <Text color="#fca5a5">Last error: {generationError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={textMuted}>
          Esc returns to mode select · blank Enter to generate
        </Text>
      </Box>
    </Box>
  );

  const renderAiWriterGenerating = (): React.JSX.Element => {
    const frame = spinnerFrames[spinnerIndex] ?? spinnerFrames[0] ?? '|';
    const trimmed = streamBuffer.length > 600 ? `…${streamBuffer.slice(-600)}` : streamBuffer;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={noxPalette.highlight}>{frame} </Text>
          <Text color={noxPalette.white} bold>
            Generating skill…
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={textMuted}>
            Prompt: <Text color={noxPalette.light}>{submittedPrompt}</Text>
          </Text>
        </Box>
        {streamBuffer.length > 0 && (
          <Box
            flexDirection="column"
            marginTop={1}
            paddingX={1}
            borderStyle="round"
            borderColor={dimSeparator}
          >
            <Text color={noxPalette.white}>{trimmed}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={textMuted}>Esc or `c` cancels generation</Text>
        </Box>
      </Box>
    );
  };

  const renderAiWriterPreview = (): React.JSX.Element => {
    const start = Math.max(
      0,
      Math.min(scrollOffset, Math.max(0, totalPreviewLines - previewHeight)),
    );
    const end = Math.min(totalPreviewLines, start + previewHeight);
    const indicator =
      totalPreviewLines === 0
        ? '0/0 lines'
        : `${start + 1}-${end} of ${totalPreviewLines} lines`;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={textMuted}>
          Preview — review the generated skill before saving.
        </Text>
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle="round"
          borderColor={noxPalette.light}
          height={previewHeight + 2}
        >
          {visibleSlice.length === 0 ? (
            <Text color={textMuted}>(empty)</Text>
          ) : (
            visibleSlice.map((line, i) => (
              <Text key={`pv-${start + i}`} color={noxPalette.white}>
                {line.length === 0 ? ' ' : line}
              </Text>
            ))
          )}
        </Box>
        <Box>
          <Text color={textMuted}>{indicator}</Text>
        </Box>
        <Box marginTop={1} flexDirection="row">
          <Box marginRight={2}>
            <Text color={noxPalette.highlight}>[a]</Text>
            <Text color={noxPalette.white}> Approve</Text>
          </Box>
          <Box marginRight={2}>
            <Text color={noxPalette.highlight}>[r]</Text>
            <Text color={noxPalette.white}> Regenerate</Text>
          </Box>
          <Box marginRight={2}>
            <Text color={noxPalette.highlight}>[e]</Text>
            <Text color={noxPalette.white}> Edit prompt</Text>
          </Box>
          <Box marginRight={2}>
            <Text color={noxPalette.highlight}>[c/esc]</Text>
            <Text color={noxPalette.white}> Cancel</Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color={textMuted}>
            ↑/↓ scroll · PgUp/PgDn page · g top · G bottom · Enter approves
          </Text>
        </Box>
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={dimSeparator}
      paddingX={1}
    >
      <Box>
        <Text color={noxPalette.white} bold>
          New skill
        </Text>
        <Text color={textMuted}> — {stepLabel(step)}</Text>
      </Box>

      {step === 'choose' && renderModeSelect()}
      {step === 'paste-filename' && renderPasteFilename()}
      {step === 'paste-body' && renderPasteBody()}
      {step === 'file-path' && renderFilePath()}
      {step === 'ai-writer-prompt' && renderAiWriterPrompt()}
      {step === 'ai-writer-generating' && renderAiWriterGenerating()}
      {step === 'ai-writer-preview' && renderAiWriterPreview()}
    </Box>
  );
}

function stepLabel(step: Step): string {
  switch (step) {
    case 'choose':
      return 'choose input mode';
    case 'paste-filename':
      return 'filename';
    case 'paste-body':
      return 'paste content';
    case 'file-path':
      return 'file path';
    case 'ai-writer-prompt':
      return 'AI writer — describe the skill';
    case 'ai-writer-generating':
      return 'AI writer — generating';
    case 'ai-writer-preview':
      return 'AI writer — preview & approve';
    default:
      return '';
  }
}

export default SkillInputOverlay;
