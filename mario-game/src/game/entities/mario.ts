import { GameEntity, EntityType, TileType, Direction, MarioState, Rect, Sprite } from '../types';

export class Mario implements GameEntity {
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
  
  state: MarioState;
  cooldown: number;
  invincibleTimer: number;
  mushroomSound: boolean;

  constructor(x: number, y: number) {
    this.id = Math.random().toString(36).slice(2, 9) + 'Mario';
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.active = true;
    this.grounded = false;
    this.facing = 'right';
    this.state = 'Small';
    this.width = 24;
    this.height = 32;
    this.cooldown = 0;
    this.invincibleTimer = 0;
    this.mushroomSound = false;
    this.type = 'MarioSmall';
  }

  update(dt: number, tiles: TileType[][], entities: GameEntity[]): void {
    if (!this.active) return;

    // Handle death animation
    if (this.state === 'Dead') {
      this.vy += 0.8 * dt; // gravity
      this.y += this.vy * dt;
      return;
    }

    // Update timer
    if (this.invincibleTimer > 0) {
      this.invincibleTimer -= dt;
    }

    if (this.cooldown > 0) {
      this.cooldown -= dt;
    }

    // Simplified input handling with direct values
    const inputSpeed = 120;
    const runMultiplier = 1.5;
    const jumpForce = -320;
    const jumpPressed = false; // This should come from input state
    const run = false; // This should come from input state
    
    const inputLeft = false; // This should come from input state
    const inputRight = false; // This should come from input state

    // Horizontal movement
    this.vx = inputLeft * -inputSpeed * (run ? runMultiplier : 1) + 
             inputRight * inputSpeed * (run ? runMultiplier : 1);

    // Jumping
    if (this.grounded && jumpPressed) {
      this.vy = jumpForce;
      this.grounded = false;
    }

    // Apply gravity
    this.vy += 800 * dt;

    // Cap vertical velocity
    if (this.vy > 400) {
      this.vy = 400;
    }

    // Update facing based on movement
    if (this.vx > 0) {
      this.facing = 'right';
    } else if (this.vx < 0) {
      this.facing = 'left';
    }

    // Update position
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Ground collision (simplified)
    const tileX = Math.floor(this.x / 32);
    const tileY = Math.floor(this.y / 32);
    const nextTileY = Math.floor((this.y + this.height) / 32);
    
    if (nextTileY < tiles.length && tileX < tiles[nextTileY].length) {
      const tileBelow = tiles[nextTileY][tileX];
      if (tileBelow && tileBelow !== 'Empty') {
        const groundY = nextTileY * 32;
        if (this.y + this.height >= groundY && this.vy >= 0) {
          this.y = groundY - this.height;
          this.vy = 0;
          this.grounded = true;
        }
      }
    }

    // Collision checks
    this.checkCoinCollision(tiles, entities);
    this.checkEnemyCollisions(entities);
    this.handlePowerUps(entities);
  }

  checkCoinCollision(tiles: TileType[][], entities: GameEntity[]): void {
    for (const entity of entities) {
      if (entity.type === 'Coin' && entity.active && this.isColliding(entity)) {
        entity.active = false;
        // Should add score here - +200
      }
    }
  }

  checkEnemyCollisions(entities: GameEntity[]): void {
    for (const entity of entities) {
      if ((entity.type === 'Goomba') && entity.active) {
        const marioRect = this.getRect();
        const enemyRect = entity.getRect();
        
        if (this.isColliding(entity)) {
          const marioBottom = marioRect.y + marioRect.height;
          const enemyTop = enemyRect.y;
          const enemyBottom = enemyRect.y + enemyRect.height;
          const marioCenterX = marioRect.x + marioRect.width / 2;
          const enemyLeft = enemyRect.x;
          const enemyRight = enemyRect.x + enemyRect.width;

          // Jumping on top of enemy
          if (marioBottom - enemyTop < 20 && this.vy > 0 && marioCenterX > enemyLeft && marioCenterX < enemyRight) {
            entity.active = false;
            this.vy = -150; // Bounce
          } else {
            // Mario takes damage
            if (this.state === 'Small') {
              this.state = 'Dead';
              this.vy = -250; // Death jump
            } else if (this.state === 'Big' || this.state === 'Fire') {
              this.state = 'Small';
              this.invincibleTimer = 1.0;
              this.updateSize();
            }
          }
        }
      }
    }
  }

  handlePowerUps(entities: GameEntity[]): void {
    for (const entity of entities) {
      if (!entity.active) continue;
      
      if (entity.type === 'Mushroom' && this.isColliding(entity)) {
        entity.active = false;
        this.state = 'Big';
        this.updateSize();
        this.mushroomSound = true;
      }
    }
  }

  isColliding(other: GameEntity): boolean {
    const rect1 = this.getRect();
    const rect2 = other.getRect();
    
    return rect1.x < rect2.x + rect2.width &&
           rect1.x + rect1.width > rect2.x &&
           rect1.y < rect2.y + rect2.height &&
           rect1.y + rect1.height > rect2.y;
  }

  updateSize(): void {
    if (this.state === 'Small') {
      this.height = 32;
      this.type = 'MarioSmall';
    } else {
      this.height = 48;
      this.type = this.state === 'Fire' ? 'MarioFire' : 'MarioBig';
    }
  }

  getRect(): Rect {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  getSprite(): Sprite | null {
    // Return null - sprite will be added by renderer from sprites.ts
    return null;
  }
}