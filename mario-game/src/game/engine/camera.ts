/**
 * Camera – follows the player through the level.
 *
 * - `follow()` repositions so the target is centred, clamped to level bounds.
 * - `worldToScreen()` converts world → screen coordinates.
 * - `isVisible()` culls off-screen entities.
 */
export class Camera {
  x: number;
  y: number;
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.x = 0;
    this.y = 0;
    this.width = width;
    this.height = height;
  }

  /**
   * Reposition the camera so `target` is roughly centred in the viewport,
   * clamped to the level's boundaries so that no dead space is shown.
   */
  follow(
    target: { x: number; y: number },
    levelWidth: number,
    levelHeight: number,
  ): void {
    // Centre the camera on the target
    let camX = target.x - this.width / 2;
    let camY = target.y - this.height / 2;

    // Clamp to level bounds (assumes level is at least as big as the viewport)
    camX = Math.max(0, Math.min(camX, levelWidth - this.width));
    camY = Math.max(0, Math.min(camY, levelHeight - this.height));

    this.x = camX;
    this.y = camY;
  }

  /**
   * Convert a world-space position to screen-space relative to the camera.
   */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: worldX - this.x,
      y: worldY - this.y,
    };
  }

  /**
   * Returns `true` if the axis-aligned bounding box of an entity is
   * within (or touching) the camera's visible rectangle.
   */
  isVisible(
    entity: { x: number; y: number; width: number; height: number },
  ): boolean {
    return (
      entity.x + entity.width >= this.x &&
      entity.x <= this.x + this.width &&
      entity.y + entity.height >= this.y &&
      entity.y <= this.y + this.height
    );
  }
}
