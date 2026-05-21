import type { TileType, EntityType, Sprite } from '../types';

// ─────────────────────────────────────────────────────────────
//  Helper – fill a row with a single colour (for solid blocks)
// ─────────────────────────────────────────────────────────────
function solidRow(colour: string, w: number): string[] {
  return Array(w).fill(colour);
}

// ─────────────────────────────────────────────────────────────
//  Helper – fill a row with alternating colours (e.g. brick)
// ─────────────────────────────────────────────────────────────
function patternedRow(
  pattern: string[],
  w: number,
): string[] {
  const row: string[] = [];
  for (let i = 0; i < w; i++) {
    row.push(pattern[i % pattern.length]);
  }
  return row;
}

// ─────────────────────────────────────────────────────────────
//  Helper – wrap a solid rectangle inside an empty border
// ─────────────────────────────────────────────────────────────
function borderedSolid(
  fill: string,
  border: string,
  w: number,
  h: number,
): string[][] {
  const pixels: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      if (y === 0 || y === h - 1 || x === 0 || x === w - 1) {
        row.push(border);
      } else {
        row.push(fill);
      }
    }
    pixels.push(row);
  }
  return pixels;
}

// ─────────────────────────────────────────────────────────────
//  TILE SPRITES (all 16×16 unless noted)
// ─────────────────────────────────────────────────────────────
const TILE_W = 16;
const TILE_H = 16;

const groundPattern: string[][] = (() => {
  const rows: string[][] = [];
  const base = '#8B4513';
  const dark = '#6B3410';
  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < TILE_W; x++) {
      // Sprinkle dark dots for texture
      if ((x + y) % 4 === 0 || (x + y) % 7 === 0) {
        row.push(dark);
      } else {
        row.push(base);
      }
    }
    rows.push(row);
  }
  return rows;
})();

const brickPattern: string[][] = (() => {
  const rows: string[][] = [];
  const brick = '#C67B30';
  const mortar = '#8B5A2B';
  const darkBrick = '#A06220';

  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = [];
    // Brick rows: every 4 pixels is a brick height
    const brickRow = Math.floor(y / 4);
    const inBrick = y % 4;
    for (let x = 0; x < TILE_W; x++) {
      // Mortar line at top of each brick
      if (inBrick === 0) {
        row.push(mortar);
      } else if (inBrick === 1 || inBrick === 2) {
        // Brick body
        const offset = brickRow % 2 === 1 ? 4 : 0; // stagger
        const brickX = (x - offset + TILE_W) % TILE_W;
        if (brickX === 0 || brickX === 7) {
          row.push(mortar);
        } else {
          row.push(brick);
        }
      } else {
        // inBrick === 3 – bottom of brick with a little detail
        const offset = brickRow % 2 === 1 ? 4 : 0;
        const brickX = (x - offset + TILE_W) % TILE_W;
        if (brickX === 0 || brickX === 7) {
          row.push(mortar);
        } else if (brickX === 3 || brickX === 5) {
          row.push(darkBrick);
        } else {
          row.push(brick);
        }
      }
    }
    rows.push(row);
  }
  return rows;
})();

// Question block – yellow with a white "?"
const questionBlock: string[][] = (() => {
  const rows: string[][] = [];
  const bg = '#FFD700';
  const border = '#B8860B';
  const question = '#FFFFFF';
  const shadow = '#DAA520';

  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < TILE_W; x++) {
      // border
      if (y === 0 || y === TILE_H - 1 || x === 0 || x === TILE_W - 1) {
        row.push(border);
      }
      // Question mark "?" shape – roughly 6x10 in centre
      else if (
        // top curve
        (y === 3 && x >= 5 && x <= 10) ||
        (y === 4 && (x === 5 || x === 10)) ||
        (y === 5 && x === 10) ||
        (y === 6 && x === 9) ||
        (y === 7 && x === 8) ||
        (y === 7 && x === 9) ||
        // dot
        (y === 9 && x >= 7 && x <= 9)
      ) {
        row.push(question);
      } else if (
        // subtle inner shadow for depth
        (y === 2 && x >= 1 && x <= 14) ||
        (x === 1 && y >= 2 && y <= 13)
      ) {
        row.push(shadow);
      } else {
        row.push(bg);
      }
    }
    rows.push(row);
  }
  return rows;
})();

