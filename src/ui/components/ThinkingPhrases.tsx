/**
 * FIX #28 — 30-per-locale bank of "thinking" phrases used by
 * `<ThinkingSpinner>`. A single phrase is surfaced at a time and
 * rotated every `PHRASE_ROTATE_MS` ms; within the visible phrase each
 * character is tinted from the `phraseGradient` (see theme.ts) with
 * an animated offset to produce a smooth left-to-right colour flow.
 *
 * This file is plain data + helpers — no React, no side effects. It
 * lives under `components/` so the barrel can expose it if needed in
 * tests, though it currently isn't imported by anything outside
 * `ThinkingSpinner.tsx`.
 */

export const PHRASES_EN: readonly string[] = [
  'Pondering',
  'Cogitating',
  'Ruminating',
  'Contemplating',
  'Percolating',
  'Ideating',
  'Scheming',
  'Brewing',
  'Churning',
  'Crystallizing',
  'Noodling',
  'Unfolding',
  'Marinating',
  'Architecting',
  'Reticulating',
  'Inferring',
  'Synthesizing',
  'Deliberating',
  'Surmising',
  'Contriving',
  'Refactoring thoughts',
  'Consulting the oracle',
  'Reading the tea leaves',
  'Folding proteins',
  'Checking vibes',
  'Hatching plans',
  'Quantum-computing',
  'Summoning patterns',
  'Roasting beans',
  'Untangling threads',
];

export const PHRASES_RU: readonly string[] = [
  'Размышляю',
  'Обдумываю',
  'Прокручиваю',
  'Перевариваю',
  'Кручу-верчу',
  'Ковыряюсь',
  'Взвешиваю',
  'Считаю до десяти',
  'Собираюсь с мыслями',
  'Отстаиваюсь',
  'Выбираю путь',
  'Рисую схему',
  'Смотрю под капот',
  'Перелистываю справочник',
  'Крашу Бейсик',
  'Скрещиваю пальцы',
  'Глажу код',
  'Гоняю пикселы',
  'Ворчу на линтер',
  'Варю кофе',
  'Спрашиваю у резинового утёнка',
  'Ищу здравый смысл',
  'Сверяю часы',
  'Настраиваю антенну',
  'Советуюсь с совой',
  'Раскладываю пасьянс',
  'Шепчу компилятору',
  'Медитирую на TODO',
  'Ловлю вдохновение',
  'Проигрываю в голове',
];

/**
 * Return the phrase at `index mod list.length` for the locale's bank,
 * with a conservative fallback when the list turns out empty (can't
 * happen with the hard-coded constants above, but TypeScript's array
 * indexing returns `T | undefined` so we guard anyway).
 */
export function pickPhrase(locale: 'en' | 'ru', index: number): string {
  const list = locale === 'ru' ? PHRASES_RU : PHRASES_EN;
  if (list.length === 0) return locale === 'ru' ? 'Думаю' : 'Thinking';
  const safeIndex = ((index % list.length) + list.length) % list.length;
  return list[safeIndex] ?? (locale === 'ru' ? 'Думаю' : 'Thinking');
}

/** How long a single phrase stays visible before rotating (ms). */
export const PHRASE_ROTATE_MS = 30_000;

/** How fast the gradient flows across characters (ms per step). */
export const GRADIENT_STEP_MS = 150;
