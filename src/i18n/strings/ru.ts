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
  'chat.toast.clipboardNoImage': 'В буфере обмена нет изображения',
  'chat.toast.clipboardSaveFailed': 'Не удалось сохранить изображение из буфера',
  'chat.toast.clipboardImageAttached': 'Изображение из буфера прикреплено',
  'journal.recovery.title': 'Обнаружены незавершённые сессии',
  'journal.recovery.message':
    'Найдено {n} незавершённых сессий после прошлого запуска.',
  'journal.recovery.hintResume':
    'R — продолжить самую свежую',
  'journal.recovery.hintArchive': 'A — заархивировать все',
  'journal.recovery.hintIgnore': 'Esc — пропустить',
  'journal.recovery.archived': 'Незавершённые журналы сессий заархивированы.',
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

  // ---------- Окно /permissions ----------
  'permissions.title': 'Разрешения',
  'permissions.note.alwaysOn': 'всегда без подтверждения',
  'permissions.note.alwaysOnDiff':
    'всегда без подтверждения, показывает diff',
  'permissions.note.grantPrompt': 'разрешить? (пробел)',
  'permissions.footer.enter': '(enter) разрешить всё',
  'permissions.footer.a': '(a) разрешить всё',
  'permissions.footer.space': '(пробел) переключить',
  'permissions.footer.esc': '(esc) закрыть',
  'permissions.granted': 'Разрешено: {list}',
  'permissions.granted.none': '(нет)',

  // ---------- Окно /context ----------
  'context.title': 'Контекст',
  'context.label.tokens': 'Токены:',
  'context.label.messages': 'Сообщения:',
  'context.label.skills': 'Навыки ({n}):',
  'context.label.skills.none': '(ни одного активного)',
  'context.label.localcodeMd': 'LOCALCODE.md:',
  'context.localcodeMd.present': 'присутствует (внедрён)',
  'context.localcodeMd.absent': 'отсутствует',
  'context.footer': '(esc / enter) закрыть',

  // ---------- Окно /ctxsize ----------
  'ctxsize.title': 'Размер контекста',
  'ctxsize.draft':
    'Черновик: окно {ctx} · keep-alive {keep} · таймаут {tmo}',
  'ctxsize.row.window': 'Окно:',
  'ctxsize.row.custom': 'Своё:',
  'ctxsize.row.keepAlive': 'Keep-alive:',
  'ctxsize.row.responseTimeout': 'Таймаут ответа:',
  'ctxsize.suffix.tokens': 'токенов',
  'ctxsize.suffix.seconds': 'секунд',
  'ctxsize.suffix.secondsRange': 'секунд (30..7200)',
  'ctxsize.suffix.editHint': '   (enter — править)',
  'ctxsize.action.apply': 'Применить',
  'ctxsize.action.cancel': 'Отмена',
  'ctxsize.error': 'Ошибка: {msg}',
  'ctxsize.footer':
    '↑/↓ строки · ←/→ пресет · (enter) подтвердить/править · (esc) отмена',
  'ctxsize.note':
    'Примечание: Ollama перезагружает модель с новым num_ctx. У LM Studio контекст задаётся при загрузке модели — сначала измените его в LM Studio, потом отразите здесь. Таймаут ответа прерывает запрос, если модель не выдаёт текста столько секунд (heartbeat и thinking-блоки не считаются). Увеличьте, если модель пишет длинный код медленно.',

  // ---------- Окно /provider ----------
  'provider.title': 'Провайдер',
  'provider.url.notSet': '(не задано)',
  'provider.edit': '[править]',
  'provider.key.set': 'ключ: {mask} установлен',
  'provider.key.fromEnv': 'ключ: из переменной ${var}',
  'provider.key.notSet': 'ключ: не задан',
  'provider.key.optional': 'ключ: необязательно',
  'provider.key.notSetMask': 'не задан',
  'provider.notes.title': 'Примечания:',
  'provider.notes.openrouterRu':
    '  • OpenRouter из России: может потребоваться VPN (Россия блокирует OpenRouter напрямую). Используйте Cloudflare WARP, Outline VPN или прокси через раздел Custom.',
  'provider.notes.cloudKeys':
    '  • Облачным провайдерам нужен API-ключ — получите его в панели провайдера или задайте переменную окружения (например, $OPENAI_API_KEY).',
  'provider.warn.openrouter':
    '  ! Выбран OpenRouter — убедитесь, что openrouter.ai доступен, прежде чем применять.',
  'provider.error.customUrlRequired': 'Нужен Custom URL',
  'provider.error.cloudUrlEmpty': 'URL облачного провайдера пуст',
  'provider.error.urlScheme':
    'URL должен начинаться с http:// или https://',
  'provider.error.cloudLocalhost':
    'URL облачного провайдера не может быть localhost',
  'provider.error.apiKeyRequired':
    'Нужен API-ключ для {name}{envHint}',
  'provider.error.apiKeyEnvHint': ' (или задайте ${var})',
  'provider.error.prefix': 'Ошибка: {msg}',
  'provider.editingUrl':
    'Правка URL — Enter сохранить · Tab перейти к ключу · Esc отмена',
  'provider.editingKey':
    'Правка API-ключа (видим — очистите буфер после вставки) · Enter сохранить · Tab перейти к URL · Esc отмена',
  'provider.footer':
    '↑/↓ навигация · (пробел) выбрать · (enter) править URL · (tab/e) править ключ · (ctrl+enter / a) применить · (esc) отмена',

  // ---------- Окно /mcp добавление сервера ----------
  'mcp.add.title': 'Добавить MCP-сервер',
  'mcp.add.existing': 'Настроенные серверы: {names}',
  'mcp.add.existing.none': 'MCP-серверы ещё не настроены.',
  'mcp.add.field.name': 'Имя',
  'mcp.add.field.url': 'URL',
  'mcp.add.field.auth': 'Авторизация',
  'mcp.add.field.token': 'Токен',
  'mcp.add.field.login': 'Логин',
  'mcp.add.field.password': 'Пароль',
  'mcp.add.auth.none': 'Нет',
  'mcp.add.auth.bearer': 'Bearer-токен',
  'mcp.add.auth.basic': 'Basic (логин + пароль)',
  'mcp.add.placeholder.name': 'my-server',
  'mcp.add.placeholder.url': 'http://192.168.1.10:8080/mcp',
  'mcp.add.placeholder.token': 'вставьте токен…',
  'mcp.add.placeholder.login': 'имя пользователя',
  'mcp.add.placeholder.password': 'пароль',
  'mcp.add.notSet': '(пусто)',
  'mcp.add.secretWarn':
    'Секреты видны во время ввода — очистите буфер терминала после вставки.',
  'mcp.add.editing': 'Правка — Enter сохранить · Esc отмена',
  'mcp.add.error.prefix': 'Ошибка: {msg}',
  'mcp.add.error.nameRequired': 'Укажите имя',
  'mcp.add.error.nameInvalid':
    'Имя может содержать только буквы, цифры, точку, дефис и подчёркивание',
  'mcp.add.error.nameDuplicate': "Сервер с именем '{name}' уже существует",
  'mcp.add.error.urlRequired': 'Укажите URL',
  'mcp.add.error.urlInvalid': 'Некорректный URL (ожидается http://host:port[/path])',
  'mcp.add.error.tokenRequired': 'Укажите Bearer-токен',
  'mcp.add.error.loginRequired': 'Укажите логин',
  'mcp.add.error.passwordRequired': 'Укажите пароль',
  'mcp.add.footer':
    '↑/↓ навигация · ←/→ авторизация · (enter) править поле · (ctrl+enter / a) добавить · (esc) отмена',
  'mcp.add.toast.success':
    "MCP-сервер '{name}' добавлен. Его инструменты появятся после перезапуска localcode.",
  'mcp.add.toast.savedButError':
    "MCP-сервер '{name}' сохранён, но подключиться не удалось: {msg}. Исправьте URL/авторизацию и повторите или перезапустите localcode.",
  'mcp.add.toast.saveFailed': "Не удалось сохранить MCP-сервер '{name}': {msg}",

  // ---------- Окно /settings ----------
  'settings.title': 'Параметры генерации',
  'settings.source.globalOnly':
    'Источник: глобально (без переопределений проекта)',
  'settings.source.projectAll':
    'Источник: проект (переопределены все 4 поля)',
  'settings.source.mixed':
    'Источник: смешанный (проект переопределяет {overridden} из {total} полей)',
  'settings.field.tempLabel': 'Температура',
  'settings.field.topPLabel': 'Top-p',
  'settings.field.repeatPenaltyLabel': 'Штраф за повтор',
  'settings.field.maxTokensLabel': 'Макс. токенов',
  'settings.fieldHint.stepRange':
    'шаг {step} · диапазон [{min}..{max}]',
  'settings.project.spaceRemove': '(пробел — убрать переопределение)',
  'settings.project.spaceEnable':
    '(пробел — включить переопределение)',
  'settings.button.saveGlobal': 'Сохранить глобально',
  'settings.button.saveProject': 'Сохранить для проекта',
  'settings.button.resetProject': 'Сбросить проект',
  'settings.button.saveTimeouts': 'Сохранить таймауты',
  'settings.panel.global': 'Глобально',
  'settings.panel.global.path': '  (~/.localcode/config.toml)',
  'settings.panel.project': 'Проект',
  'settings.panel.project.suffix':
    '  (<projectRoot>/.localcode/settings.json) — {n}/{total} активно',
  'settings.panel.timeouts': 'Таймауты (глобально)',
  'settings.panel.timeouts.path':
    '  (~/.localcode/config.toml [context])',
  'settings.row.responseWait': 'Ожидание ответа',
  'settings.row.keepAlive': 'Keep-alive',
  'settings.row.custom': 'Своё',
  'settings.suffix.secondsRange': 'секунд ({min}..{max})',
  'settings.suffix.editHint': '   (enter — править)',
  'settings.error': 'Ошибка: {msg}',
  'settings.footer':
    '↑/↓ навигация · ←/→ изменить · (пробел) переопределение · (enter) сохранить раздел · (esc) закрыть',
  'settings.validate.notNumber': '{label} — не число',
  'settings.validate.outOfRange':
    '{label} вне диапазона [{min}..{max}]',
  'settings.validate.notInteger': '{label} должно быть целым',
  'settings.validate.required': '{label} обязательно',

  // ---------- Окно /resume ----------
  'resume.title': 'Возобновить прошлую сессию',
  'resume.empty': 'Сохранённых сессий пока нет.',
  'resume.untitled': '(без названия)',
  'resume.summary': 'Краткое описание:',
  'resume.summary.none': '(описания нет)',
  'resume.footer':
    '↑/↓ выбор · Enter — возобновить · Esc — закрыть · показано до 20 записей',
  'resume.footer.olderHidden': ' (ещё {n} старых скрыто)',

  // ---------- Режим планирования (баннер + значок блокировки + тосты) ----------
  // Появляется, когда `config.permissions.profile === 'plan'`.
  'plan.banner.title': 'РЕЖИМ ПЛАНА',
  'plan.banner.hint':
    'инструменты записи и команд заблокированы — Ctrl+P для выхода или /profile default',
  'plan.toolBlocked': '[БЛОКИРОВАНО В РЕЖИМЕ ПЛАНА] {tool}',
  'plan.toast.on':
    'Режим плана ВКЛЮЧЁН — инструменты правки и команд заблокированы. Нажмите Ctrl+P или /profile default чтобы выйти.',
  'plan.toast.off': 'Режим плана ВЫКЛЮЧЕН — обычный профиль восстановлен.',

  // ---------- Окно /metrics ----------
  'metrics.title': 'Метрики (локально)',
  'metrics.tab.tools': 'Инструменты',
  'metrics.tab.cache': 'Кэш',
  'metrics.tab.cost': 'Стоимость',
  'metrics.tab.sessions': 'Сессии',
  'metrics.disabled':
    'Телеметрия по согласию. Включите в ~/.localcode/config.toml [telemetry] enabled = true',
  'metrics.window': 'Окно: {start} → {end}',

  // ---------- Маркетплейс (/skills browse, /mcp browse) ----------
  'marketplace.title': 'Маркетплейс',
  'marketplace.title.skills': 'Каталог навыков (Anthropic)',
  'marketplace.title.mcp': 'Каталог MCP-серверов',
  'marketplace.empty': 'Записей нет.',
  'marketplace.loading': 'Загружаю каталог…',
  'marketplace.cached': 'из кэша {age} назад',
  'marketplace.rateLimited':
    'Достигнут лимит GitHub — показаны записи из кэша.',
  'marketplace.installed': 'Установлено: {name}',
  'marketplace.installFailed': 'Установка не удалась: {msg}',
  'marketplace.hint.global': 'установить глобально',
  'marketplace.hint.project': 'установить в проект',
  'marketplace.hint.refresh': 'обновить',

  // BATCH-APPROVAL-SECTION
  // Окно единого подтверждения, появляется когда модель просит
  // изменить N или более файлов за один ход (рефакторинг по
  // нескольким файлам).
  'batch.title': 'Подтвердите {n} изменений',
  'batch.empty': '(нет элементов для проверки)',
  'batch.hint.approve': '[space/enter] переключить',
  'batch.hint.reject': '[r] отклонить все',
  'batch.hint.all':
    '[a] принять все  [Ctrl+Enter] подтвердить  [Esc] отмена',
  'batch.status':
    'принято: {approved} · отклонено: {rejected} · ожидает: {pending}',
  // BATCH-APPROVAL-SECTION-END

  // SKILL-SUGGEST-SECTION
  // Тост подсказки навыка, появляется, когда введённый текст совпадает
  // с триггерами неактивного скилла. Tab — активировать первый,
  // Esc — скрыть. Автоматически исчезает через 8 секунд.
  'skill.suggest.toast': 'Скилл {name} подходит',
  'skill.suggest.hint.tab': 'активировать',
  'skill.suggest.hint.esc': 'скрыть',
  // SKILL-SUGGEST-SECTION-END

  // IMPORT-CMD-SECTION
  // `/import claude-code` и первая подсказка при обнаружении сессий
  // Claude Code в `~/.claude/projects/`.
  'import.title': 'Импорт из Claude Code',
  'import.scanning': 'Сканирую ~/.claude/projects…',
  'import.empty': 'Сессии Claude Code не найдены.',
  'import.projects': 'Проектов ({n})',
  'import.sessions': 'Сессий ({n})',
  'import.confirm': 'Импортировать {n} сессий?',
  'import.progress': 'Импортировано {done} из {total}',
  'import.done': 'Импортировано {imported} сессий.',
  'import.firstRun.prompt':
    'Найдены сессии Claude Code. Импортировать?',
  'import.firstRun.yes': 'Да',
  'import.firstRun.no': 'Не сейчас',
  'import.firstRun.never': 'Больше не спрашивать',
  // IMPORT-CMD-SECTION-END

  // PRESENCE-SECTION — совместная работа нескольких пользователей (только web).
  'presence.typing.one': '{name} печатает…',
  'presence.typing.many': '{n} человек печатают…',
  'presence.peers': '{n} участников',
  // PRESENCE-SECTION-END
};
