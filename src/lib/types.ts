export type Direction = "up" | "down" | "left" | "right";

// 4 terrain types — each creates tactical variety
export type TileType = "wall" | "grass" | "water" | "open";

// 3 weapon types — rock-paper-scissors
export type WeaponType = "sword" | "bow" | "spear";
// sword > spear > bow > sword:
//   sword: melee 30dmg, ignores shield, weak to bow (kited)
//   bow:   ranged 20dmg, blocked by shield, weak to spear (mid-range gap-close)
//   spear: mid-range 25dmg, beats bow, weak to sword (melee beats it)

// 3 skill types — each has terrain advantage
export type SkillType = "shield" | "sprint" | "cloak";
// shield: blocks projectiles, best on open ground
// sprint: double speed, best in water (ignores slow)
// cloak:  invisible, best in grass (extended duration)

export type ActionKind = "move" | "shoot" | "skill" | "pickup" | "none";

export const SKILL_DEFS: Record<SkillType, { cooldown: number; duration: number }> = {
  shield: { cooldown: 20, duration: 4 },
  sprint: { cooldown: 15, duration: 6 },
  cloak:  { cooldown: 25, duration: 8 },
};

// Terrain effects
export const TERRAIN_EFFECTS: Record<TileType, { moveSpeed: number; damageMod: number; stealth: boolean }> = {
  open:  { moveSpeed: 1.0, damageMod: 1.0, stealth: false },
  grass: { moveSpeed: 1.0, damageMod: 1.5, stealth: true },
  water: { moveSpeed: 0.5, damageMod: 0.7, stealth: false },
  wall:  { moveSpeed: 0,   damageMod: 0,   stealth: false },
};

export const WEAPON_DEFS: Record<WeaponType, { damage: number; range: number; cooldown: number }> = {
  sword: { damage: 30, range: 1.5, cooldown: 8 },
  spear: { damage: 25, range: 3.0, cooldown: 10 },
  bow:   { damage: 20, range: 8.0, cooldown: 6 },
};

export interface AgentAction {
  action: ActionKind;
  direction?: Direction;
}

export interface AgentSnapshot {
  x: number; y: number;
  facing: Direction;
  hp: number; maxHp: number;
  weapon: WeaponType | null;
  weaponCooldown: number;
  skill: SkillType | null;
  skillCooldown: number;
  onTerrain: TileType;
  // Status effects
  shielded: boolean;
  cloaked: boolean;
  sprinting: boolean;
}

export interface AgentState {
  self: AgentSnapshot;
  enemy: AgentSnapshot | null; // null if stealth or out of sight range (8 tiles)
  items: Array<{ x: number; y: number; type: WeaponType; active: boolean }>;
  projectiles: Array<{ x: number; y: number; direction: Direction; owner: string; damage: number }>;
  terrain: Array<Array<{ type: string; speed: number }>>;
  capturePoint: { x: number; y: number; radius: number };
  captureProgress: { me: number; enemy: number };
  map: { width: number; height: number; seed: number };
  frame: number;
  maxFrames: number;
}

export interface Tile {
  type: TileType;
}

export interface MapData {
  width: number;
  height: number;
  tiles: Tile[][];
  playerSpawns: Array<{ x: number; y: number }>;
  itemSpawns: Array<{ x: number; y: number; type: WeaponType }>;
  capturePoint: { x: number; y: number; radius: number };
}
