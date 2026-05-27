/**
 * String-coverage regression test (Wave 8C user-visible bug fix).
 *
 * Pins the contract that every "must-be-translated" surface in the TUI
 * has a real string in BOTH `en.ts` and `ru.ts`. The registry below is
 * the source of truth: when a new visible string is added to an overlay
 * or screen, the developer adds its key here, then adds entries to
 * `en.ts` + `ru.ts`. If they forget any of the three the test fails.
 *
 * This protects against the original report: user picks Russian on
 * first launch, but the rest of the TUI still renders English. With
 * this guard, any future overlay that ships hardcoded English without
 * routing through `t()` will at minimum show up here (because the key
 * would be missing OR present in one table and not the other).
 *
 * The check is deliberately strict-equal:
 *   - `Object.keys(en)` must contain every key in `REQUIRED_KEYS`.
 *   - `Object.keys(ru)` must contain every key in `REQUIRED_KEYS`.
 *   - For each REQUIRED key, the RU value must be a non-empty string
 *     that is NOT identical to the EN value (a clear sign someone
 *     copy-pasted without translating).
 */

import { describe, test, expect } from 'bun:test';
import { en } from '../../src/i18n/strings/en.js';
import { ru } from '../../src/i18n/strings/ru.js';

/**
 * Every key referenced by a `useT().t(...)` call in the TUI. Grow this
 * list when you wire a new visible string. Tests fail BOTH if a key is
 * missing from either table AND if the EN/RU values are identical (a
 * forgotten translation).
 *
 * A small allowlist (`KEYS_ALLOWED_TO_MATCH`) below covers strings that
 * are deliberately the same in both languages — backticked command
 * names, brand names, opaque keyboard glyphs, etc.
 */
const REQUIRED_KEYS = [
  // Onboarding
  'onboarding.welcome',
  'onboarding.needsApiKey',
  'onboarding.navHint',
  'onboarding.selected',
  'onboarding.serverUrl',
  'onboarding.urlFooter',
  'onboarding.apiKey',
  'onboarding.apiKeyOptional',
  'onboarding.envDetected',
  'onboarding.keyWarning',
  'onboarding.apiKeyFooter',
  'onboarding.apiKeyFooterSkip',
  'onboarding.apiKeyRequired',
  'onboarding.apiKeyEnvHint',
  'onboarding.scanning',
  'onboarding.connected',
  'onboarding.availableModels',
  'onboarding.noModels',
  'onboarding.moreModels',
  'onboarding.pressEnter',
  'onboarding.cantReach',
  'onboarding.noModelsHint.ollama',
  'onboarding.noModelsHint.lmstudio',
  'onboarding.noModelsHint.custom',
  'onboarding.noModelsHint.cloud',
  'onboarding.serverReachableNoModels',
  'onboarding.scanFailed',
  // Language picker / slash command
  'language.welcome',
  'language.choose',
  'language.navHint',
  'language.current',
  'language.notSet',
  'language.switchHint',
  'language.alreadyOn',
  'language.unknown',
  'language.failed',
  'language.setTo',
  // Chat surface
  'chat.emptyHint',
  'chat.placeholderApproval',
  'chat.placeholderStreaming',
  'chat.queuePausedBanner',
  'chat.queueCountOne',
  'chat.queueCountMany',
  'chat.toast.answerApprovalFirst',
  'chat.toast.queued',
  'chat.readingMode',
  'chat.selectMode',
  'chat.modelSwap',
  'chat.configLoadFailed',
  'chat.reconfigureHint',
  // Slash menu + input
  'slash.noMatch',
  'slash.moreAbove',
  'slash.moreBelow',
  'input.placeholder',
  'input.bashModeHint',
  // /permissions
  'permissions.title',
  'permissions.note.alwaysOn',
  'permissions.note.alwaysOnDiff',
  'permissions.note.grantPrompt',
  'permissions.footer.enter',
  'permissions.footer.a',
  'permissions.footer.space',
  'permissions.footer.esc',
  'permissions.granted',
  'permissions.granted.none',
  // /context
  'context.title',
  'context.label.tokens',
  'context.label.messages',
  'context.label.skills',
  'context.label.skills.none',
  'context.label.localcodeMd',
  'context.localcodeMd.present',
  'context.localcodeMd.absent',
  'context.footer',
  // /ctxsize
  'ctxsize.title',
  'ctxsize.draft',
  'ctxsize.row.window',
  'ctxsize.row.custom',
  'ctxsize.row.keepAlive',
  'ctxsize.row.responseTimeout',
  'ctxsize.suffix.tokens',
  'ctxsize.suffix.seconds',
  'ctxsize.suffix.secondsRange',
  'ctxsize.suffix.editHint',
  'ctxsize.action.apply',
  'ctxsize.action.cancel',
  'ctxsize.error',
  'ctxsize.footer',
  'ctxsize.note',
  // /provider
  'provider.title',
  'provider.url.notSet',
  'provider.edit',
  'provider.key.set',
  'provider.key.fromEnv',
  'provider.key.notSet',
  'provider.key.optional',
  'provider.notes.title',
  'provider.notes.openrouterRu',
  'provider.notes.cloudKeys',
  'provider.warn.openrouter',
  'provider.error.customUrlRequired',
  'provider.error.cloudUrlEmpty',
  'provider.error.urlScheme',
  'provider.error.cloudLocalhost',
  'provider.error.apiKeyRequired',
  'provider.error.apiKeyEnvHint',
  'provider.error.prefix',
  'provider.editingUrl',
  'provider.editingKey',
  'provider.footer',
  // /settings
  'settings.title',
  'settings.source.globalOnly',
  'settings.source.projectAll',
  'settings.source.mixed',
  'settings.field.tempLabel',
  'settings.field.topPLabel',
  'settings.field.repeatPenaltyLabel',
  'settings.field.maxTokensLabel',
  'settings.fieldHint.stepRange',
  'settings.project.spaceRemove',
  'settings.project.spaceEnable',
  'settings.button.saveGlobal',
  'settings.button.saveProject',
  'settings.button.resetProject',
  'settings.button.saveTimeouts',
  'settings.panel.global',
  'settings.panel.project',
  'settings.panel.timeouts',
  'settings.row.responseWait',
  'settings.row.keepAlive',
  'settings.row.custom',
  'settings.suffix.secondsRange',
  'settings.suffix.editHint',
  'settings.error',
  'settings.footer',
  // /resume
  'resume.title',
  'resume.empty',
  'resume.untitled',
  'resume.summary',
  'resume.summary.none',
  'resume.footer',
  'resume.footer.olderHidden',
] as const;

