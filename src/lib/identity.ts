// Deterministic tank identity from seed
// Generates name, SVG avatar, color scheme — same seed = same identity

const ADJECTIVES = [
  "Nova", "Crimson", "Azure", "Shadow", "Phantom", "Thunder", "Frost",
  "Ember", "Void", "Solar", "Lunar", "Storm", "Blaze", "Toxic", "Primal",
  "Cyber", "Omega", "Delta", "Hyper", "Zenith",
];

const NOUNS = [
  "Scout", "Hunter", "Bastion", "Wraith", "Sentinel", "Striker", "Guardian",
  "Reaper", "Phoenix", "Dragon", "Wolf", "Falcon", "Titan", "Specter", "Knight",
  "Ronin", "Havoc", "Vertex", "Drifter", "Siege",
];

const COLOR_SCHEMES = [
  { primary: "#38bdf8", secondary: "#0ea5e9", accent: "#7dd3fc" }, // Sky
  { primary: "#f87171", secondary: "#dc2626", accent: "#fca5a5" }, // Red
  { primary: "#4ade80", secondary: "#16a34a", accent: "#86efac" }, // Green
  { primary: "#a78bfa", secondary: "#7c3aed", accent: "#c4b5fd" }, // Purple
  { primary: "#fbbf24", secondary: "#d97706", accent: "#fde68a" }, // Gold
  { primary: "#fb923c", secondary: "#ea580c", accent: "#fdba74" }, // Orange
  { primary: "#f472b6", secondary: "#db2777", accent: "#f9a8d4" }, // Pink
  { primary: "#67e8f9", secondary: "#06b6d4", accent: "#a5f3fc" }, // Cyan
];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TankIdentity {
  name: string;
  seed: number;
  colors: { primary: string; secondary: string; accent: string };
  svg: string;
}

export function generateIdentity(seed?: number): TankIdentity {
  const s = seed ?? Math.floor(Math.random() * 100000);
  const rng = mulberry32(s);

  const adj = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(rng() * NOUNS.length)];
  const name = `${adj}-${noun}`;
  const colors = COLOR_SCHEMES[Math.floor(rng() * COLOR_SCHEMES.length)];

  const svg = generateSVG(s, colors);

  return { name, seed: s, colors, svg };
}

function generateSVG(seed: number, colors: { primary: string; secondary: string; accent: string }): string {
  const rng = mulberry32(seed + 999);
  const bodyW = 30 + Math.floor(rng() * 20);  // 30-50
  const bodyH = 40 + Math.floor(rng() * 20);  // 40-60
  const headR = 8 + Math.floor(rng() * 6);     // 8-14
  const hasShield = rng() > 0.5;
  const hasCape = rng() > 0.5;
  const eyeStyle = Math.floor(rng() * 3);
  const weaponX = bodyW / 2 + 5;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">`;

  // Cape
  if (hasCape) {
    svg += `<path d="M${32 - bodyW / 2} ${32 + bodyH / 4} L${32 - bodyW / 2 - 8} ${32 + bodyH / 2 + 8} L${32} ${32 + bodyH / 2} Z" fill="${colors.secondary}" opacity="0.6"/>`;
    svg += `<path d="M${32 + bodyW / 2} ${32 + bodyH / 4} L${32 + bodyW / 2 + 8} ${32 + bodyH / 2 + 8} L${32} ${32 + bodyH / 2} Z" fill="${colors.secondary}" opacity="0.6"/>`;
  }

  // Body
  svg += `<rect x="${32 - bodyW / 2}" y="${32 - bodyH / 4}" width="${bodyW}" height="${bodyH}" rx="6" fill="${colors.primary}" stroke="${colors.secondary}" stroke-width="2"/>`;

  // Shield
  if (hasShield) {
    svg += `<ellipse cx="${32 - bodyW / 2 - 2}" cy="${32}" rx="6" ry="10" fill="${colors.accent}" stroke="${colors.secondary}" stroke-width="1.5" opacity="0.8"/>`;
  }

  // Head
  const headY = 32 - bodyH / 4 - headR;
  svg += `<circle cx="32" cy="${headY}" r="${headR}" fill="${colors.secondary}" stroke="${colors.primary}" stroke-width="1.5"/>`;

  // Eyes
  if (eyeStyle === 0) {
    svg += `<circle cx="29" cy="${headY - 1}" r="2" fill="white"/><circle cx="35" cy="${headY - 1}" r="2" fill="white"/>`;
  } else if (eyeStyle === 1) {
    svg += `<rect x="27" y="${headY - 3}" width="3" height="4" rx="1" fill="white"/><rect x="34" y="${headY - 3}" width="3" height="4" rx="1" fill="white"/>`;
  } else {
    svg += `<line x1="27" y1="${headY}" x2="31" y2="${headY}" stroke="white" stroke-width="2"/><line x1="33" y1="${headY}" x2="37" y2="${headY}" stroke="white" stroke-width="2"/>`;
  }

  // Weapon
  svg += `<line x1="32" y1="${32 - bodyH / 4}" x2="${32 + weaponX}" y2="${32 - bodyH / 4 - 10}" stroke="${colors.accent}" stroke-width="3" stroke-linecap="round"/>`;

  svg += `</svg>`;
  return svg;
}

// Tank registry
export interface TankEntry {
  name: string;
  seed: number;
  identity: TankIdentity;
  model: string;       // "Claude" | "GPT" | "DeepSeek" | "human"
  code: string;
  skill: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  createdAt: string;
  lastBattle: string | null;
  tankKeyHash?: string; // SHA256 of tank key for Agent API auth
}

import * as fs from "fs";
import * as path from "path";

const TANK_FILE = path.join(process.cwd(), "tanks.json");

export function loadTanks(): TankEntry[] {
  try {
    if (fs.existsSync(TANK_FILE)) return JSON.parse(fs.readFileSync(TANK_FILE, "utf-8"));
  } catch {}
  return [];
}

export function saveTanks(tanks: TankEntry[]): void {
  fs.writeFileSync(TANK_FILE, JSON.stringify(tanks, null, 2));
}

export function registerTank(
  name: string,
  code: string,
  skill: string,
  model: string,
  seed?: number,
): TankEntry {
  const tanks = loadTanks();
  const identity = generateIdentity(seed);
  const entry: TankEntry = {
    name: name || identity.name,
    seed: identity.seed,
    identity,
    model,
    code,
    skill,
    elo: 1200,
    wins: 0,
    losses: 0,
    draws: 0,
    createdAt: new Date().toISOString(),
    lastBattle: null,
  };
  tanks.push(entry);
  saveTanks(tanks);
  return entry;
}

export function updateTank(name: string, updates: Partial<TankEntry>): void {
  const tanks = loadTanks();
  const idx = tanks.findIndex((t) => t.name === name);
  if (idx >= 0) {
    tanks[idx] = { ...tanks[idx], ...updates };
    saveTanks(tanks);
  }
}
