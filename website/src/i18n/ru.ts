import type { Strings } from './types';

export const ru: Strings = {
  nav: {
    install: 'Установка',
    features: 'Возможности',
    docs: 'Документация',
    github: 'GitHub',
  },
  hero: {
    tagline: 'Терминал, который правда понимает твой код.',
    subtitle:
      'LocalCode — локальный AI-ассистент для разработки. Подключайте любую модель — Ollama, Anthropic, OpenAI, OpenRouter, всё OpenAI-совместимое. Терминал + браузер. Прозрачно. Быстро.',
    installCta: 'Установить за 10 секунд',
    copy: 'Копировать',
    copied: 'Скопировано',
    versionBadge: 'v0.21 — локально-first',
  },
  install: {
    heading: 'Одна команда. Без Electron. Без телеметрии.',
    subheading: 'Выберите платформу — подходящая команда подсвечена.',
    macos: 'macOS',
    linux: 'Linux',
    wsl: 'WSL',
    windows: 'Windows',
  },
  features: {
    heading: 'Почему LocalCode',
    tiles: [
      {
        icon: 'spark',
        title: 'Любая модель',
        body: 'Ollama, LM Studio, Anthropic, OpenAI, OpenRouter, Gemini, Groq. Переключение слэшем.',
      },
      {
        icon: 'shield',
        title: 'Подтверждение действий',
        body: 'Diff-предпросмотр. Превью команд. Точечное автоодобрение. Пять профилей доступа.',
      },
      {
        icon: 'bolt',
        title: 'Два интерфейса, один мозг',
        body: 'Ink-TUI и настоящий веб с табами, доком, голосом, drag-drop, PDF и whiteboard.',
      },
      {
        icon: 'tools',
        title: '30+ инструментов из коробки',
        body: 'read_file, edit_file, run_command, glob_search, lint_file, find_symbol, fetch_image, web_search и другие.',
      },
      {
        icon: 'agent',
        title: 'Sub-agents по требованию',
        body: 'Architect, debugger, security-reviewer — спецагенты из готового каталога через /spawn.',
      },
      {
        icon: 'brain',
        title: 'Память, skills, hooks и MCP',
        body: 'Markdown-навыки с горячей перезагрузкой. Память проекта. Hooks через настройки. Любые MCP-сервера.',
      },
      {
        icon: 'branch',
        title: 'Ветвящиеся сессии и /undo',
        body: 'Ответвите любой ход в side branch. Откатите вызов инструмента без потери диалога.',
      },
      {
        icon: 'graph',
        title: 'Онтология кода',
        body: 'LSP-инструменты строят карту символов, ссылок и типов по всему репозиторию.',
      },
      {
        icon: 'compass',
        title: 'Архитектурные правила',
        body: '.localcode/arch.toml описывает разрешённые импорты между модулями. Нарушения блокируют правки.',
      },
      {
        icon: 'shieldKey',
        title: 'Сканер секретов',
        body: 'Ключи, токены и пути к .env подсвечиваются до того, как попадут в diff или коммит.',
      },
      {
        icon: 'network',
        title: 'LAN P2P шаринг сессий',
        body: 'Пиры из локальной сети находятся через mDNS и подключаются к вашей сессии. Без облачного релея.',
      },
      {
        icon: 'palette',
        title: 'Whiteboard, PDF, голос',
        body: 'Перетащите PDF, рисуйте на whiteboard, диктуйте следующий шаг — всё в веб-интерфейсе.',
      },
      {
        icon: 'refresh',
        title: 'Автообновление delta-патчами',
        body: 'Фоновое самообновление. Bsdiff/xdelta-патчи держат обновления маленькими.',
      },
      {
        icon: 'usb',
        title: 'MCP + плагины',
        body: 'Подключайте любые MCP-сервера. Кастомные плагины как инструменты модели.',
      },
      {
        icon: 'lock',
        title: 'Локально-first',
        body: 'Один Bun-бинарник. SQLite-сессии. Никаких облачных вызовов без вашего согласия.',
      },
    ],
  },
  commands: {
    heading: 'Слэш-команды',
    subheading: 'Мощные действия в одно нажатие.',
    items: [
      { cmd: '/web', body: 'Открыть веб-UI в браузере — табы, файлы, сессии, голос.' },
      { cmd: '/update', body: 'Обновиться до последнего релиза. Delta-патчи держат всё маленьким.' },
      { cmd: '/diff', body: 'Показать все ожидающие diff-ы за сессию до коммита.' },
      { cmd: '/branch', body: 'Ответвить текущий ход в side branch. Пробуйте идеи, не теряя контекст.' },
      { cmd: '/spawn', body: 'Запустить sub-agent — architect, debugger, security-reviewer — на подзадачу.' },
      { cmd: '/usage', body: 'Разбор токенов и стоимости по моделям в текущей сессии.' },
      { cmd: '/language', body: 'Переключить язык интерфейса. EN / RU встроены.' },
      { cmd: '/undo', body: 'Откатить последний вызов инструмента, сохраняя историю чата.' },
    ],
  },
  profiles: {
    heading: 'Профили доступа',
    subheading: 'Пять пресетов. Переключение через /permissions.',
    items: [
      { name: 'Только чтение', body: 'Read-инструменты — авто. Любое изменение требует подтверждения.' },
      { name: 'Осторожный', body: 'По умолчанию. Read — авто, на каждый write/run — превью diff или команды.' },
      { name: 'Доверенные правки', body: 'Правки в корне проекта — авто. Shell-команды всё ещё запрашивают подтверждение.' },
      { name: 'Доверенный shell', body: 'Правки + shell внутри проекта — авто. Сетевые вызовы запрашиваются.' },
      { name: 'Без ограничений', body: 'Всё авто. Только для одноразовых песочниц.' },
    ],
  },
  privacy: {
    heading: 'Приватность и безопасность',
    points: [
      {
        title: 'Локально-first по дизайну',
        body: 'Один Bun-бинарник работает у вас на машине. Сессии, настройки и skills — в ~/.localcode и вашем проекте.',
      },
      {
        title: 'Никакой телеметрии',
        body: 'Ваш код не покидает машину, пока вы сами не выберете облачную модель. И даже тогда — только промпт, без файловой системы.',
      },
      {
        title: 'Подписанные и notarized релизы',
        body: 'macOS-сборки подписаны и notarized у Apple. Linux-релизы с контрольными суммами и подписями.',
      },
      {
        title: 'Сканер секретов блокирует утечки',
        body: 'Ключи, токены и содержимое .env обнаруживаются до того, как попадут в diff или shell. По умолчанию — блокирующий режим.',
      },
    ],
  },
  surfaces: {
    heading: 'Два интерфейса, один мозг',
    tui: 'Терминал',
    web: 'Веб',
    toggle: 'Переключить',
  },
  demo: {
    heading: 'Посмотрите в движении',
    caption: 'Вызов инструмента с предпросмотром diff, подтверждением и стримингом. (placeholder gif)',
  },
  channels: {
    heading: 'Каналы установки',
    soon: 'скоро',
  },
  footer: {
    tagline: 'Сделано с любовью, не на вайбах.',
    license: 'Лицензия MIT',
    contact: 'Связь',
    contactValue: 'откройте issue на GitHub',
  },
};
