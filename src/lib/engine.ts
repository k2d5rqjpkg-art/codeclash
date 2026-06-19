import type { MapData, Tile, AgentAction, Direction, AgentSnapshot, AgentState, SkillType, WeaponType } from "./types";
import { SKILL_DEFS, WEAPON_DEFS, TERRAIN_EFFECTS } from "./types";
import { sandboxCall } from "./sandbox";
import { createSeededRng } from "./map-generator";

const MAX_FRAMES = 300;
const CAPTURE_WIN_FRAMES = 120;
const PROJECTILE_SPEED = 2;
const DEFAULT_HP = 100;
const SIGHT_RANGE = 8;
const ITEM_RESPAWN_FRAMES = 40;

// ---- serializable state for player ----
interface SerializedAgentState {
  self: AgentSnapshot;
  enemy: AgentSnapshot | null;
  items: Array<{ x: number; y: number; type: string; active: boolean }>;
  projectiles: Array<{ x: number; y: number; direction: string; owner: string; damage: number }>;
  terrain: Array<Array<{ type: string; speed: number }>>;
  capturePoint: { x: number; y: number; radius: number };
  captureProgress: { me: number; enemy: number };
  map: { width: number; height: number; seed: number };
  frame: number;
  maxFrames: number;
}

// ---- internal ----
interface AgentInternal {
  id: string;
  x: number; y: number;
  facing: Direction;
  hp: number; maxHp: number;
  weapon: WeaponType | null;
  weaponCooldown: number;
  skill: SkillType | null;
  skillCooldown: number;
  shielded: boolean; shieldTimer: number;
  cloaked: boolean; cloakTimer: number;
  sprinting: boolean; sprintTimer: number;
  alive: boolean;
  captureFrames: number; // total frames this agent held capture point
}

interface GameItem {
  x: number; y: number;
  type: WeaponType;
  active: boolean;
  respawnTimer: number;
}

interface Projectile {
  id: string;
  x: number; y: number;
  direction: Direction;
  owner: string;
  damage: number;
}

interface ReplayEvent {
  frame: number;
  action: string;
  type: string;
  [key: string]: unknown;
}

interface GameState {
  agents: [AgentInternal, AgentInternal];
  items: GameItem[];
  projectiles: Projectile[];
  map: MapData;
  capturePoint: { x: number; y: number; radius: number };
  frame: number;
  winner: number | null;
  resultReason: string; // "killed" | "capture" | "timeout" | "crashed"
  rng: () => number;
  matchSeed: number;
  records: ReplayEvent[];
}

export interface MatchResult {
  winner: number | null;
  resultReason: string;
  totalFrames: number;
  records: ReplayEvent[];
  captureProgress: { a: number; b: number };
}

// ---- helpers ----
function tileAt(map: MapData, x: number, y: number): Tile {
  if (y < 0 || y >= map.height || x < 0 || x >= map.width) return { type: "wall" };
  return map.tiles[y][x];
}