const usedBlock: string[][] = (() => {
  const rows: string[][] = [];
  const fill = '#8B7355';
  const border = '#6B5335';

  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < TILE_W; x++) {
      if (y === 0 || y === TILE_H - 1 || x === 0 || x === TILE_W - 1) {
        row.push(border);
      } else {
        row.push(fill);
      }
    }
    rows.push(row);
  }
  return rows;
})();

function makePipeSprite(
  isTop: boolean,
  isLeft: boolean,
): string[][] {
  const rows: string[][] = [];
  const body = '#00AA00';
  const highlight = '#00DD00';
  const dark = '#007700';
  const outline = '#005500';

  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = [];
    // Pipe top is shorter (rows 0-3) with wider brim
    const inTop = isTop && y < 4;
    const brimTop = isTop && y < 2;
    const brimBottom = isTop && y === 3;

    for (let x = 0; x < TILE_W; x++) {
      // Outermost outline (left/right edges)
      const isLeftEdge = isLeft ? x === 0 : x === TILE_W - 1;
      const isOuterEdge = isLeft ? x === 0 || x === 1 : x === TILE_W - 1 || x === TILE_W - 2;

      if (isTop && y === 0) {
        // Top brim line – all outline
        row.push(outline);
      } else if (brimTop && (x === 0 || x === TILE_W - 1)) {
        row.push(outline);
      } else if (brimTop) {
        // Brim surface – dark on outside, highlight on inside
        if (x === 1 || x === TILE_W - 2) row.push(dark);
        else if (isLeft ? x < TILE_W / 2 : x > TILE_W / 2) row.push(highlight);
        else row.push(body);
      } else if (brimBottom && (x === 0 || x === TILE_W - 1)) {
        row.push(outline);
      } else if (brimBottom && (x === 1 || x === TILE_W - 2)) {
        row.push(dark);
      } else if (isTop && y >= 2 && y < 4) {
        // Inside the brim
        if (x === 0 || x === TILE_W - 1) row.push(outline);
        else if (x === 1 || x === TILE_W - 2) row.push(dark);
        else row.push(isLeft ? highlight : body);
      } else {
        // Pipe body
        if (x === 0 || x === TILE_W - 1) row.push(dark);
        else if (x === 1 || x === TILE_W - 2) row.push(body);
        else row.push(isLeft ? highlight : body);
      }
    }
    rows.push(row);
  }
  return rows;
}

const pipeTopLeft = makePipeSprite(true, true);
const pipeTopRight = makePipeSprite(true, false);
const pipeBodyLeft = makePipeSprite(false, true);
const pipeBodyRight = makePipeSprite(false, false);

const hardBlock: string[][] = (() => {
  const rows: string[][] = [];
  const fill = '#A0A0A0';
  const light = '#C0C0C0';
  const dark = '#707070';

  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < TILE_W; x++) {
      if (y === 0 || x === 0) {
        row.push(light); // top/left highlights
      } else if (y === TILE_H - 1 || x === TILE_W - 1) {
        row.push(dark); // bottom/right shadows
      } else if ((x + y) % 5 === 0) {
        row.push(dark); // small indent detail
      } else {
        row.push(fill);
      }
    }
    rows.push(row);
  }
  return rows;
})();

// Flag pole – thin grey pole with a green flag on top
const flagPole: string[][] = (() => {
  const rows: string[][] = [];
  const pole = '#808080';
  const dark = '#606060';
  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = Array(TILE_W).fill('');
    // Pole is at x=7,8
    if (y >= 0) {
      row[7] = dark;
      row[8] = pole;
    }
    rows.push(row);
  }
  return rows;
})();

const flagTop: string[][] = (() => {
  const rows: string[][] = [];
  const pole = '#808080';
  const dark = '#606060';
  const flag = '#00AA00';
  const flagLight = '#00DD00';
  for (let y = 0; y < TILE_H; y++) {
    const row: string[] = Array(TILE_W).fill('');
    // Pole continues
    row[7] = dark;
    row[8] = pole;
    // Flag – triangular/rectangular at top
    if (y === 0) {
      // Ball on top
      row[7] = '#A0A0A0';
      row[8] = '#A0A0A0';
    } else if (y >= 2 && y <= 5) {
      // Flag extends left from pole
      for (let x = 2; x <= 6; x++) {
        row[x] = flag;
      }
      // Highlight edge
      row[2] = flagLight;
    } else if (y >= 6 && y <= 8) {
      for (let x = 4; x <= 6; x++) {
        row[x] = flag;
      }
      row[4] = flagLight;
    }
    rows.push(row);
  }
  return rows;
})();

