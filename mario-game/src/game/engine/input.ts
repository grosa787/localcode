import type { InputState } from '../../types';

/**
 * Keyboard + optional on-screen / mobile touch controls.
 *
 * Usage:
 * ```ts
 * const input = new InputHandler();
 * input.attach();
 *
 * // Every frame:
 * const state = input.getState();
 * if (state.left)  player.moveLeft();
 * if (state.jump)  player.jump();
 *
 * // When no longer needed:
 * input.detach();
 * ```
 */
export class InputHandler {
  /** Set of currently pressed key values (event.key). */
  keys: Set<string>;

  // ── Touch / on-screen overrides ───────────────────────────
  private _touchLeft = false;
  private _touchRight = false;
  private _touchUp = false;
  private _touchDown = false;
  private _touchJump = false;
  private _touchRun = false;

  // ── Bound handler references (used by detach) ─────────────
  private _boundKeyDown: (e: KeyboardEvent) => void;
  private _boundKeyUp: (e: KeyboardEvent) => void;
  private _boundBlur: () => void;

  constructor() {
    this.keys = new Set();

    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundKeyUp = this._onKeyUp.bind(this);
    this._boundBlur = this._onBlur.bind(this);
  }

  // ───────────────────────────────────────────────────────────
  //  Public API
  // ───────────────────────────────────────────────────────────

  /** Returns a snapshot of the current input state. */
  getState(): InputState {
    return {
      left:  this.keys.has('ArrowLeft')  || this.keys.has('a') || this.keys.has('A') || this._touchLeft,
      right: this.keys.has('ArrowRight') || this.keys.has('d') || this.keys.has('D') || this._touchRight,
      up:    this.keys.has('ArrowUp')    || this.keys.has('w') || this.keys.has('W') || this._touchUp,
      down:  this.keys.has('ArrowDown')  || this.keys.has('s') || this.keys.has('S') || this._touchDown,
      jump:  this.keys.has(' ')          || this._touchJump,
      run:   this.keys.has('Shift')      || this._touchRun,
    };
  }

  /** Start listening to keyboard events. Attach once per lifetime. */
  attach(): void {
    window.addEventListener('keydown', this._boundKeyDown);
    window.addEventListener('keyup', this._boundKeyUp);
    window.addEventListener('blur', this._boundBlur);
  }

  /** Stop listening – call when the component unmounts. */
  detach(): void {
    window.removeEventListener('keydown', this._boundKeyDown);
    window.removeEventListener('keyup', this._boundKeyUp);
    window.removeEventListener('blur', this._boundBlur);
    this.keys.clear();
  }

  // ───────────────────────────────────────────────────────────
  //  On-screen-control helpers (optional mobile / touch)
  // ───────────────────────────────────────────────────────────

  setLeft(v: boolean): void  { this._touchLeft = v; }
  setRight(v: boolean): void { this._touchRight = v; }
  setUp(v: boolean): void    { this._touchUp = v; }
  setDown(v: boolean): void  { this._touchDown = v; }
  setJump(v: boolean): void  { this._touchJump = v; }
  setRun(v: boolean): void   { this._touchRun = v; }

  /** Convenience: press a direction button (for D-pad usage). */
  pressDir(dir: 'left' | 'right' | 'up' | 'down'): void {
    if (dir === 'left')  this.setLeft(true);
    if (dir === 'right') this.setRight(true);
    if (dir === 'up')    this.setUp(true);
    if (dir === 'down')  this.setDown(true);
  }

  /** Convenience: release a direction button. */
  releaseDir(dir: 'left' | 'right' | 'up' | 'down'): void {
    if (dir === 'left')  this.setLeft(false);
    if (dir === 'right') this.setRight(false);
    if (dir === 'up')    this.setUp(false);
    if (dir === 'down')  this.setDown(false);
  }

  // ───────────────────────────────────────────────────────────
  //  Internal
  // ───────────────────────────────────────────────────────────

  private _onKeyDown(e: KeyboardEvent): void {
    // Prevent default for game keys so the page doesn't scroll
    const gameKeys = [
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      ' ', 'Shift',
      'a', 'A', 'd', 'D', 'w', 'W', 's', 'S',
    ];
    if (gameKeys.includes(e.key)) {
      e.preventDefault();
    }
    this.keys.add(e.key);
  }

  private _onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.key);
  }

  private _onBlur(): void {
    // When the window loses focus, release all keys to avoid stuck keys
    this.keys.clear();
    this._touchLeft = false;
    this._touchRight = false;
    this._touchUp = false;
    this._touchDown = false;
    this._touchJump = false;
    this._touchRun = false;
  }
}
