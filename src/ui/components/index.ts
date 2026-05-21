/**
 * Barrel re-exports for all UI components.
 *
 * Every component keeps a `default` export (that's the React convention
 * used across this repo); we expose both the default and any ambient
 * types (e.g. `ToolCallStatus`). Existing deep-path imports still work
 * — this barrel is additive.
 *
 * Round 3 adds:
 *   - Nox (NoxBig + NoxMini) mascot components (FIX #25).
 *   - ThinkingPhrases data/helpers (FIX #28).
 *   - Four slash-command overlays (FIX #32):
 *     PermissionsOverlay, ContextOverlay, CtxSizeOverlay, ResumeOverlay.
 */

export { default as ApprovalPrompt } from './ApprovalPrompt.js';
export type { ApprovalPromptProps } from './ApprovalPrompt.js';

export { default as CodeBlock } from './CodeBlock.js';
export type { CodeBlockProps } from './CodeBlock.js';

export { default as ContextBar } from './ContextBar.js';
export type { ContextBarProps } from './ContextBar.js';

export { default as ContextOverlay } from './ContextOverlay.js';
export type { ContextOverlayProps } from './ContextOverlay.js';

export { default as CtxSizeOverlay } from './CtxSizeOverlay.js';
export type { CtxSizeOverlayProps } from './CtxSizeOverlay.js';

export { default as DiffView } from './DiffView.js';
export type { DiffViewProps } from './DiffView.js';

export { default as Header } from './Header.js';
export type { HeaderProps } from './Header.js';

export { default as InlineDiffView } from './InlineDiffView.js';
export type { InlineDiffViewProps } from './InlineDiffView.js';

export { default as InputBar } from './InputBar.js';
export type { InputBarProps } from './InputBar.js';

export { default as MessageBlock } from './MessageBlock.js';
export type { MessageBlockProps, MessageBlockRole } from './MessageBlock.js';

export { NoxBig, NoxMini, NoxTamagotchi } from './Nox.js';
export type { NoxMiniProps, NoxTamagotchiProps } from './Nox.js';

export { default as PermissionsOverlay } from './PermissionsOverlay.js';
export type { PermissionsOverlayProps } from './PermissionsOverlay.js';

export { default as ProviderOverlay } from './ProviderOverlay.js';
export type {
  ProviderOverlayProps,
  ProviderRow,
  ProviderUrls,
} from './ProviderOverlay.js';

export { default as ResumeOverlay, RESUME_MAX_ROWS } from './ResumeOverlay.js';
export type { ResumeOverlayProps } from './ResumeOverlay.js';

export { default as SettingsOverlay } from './SettingsOverlay.js';
export type { SettingsOverlayProps } from './SettingsOverlay.js';

export { default as SkillInputOverlay } from './SkillInputOverlay.js';
export type {
  SkillInputOverlayProps,
  SkillOverlaySubmission,
} from './SkillInputOverlay.js';

export { default as SlashMenu } from './SlashMenu.js';
export type { SlashMenuProps } from './SlashMenu.js';

export { default as StreamOutput } from './StreamOutput.js';
export type { StreamOutputProps } from './StreamOutput.js';

export { ThinkingBlock } from './ThinkingBlock.js';
export type { ThinkingBlockProps } from './ThinkingBlock.js';

export { default as ThinkingSpinner } from './ThinkingSpinner.js';
export type { ThinkingSpinnerProps } from './ThinkingSpinner.js';

export {
  PHRASES_EN,
  PHRASES_RU,
  pickPhrase,
  PHRASE_ROTATE_MS,
  GRADIENT_STEP_MS,
} from './ThinkingPhrases.js';

export { default as ToolCallBlock } from './ToolCallBlock.js';
export type { ToolCallBlockProps, ToolCallStatus } from './ToolCallBlock.js';

export { default as UsageFooter } from './UsageFooter.js';
export type { UsageFooterProps } from './UsageFooter.js';
