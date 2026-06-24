import type { MapData, Tile, TileType, WeaponType } from "./types";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRng(seed: number): () => number { return mulberry32(seed); }
function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function generateMap(seed?: number): MapData {
  const rng = createSeededRng(seed ?? (Date.now() | 0));
  const W = 18, H = 12, CX = 9, CY = 6;

  // Thematic variant based on seed
  const theme = Math.floor(rng() * 3); // 0=balanced, 1=forest, 2=waterworld
  const grassRate = theme === 1 ? 0.25 : 0.12;
  const waterRate = theme === 2 ? 0.08 : 0.03;

  const tiles: Tile[][] = [];
  for (let y = 0; y < H; y++) { tiles[y] = []; for (let x = 0; x < W; x++) tiles[y][x] = { type: "open" }; }

  // Boundary walls
  for (let x = 0; x < W; x++) { tiles[0][x] = { type: "wall" }; tiles[H-1][x] = { type: "wall" }; }
  for (let y = 0; y < H; y++) { tiles[y][0] = { type: "wall" }; tiles[y][W-1] = { type: "wall" }; }

  // Symmetric spawns: bottom-left (1,H-2) and top-right (W-2,1)
  const spawnA = { x: 1, y: H - 2 };
  const spawnB = { x: W - 2, y: 1 };

  // Internal walls — create lanes
  const wallClusters = randInt(rng, 3, 5);
  for (let i = 0; i < wallClusters; i++) {
    const wx = randInt(rng, 2, W - 4), wy = randInt(rng, 2, H - 4);
    const ww = randInt(rng, 1, 3), wh = randInt(rng, 1, 2);
    for (let dy = 0; dy < wh; dy++) {
      for (let dx = 0; dx < ww; dx++) {
        const nx = wx + dx, ny = wy + dy;
        if (Math.abs(nx - spawnA.x) <= 2 && Math.abs(ny - spawnA.y) <= 2) continue;
        if (Math.abs(nx - spawnB.x) <= 2 && Math.abs(ny - spawnB.y) <= 2) continue;
        if (Math.abs(nx - CX) <= 2 && Math.abs(ny - CY) <= 2) continue;
        if (nx > 0 && nx < W-1 && ny > 0 && ny < H-1) tiles[ny][nx] = { type: "wall" };
      }
    }
  }

  // Grass — less near capture zone
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (tiles[y][x].type === "open" && rng() < grassRate) {
        const d = Math.abs(x - CX) + Math.abs(y - CY);
        if (d > 2 || rng() < 0.3) tiles[y][x] = { type: "grass" };
      }
    }
  }

  // Water — 1-2 small lakes
  const waterPatches = randInt(rng, 1, 2);
  for (let i = 0; i < waterPatches; i++) {
    const wx = randInt(rng, 3, W - 6), wy = randInt(rng, 3, H - 6);
    const ww = randInt(rng, 2, 3), wh = randInt(rng, 1, 2);
    for (let dy = 0; dy < wh; dy++) {
      for (let dx = 0; dx < ww; dx++) {
        const nx = wx + dx, ny = wy + dy;
        if (Math.abs(nx - CX) <= 2 && Math.abs(ny - CY) <= 2) continue;
        if (tiles[ny]?.[nx]?.type === "open") tiles[ny][nx] = { type: "water" };
      }
    }
  }

  // Extra water for waterworld theme
  if (theme === 2) {
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++)
        if (tiles[y][x].type === "open" && rng() < waterRate && Math.abs(x-CX)+Math.abs(y-CY) > 2)
          tiles[y][x] = { type: "water" };
  }

  // Capture zone — center, mostly open, single cover
  const captureRadius = 2;
  for (let y = CY - captureRadius; y <= CY + captureRadius; y++)
    for (let x = CX - captureRadius; x <= CX + captureRadius; x++)
      if (y > 0 && y < H-1 && x > 0 && x < W-1 && Math.abs(x-CX)+Math.abs(y-CY) <= captureRadius)
        tiles[y][x] = { type: "open" };
  tiles[CY][CX + 2] = { type: "wall" };

  // Clear spawn areas
  for (const sp of [spawnA, spawnB])
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (sp.x+dx > 0 && sp.x+dx < W-1 && sp.y+dy > 0 && sp.y+dy < H-1)
          tiles[sp.y+dy][sp.x+dx] = { type: "open" };

  // Weapon spawns — one near each side, one near center
  const weapons: WeaponType[] = ["sword", "bow", "spear"];
  const itemSpawns: Array<{ x: number; y: number; type: WeaponType }> = [];
  const positions = [
    { x: randInt(rng, 2, CX - 3), y: randInt(rng, CY, H - 2) },
    { x: randInt(rng, CX + 3, W - 3), y: randInt(rng, 2, CY) },
    { x: randInt(rng, CX - 1, CX + 1), y: randInt(rng, CY - 1, CY + 1) },
  ];
  for (const pos of positions)
    if (tiles[pos.y]?.[pos.x]?.type === "open")
      itemSpawns.push({ x: pos.x, y: pos.y, type: weapons[Math.floor(rng() * weapons.length)] });

  return { width: W, height: H, tiles, playerSpawns: [spawnA, spawnB], itemSpawns, capturePoint: { x: CX, y: CY, radius: captureRadius } };
}
