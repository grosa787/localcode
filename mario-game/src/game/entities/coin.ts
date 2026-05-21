import { GameEntity, EntityType, TileType, Direction, Rect, Sprite } from '../types';

export class Coin implements GameEntity {
  id: string;
  type: EntityType;
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  active: boolean;
  grounded: boolean;
  facing: Direction;
  
  animated: boolean;
  frameTimer: number;

  constructor(x: number, y: number) {
    this.id = Math.random().toString(36).slice(2, 9) + 'Coin';
    this.type = 'Coin';
    this.x = x;
    this.y = y;
    this.width = 24;
    this.height = 32;
    this.vx = 0;
    this.vy = 0;
    this.active = true;
    this.grounded = false;
    this.facing = 'right';
    this.animated = true;
    this.frameTimer = 0;
  }

  update(dt: number, tiles: TileType[][], entities: GameEntity[]): void {
    if (!this.active) return;

    // Update animation timer
    this.frameTimer += dt;
    if (this.frameTimer > 0.2) {
      this.frameTimer = 0;
    }

    // Coins are static - no movement
    // They can be collected by collision check in other entities
  }

  // Get current animation frame - this would be used by the renderer
  getAnimationFrame(): number {
    return Math.floor(this.frameTimer * 8) % 4;
  }

  getRect(): Rect {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  getSprite(): Sprite | null {
    return null;
  }
}