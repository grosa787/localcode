import type { LevelData, TileType, EntityType } from '../types';

// Helper function to create a row of empty tiles
const createEmptyRow(width: number): TileType[] {
  return Array(width).fill('Empty');
}

// Helper function to create a row of a specific tile type
const createFilledRow(width: number, tile: TileType): TileType[] {
  return Array(width).fill(tile);
}

// Helper function to replace tiles at specific positions
const withTile = (
  tiles: TileType[][],
  tile: TileType,
  row: number,
  col: number
): TileType[][] => {
  const newRow = [...tiles[row]];
  newRow[col] = tile;
  return [...tiles.slice(0, row), newRow, ...tiles.slice(row + 1)];
};

const level1: LevelData = {
  name: 'Level 1-1 (Mario Style)',
  tileSize: 32,
  width: 150, // Reduced from 212 for playability
  height: 15, // 13-14 visible + ground row
  backgroundColor: '#5c94fc', // Classic Mario sky blue

  // Base ground layer (rows 13-14)
  tiles: (() => {
    let tiles: TileType[][] = [];
    for (let row = 0; row < 15; row++) {
      if (row >= 13) {
        tiles.push(createFilledRow(150, 'Ground'));
      } else {
        tiles.push(createEmptyRow(150));
      }
    }

    // Player spawn point (row 13, col 48)
    // y = row * 32 + (ground height adjustment)
    return tiles;
  })(),

  entities: [
    // Goombas on the ground
    { type: 'Goomba', x: 96, y: 352 },
    { type: 'Goomba', x: 192, y: 352 },
    { type: 'Goomba', x: 352, y: 352 },
    { type: 'Goomba', x: 576, y: 352 },
    { type: 'Goomba', x: 768, y: 352 },
    { type: 'Goomba', x: 960, y: 352 },

    // Coins in question blocks
    { type: 'Coin', x: 160, y: 320 },
    { type: 'Coin', x: 288, y: 256 },
    { type: 'Coin', x: 448, y: 384 },
    { type: 'Coin', x: 512, y: 224 },
    { type: 'Coin', x: 640, y: 320 },
    { type: 'Coin', x: 704, y: 256 },
    { type: 'Coin', x: 896, y: 384 },
    { type: 'Coin', x: 1024, y: 320 },
    { type: 'Coin', x: 1152, y: 384 },
    { type: 'Coin', x: 1216, y: 256 },

    // Mushroom spawns (spawn from question blocks, but these are tracking coins for entities)
    { type: 'Coin', x: 224, y: 384 }, // Mushroom block
    { type: 'Coin', x: 512, y: 320 }, // Mushroom block
  ],

  playerSpawn: { x: 48, y: 352 }, // On the ground
};

