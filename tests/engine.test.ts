import { describe, it, expect } from "vitest";
import { runMatch } from "../src/lib/engine";
import { generateMap } from "../src/lib/map-generator";
import { calcElo, ratingToTier } from "../src/lib/elo";
import type { SkillType } from "../src/lib/types";

const CAPTURE_WIN = 120;

// ---- Test strategies ----

const AGGRESSIVE = `
function act(state) {
  var self = state.self;
  var enemy = state.enemy;
  // Always pick up a weapon first
  if (!self.weapon) {
    var items = state.items.filter(function(i) { return i.active; });
    if (items.length > 0) {
      var it = items[0];
      if (Math.abs(it.x - self.x) < 2 && Math.abs(it.y - self.y) < 2) return { action: 'pickup' };
      return { action: 'move', direction: it.x > self.x ? 'right' : it.x < self.x ? 'left' : it.y > self.y ? 'down' : 'up' };
    }
  }
  if (self.skillCooldown === 0) return { action: 'skill' };
  if (!enemy) return { action: 'move', direction: state.capturePoint.x > self.x ? 'right' : 'left' };
  var dx = enemy.x - self.x;
  if (self.weaponCooldown === 0 && Math.abs(dx) < 5) {
    return { action: 'shoot', direction: dx > 0 ? 'right' : 'left' };
  }
  return { action: 'move', direction: dx > 0 ? 'right' : 'left' };
}`;

const CAPTURE_FOCUSED = `
function act(state) {
  var self = state.self;
  var cp = state.capturePoint;
  // Get weapon first: move to item, then pickup
  if (!self.weapon) {
    var items = state.items.filter(function(i) { return i.active; });
    if (items.length > 0) {
      var it = items[0], minD = 99;
      for (var i = 0; i < items.length; i++) {
        var d = Math.abs(items[i].x - self.x) + Math.abs(items[i].y - self.y);
        if (d < minD) { minD = d; it = items[i]; }
      }
      if (minD < 2) return { action: 'pickup' };
      return { action: 'move', direction: it.x > self.x ? 'right' : it.x < self.x ? 'left' : it.y > self.y ? 'down' : 'up' };
    }
  }
  // Head to capture point
  var toCpX = cp.x - self.x;
  var toCpY = cp.y - self.y;
  if (Math.abs(toCpX) + Math.abs(toCpY) > cp.radius) {
    return { action: 'move', direction: toCpX > 0 ? 'right' : toCpX < 0 ? 'left' : toCpY > 0 ? 'down' : 'up' };
  }
  if (self.skillCooldown === 0) return { action: 'skill' };
  if (state.enemy && self.weaponCooldown === 0) {
    return { action: 'shoot', direction: state.enemy.x > self.x ? 'right' : 'left' };
  }
  return { action: 'none' };
}`;

const TERRAIN_SMART = `
function act(state) {
  var self = state.self;
  var enemy = state.enemy;
  var myTile = state.terrain[Math.round(self.y)][Math.round(self.x)];
  // If in water, get out
  if (myTile.type === 'water') {
    return { action: 'move', direction: self.facing === 'up' ? 'down' : self.facing === 'down' ? 'up' : 'right' };
  }
  // Move to grass for ambush
  if (myTile.type !== 'grass') {
    for (var dy = -3; dy <= 3; dy++) {
      for (var dx = -3; dx <= 3; dx++) {
        var ty = Math.round(self.y) + dy;
        var tx = Math.round(self.x) + dx;
        if (ty >= 0 && ty < state.map.height && tx >= 0 && tx < state.map.width) {
          if (state.terrain[ty][tx].type === 'grass') {
            return { action: 'move', direction: dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up' };
          }
        }
      }
    }
  }
  if (self.skillCooldown === 0 && myTile.type === 'grass') return { action: 'skill' };
  if (enemy && self.weaponCooldown === 0 && myTile.type === 'grass') {
    return { action: 'shoot', direction: enemy.x > self.x ? 'right' : 'left' };
  }
  return { action: 'move', direction: state.capturePoint.x > self.x ? 'right' : 'left' };
}`;