// ─────────────────────────────────────────────────────────────
//  ENTITY SPRITES
// ─────────────────────────────────────────────────────────────

// Mario Small – 16x16
const marioSmall: string[][] = (() => {
  const rows: string[][] = [];
  const skin = '#FFB89A';
  const hat = '#FF2020';
  const hair = '#8B4513';
  const overalls = '#2020FF';
  const shoe = '#8B4513';
  const eye = '#000000';
  const empty = '';

  for (let y = 0; y < 16; y++) {
    const row: string[] = Array(16).fill(empty);
    if (y === 0) {
      // Hat top
      row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = hat;
    } else if (y === 1) {
      // Hat brim
      row[3] = row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = row[11] = hat;
    } else if (y === 2) {
      // Face – skin with eyes
      row[3] = row[4] = skin;
      row[5] = eye;
      row[6] = skin;
      row[7] = skin;
      row[8] = eye;
      row[9] = skin;
      row[10] = skin;
      row[11] = skin;
    } else if (y === 3) {
      // Face – skin, nose, mouth
      row[3] = row[4] = skin;
      row[5] = skin;
      row[6] = skin;
      row[7] = '#FF6666'; // nose/mouth
      row[8] = skin;
      row[9] = skin;
      row[10] = skin;
      row[11] = skin;
    } else if (y === 4) {
      // Neck / shirt
      row[4] = hat;
      row[5] = hat;
      row[6] = hat;
      row[7] = hat;
      row[8] = hat;
      row[9] = hat;
      row[10] = hat;
    } else if (y === 5) {
      // Arms + overalls top
      row[2] = skin;
      row[3] = skin;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = '#FFFFFF'; // button
      row[7] = overalls;
      row[8] = overalls;
      row[9] = '#FFFFFF';
      row[10] = overalls;
      row[11] = overalls;
      row[12] = skin;
      row[13] = skin;
    } else if (y === 6) {
      // Overalls body
      row[2] = skin;
      row[3] = overalls;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = overalls;
      row[11] = overalls;
      row[12] = overalls;
      row[13] = skin;
    } else if (y === 7) {
      // Overalls with pocket detail
      row[2] = skin;
      row[3] = overalls;
      row[4] = overalls;
      row[5] = '#1818BB';
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = '#1818BB';
      row[11] = overalls;
      row[12] = overalls;
      row[13] = skin;
    } else if (y === 8) {
      // Overalls bottom
      row[3] = overalls;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = overalls;
      row[7] = '#1818BB';
      row[8] = '#1818BB';
      row[9] = overalls;
      row[10] = overalls;
      row[11] = overalls;
      row[12] = overalls;
    } else if (y === 9) {
      // Legs
      row[3] = overalls;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = overalls;
      row[11] = overalls;
      row[12] = overalls;
    } else if (y === 10) {
      // Legs separating
      row[4] = overalls;
      row[5] = overalls;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = overalls;
      row[11] = overalls;
    } else if (y === 11) {
      // Boots top
      row[3] = shoe;
      row[4] = shoe;
      row[5] = shoe;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
    } else if (y === 12) {
      // Boots
      row[2] = shoe;
      row[3] = shoe;
      row[4] = shoe;
      row[5] = shoe;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
      row[13] = shoe;
    } else if (y === 13) {
      // Boots bottom
      row[1] = shoe;
      row[2] = shoe;
      row[3] = shoe;
      row[4] = shoe;
      row[5] = shoe;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
      row[13] = shoe;
      row[14] = shoe;
    } else if (y === 14 || y === 15) {
      // Boots soles
      row[1] = shoe;
      row[2] = shoe;
      row[3] = shoe;
      row[4] = shoe;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
      row[13] = shoe;
    }
    rows.push(row);
  }
  return rows;
})();

