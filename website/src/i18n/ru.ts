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
        icon: 'brain',
        title: 'Skills и память',
        body: 'Markdown-навыки автоматически. Память проекта живёт между сессиями.',
      },
      {
        icon: 'tools',
        title: 'Богатый инструментарий',
        body: 'read/write/edit, run, glob, lint, find_symbol, fetch_image, MCP, плагины.',
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
      {
        icon: 'agent',
        title: 'Sub-agents',
        body: 'Architect, debugger, security-reviewer — спецагенты из готового каталога.',
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
