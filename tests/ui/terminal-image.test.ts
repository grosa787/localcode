/**
 * Wave 6A2 — terminal-image protocol detection.
 *
 * The detector is pure (`env` → protocol), so each case sets only the
 * env keys it cares about. We do NOT exercise the encoder branches
 * here — that's owned by the integration that drives `BrowserSession`
 * frames into ink. The contract under test is the precedence order
 * documented in `src/ui/terminal-image.ts`.
 */

import { describe, test, expect } from 'bun:test';
import {
  detectTerminalImageProtocol,
  type TerminalEnvSnapshot,
} from '@/ui/terminal-image';

describe('detectTerminalImageProtocol', () => {
  test('iTerm.app advertises the iterm2 protocol', () => {
    const env: TerminalEnvSnapshot = { TERM_PROGRAM: 'iTerm.app' };
    expect(detectTerminalImageProtocol(env)).toBe('iterm2');
  });

  test('WezTerm reports iterm2 (it implements the iterm2 protocol)', () => {
    const env: TerminalEnvSnapshot = { TERM_PROGRAM: 'WezTerm' };
    expect(detectTerminalImageProtocol(env)).toBe('iterm2');
  });

  test('LC_TERMINAL=iterm2 falls through to iterm2', () => {
    const env: TerminalEnvSnapshot = { LC_TERMINAL: 'iTerm2' };
    expect(detectTerminalImageProtocol(env)).toBe('iterm2');
  });

  test('Kitty detected via KITTY_WINDOW_ID', () => {
    const env: TerminalEnvSnapshot = { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' };
    expect(detectTerminalImageProtocol(env)).toBe('kitty');
  });

  test('Kitty detected via TERM substring alone', () => {
    const env: TerminalEnvSnapshot = { TERM: 'xterm-kitty' };
    expect(detectTerminalImageProtocol(env)).toBe('kitty');
  });

  test('Sixel-capable terminals detected via TERM substring', () => {
    for (const term of ['mlterm', 'foot', 'mintty', 'xterm-sixel']) {
      const env: TerminalEnvSnapshot = { TERM: term };
      expect(detectTerminalImageProtocol(env)).toBe('sixel');
    }
  });

  test('WT_SESSION (Windows Terminal) routed to sixel', () => {
    const env: TerminalEnvSnapshot = { WT_SESSION: '7d…' };
    expect(detectTerminalImageProtocol(env)).toBe('sixel');
  });

  test('Generic xterm-256color falls back to none', () => {
    const env: TerminalEnvSnapshot = { TERM: 'xterm-256color' };
    expect(detectTerminalImageProtocol(env)).toBe('none');
  });

  test('Empty env falls back to none', () => {
    expect(detectTerminalImageProtocol({})).toBe('none');
  });

  test('Explicit override beats every heuristic', () => {
    const env: TerminalEnvSnapshot = {
      TERM_PROGRAM: 'iTerm.app',
      LOCALCODE_IMAGE_PROTOCOL: 'none',
    };
    expect(detectTerminalImageProtocol(env)).toBe('none');
  });

  test('Override accepts kitty too', () => {
    const env: TerminalEnvSnapshot = {
      TERM_PROGRAM: 'iTerm.app',
      LOCALCODE_IMAGE_PROTOCOL: 'kitty',
    };
    expect(detectTerminalImageProtocol(env)).toBe('kitty');
  });

  test('Unknown override falls through to the heuristic path', () => {
    const env: TerminalEnvSnapshot = {
      TERM_PROGRAM: 'iTerm.app',
      LOCALCODE_IMAGE_PROTOCOL: 'svg',
    };
    expect(detectTerminalImageProtocol(env)).toBe('iterm2');
  });

  test('Override is case-insensitive and tolerates whitespace', () => {
    const env: TerminalEnvSnapshot = {
      LOCALCODE_IMAGE_PROTOCOL: '  KITTY  ',
    };
    expect(detectTerminalImageProtocol(env)).toBe('kitty');
  });
});
