/**
 * Thinking phrase banks ported verbatim from the TUI
 * (`src/ui/components/ThinkingPhrases.tsx`).
 *
 * Used by `<ThinkingIndicator>` to surface a rotating "model is
 * thinking…" hint while a request is in flight. No React, no side
 * effects — plain data + helpers.
 */

export const THINKING_PHRASES_EN: readonly string[] = [
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

export const THINKING_PHRASES_RU: readonly string[] = [
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
 * Pick the phrase bank for a given locale string. Anything starting
 * with `ru` (case-insensitive) maps to Russian; everything else falls
 * back to English.
 */
export function pickPhrasesForLocale(locale: string): readonly string[] {
  return locale.toLowerCase().startsWith('ru')
    ? THINKING_PHRASES_RU
    : THINKING_PHRASES_EN;
}

/**
 * Fisher–Yates shuffle that returns a new array. Used to pick a fresh
 * order each mount so consecutive runs don't always open with the same
 * phrase.
 */
export function shufflePhrases(list: readonly string[]): string[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}