// Mario Big – 16×32 (stretched Mario)
const marioBig: string[][] = (() => {
  const rows: string[][] = [];
  const skin = '#FFB89A';
  const hat = '#FF2020';
  const overalls = '#2020FF';
  const shoe = '#8B4513';
  const eye = '#000000';
  const empty = '';

  for (let y = 0; y < 32; y++) {
    const row: string[] = Array(16).fill(empty);
    if (y < 4) {
      // Hat – 4px tall
      if (y === 0) {
        row[5] = row[6] = row[7] = row[8] = row[9] = hat;
      } else if (y === 1) {
        row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = hat;
      } else if (y === 2 || y === 3) {
        row[3] = row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = row[11] = hat;
      }
    } else if (y < 7) {
      // Face
      if (y === 4) {
        row[3] = row[4] = skin;
        row[5] = eye;
        row[6] = skin;
        row[7] = skin;
        row[8] = eye;
        row[9] = skin;
        row[10] = skin;
        row[11] = skin;
      } else if (y === 5) {
        row[3] = row[4] = skin;
        row[5] = skin;
        row[6] = skin;
        row[7] = '#FF6666';
        row[8] = skin;
        row[9] = skin;
        row[10] = skin;
        row[11] = skin;
      } else {
        row[4] = skin;
        row[5] = skin;
        row[6] = skin;
        row[7] = skin;
        row[8] = skin;
        row[9] = skin;
        row[10] = skin;
      }
    } else if (y < 10) {
      // Shirt / neck
      row[4] = hat;
      row[5] = hat;
      row[6] = hat;
      row[7] = hat;
      row[8] = hat;
      row[9] = hat;
      row[10] = hat;
    } else if (y < 12) {
      // Arms + overalls top
      row[2] = skin;
      row[3] = skin;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = '#FFFFFF';
      row[7] = overalls;
      row[8] = overalls;
      row[9] = '#FFFFFF';
      row[10] = overalls;
      row[11] = overalls;
      row[12] = skin;
      row[13] = skin;
    } else if (y < 18) {
      // Torso - overalls
      row[2] = skin;
      row[3] = overalls;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = overalls;
      row[11] = overalls;
      row[12] = overalls;
      row[13] = skin;
    } else if (y < 24) {
      // Legs
      row[3] = overalls;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = overalls;
      row[11] = overalls;
      row[12] = overalls;
    } else if (y < 28) {
      // Boots top
      row[2] = shoe;
      row[3] = shoe;
      row[4] = shoe;
      row[5] = shoe;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
      row[13] = shoe;
    } else {
      // Boots soles
      row[1] = shoe;
      row[2] = shoe;
      row[3] = shoe;
      row[4] = shoe;
      row[5] = shoe;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
      row[13] = shoe;
      row[14] = shoe;
    }
    rows.push(row);
  }
  return rows;
})();