function isSolid(map: MapData, x: number, y: number): boolean {
  return tileAt(map, x, y).type === "wall";
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function inCaptureZone(
  agent: { x: number; y: number },
  cp: { x: number; y: number; radius: number }
): boolean {
  return Math.abs(agent.x - cp.x) + Math.abs(agent.y - cp.y) <= cp.radius;
}

function onTerrain(map: MapData, x: number, y: number): import("./types").TileType {
  return tileAt(map, Math.round(x), Math.round(y)).type;
}

function getTerrainMod(map: MapData, x: number, y: number) {
  return TERRAIN_EFFECTS[onTerrain(map, x, y)];
}

// ---- state builder ----
function buildAgentState(state: GameState, agentIdx: number): SerializedAgentState {
  const self = state.agents[agentIdx];
  const enemy = state.agents[1 - agentIdx];

  // Enemy visibility: hidden if cloaked, on grass, or beyond sight range
  const selfTerrain = onTerrain(state.map, self.x, self.y);
  const enemyTerrain = onTerrain(state.map, enemy.x, enemy.y);
  const enemyHidden =
    !enemy.alive ||
    enemy.cloaked ||
    (enemyTerrain === "grass" && !self.sprinting) || // sprint reveals grass enemies
    dist(self, enemy) > SIGHT_RANGE;

  const terrain: Array<Array<{ type: string; speed: number }>> = [];
  for (let y = 0; y < state.map.height; y++) {
    terrain[y] = [];
    for (let x = 0; x < state.map.width; x++) {
      const t = state.map.tiles[y][x];
      const eff = TERRAIN_EFFECTS[t.type];
      terrain[y][x] = { type: t.type, speed: eff.moveSpeed };
    }
  }

  return {
    self: {
      x: self.x, y: self.y, facing: self.facing,
      hp: self.hp, maxHp: self.maxHp,
      weapon: self.weapon, weaponCooldown: self.weaponCooldown,
      skill: self.skill, skillCooldown: self.skillCooldown,
      onTerrain: selfTerrain,
      shielded: self.shielded, cloaked: self.cloaked, sprinting: self.sprinting,
    },
    enemy: enemyHidden ? null : {
      x: enemy.x, y: enemy.y, facing: enemy.facing,
      hp: enemy.hp, maxHp: enemy.maxHp,
      weapon: enemy.weapon, weaponCooldown: enemy.weaponCooldown,
      skill: enemy.skill, skillCooldown: enemy.skillCooldown,
      onTerrain: enemyTerrain,
      shielded: enemy.shielded, cloaked: enemy.cloaked, sprinting: enemy.sprinting,
    },
    items: state.items.filter((it) => it.active).map((it) => ({
      x: it.x, y: it.y, type: it.type, active: it.active,
    })),
    projectiles: state.projectiles.map((p) => ({
      x: p.x, y: p.y, direction: p.direction, owner: p.owner, damage: p.damage,
    })),
    terrain,
    capturePoint: state.capturePoint,
    captureProgress: {
      me: agentIdx === 0 ? state.agents[0].captureFrames : state.agents[1].captureFrames,
      enemy: agentIdx === 0 ? state.agents[1].captureFrames : state.agents[0].captureFrames,
    },
    map: { width: state.map.width, height: state.map.height, seed: state.matchSeed },
    frame: state.frame,
    maxFrames: MAX_FRAMES,
  };
}

// ---- step functions ----
function applyMove(state: GameState, agentIdx: number, action: AgentAction) {
  const agent = state.agents[agentIdx];
  if (!agent.alive) return;

  const dir = action.direction;
  if (!dir) return;

  let dx = 0, dy = 0;
  if (dir === "left") dx = -1;
  if (dir === "right") dx = 1;
  if (dir === "up") dy = -1;
  if (dir === "down") dy = 1;

  agent.facing = dir;

  const speed = agent.sprinting ? 2 : 1;
  const terrainMod = getTerrainMod(state.map, agent.x, agent.y).moveSpeed;
  const effectiveSpeed = Math.max(1, Math.round(speed * terrainMod));

  for (let step = 0; step < effectiveSpeed; step++) {
    const nx = agent.x + dx * (step + 1);
    const ny = agent.y + dy * (step + 1);
    if (nx < 0 || nx >= state.map.width || ny < 0 || ny >= state.map.height) break;
    if (isSolid(state.map, nx, ny)) break;
    agent.x = nx;
    agent.y = ny;
  }

  state.records.push({
    frame: state.frame, action: "move", type: "agent",
    objectId: agent.id, to: [agent.x, agent.y],
  });
}

function applyShoot(state: GameState, agentIdx: number, action: AgentAction) {
  const agent = state.agents[agentIdx];
  if (!agent.alive) return;
  if (agent.weaponCooldown > 0) return;
  if (onTerrain(state.map, agent.x, agent.y) === "water") return; // can't shoot in water

  const weapon = agent.weapon;
  if (!weapon) return; // must pick up weapon first

  const def = WEAPON_DEFS[weapon];
  const dir = action.direction || agent.facing;
  const pid = `proj_${state.frame}_${agentIdx}_${state.projectiles.length}`;

  if (weapon === "sword") {
    // Sword is melee — instant damage to nearby enemy
    const enemy = state.agents[1 - agentIdx];
    if (!enemy.alive) return;
    if (dist(agent, enemy) <= def.range) {
      let damage = def.damage;
      if (enemy.shielded) {
        enemy.shielded = false;
        enemy.shieldTimer = 0;
        state.records.push({
          frame: state.frame, action: "shield_break", type: "agent", target: enemy.id,
        });
        damage = 0; // sword pierces shield but does no HP damage this hit
      }
      const terrainMod = getTerrainMod(state.map, agent.x, agent.y).damageMod;
      damage = Math.round(damage * terrainMod);
      // Extra damage from grass ambush
      if (onTerrain(state.map, agent.x, agent.y) === "grass") {
        damage = Math.round(damage * 1.5);
      }
      enemy.hp -= damage;
      state.records.push({
        frame: state.frame, action: "damage", type: "agent",
        target: enemy.id, damage, hp: enemy.hp, weapon: "sword",
      });
      if (enemy.hp <= 0) { enemy.hp = 0; enemy.alive = false; }
    }
  } else {
    // Bow and spear are projectiles
    state.projectiles.push({
      id: pid,
      x: agent.x, y: agent.y,
      direction: dir,
      owner: agent.id,
      damage: def.damage,
    });
    state.records.push({
      frame: state.frame, action: "created", type: "projectile",
      objectId: pid, x: agent.x, y: agent.y, direction: dir, owner: agent.id,
    });
  }

  agent.weaponCooldown = def.cooldown;
}

function applySkill(state: GameState, agentIdx: number, _action: AgentAction) {
  const agent = state.agents[agentIdx];
  if (!agent.alive || !agent.skill || agent.skillCooldown > 0) return;

  const def = SKILL_DEFS[agent.skill];

  switch (agent.skill) {
    case "shield":
      agent.shielded = true;
      agent.shieldTimer = def.duration;
      break;
    case "sprint":
      agent.sprinting = true;
      agent.sprintTimer = def.duration;
      break;
    case "cloak":
      agent.cloaked = true;
      agent.cloakTimer = def.duration;
      break;
  }

  agent.skillCooldown = def.cooldown;

  state.records.push({
    frame: state.frame, action: "skill", type: "agent",
    objectId: agent.id, skillType: agent.skill,
  });
}

function applyPickup(state: GameState, agentIdx: number, _action: AgentAction) {
  const agent = state.agents[agentIdx];
  if (!agent.alive) return;

  for (const item of state.items) {
    if (!item.active) continue;
    if (dist(agent, item) < 1.5) {
      item.active = false;
      item.respawnTimer = ITEM_RESPAWN_FRAMES;
      agent.weapon = item.type;
      agent.weaponCooldown = 0;
      state.records.push({
        frame: state.frame, action: "pickup", type: "agent",
        objectId: agent.id, weapon: item.type,
      });
      break; // one pickup per frame
    }
  }
}

function moveProjectiles(state: GameState) {
  for (const p of state.projectiles) {
    let dx = 0, dy = 0;
    if (p.direction === "left") dx = -PROJECTILE_SPEED;
    if (p.direction === "right") dx = PROJECTILE_SPEED;
    if (p.direction === "up") dy = -PROJECTILE_SPEED;
    if (p.direction === "down") dy = PROJECTILE_SPEED;
    p.x += dx;
    p.y += dy;
  }
  state.projectiles = state.projectiles.filter((p) => {
    if (p.x < 0 || p.x >= state.map.width || p.y < 0 || p.y >= state.map.height) return false;
    if (isSolid(state.map, Math.round(p.x), Math.round(p.y))) return false;
    return true;
  });
}

function applyDamage(state: GameState) {
  for (const agent of state.agents) {
    if (!agent.alive) continue;

    for (let i = state.projectiles.length - 1; i >= 0; i--) {
      const p = state.projectiles[i];
      if (p.owner === agent.id) continue; // no self-damage

      if (dist(agent, p) < 1.5) {
        let damage = p.damage;

        // Shield blocks projectiles
        if (agent.shielded) {
          agent.shielded = false;
          agent.shieldTimer = 0;
          state.projectiles.splice(i, 1);
          state.records.push({
            frame: state.frame, action: "shield_block", type: "agent", target: agent.id,
          });
          continue;
        }

        // Terrain modifier for the target
        const terrainMod = getTerrainMod(state.map, agent.x, agent.y).damageMod;
        damage = Math.round(damage * terrainMod);

        agent.hp -= damage;

        state.records.push({
          frame: state.frame, action: "damage", type: "agent",
          target: agent.id, damage, hp: agent.hp,
        });
        state.projectiles.splice(i, 1);

        if (agent.hp <= 0) { agent.hp = 0; agent.alive = false; }
      }
    }
  }
}

function updateCapture(state: GameState) {
  const [a, b] = state.agents;
  if (!a.alive || !b.alive) return;

  const cp = state.capturePoint;
  const aIn = inCaptureZone(a, cp);
  const bIn = inCaptureZone(b, cp);

  // Only progress if exactly one agent is in zone
  if (aIn && !bIn) {
    a.captureFrames++;
    if (a.captureFrames % 30 === 0) {
      state.records.push({
        frame: state.frame, action: "capture_progress", type: "game",
        agent: "A", progress: a.captureFrames,
      });
    }
  } else if (bIn && !aIn) {
    b.captureFrames++;
    if (b.captureFrames % 30 === 0) {
      state.records.push({
        frame: state.frame, action: "capture_progress", type: "game",
        agent: "B", progress: b.captureFrames,
      });
    }
  }
  // If both or neither in zone, no progress
}

function respawnItems(state: GameState) {
  for (const item of state.items) {
    if (!item.active && item.respawnTimer > 0) {
      item.respawnTimer--;
      if (item.respawnTimer === 0) item.active = true;
    }
  }
}

function tickStatus(state: GameState) {
  for (const agent of state.agents) {
    if (!agent.alive) continue;
    if (agent.shieldTimer > 0) { agent.shieldTimer--; if (agent.shieldTimer === 0) agent.shielded = false; }
    if (agent.cloakTimer > 0) {
      agent.cloakTimer--;
      if (agent.cloakTimer === 0) agent.cloaked = false;
      // Cloak lasts longer in grass
      if (onTerrain(state.map, agent.x, agent.y) === "grass" && agent.cloakTimer > 0) {
        agent.cloakTimer++; // grass extends cloak
      }
    }
    if (agent.sprintTimer > 0) {
      agent.sprintTimer--;
      if (agent.sprintTimer === 0) agent.sprinting = false;
      // Sprint is extended in water (ignores water slow)
    }
    if (agent.skillCooldown > 0) agent.skillCooldown--;
    if (agent.weaponCooldown > 0) agent.weaponCooldown--;
  }
}

function checkGameOver(state: GameState): boolean {
  const [a, b] = state.agents;
  const hadCrash = state.resultReason === "crashed";

  if (!a.alive && !hadCrash) { state.winner = 1; state.resultReason = "killed"; return true; }
  if (!b.alive && !hadCrash) { state.winner = 0; state.resultReason = "killed"; return true; }
  if (!a.alive || !b.alive) return true;

  // Capture win
  if (a.captureFrames >= CAPTURE_WIN_FRAMES) {
    state.winner = 0; state.resultReason = "capture"; return true;
  }
  if (b.captureFrames >= CAPTURE_WIN_FRAMES) {
    state.winner = 1; state.resultReason = "capture"; return true;
  }

  if (state.frame >= MAX_FRAMES - 1) {
    if (a.hp > b.hp) state.winner = 0;
    else if (b.hp > a.hp) state.winner = 1;
    else {
      // If HP equal, whoever has more capture progress wins
      if (a.captureFrames > b.captureFrames) state.winner = 0;
      else if (b.captureFrames > a.captureFrames) state.winner = 1;
      else state.winner = null;
    }
    state.resultReason = "timeout";
    return true;
  }
  return false;
}

// ---- main ----
export function initState(mapData: MapData, matchSeed: number, skillA?: SkillType, skillB?: SkillType): GameState {
  const rng = createSeededRng(matchSeed);
  const makeAgent = (id: string, sx: number, sy: number, facing: Direction, skill?: SkillType): AgentInternal => ({
    id, x: sx, y: sy, facing,
    hp: DEFAULT_HP, maxHp: DEFAULT_HP,
    weapon: null, weaponCooldown: 0,
    skill: skill || null, skillCooldown: 0,
    shielded: false, shieldTimer: 0,
    cloaked: false, cloakTimer: 0,
    sprinting: false, sprintTimer: 0,
    alive: true,
    captureFrames: 0,
  });
  return {
    agents: [
      makeAgent("agentA", mapData.playerSpawns[0].x, mapData.playerSpawns[0].y, "right", skillA),
      makeAgent("agentB", mapData.playerSpawns[1].x, mapData.playerSpawns[1].y, "left", skillB),
    ],
    items: mapData.itemSpawns.map((sp) => ({
      x: sp.x, y: sp.y, type: sp.type, active: true, respawnTimer: 0,
    })),
    projectiles: [],
    map: mapData,
    capturePoint: mapData.capturePoint,
    frame: 0, winner: null, resultReason: "",
    rng, matchSeed, records: [],
  };
}

function step(
  state: GameState,
  actionA: AgentAction, actionB: AgentAction,
  crashedA: boolean, crashedB: boolean,
) {
  if (crashedA) { state.agents[0].alive = false; state.winner = 1; state.resultReason = "crashed"; return; }
  if (crashedB) { state.agents[1].alive = false; state.winner = 0; state.resultReason = "crashed"; return; }

  if (actionA.action === "move") applyMove(state, 0, actionA);
  if (actionB.action === "move") applyMove(state, 1, actionB);

  if (actionA.action === "shoot") applyShoot(state, 0, actionA);
  if (actionB.action === "shoot") applyShoot(state, 1, actionB);

  moveProjectiles(state);

  if (actionA.action === "skill") applySkill(state, 0, actionA);
  if (actionB.action === "skill") applySkill(state, 1, actionB);

  if (actionA.action === "pickup") applyPickup(state, 0, actionA);
  if (actionB.action === "pickup") applyPickup(state, 1, actionB);

  applyDamage(state);
  updateCapture(state);
  respawnItems(state);
  tickStatus(state);
}

export async function runMatch(
  codeA: string, codeB: string,
  mapData: MapData, matchSeed: number,
  skillA?: SkillType, skillB?: SkillType,
): Promise<MatchResult> {
  const state = initState(mapData, matchSeed, skillA, skillB);

  for (state.frame = 0; state.frame < MAX_FRAMES; state.frame++) {
    const stateA = buildAgentState(state, 0);
    const stateB = buildAgentState(state, 1);

    const [resA, resB] = await Promise.all([
      sandboxCall(codeA, stateA as unknown as AgentState),
      sandboxCall(codeB, stateB as unknown as AgentState),
    ]);

    const actionA: AgentAction = resA.ok ? resA.action : { action: "none" };
    const actionB: AgentAction = resB.ok ? resB.action : { action: "none" };

    step(state, actionA, actionB, !resA.ok && resA.reason === "crash", !resB.ok && resB.reason === "crash");

    if (checkGameOver(state)) break;
  }

  state.records.push({
    frame: state.frame, action: "end", type: "game",
    winner: state.winner ?? -1,
    reason: state.resultReason,
    captureProgress: {
      a: state.agents[0].captureFrames,
      b: state.agents[1].captureFrames,
    },
  });

  return {
    winner: state.winner,
    resultReason: state.resultReason,
    totalFrames: state.frame + 1,
    records: state.records,
    captureProgress: {
      a: state.agents[0].captureFrames,
      b: state.agents[1].captureFrames,
    },
  };
}
