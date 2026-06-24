// Cloudflare Worker — CodeClash

// ---- Pure JS sandbox (replaces isolated-vm) ----
function sandboxCall(code, state) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: "timeout", error: "500ms exceeded" }), 500);
    try {
      const fn = new Function("state", code + "\nreturn act(state);");
      const action = fn(state);
      clearTimeout(timer);
      resolve({ ok: true, action: action || { action: "none" } });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, reason: "crash", error: err.message });
    }
  });
}

// ---- Engine (minimal, inlined for Workers) ----
function createSeededRng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function generateMap(seed) {
  const rng = createSeededRng(seed ?? Date.now());
  const W = 18, H = 12, CX = 9, CY = 6;
  const tiles = [];
  for (let y = 0; y < H; y++) { tiles[y] = []; for (let x = 0; x < W; x++) tiles[y][x] = { type: "open" }; }
  for (let x = 0; x < W; x++) { tiles[0][x] = { type: "wall" }; tiles[H-1][x] = { type: "wall" }; }
  for (let y = 0; y < H; y++) { tiles[y][0] = { type: "wall" }; tiles[y][W-1] = { type: "wall" }; }
  const wallClusters = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < wallClusters; i++) {
    const wx = 2 + Math.floor(rng() * (W-6)), wy = 2 + Math.floor(rng() * (H-6));
    for (let dy = 0; dy < 1 + Math.floor(rng() * 2); dy++)
      for (let dx = 0; dx < 1 + Math.floor(rng() * 3); dx++)
        if (wx+dx > 0 && wx+dx < W-1 && wy+dy > 0 && wy+dy < H-1 && !(Math.abs(wx+dx-1) <= 2 && Math.abs(wy+dy-H+2) <= 2) && !(Math.abs(wx+dx-W+2) <= 2 && Math.abs(wy+dy-1) <= 2) && !(Math.abs(wx+dx-CX) <= 2 && Math.abs(wy+dy-CY) <= 2))
          tiles[wy+dy][wx+dx] = { type: "wall" };
  }
  for (let y = 1; y < H-1; y++) for (let x = 1; x < W-1; x++) if (tiles[y][x].type === "open" && rng() < 0.15) if (Math.abs(x-CX)+Math.abs(y-CY) > 2 || rng() < 0.3) tiles[y][x] = { type: "grass" };
  for (let y = CY-2; y <= CY+2; y++) for (let x = CX-2; x <= CX+2; x++) if (y > 0 && y < H-1 && x > 0 && x < W-1 && Math.abs(x-CX)+Math.abs(y-CY) <= 2) tiles[y][x] = { type: "open" };
  tiles[CY][CX+2] = { type: "wall" };
  const spA = { x: 1, y: H-2 }, spB = { x: W-2, y: 1 };
  for (const sp of [spA, spB]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (sp.x+dx > 0 && sp.x+dx < W-1 && sp.y+dy > 0 && sp.y+dy < H-1) tiles[sp.y+dy][sp.x+dx] = { type: "open" };
  const weapons = ["sword", "bow", "spear"];
  const itemSpawns = [{ x: 2 + Math.floor(rng() * (CX-5)), y: CY + Math.floor(rng() * (H-2-CY)), type: weapons[Math.floor(rng() * 3)] }, { x: CX + 3 + Math.floor(rng() * (W-3-CX-3)), y: 2 + Math.floor(rng() * (CY-2)), type: weapons[Math.floor(rng() * 3)] }];
  return { width: W, height: H, tiles, playerSpawns: [spA, spB], itemSpawns, capturePoint: { x: CX, y: CY, radius: 2 } };
}