// Mario Fire – like Big but with fire accents
const marioFire: string[][] = (() => {
  const rows: string[][] = [];
  const skin = '#FFB89A';
  const hat = '#FF2020';
  const overalls = '#2020FF';
  const shoe = '#8B4513';
  const eye = '#000000';
  const fire = '#FF6600';
  const fireBright = '#FFAA00';
  const empty = '';

  for (let y = 0; y < 32; y++) {
    const row: string[] = Array(16).fill(empty);
    if (y < 4) {
      // Hat with fire accent
      if (y === 0) {
        row[4] = fireBright;
        row[5] = row[6] = row[7] = row[8] = row[9] = hat;
        row[10] = fire;
      } else if (y === 1) {
        row[3] = fireBright;
        row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = hat;
        row[11] = fire;
      } else if (y === 2 || y === 3) {
        row[2] = fire;
        row[3] = row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = row[11] = hat;
      }
    } else if (y < 7) {
      // Face
      if (y === 4) {
        row[3] = row[4] = skin;
        row[5] = eye;
        row[6] = skin;
        row[7] = skin;
        row[8] = eye;
        row[9] = skin;
        row[10] = skin;
      } else if (y === 5) {
        row[3] = skin;
        row[4] = skin;
        row[5] = skin;
        row[6] = skin;
        row[7] = '#FF6666';
        row[8] = skin;
        row[9] = skin;
        row[10] = skin;
      } else {
        row[4] = skin;
        row[5] = skin;
        row[6] = skin;
        row[7] = skin;
        row[8] = skin;
        row[9] = skin;
      }
    } else if (y < 10) {
      // Shirt with fire trim
      row[4] = fire;
      row[5] = hat;
      row[6] = hat;
      row[7] = hat;
      row[8] = hat;
      row[9] = hat;
      row[10] = fire;
    } else if (y < 12) {
      // Arms + overalls top
      row[2] = skin;
      row[3] = fire;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = '#FFFFFF';
      row[7] = overalls;
      row[8] = overalls;
      row[9] = '#FFFFFF';
      row[10] = overalls;
      row[11] = overalls;
      row[12] = fire;
      row[13] = skin;
    } else if (y < 18) {
      // Torso - overalls with fire belt
      if (y === 16) {
        row[2] = skin;
        row[3] = overalls;
        row[4] = overalls;
        row[5] = fireBright;
        row[6] = fire;
        row[7] = fire;
        row[8] = fire;
        row[9] = fire;
        row[10] = fireBright;
        row[11] = overalls;
        row[12] = overalls;
        row[13] = skin;
      } else {
        row[2] = skin;
        row[3] = overalls;
        row[4] = overalls;
        row[5] = overalls;
        row[6] = overalls;
        row[7] = overalls;
        row[8] = overalls;
        row[9] = overalls;
        row[10] = overalls;
        row[11] = overalls;
        row[12] = overalls;
        row[13] = skin;
      }
    } else if (y < 24) {
      // Legs
      row[3] = overalls;
      row[4] = overalls;
      row[5] = overalls;
      row[6] = overalls;
      row[7] = overalls;
      row[8] = overalls;
      row[9] = overalls;
      row[10] = overalls;
      row[11] = overalls;
      row[12] = overalls;
    } else if (y < 28) {
      // Boots with fire
      row[2] = shoe;
      row[3] = shoe;
      row[4] = shoe;
      row[5] = shoe;
      row[6] = fire;
      row[7] = fireBright;
      row[8] = fireBright;
      row[9] = fire;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
      row[13] = shoe;
    } else {
      row[1] = shoe;
      row[2] = shoe;
      row[3] = shoe;
      row[4] = shoe;
      row[5] = shoe;
      row[10] = shoe;
      row[11] = shoe;
      row[12] = shoe;
      row[13] = shoe;
      row[14] = shoe;
    }
    rows.push(row);
  }
  return rows;
})();

// Goomba – 16×16
const goomba: string[][] = (() => {
  const rows: string[][] = [];
  const body = '#8B4513';
  const dark = '#5C2D0A';
  const eye = '#000000';
  const eyeWhite = '#FFFFFF';
  const foot = '#3A1A00';
  const empty = '';

  for (let y = 0; y < 16; y++) {
    const row: string[] = Array(16).fill(empty);
    if (y === 0) {
      // Top of head
      row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = body;
    } else if (y === 1) {
      row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = row[11] = body;
    } else if (y === 2) {
      // Eyes with angry eyebrows
      row[4] = body;
      row[5] = dark; // eyebrow
      row[6] = eyeWhite;
      row[7] = eye;
      row[8] = eyeWhite;
      row[9] = eye;
      row[10] = dark;
      row[11] = body;
    } else if (y === 3) {
      row[3] = body;
      row[4] = body;
      row[5] = body;
      row[6] = eyeWhite;
      row[7] = eye;
      row[8] = eyeWhite;
      row[9] = eye;
      row[10] = body;
      row[11] = body;
      row[12] = body;
    } else if (y === 4) {
      row[3] = body;
      row[4] = body;
      row[5] = body;
      row[6] = body;
      row[7] = body;
      row[8] = body;
      row[9] = body;
      row[10] = body;
      row[11] = body;
      row[12] = body;
    } else if (y === 5 || y === 6) {
      // Body
      row[2] = body;
      row[3] = body;
      row[4] = body;
      row[5] = body;
      row[6] = body;
      row[7] = body;
      row[8] = body;
      row[9] = body;
      row[10] = body;
      row[11] = body;
      row[12] = body;
      row[13] = body;
    } else if (y === 7 || y === 8) {
      // Mouth/teeth
      row[2] = body;
      row[3] = body;
      row[4] = '#FFFFFF';
      row[5] = '#FFFFFF';
      row[6] = body;
      row[7] = body;
      row[8] = body;
      row[9] = body;
      row[10] = '#FFFFFF';
      row[11] = '#FFFFFF';
      row[12] = body;
      row[13] = body;
    } else if (y === 9 || y === 10) {
      // Lower body
      row[3] = body;
      row[4] = body;
      row[5] = body;
      row[6] = body;
      row[7] = body;
      row[8] = body;
      row[9] = body;
      row[10] = body;
      row[11] = body;
      row[12] = body;
    } else if (y === 11) {
      // Feet start
      row[2] = foot;
      row[3] = foot;
      row[4] = foot;
      row[5] = body;
      row[6] = body;
      row[7] = body;
      row[8] = body;
      row[9] = body;
      row[10] = body;
      row[11] = foot;
      row[12] = foot;
      row[13] = foot;
    } else if (y === 12 || y === 13 || y === 14 || y === 15) {
      // Feet
      row[1] = foot;
      row[2] = foot;
      row[3] = foot;
      row[4] = foot;
      row[5] = foot;
      row[10] = foot;
      row[11] = foot;
      row[12] = foot;
      row[13] = foot;
      row[14] = foot;
    }
    rows.push(row);
  }
  return rows;
})();