/**
 * Keys where the EN and RU strings are intentionally identical (brand
 * marks, opaque tokens, single-letter labels). Anything NOT in this set
 * must differ between languages or the test fails.
 */
const KEYS_ALLOWED_TO_MATCH = new Set<string>([
  // Identical glyph / Latin label across both locales.
  'settings.field.topPLabel', // "Top-p"
  // Path strings, env-var names, keep-alive units…
  'settings.panel.global.path',
  'settings.panel.timeouts.path',
  // Technical labels — same in both locales by convention.
  'context.label.localcodeMd', // "LOCALCODE.md:"
  'ctxsize.row.keepAlive', // "Keep-alive:" — the term itself stays Latin
  'settings.row.keepAlive', // ditto
]);

describe('TUI i18n — required string coverage (Wave 8C)', () => {
  test('every required key exists in EN', () => {
    const enKeys = new Set(Object.keys(en));
    const missing: string[] = [];
    for (const key of REQUIRED_KEYS) {
      if (!enKeys.has(key)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  test('every required key exists in RU', () => {
    const ruKeys = new Set(Object.keys(ru));
    const missing: string[] = [];
    for (const key of REQUIRED_KEYS) {
      if (!ruKeys.has(key)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  test('RU values are non-empty', () => {
    const empty: string[] = [];
    for (const key of REQUIRED_KEYS) {
      const value = (ru as Record<string, string>)[key];
      if (value === undefined || value.length === 0) empty.push(key);
    }
    expect(empty).toEqual([]);
  });

  test('RU values differ from EN (modulo brand allowlist)', () => {
    const identical: string[] = [];
    for (const key of REQUIRED_KEYS) {
      if (KEYS_ALLOWED_TO_MATCH.has(key)) continue;
      const enValue = (en as Record<string, string>)[key];
      const ruValue = (ru as Record<string, string>)[key];
      if (enValue !== undefined && enValue === ruValue) identical.push(key);
    }
    expect(identical).toEqual([]);
  });

  test('en.ts and ru.ts have identical key sets (parity)', () => {
    const enKeys = new Set(Object.keys(en));
    const ruKeys = new Set(Object.keys(ru));
    const onlyEn: string[] = [];
    const onlyRu: string[] = [];
    for (const k of enKeys) if (!ruKeys.has(k)) onlyEn.push(k);
    for (const k of ruKeys) if (!enKeys.has(k)) onlyRu.push(k);
    expect(onlyEn).toEqual([]);
    expect(onlyRu).toEqual([]);
  });
});