async function runMatch(codeA, codeB, map, seed, skillA, skillB) {
  const MAX_FRAMES = 200, CAPTURE_WIN = 120, SIGHT = 8, DEFAULT_HP = 100;
  const WEAPONS = { sword: { dmg: 30, range: 1.5, cd: 8 }, spear: { dmg: 25, range: 3, cd: 10 }, bow: { dmg: 20, range: 8, cd: 6 } };
  const SKILLS = { shield: { cd: 20, dur: 4 }, sprint: { cd: 15, dur: 6 }, cloak: { cd: 25, dur: 8 } };
  const TERRAIN = { open: { spd: 1, dmg: 1 }, grass: { spd: 1, dmg: 1.5 }, water: { spd: 0.5, dmg: 0.7 }, wall: { spd: 0, dmg: 0 } };

  function tileAt(x, y) { if (y<0||y>=map.height||x<0||x>=map.width) return { type: "wall" }; return map.tiles[y][x]; }
  function isSolid(x, y) { return tileAt(x,y).type === "wall"; }
  function dist(a,b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2); }
  function terrainAt(x, y) { return TERRAIN[tileAt(Math.round(x),Math.round(y)).type] || TERRAIN.open; }
  function inCapture(a, cp) { return Math.abs(a.x-cp.x)+Math.abs(a.y-cp.y) <= cp.radius; }

  const agents = [
    { id: "agentA", x: map.playerSpawns[0].x, y: map.playerSpawns[0].y, facing: "right", hp: DEFAULT_HP, maxHp: DEFAULT_HP, weapon: null, weaponCd: 0, skill: skillA, skillCd: 0, shielded: false, shieldTimer: 0, cloaked: false, cloakTimer: 0, sprinting: false, sprintTimer: 0, alive: true, capFrames: 0 },
    { id: "agentB", x: map.playerSpawns[1].x, y: map.playerSpawns[1].y, facing: "left", hp: DEFAULT_HP, maxHp: DEFAULT_HP, weapon: null, weaponCd: 0, skill: skillB, skillCd: 0, shielded: false, shieldTimer: 0, cloaked: false, cloakTimer: 0, sprinting: false, sprintTimer: 0, alive: true, capFrames: 0 },
  ];
  let projectiles = [], items = map.itemSpawns.map(s => ({ ...s, active: true, respawn: 0 }));
  const cp = map.capturePoint;
  let winner = null, reason = "", records = [];

  function buildState(idx) {
    const s = agents[idx], e = agents[1-idx];
    const eHidden = !e.alive || e.cloaked || (terrainAt(e.x,e.y).dmg > 1 && dist(s,e) > 5) || dist(s,e) > SIGHT;
    const terrain = []; for (let y=0;y<map.height;y++) { terrain[y]=[]; for (let x=0;x<map.width;x++) terrain[y][x]={type:map.tiles[y][x].type,speed:TERRAIN[map.tiles[y][x].type].spd}; }
    return {
      self: { x:s.x, y:s.y, facing:s.facing, hp:s.hp, maxHp:s.maxHp, weapon:s.weapon, weaponCooldown:s.weaponCd, skill:s.skill, skillCooldown:s.skillCd, onTerrain:tileAt(Math.round(s.x),Math.round(s.y)).type, shielded:s.shielded, cloaked:s.cloaked, sprinting:s.sprinting },
      enemy: eHidden ? null : { x:e.x, y:e.y, facing:e.facing, hp:e.hp, maxHp:e.maxHp, weapon:e.weapon, weaponCooldown:e.weaponCd, skill:e.skill, skillCooldown:e.skillCd, onTerrain:tileAt(Math.round(e.x),Math.round(e.y)).type, shielded:e.shielded, cloaked:e.cloaked, sprinting:e.sprinting },
      items: items.filter(it=>it.active).map(it=>({x:it.x,y:it.y,type:it.type,active:it.active})),
      projectiles: projectiles.map(p=>({x:p.x,y:p.y,direction:p.direction,owner:p.owner,damage:p.damage})),
      terrain, capturePoint: cp, captureProgress: { me: idx===0?agents[0].capFrames:agents[1].capFrames, enemy: idx===0?agents[1].capFrames:agents[0].capFrames },
      map: { width:map.width, height:map.height, seed }, frame, maxFrames: MAX_FRAMES
    };
  }

  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const [resA, resB] = await Promise.all([sandboxCall(codeA, buildState(0)), sandboxCall(codeB, buildState(1))]);
    const actA = resA.ok ? resA.action : { action: "none" }, actB = resB.ok ? resB.action : { action: "none" };
    if (!resA.ok && resA.reason === "crash") { agents[0].alive = false; winner = 1; reason = "crashed"; }
    if (!resB.ok && resB.reason === "crash") { agents[1].alive = false; winner = 0; reason = "crashed"; }
    if (winner !== null) break;

    for (const [idx, act] of [[0, actA], [1, actB]]) {
      const a = agents[idx];
      if (!a.alive) continue;
      // Move
      if (act.action === "move" && act.direction) {
        const dir = act.direction; let dx=0, dy=0;
        if (dir==="left") dx=-1; if (dir==="right") dx=1; if (dir==="up") dy=-1; if (dir==="down") dy=1;
        a.facing = dir;
        const spd = a.sprinting ? 2 : 1;
        const tmod = terrainAt(a.x, a.y).spd;
        for (let s=0; s<Math.max(1,Math.round(spd*tmod)); s++) {
          const nx = a.x+dx, ny = a.y+dy;
          if (nx<0||nx>=map.width||ny<0||ny>=map.height||isSolid(nx,ny)) break;
          a.x=nx; a.y=ny;
        }
      }
      // Skill
      if (act.action === "skill" && a.skill && a.skillCd === 0) {
        const sd = SKILLS[a.skill];
        if (a.skill === "shield") { a.shielded=true; a.shieldTimer=sd.dur; }
        if (a.skill === "sprint") { a.sprinting=true; a.sprintTimer=sd.dur; }
        if (a.skill === "cloak") { a.cloaked=true; a.cloakTimer=sd.dur; }
        a.skillCd = sd.cd;
      }
      // Shoot
      if (act.action === "shoot" && a.weapon && a.weaponCd === 0 && terrainAt(a.x,a.y).spd > 0) {
        const wd = WEAPONS[a.weapon];
        if (a.weapon === "sword") {
          const e = agents[1-idx];
          if (e.alive && dist(a,e) <= wd.range) {
            let dmg = wd.dmg * terrainAt(a.x,a.y).dmg;
            if (e.shielded) { e.shielded=false; e.shieldTimer=0; } else { e.hp -= dmg; records.push({frame,action:"damage",target:e.id,damage:dmg,hp:e.hp}); if (e.hp<=0) { e.hp=0; e.alive=false; } }
          }
        } else {
          const d = act.direction || a.facing;
          projectiles.push({ x:a.x, y:a.y, direction:d, owner:a.id, damage:wd.dmg });
        }
        a.weaponCd = wd.cd;
      }
      // Pickup
      if (act.action === "pickup") {
        for (const it of items) { if (it.active && dist(a,it) < 1.5) { it.active=false; it.respawn=40; a.weapon=it.type; a.weaponCd=0; break; } }
      }
    }

    // Move projectiles
    for (const p of projectiles) { let dx=0, dy=0; if (p.direction==="left") dx=-2; if (p.direction==="right") dx=2; if (p.direction==="up") dy=-2; if (p.direction==="down") dy=2; p.x+=dx; p.y+=dy; }
    projectiles = projectiles.filter(p=>!(p.x<0||p.x>=map.width||p.y<0||p.y>=map.height||isSolid(Math.round(p.x),Math.round(p.y))));

    // Apply damage
    for (const a of agents) {
      if (!a.alive) continue;
      for (let i=projectiles.length-1; i>=0; i--) {
        const p = projectiles[i];
        if (p.owner === a.id) continue;
        if (dist(a,p) < 2) {
          let dmg = p.damage * terrainAt(a.x,a.y).dmg;
          if (a.shielded) { a.shielded=false; a.shieldTimer=0; projectiles.splice(i,1); continue; }
          a.hp -= dmg; records.push({frame,action:"damage",target:a.id,damage:dmg,hp:a.hp}); projectiles.splice(i,1);
          if (a.hp<=0) { a.hp=0; a.alive=false; }
        }
      }
    }

    // Capture
    const [aIn,bIn] = [inCapture(agents[0],cp), inCapture(agents[1],cp)];
    if (aIn && !bIn) agents[0].capFrames++;
    else if (bIn && !aIn) agents[1].capFrames++;
    if (agents[0].capFrames >= CAPTURE_WIN) { winner=0; reason="capture"; break; }
    if (agents[1].capFrames >= CAPTURE_WIN) { winner=1; reason="capture"; break; }
    // Timeout
    if (frame >= MAX_FRAMES-1) {
      if (agents[0].hp > agents[1].hp) winner=0; else if (agents[1].hp > agents[0].hp) winner=1;
      else if (agents[0].capFrames > agents[1].capFrames) winner=0; else if (agents[1].capFrames > agents[0].capFrames) winner=1;
      reason="timeout"; break;
    }
    // Killed
    if (!agents[0].alive) { winner=1; reason="killed"; break; }
    if (!agents[1].alive) { winner=0; reason="killed"; break; }

    // Tick timers
    for (const a of agents) { if (a.shieldTimer>0&&--a.shieldTimer===0) a.shielded=false; if (a.cloakTimer>0&&--a.cloakTimer===0) a.cloaked=false; if (a.sprintTimer>0&&--a.sprintTimer===0) a.sprinting=false; if (a.skillCd>0) a.skillCd--; if (a.weaponCd>0) a.weaponCd--; }
    for (const it of items) if (!it.active&&it.respawn>0&&--it.respawn===0) it.active=true;
  }

  return { winner, resultReason: reason, totalFrames: records.length ? records[records.length-1]?.frame+1 : 1, records, captureProgress: { a: agents[0].capFrames, b: agents[1].capFrames } };
}

