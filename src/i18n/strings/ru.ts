/**
 * Russian (ru-RU) string table for the TUI.
 *
 * Mirrors `./en.ts`. Any missing key transparently falls back to the
 * English table — keep the symmetry in sync, but failure is graceful
 * (the user sees English text for that one phrase, not a crash).
 */

import type { StringTable } from './en.js';

export const ru: StringTable = {
  // ---------- Онбординг ----------
  'onboarding.welcome':
    'Добро пожаловать. Выберите LLM-бэкенд для общения. Локальные провайдеры (Ollama, LM Studio) не требуют ключа — облачным он нужен.',
  'onboarding.needsApiKey': '[нужен API-ключ]',
  'onboarding.navHint': '↑/↓ перемещение · Enter выбрать · Esc выйти',
  'onboarding.selected': 'Выбрано: {name}',
  'onboarding.serverUrl': 'URL сервера:',
  'onboarding.urlFooter':
    'Enter подтвердить · Esc назад · Сейчас: {value}',
  'onboarding.apiKey': 'API-ключ:',
  'onboarding.apiKeyOptional': 'API-ключ (необязательно):',
  'onboarding.envDetected':
    '✓ Обнаружена переменная ${name} — нажмите Enter с пустым полем, чтобы её использовать.',
  'onboarding.keyWarning':
    'Внимание: терминал может не маскировать ключ при вводе — очистите буфер прокрутки после вставки.',
  'onboarding.apiKeyFooter': 'Enter подтвердить · Esc назад',
  'onboarding.apiKeyFooterSkip':
    'Enter подтвердить · Esc назад · пустой Enter = пропустить',
  'onboarding.apiKeyRequired':
    'Нужен API-ключ для {name}{envHint}.',
  'onboarding.apiKeyEnvHint':
    ' (или задайте ${var} в окружении оболочки)',
  'onboarding.scanning': 'Поиск моделей на {url}…',
  'onboarding.connected': '✓ Подключено к {name}',
  'onboarding.availableModels': 'Доступные модели ({n}):',
  'onboarding.noModels':
    '(ничего не найдено — возможно, нужно сначала загрузить модель)',
  'onboarding.moreModels': '…ещё {n}',
  'onboarding.pressEnter': 'Нажмите Enter, чтобы начать чат.',
  'onboarding.cantReach':
    'Не удалось подключиться к {url}. Сервер запущен? URL верный?',
  'onboarding.noModelsHint.ollama':
    'Попробуйте: `ollama pull qwen2.5-coder`.',
  'onboarding.noModelsHint.lmstudio':
    'Сначала загрузите модель в LM Studio.',
  'onboarding.noModelsHint.custom':
    'Кастомный эндпоинт не вернул /v1/models — проверьте URL.',
  'onboarding.noModelsHint.cloud':
    'Убедитесь, что API-ключ даёт доступ к моделям {name}.',
  'onboarding.serverReachableNoModels':
    'Сервер доступен, но не вернул моделей. {hint}',
  'onboarding.scanFailed': 'Сканирование не удалось: {msg}',

  // ---------- Выбор языка ----------
  'language.welcome': 'Добро пожаловать в LocalCode',
  'language.choose': 'Выберите язык',
  'language.navHint': '↑/↓ перемещение · Enter подтвердить',
  'language.current': 'Текущий язык: {name}',
  'language.notSet': '(не задан)',
  'language.switchHint': 'Сменить: `/language <en|ru>`.',
  'language.alreadyOn': "Уже выбран '{name}'.",
  'language.unknown':
    "Неизвестный язык: '{value}'. Доступно: en, ru.",
  'language.failed': 'Не удалось сменить язык: {msg}',
  'language.setTo': "Язык установлен: '{name}'.",

  // ---------- Чат: пустой экран / баннеры / подсказки ----------
  'chat.emptyHint':
    'Введите сообщение или `/` для команд. Esc во время генерации — отмена.',
  'chat.placeholderApproval':
    'Введите, чтобы поставить в очередь — сначала ответьте на запрос выше (y/n)…',
  'chat.placeholderStreaming':
    'Введите следующее сообщение в очередь — Esc отменит ответ…',
  'chat.queuePausedBanner':
    'Очередь приостановлена — прошлый ход с ошибкой. Повторите упавшее сообщение или отправьте новое. (Ctrl+R повтор · Ctrl+X сброс)',
  'chat.queueCountOne': '↳ 1 сообщение в очереди (отправится после этого хода)',
  'chat.queueCountMany': '↳ {n} сообщений в очереди (отправятся после этого хода)',
  'chat.toast.answerApprovalFirst': 'Сначала ответьте на запрос подтверждения',
  'chat.toast.queued': 'В очереди — отправится после текущего хода',
  'chat.readingMode': 'РЕЖИМ ЧТЕНИЯ — F чтобы выйти',
  'chat.selectMode':
    'РЕЖИМ ВЫБОРА — ↑/↓ выбрать · Y скопировать · Esc выйти (строка {row}/{total})',
  'chat.modelSwap': 'СМЕНА МОДЕЛИ — открываю выбор…',
  'chat.configLoadFailed': 'Не удалось загрузить конфиг.',
  'chat.reconfigureHint':
    'Выполните `localcode --reconfigure` чтобы пройти онбординг заново.',

  // ---------- Меню слэш-команд ----------
  'slash.noMatch': 'Нет команд по запросу "{query}"',
  'slash.moreAbove': '↑ ещё {n}',
  'slash.moreBelow': '↓ ещё {n}',

  // ---------- Поле ввода ----------
  'input.placeholder': 'Введите сообщение или /команду…',
  'input.bashModeHint':
    '$ Bash-режим — вывод попадёт только в чат, модель его не увидит',
};