// Coin – 8×16 (golden)
const coin: string[][] = (() => {
  const rows: string[][] = [];
  const gold = '#FFD700';
  const bright = '#FFEC80';
  const dark = '#B8860B';
  const empty = '';

  for (let y = 0; y < 16; y++) {
    const row: string[] = Array(8).fill(empty);
    if (y === 0 || y === 15) {
      // Top/bottom edges – just a sliver
      row[3] = row[4] = dark;
    } else if (y === 1 || y === 14) {
      row[2] = dark;
      row[3] = gold;
      row[4] = gold;
      row[5] = dark;
    } else if (y === 2 || y === 13) {
      row[1] = dark;
      row[2] = gold;
      row[3] = bright;
      row[4] = bright;
      row[5] = gold;
      row[6] = dark;
    } else if (y === 3 || y === 12) {
      row[1] = dark;
      row[2] = bright;
      row[3] = gold;
      row[4] = gold;
      row[5] = bright;
      row[6] = dark;
    } else if (y >= 4 && y <= 11) {
      // Middle band
      row[1] = dark;
      row[2] = gold;
      row[3] = gold;
      row[4] = gold;
      row[5] = gold;
      row[6] = dark;
    }
    // Centre highlight
    if (y >= 4 && y <= 11) {
      row[3] = bright;
    }
    rows.push(row);
  }
  return rows;
})();

// Mushroom – 16×16
const mushroom: string[][] = (() => {
  const rows: string[][] = [];
  const cap = '#FF2020';
  const spot = '#FFFFFF';
  const stem = '#F5DEB3';
  const darkStem = '#D2B48C';
  const empty = '';

  for (let y = 0; y < 16; y++) {
    const row: string[] = Array(16).fill(empty);
    if (y === 0) {
      // Cap top curve
      row[3] = row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = row[11] = row[12] = cap;
    } else if (y === 1) {
      row[2] = row[3] = row[4] = row[5] = row[6] = row[7] = row[8] = row[9] = row[10] = row[11] = row[12] = row[13] = cap;
    } else if (y === 2) {
      row[2] = cap;
      row[3] = cap;
      row[4] = spot;
      row[5] = cap;
      row[6] = cap;
      row[7] = spot;
      row[8] = spot;
      row[9] = cap;
      row[10] = cap;
      row[11] = spot;
      row[12] = cap;
      row[13] = cap;
    } else if (y === 3) {
      row[2] = cap;
      row[3] = cap;
      row[4] = cap;
      row[5] = spot;
      row[6] = cap;
      row[7] = cap;
      row[8] = cap;
      row[9] = cap;
      row[10] = cap;
      row[11] = cap;
      row[12] = cap;
      row[13] = cap;
    } else if (y === 4) {
      row[3] = cap;
      row[4] = cap;
      row[5] = cap;
      row[6] = cap;
      row[7] = cap;
      row[8] = cap;
      row[9] = cap;
      row[10] = cap;
      row[11] = cap;
      row[12] = cap;
    } else if (y === 5) {
      // Cap bottom edge
      row[3] = '#CC0000';
      row[4] = '#CC0000';
      row[5] = '#CC0000';
      row[6] = '#CC0000';
      row[7] = '#CC0000';
      row[8] = '#CC0000';
      row[9] = '#CC0000';
      row[10] = '#CC0000';
      row[11] = '#CC0000';
      row[12] = '#CC0000';
    } else if (y >= 6 && y <= 9) {
      // Stem
      row[5] = stem;
      row[6] = stem;
      row[7] = stem;
      row[8] = stem;
      row[9] = stem;
      row[10] = stem;
      // Stem shading
      if (y === 6) {
        row[5] = darkStem; row[10] = darkStem;
      }
      if (y === 7) {
        row[5] = darkStem; row[10] = darkStem;
      }
    } else if (y === 10 || y === 11) {
      // Stem base
      row[4] = stem;
      row[5] = stem;
      row[6] = stem;
      row[7] = stem;
      row[8] = stem;
      row[9] = stem;
      row[10] = stem;
      row[11] = stem;
    } else {
      // Bottom
      row[4] = darkStem;
      row[5] = stem;
      row[6] = stem;
      row[7] = stem;
      row[8] = stem;
      row[9] = stem;
      row[10] = stem;
      row[11] = darkStem;
    }
    rows.push(row);
  }
  return rows;
})();