// ---- Routes ----
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
    if (method === "OPTIONS") return new Response(null, { status: 204, headers });

    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    const error = (msg, status = 400) => json({ error: msg }, status);
    const body = async () => { try { return await request.json(); } catch { return {}; } };

    // Health
    if (url.pathname === "/api/health") return json({ status: "ok", name: "CodeClash", version: "0.2-cf" });

    // Get tanks from KV
    const getTanks = async () => { try { const d = await env.TANKS.get("tanks"); return d ? JSON.parse(d) : []; } catch { return []; } };
    const setTanks = async (tanks) => { await env.TANKS.put("tanks", JSON.stringify(tanks)); };

    // Register
    if (method === "POST" && url.pathname === "/api/tanks/register") {
      const b = await body();
      const name = b.name || "Agent-" + Math.random().toString(36).slice(2, 8);
      const code = b.code || "function act(s){var e=s.enemy,cp=s.capturePoint;if(!s.self.weapon&&s.items.length){var it=s.items[0];if(Math.abs(it.x-s.self.x)<2)return{action:'pickup'};return{action:'move',direction:it.x>s.self.x?'right':'left'}}if(s.self.skillCooldown===0)return{action:'skill'};if(!e)return{action:'move',direction:cp.x>s.self.x?'right':'left'}if(s.self.weaponCooldown===0)return{action:'shoot',direction:e.x>s.self.x?'right':'left'};return{action:'move',direction:e.x>s.self.x?'right':'left'}}";
      const skill = b.skill || "shield";
      const model = b.model || "human";
      const tanks = await getTanks();
      const tankKey = "tk_" + crypto.randomUUID().replace(/-/g, "").slice(0, 32);
      const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tankKey));
      const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      const tank = { name, code, skill, model, elo: 1200, wins: 0, losses: 0, draws: 0, tankKeyHash: hash, createdAt: new Date().toISOString(), lastBattle: null };
      tanks.push(tank);
      await setTanks(tanks);
      return json({ name, tankKey, skill, model, agentGuideUrl: url.origin + "/agent-guide", message: "Give this battle key and guide URL to your AI agent." }, 201);
    }

    // Leaderboard
    if (url.pathname === "/api/agent/leaderboard") {
      const tanks = await getTanks();
      return json(tanks.sort((a, b) => b.elo - a.elo).slice(0, 50).map((t, i) => ({ rank: i + 1, name: t.name, elo: t.elo, wins: t.wins, losses: t.losses, draws: t.draws, model: t.model, skill: t.skill })));
    }

    // Challenge
    if (method === "POST" && url.pathname === "/api/agent/tank/challenge") {
      const b = await body();
      const auth = request.headers.get("Authorization") || "";
      const key = auth.startsWith("Bearer tk_") ? auth.slice(7) : "";
      if (!key) return error("Valid battle key required", 401);
      const tanks = await getTanks();
      const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      const reqHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      const me = tanks.find(t => t.tankKeyHash === reqHash);
      if (!me) return error("Invalid key", 401);
      const opp = tanks.find(t => t.name === b.opponent);
      if (!opp) return error("Opponent not found", 404);

      const seed = Date.now();
      const map = generateMap(seed);
      const result = await runMatch(me.code, opp.code, map, seed, me.skill, opp.skill);

      // ELO
      const K = 25;
      const expectedA = 1 / (1 + 10 ** ((opp.elo - me.elo) / 400));
      const scoreA = result.winner === 0 ? 1 : result.winner === 1 ? 0 : 0.5;
      const deltaA = Math.round(K * (scoreA - expectedA));
      me.elo += (result.winner === 0 ? deltaA : result.winner === 1 ? -Math.round(K * ((1-scoreA) - (1-expectedA))) : 0);
      opp.elo += (result.winner === 1 ? deltaA : result.winner === 0 ? Math.round(K * ((1-scoreA) - (1-expectedA))) : 0);
      if (result.winner === 0) { me.wins++; opp.losses++; } else if (result.winner === 1) { opp.wins++; me.losses++; } else { me.draws++; opp.draws++; }
      me.lastBattle = new Date().toISOString(); opp.lastBattle = new Date().toISOString();
      await setTanks(tanks);

      return json({ winner: result.winner === 0 ? me.name : result.winner === 1 ? opp.name : null, resultReason: result.resultReason, totalFrames: result.totalFrames, captureProgress: result.captureProgress });
    }

    // Simulate
    if (method === "POST" && url.pathname === "/api/agent/tank/simulate") {
      const b = await body();
      if (!b.code) return error("code required");
      const map = generateMap(Date.now());
      const opponentCode = b.opponentCode || "function act(s){return{action:'move',direction:'right'}}";
      const result = await runMatch(b.code, opponentCode, map, Date.now(), b.skillType || "shield", "shield");
      return json({ winner: result.winner, resultReason: result.resultReason, totalFrames: result.totalFrames });
    }

    // Generate
    if (method === "POST" && url.pathname === "/api/tanks/generate") {
      const b = await body();
      if (!b.prompt || !b.apiKey) return error("prompt and apiKey required");
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json", "x-api-key": b.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1500,
            system: "You write JavaScript battle strategies. Output ONLY function act(state) { ... }. No explanations. Game: 18x12 grid, weapons (sword/bow/spear), skills (shield/sprint/cloak), capture point center. Enemy null when hidden.",
            messages: [{ role: "user", content: `Write a battle strategy: ${b.prompt}. Agent skill: ${b.skill || "shield"}.` }]
          })
        });
        const data = await resp.json();
        let code = data.content?.[0]?.text || "";
        const m = code.match(/```[\s\S]*?```/) || []; if (m[0]) code = m[0].replace(/```\w*\n?/g, "").trim();
        if (code.startsWith("function act")) code = code; else if (code.includes("function act")) code = code.slice(code.indexOf("function act"));
        return json({ code: code || "function act(s){return{action:'move',direction:'right'}}" });
      } catch (e) { return error("AI generation failed: " + e.message, 500); }
    }

    return json({ status: "ok" });
  }
};
