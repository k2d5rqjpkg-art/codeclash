import type { MapData, Tile, TileType, WeaponType } from "./types";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRng(seed: number): () => number {
  return mulberry32(seed);
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function generateMap(seed?: number): MapData {
  const rng = createSeededRng(seed ?? (Date.now() | 0));
  const W = 18;
  const H = 12;
  const CX = Math.floor(W / 2);
  const CY = Math.floor(H / 2);

  const tiles: Tile[][] = [];
  for (let y = 0; y < H; y++) {
    tiles[y] = [];
    for (let x = 0; x < W; x++) {
      tiles[y][x] = { type: "open" };
    }
  }

  // Boundary walls
  for (let x = 0; x < W; x++) {
    tiles[0][x] = { type: "wall" };
    tiles[H - 1][x] = { type: "wall" };
  }
  for (let y = 0; y < H; y++) {
    tiles[y][0] = { type: "wall" };
    tiles[y][W - 1] = { type: "wall" };
  }

  // Internal walls — lanes and chokepoints
  const wallClusters = randInt(rng, 3, 5);
  for (let i = 0; i < wallClusters; i++) {
    const wx = randInt(rng, 2, W - 4);
    const wy = randInt(rng, 2, H - 4);
    const ww = randInt(rng, 1, 3);
    const wh = randInt(rng, 1, 2);
    for (let dy = 0; dy < wh; dy++) {
      for (let dx = 0; dx < ww; dx++) {
        const nx = wx + dx;
        const ny = wy + dy;
        if (Math.abs(nx - 1) <= 2 && Math.abs(ny - (H - 2)) <= 2) continue;
        if (Math.abs(nx - (W - 2)) <= 2 && Math.abs(ny - 1) <= 2) continue;
        if (Math.abs(nx - CX) <= 2 && Math.abs(ny - CY) <= 2) continue;
        if (nx > 0 && nx < W - 1 && ny > 0 && ny < H - 1) {
          tiles[ny][nx] = { type: "wall" };
        }
      }
    }
  }

  // Grass — less near capture zone
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (tiles[y][x].type === "open" && rng() < 0.15) {
        const distToCenter = Math.abs(x - CX) + Math.abs(y - CY);
        if (distToCenter > 2 || rng() < 0.3) {
          tiles[y][x] = { type: "grass" };
        }
      }
    }
  }

  // Water patches
  const waterPatches = randInt(rng, 1, 2);
  for (let i = 0; i < waterPatches; i++) {
    const wx = randInt(rng, 3, W - 6);
    const wy = randInt(rng, 3, H - 6);
    const ww = randInt(rng, 2, 3);
    const wh = randInt(rng, 1, 2);
    for (let dy = 0; dy < wh; dy++) {
      for (let dx = 0; dx < ww; dx++) {
        const nx = wx + dx;
        const ny = wy + dy;
        if (Math.abs(nx - CX) <= 2 && Math.abs(ny - CY) <= 2) continue;
        if (tiles[ny]?.[nx]?.type === "open") {
          tiles[ny][nx] = { type: "water" };
        }
      }
    }
  }

  // Capture zone — center, open with minimal cover
  const captureRadius = 2;
  for (let y = CY - captureRadius; y <= CY + captureRadius; y++) {
    for (let x = CX - captureRadius; x <= CX + captureRadius; x++) {
      if (y > 0 && y < H - 1 && x > 0 && x < W - 1) {
        const dist = Math.abs(x - CX) + Math.abs(y - CY);
        if (dist <= captureRadius) {
          tiles[y][x] = { type: "open" };
        }
      }
    }
  }
  tiles[CY][CX + 2] = { type: "wall" }; // single cover block

  // Spawns
  const playerSpawns = [
    { x: 1, y: H - 2 },
    { x: W - 2, y: 1 },
  ];
  for (const sp of playerSpawns) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = sp.x + dx;
        const ny = sp.y + dy;
        if (nx > 0 && nx < W - 1 && ny > 0 && ny < H - 1) {
          tiles[ny][nx] = { type: "open" };
        }
      }
    }
  }

  // Weapon spawns
  const weapons: WeaponType[] = ["sword", "bow", "spear"];
  const itemSpawns: Array<{ x: number; y: number; type: WeaponType }> = [];
  const spawnPositions = [
    { x: randInt(rng, 2, CX - 3), y: randInt(rng, CY, H - 2) },
    { x: randInt(rng, CX + 3, W - 3), y: randInt(rng, 2, CY) },
    { x: randInt(rng, CX - 1, CX + 1), y: randInt(rng, CY - 1, CY + 1) },
  ];
  for (const pos of spawnPositions) {
    if (tiles[pos.y]?.[pos.x]?.type === "open") {
      itemSpawns.push({ x: pos.x, y: pos.y, type: weapons[Math.floor(rng() * weapons.length)] });
    }
  }

  return { width: W, height: H, tiles, playerSpawns, itemSpawns, capturePoint: { x: CX, y: CY, radius: captureRadius } };
}