// Flower – 16×16 (orange)
const flower: string[][] = (() => {
  const rows: string[][] = [];
  const petal = '#FF6600';
  const petalDark = '#CC4400';
  const petalLight = '#FF9944';
  const centre = '#FFD700';
  const stem = '#00AA00';
  const empty = '';

  for (let y = 0; y < 16; y++) {
    const row: string[] = Array(16).fill(empty);
    if (y === 0 || y === 1) {
      // Petals top
      if (y === 0) {
        row[6] = row[7] = row[8] = row[9] = petal;
      } else {
        row[5] = petal; row[6] = petalLight; row[7] = petal;
        row[8] = petal; row[9] = petalLight; row[10] = petal;
      }
    } else if (y === 2) {
      // Petal ring
      row[4] = petal; row[5] = petalLight; row[6] = centre;
      row[7] = centre; row[8] = centre; row[9] = centre;
      row[10] = petalLight; row[11] = petal;
    } else if (y === 3) {
      row[4] = petalDark; row[5] = petal; row[6] = centre;
      row[7] = centre; row[8] = centre; row[9] = centre;
      row[10] = petal; row[11] = petalDark;
    } else if (y === 4) {
      row[5] = petalDark; row[6] = petal; row[7] = petal;
      row[8] = petal; row[9] = petal; row[10] = petalDark;
    } else if (y === 5) {
      row[6] = petalDark; row[7] = petal; row[8] = petal;
      row[9] = petalDark;
    } else if (y >= 6 && y <= 9) {
      // Stem
      row[7] = stem;
      row[8] = stem;
    } else if (y >= 10 && y <= 12) {
      // Leaves
      row[6] = stem;
      row[7] = stem;
      row[8] = stem;
      row[9] = stem;
      if (y === 10) {
        row[5] = stem;
        row[10] = stem;
      }
      if (y === 11) {
        row[4] = stem;
        row[11] = stem;
      }
      if (y === 12) {
        row[5] = stem;
        row[10] = stem;
      }
    } else {
      // Stem bottom
      row[7] = stem;
      row[8] = stem;
    }
    rows.push(row);
  }
  return rows;
})();

// Star – 16×16 yellow
const star: string[][] = (() => {
  const rows: string[][] = [];
  const yellow = '#FFD700';
  const bright = '#FFFFAA';
  const dark = '#B8860B';
  const empty = '';

  for (let y = 0; y < 16; y++) {
    const row: string[] = Array(16).fill(empty);
    if (y === 0 || y === 1) {
      // Top points
      if (y === 0) {
        row[7] = row[8] = yellow;
      } else {
        row[6] = yellow; row[7] = bright; row[8] = bright; row[9] = yellow;
      }
    } else if (y === 2) {
      // Upper star arms
      row[4] = yellow; row[5] = bright; row[6] = bright;
      row[7] = yellow; row[8] = yellow;
      row[9] = bright; row[10] = bright; row[11] = yellow;
    } else if (y === 3) {
      row[3] = yellow; row[4] = bright; row[5] = yellow;
      row[6] = yellow; row[7] = yellow; row[8] = yellow; row[9] = yellow;
      row[10] = yellow; row[11] = bright; row[12] = yellow;
    } else if (y >= 4 && y <= 5) {
      // Diamond middle
      for (let x = 2; x <= 13; x++) row[x] = yellow;
      row[3] = bright; row[12] = bright;
    } else if (y >= 6 && y <= 9) {
      // Lower star
      for (let x = 3; x <= 12; x++) row[x] = yellow;
      row[4] = bright; row[11] = bright;
      if (y === 7) { row[5] = bright; row[10] = bright; }
      if (y === 8) { row[6] = dark; row[9] = dark; }
    } else if (y === 10) {
      row[5] = yellow; row[6] = yellow; row[7] = yellow;
      row[8] = yellow; row[9] = yellow; row[10] = yellow;
    } else if (y === 11) {
      row[6] = yellow; row[7] = yellow; row[8] = yellow; row[9] = yellow;
    } else if (y === 12) {
      row[7] = yellow; row[8] = yellow;
    }
    rows.push(row);
  }
  return rows;
})();