// Functions to set up the level programmatically
level1.tiles = (() => {
  let tiles: TileType[][] = [];
  for (let row = 0; row < 15; row++) {
    if (row >= 13) {
      tiles.push(createFilledRow(150, 'Ground'));
    } else {
      tiles.push(createEmptyRow(150));
    }
  }

  // Section 1: Question blocks (row 9, cols 16-23)
  // Brick (2) at x=16, QuestionBlock (3) at x=17
  tiles = withTile(tiles, 'Brick', 9, 16);
  tiles = withTile(tiles, 'QuestionBlock', 9, 17);
  // QuestionBlock at x=20
  tiles = withTile(tiles, 'QuestionBlock', 9, 20);
  // QuestionBlock at x=22
  tiles = withTile(tiles, 'QuestionBlock', 9, 22);

  // Section 2: More question blocks and pipes (x: 24-36)
  // Pipe 1 at x=24
  tiles = withTile(tiles, 'PipeTopLeft', 10, 24);
  tiles = withTile(tiles, 'PipeBodyLeft', 11, 24);
  tiles = withTile(tiles, 'PipeBodyLeft', 12, 24);
  // Pipe 2 at x=32
  tiles = withTile(tiles, 'PipeTopRight', 9, 32);
  tiles = withTile(tiles, 'PipeBodyRight', 10, 32);
  tiles = withTile(tiles, 'PipeBodyRight', 11, 32);
  tiles = withTile(tiles, 'PipeBodyRight', 12, 32);

  // Section 3: Hard blocks and question blocks (x: 48-64)
  tiles = withTile(tiles, 'HardBlock', 7, 48);
  tiles = withTile(tiles, 'HardBlock', 7, 50);
  tiles = withTile(tiles, 'HardBlock', 7, 52);
  tiles = withTile(tiles, 'HardBlock', 7, 54);
  tiles = withTile(tiles, 'QuestionBlock', 9, 56);
  tiles = withTile(tiles, 'QuestionBlock', 9, 57);
  tiles = withTile(tiles, 'QuestionBlock', 9, 58);
  tiles = withTile(tiles, 'QuestionBlock', 9, 59);

  // Section 4: Another pipe and platforms (x: 64-80)
  tiles = withTile(tiles, 'PipeTopLeft', 8, 64);
  tiles = withTile(tiles, 'PipeBodyLeft', 9, 64);
  tiles = withTile(tiles, 'PipeBodyLeft', 10, 64);
  tiles = withTile(tiles, 'PipeBodyLeft', 11, 64);
  tiles = withTile(tiles, 'PipeBodyLeft', 12, 64);
  // Question blocks on pipe
  tiles = withTile(tiles, 'QuestionBlock', 7, 66);
  tiles = withTile(tiles, 'QuestionBlock', 7, 68);

  // Section 5: Tall platform with question blocks (x: 80-96)
  for (let i = 80; i < 88; i++) {
    tiles = withTile(tiles, 'Brick', 7, i);
  }
  tiles = withTile(tiles, 'QuestionBlock', 5, 80);
  tiles = withTile(tiles, 'QuestionBlock', 5, 82);
  tiles = withTile(tiles, 'QuestionBlock', 5, 84);
  tiles = withTile(tiles, 'QuestionBlock', 5, 86);
  tiles = withTile(tiles, 'QuestionBlock', 5, 88);

  // Section 6: Another pipe section (x: 96-112)
  tiles = withTile(tiles, 'PipeTopRight', 6, 96);
  tiles = withTile(tiles, 'PipeBodyRight', 7, 96);
  tiles = withTile(tiles, 'PipeBodyRight', 8, 96);
  tiles = withTile(tiles, 'PipeBodyRight', 9, 96);
  tiles = withTile(tiles, 'PipeBodyRight', 10, 96);
  tiles = withTile(tiles, 'PipeBodyRight', 11, 96);
  tiles = withTile(tiles, 'PipeBodyRight', 12, 96);

  // Section 7: Floating platforms with question blocks (x: 112-128)
  // Hard blocks
  for (let i = 112; i < 120; i++) {
    tiles = withTile(tiles, 'HardBlock', 10, i);
  }
  // Question blocks
  tiles = withTile(tiles, 'QuestionBlock', 8, 112);
  tiles = withTile(tiles, 'QuestionBlock', 8, 114);
  tiles = withTile(tiles, 'QuestionBlock', 8, 116);
  tiles = withTile(tiles, 'QuestionBlock', 8, 118);

  // Section 8: High platforms (x: 128-144)
  for (let i = 128; i < 136; i++) {
    tiles = withTile(tiles, 'Brick', 5, i);
  }
  tiles = withTile(tiles, 'QuestionBlock', 3, 130);
  tiles = withTile(tiles, 'QuestionBlock', 3, 132);
  tiles = withTile(tiles, 'QuestionBlock', 3, 134);
  tiles = withTile(tiles, 'QuestionBlock', 3, 136);

  // Section 9: Final section (x: 144-150)
  for (let i = 144; i < 148; i++) {
    tiles = withTile(tiles, 'HardBlock', 8, i);
  }
  // Final question block
  tiles = withTile(tiles, 'QuestionBlock', 9, 144);
  // Flag pole
  tiles = withTile(tiles, 'FlagPole', 4, 145);
  tiles = withTile(tiles, 'FlagPole', 5, 145);
  tiles = withTile(tiles, 'FlagPole', 6, 145);
  tiles = withTile(tiles, 'FlagPole', 7, 145);
  tiles = withTile(tiles, 'FlagPole', 8, 145);
  tiles = withTile(tiles, 'FlagPole', 9, 145);
  tiles = withTile(tiles, 'FlagPole', 10, 145);
  tiles = withTile(tiles, 'FlagPole', 11, 145);
  tiles = withTile(tiles, 'FlagPole', 12, 145);
  tiles = withTile(tiles, 'FlagTop', 13, 145);

  return tiles;
})();

export default level1;
