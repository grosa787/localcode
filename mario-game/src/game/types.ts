// ── Tile types ──────────────────────────────────────────────
export type TileType =
  | 'Ground'
  | 'Brick'
  | 'QuestionBlock'
  | 'UsedBlock'
  | 'PipeTopLeft'
  | 'PipeTopRight'
  | 'PipeBodyLeft'
  | 'PipeBodyRight'
  | 'HardBlock'
  | 'FlagPole'
  | 'FlagTop'
  | 'Empty';

// ── Entity types ────────────────────────────────────────────
export type EntityType =
  | 'MarioSmall'
  | 'MarioBig'
  | 'MarioFire'
  | 'Goomba'
  | 'Coin'
  | 'Mushroom'
  | 'Flower'
  | 'Star'
  | 'Bullet';

// ── A pixel-art sprite ──────────────────────────────────────
export interface Sprite {
  pixels: string[][];   // 2D array of hex colours "#RRGGBB" or "" (transparent)
  width: number;
  height: number;
}

// ── Input state snapshot ────────────────────────────────────
export interface InputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  run: boolean;
}

// ── Level data structure ─────────────────────────────────────
export interface LevelData {
  tiles: TileType[][];
  entities: LevelEntity[];
  playerSpawn: { x: number; y: number };
  width: number;
  height: number;
  tileSize: number;
  backgroundColor: string;
  name: string;
}

export interface LevelEntity {
  type: EntityType;
  x: number;
  y: number;
}

// ── Direction ─────────────────────────────────────────────────
export type Direction = 'left' | 'right';

// ── Mario state ─────────────────────────────────────────────
export type MarioState = 'Small' | 'Big' | 'Fire' | 'Dead';

// ── Rectangle ───────────────────────────────────────────────
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Game entity interface ────────────────────────────────────
export interface GameEntity {
  id: string;
  type: EntityType;
  x: number; y: number;
  width: number; height: number;
  vx: number; vy: number;
  active: boolean;
  grounded: boolean;
  facing: Direction;
  update(dt: number, tiles: TileType[][], entities: GameEntity[]): void;
  getRect(): Rect;
  getSprite(): Sprite | null;
}