// Bullet – 16×8 (small red ball)
const bullet: string[][] = (() => {
  const rows: string[][] = [];
  const red = '#FF2020';
  const dark = '#CC0000';
  const bright = '#FF6666';
  const empty = '';

  // We'll make it 8×8, then centre it in a 16×16 box
  const w = 16;
  const h = 16;
  for (let y = 0; y < h; y++) {
    const row: string[] = Array(w).fill(empty);
    if (y === 0 || y === 7) {
      row[6] = dark;
      row[7] = dark;
      row[8] = dark;
      row[9] = dark;
    } else if (y === 1 || y === 6) {
      row[5] = dark;
      row[6] = red;
      row[7] = bright;
      row[8] = bright;
      row[9] = red;
      row[10] = dark;
    } else if (y === 2 || y === 5) {
      row[4] = dark;
      row[5] = red;
      row[6] = red;
      row[7] = bright;
      row[8] = bright;
      row[9] = red;
      row[10] = red;
      row[11] = dark;
    } else if (y === 3 || y === 4) {
      row[4] = dark;
      row[5] = red;
      row[6] = red;
      row[7] = red;
      row[8] = red;
      row[9] = red;
      row[10] = red;
      row[11] = dark;
    }
    rows.push(row);
  }
  return rows;
})();

// ─────────────────────────────────────────────────────────────
//  EXPORT
// ─────────────────────────────────────────────────────────────

export const TILE_SPRITES: Record<TileType, Sprite> = {
  Ground:         { pixels: groundPattern,     width: TILE_W, height: TILE_H },
  Brick:          { pixels: brickPattern,      width: TILE_W, height: TILE_H },
  QuestionBlock:  { pixels: questionBlock,     width: TILE_W, height: TILE_H },
  UsedBlock:      { pixels: usedBlock,         width: TILE_W, height: TILE_H },
  PipeTopLeft:    { pixels: pipeTopLeft,       width: TILE_W, height: TILE_H },
  PipeTopRight:   { pixels: pipeTopRight,      width: TILE_W, height: TILE_H },
  PipeBodyLeft:   { pixels: pipeBodyLeft,      width: TILE_W, height: TILE_H },
  PipeBodyRight:  { pixels: pipeBodyRight,     width: TILE_W, height: TILE_H },
  HardBlock:      { pixels: hardBlock,         width: TILE_W, height: TILE_H },
  FlagPole:       { pixels: flagPole,          width: TILE_W, height: TILE_H },
  FlagTop:        { pixels: flagTop,           width: TILE_W, height: TILE_H },
  Empty:          { pixels: Array.from({ length: TILE_H }, () => Array(TILE_W).fill('')), width: TILE_W, height: TILE_H },
};

export const ENTITY_SPRITES: Record<EntityType, Sprite> = {
  MarioSmall: { pixels: marioSmall, width: 16, height: 16 },
  MarioBig:   { pixels: marioBig,   width: 16, height: 32 },
  MarioFire:  { pixels: marioFire,  width: 16, height: 32 },
  Goomba:     { pixels: goomba,     width: 16, height: 16 },
  Coin:       { pixels: coin,       width: 8,  height: 16 },
  Mushroom:   { pixels: mushroom,   width: 16, height: 16 },
  Flower:     { pixels: flower,     width: 16, height: 16 },
  Star:       { pixels: star,       width: 16, height: 16 },
  Bullet:     { pixels: bullet,     width: 16, height: 16 },
};