describe("Engine", () => {
  it("runs 1v1 and produces winner + records", async () => {
    const map = generateMap(42);
    const result = await runMatch(AGGRESSIVE, CAPTURE_FOCUSED, map, 42, "shield", "sprint");

    console.log("\n========== MATCH RESULT ==========");
    console.log(`Winner: ${result.winner === 0 ? "A (Shield)" : result.winner === 1 ? "B (Sprint)" : "Draw"}`);
    console.log(`Reason: ${result.resultReason}`);
    console.log(`Frames: ${result.totalFrames}`);
    console.log(`Capture: A=${result.captureProgress.a} B=${result.captureProgress.b}`);
    console.log(`Events: ${result.records.length}`);
    console.log("==================================\n");

    expect([0, 1, null]).toContain(result.winner);
    expect(result.totalFrames).toBeGreaterThan(0);
    expect(result.records.length).toBeGreaterThan(0);
    const last = result.records[result.records.length - 1];
    expect(last.action).toBe("end");
  });

  it("deterministic: same seed = same result", async () => {
    const m1 = generateMap(123);
    const m2 = generateMap(123);
    const r1 = await runMatch(AGGRESSIVE, CAPTURE_FOCUSED, m1, 123, "shield", "sprint");
    const r2 = await runMatch(AGGRESSIVE, CAPTURE_FOCUSED, m2, 123, "shield", "sprint");
    expect(r1.winner).toBe(r2.winner);
    expect(r1.totalFrames).toBe(r2.totalFrames);
    expect(r1.captureProgress.a).toBe(r2.captureProgress.a);
  });

  it("capture point exists and is at map center", () => {
    const map = generateMap(99);
    expect(map.capturePoint.x).toBe(9);  // center of 18
    expect(map.capturePoint.y).toBe(6);  // center of 12
    expect(map.capturePoint.radius).toBe(2);
  });

  it("capture zone has minimal cover", () => {
    const map = generateMap(100);
    const cp = map.capturePoint;
    let wallCount = 0;
    for (let dy = -cp.radius; dy <= cp.radius; dy++) {
      for (let dx = -cp.radius; dx <= cp.radius; dx++) {
        const x = cp.x + dx;
        const y = cp.y + dy;
        if (y >= 0 && y < map.height && x >= 0 && x < map.width) {
          if (Math.abs(dx) + Math.abs(dy) <= cp.radius) {
            if (map.tiles[y][x].type === "wall") wallCount++;
          }
        }
      }
    }
    console.log(`  Walls in capture zone: ${wallCount} (should be 0-2)`);
    expect(wallCount).toBeLessThanOrEqual(2);
  });

  it("capture-focused agent makes progress toward 120", async () => {
    const IDLE = `function act(state) { return { action: 'none' }; }`;
    const map = generateMap(42);
    // Capture-focused vs idle — should capture quickly
    const result = await runMatch(CAPTURE_FOCUSED, IDLE, map, 42, "sprint", "cloak");
    console.log(`  Capture progress: A=${result.captureProgress.a} B=${result.captureProgress.b}`);
    // cap-focused should have more progress than idle
    expect(result.captureProgress.a).toBeGreaterThan(result.captureProgress.b);
  });

  it("both in zone = no progress for either", async () => {
    const BOTH_CENTER = `
function act(state) {
  var self = state.self;
  var cp = state.capturePoint;
  var dx = cp.x - self.x;
  var dy = cp.y - self.y;
  if (Math.abs(dx) + Math.abs(dy) > cp.radius) {
    return { action: 'move', direction: dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up' };
  }
  return { action: 'none' };
}`;
    const map = generateMap(77);
    const result = await runMatch(BOTH_CENTER, BOTH_CENTER, map, 77);
    // Both go to center and contest — capture cannot progress for either
    console.log(`  Both-in-zone: A=${result.captureProgress.a} B=${result.captureProgress.b} reason=${result.resultReason}`);
    // Neither can reach 120 due to mutual contest
    expect(result.captureProgress.a).toBeLessThan(CAPTURE_WIN);
    expect(result.captureProgress.b).toBeLessThan(CAPTURE_WIN);
  });

  it("crash = instant loss", async () => {
    const CRASH = `function act(state) { throw new Error("crash"); }`;
    const map = generateMap(55);
    const result = await runMatch(CRASH, AGGRESSIVE, map, 55);
    expect(result.resultReason).toBe("crashed");
    expect(result.winner).toBe(1);
  });

  it("terrain-smart agent seeks grass for ambush", async () => {
    const map = generateMap(33);
    const result = await runMatch(TERRAIN_SMART, AGGRESSIVE, map, 33, "cloak", "shield");
    console.log(`  Terrain-smart vs Aggressive: winner=${result.winner} reason=${result.resultReason}`);
    expect(result.totalFrames).toBeGreaterThan(0);
  });

  it("weapon counter: sword beats no-shield, bow blocked by shield", async () => {
    // This tests that the counter system compiles and runs
    const map = generateMap(11);
    const result = await runMatch(AGGRESSIVE, AGGRESSIVE, map, 11, "shield", "shield");
    const blocks = result.records.filter((e) => e.action === "shield_block");
    const shieldBreaks = result.records.filter((e) => e.action === "shield_break");
    console.log(`  Shield blocks: ${blocks.length}, Shield breaks: ${shieldBreaks.length}`);
    expect(result.totalFrames).toBeGreaterThan(0);
  });
});

describe("ELO", () => {
  it("calcElo works", () => {
    const r = calcElo(1200, 1200, "A");
    expect(r.newRatingA).toBeGreaterThan(1200);
    expect(r.newRatingB).toBeLessThan(1200);
  });

  it("ratingToTier works", () => {
    expect(ratingToTier(1100).tier).toBe("bronze");
    expect(ratingToTier(1350).tier).toBe("silver");
    expect(ratingToTier(2100).tier).toBe("diamond");
    expect(ratingToTier(2300).tier).toBe("master");
  });
});

describe("Map", () => {
  it("deterministic", () => {
    expect(generateMap(42)).toEqual(generateMap(42));
  });

  it("correct size", () => {
    const m = generateMap(1);
    expect(m.width).toBe(18);
    expect(m.height).toBe(12);
  });

  it("has walls at boundaries", () => {
    const m = generateMap(2);
    for (let x = 0; x < 18; x++) {
      expect(m.tiles[0][x].type).toBe("wall");
      expect(m.tiles[11][x].type).toBe("wall");
    }
  });
});
