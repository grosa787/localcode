import { GameEntity, EntityType, TileType, Direction, Rect, Sprite } from '../types';

export class Goomba implements GameEntity {
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
  
  squished: boolean;
  squishTimer: number;

  constructor(x: number, y: number) {
    this.id = Math.random().toString(36).slice(2, 9) + 'Goomba';
    this.type = 'Goomba';
    this.x = x;
    this.y = y;
    this.width = 32;
    this.height = 32;
    this.vx = -50; // Walk left initially
    this.vy = 0;
    this.active = true;
    this.grounded = false;
    this.facing = 'left';
    this.squished = false;
    this.squishTimer = 0;
  }

  update(dt: number, tiles: TileType[][], entities: GameEntity[]): void {
    if (!this.active) return;

    if (this.squished) {
      this.squishTimer -= dt;
      if (this.squishTimer <= 0) {
        this.active = false;
      }
      return;
    }

    // Apply gravity
    this.vy += 800 * dt;
    
    if (this.vy > 400) {
      this.vy = 400;
    }

    // Horizontal movement
    this.x += this.vx * dt;
    
    // Update facing based on movement
    if (this.vx > 0) {
      this.facing = 'right';
    } else if (this.vx < 0) {
      this.facing = 'left';
    }

    // Update vertical position
    this.y += this.vy * dt;

    // Ground and wall collision
    this.handleCollisions(tiles);
  }

  handleCollisions(tiles: TileType[][]): void {
    const bounds = this.getBounds();
    const leftTile = Math.floor(bounds.left / 32);
    const rightTile = Math.floor(bounds.right / 32);
    const topTile = Math.floor(bounds.top / 32);
    const bottomTile = Math.floor(bounds.bottom / 32);

    const levelWidth = tiles[0]?.length * 32 || 0;
    const levelHeight = tiles.length * 32 || 0;

    // Check horizontal collisions
    let willTurn = false;
    
    // Check wall collisions
    if (this.vx < 0) { // Moving left
      if (leftTile >= 0 && topTile < tiles.length && leftTile < tiles[topTile].length) {
        const leftTileType = tiles[topTile][leftTile];
        const leftTopTileType = tiles[topTile] && tiles[topTile][leftTile - 1];
        
        if (leftTileType && leftTileType !== 'Empty') {
          this.x = (leftTile + 1) * 32;
          willTurn = true;
        }
      }
    } else if (this.vx > 0) { // Moving right
      if (rightTile >= 0 && topTile < tiles.length && rightTile < tiles[topTile].length) {
        const rightTileType = tiles[topTile][rightTile];
        const rightTopTileType = tiles[topTile] && tiles[topTile][rightTile + 1];
        
        if (rightTileType && rightTileType !== 'Empty') {
          this.x = (rightTile * 32) - this.width;
          willTurn = true;
        }
      }
    }

    // Check platform edge - turn around if about to fall off
    if (!willTurn) {
      // Look ahead for edge
      const lookAheadTile = this.vx < 0 ? leftTile - 1 : rightTile + 1;
      const currentTileX = Math.floor((this.x + this.width/2) / 32);
      const nextTileX = this.vx < 0 ? currentTileX - 1 : currentTileX + 1;
      
      if (nextTileX >= 0 && nextTileX < (tiles[bottomTile]?.length || 0)) {
        if (tiles[bottomTile+1] && !tiles[bottomTile+1][nextTileX]) {
          // Next tile position will be empty space - turn around
          willTurn = true;
        }
      }
    }

    // Turn around if needed
    if (willTurn) {
      this.vx = -this.vx;
      this.facing = this.vx > 0 ? 'right' : 'left';
    }

    // Check vertical collisions
    if (this.vy > 0) { // Falling
      if (bottomTile < tiles.length && leftTile < tiles[bottomTile].length && rightTile < tiles[bottomTile].length) {
        const leftBottomTile = tiles[bottomTile][leftTile];
        const rightBottomTile = tiles[bottomTile][rightTile];
        
        if (leftBottomTile && leftBottomTile !== 'Empty') {
          this.y = bottomTile * 32 - this.height;
          this.vy = 0;
          this.grounded = true;
        } else if (rightBottomTile && rightBottomTile !== 'Empty') {
          this.y = bottomTile * 32 - this.height;
          this.vy = 0;
          this.grounded = true;
        }
      }
    }

    // Check bounds
    if (this.x < 0) {
      this.x = 0;
      this.vx = -this.vx;
      this.facing = 'right';
    }

    if (this.x + this.width > levelWidth) {
      this.x = levelWidth - this.width;
      this.vx = -this.vx;
      this.facing = 'left';
    }
  }

  getBounds() {
    return {
      left: this.x,
      right: this.x + this.width,
      top: this.y,
      bottom: this.y + this.height
    };
  }

  squish(): void {
    if (!this.squished) {
      this.squished = true;
      this.squishTimer = 0.5;
    }
  }

  getRect(): Rect {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  getSprite(): Sprite | null {
    return null;
  }
}