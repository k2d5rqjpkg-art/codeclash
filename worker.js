// Cloudflare Worker — CodeClash v0.3

// ---- Sandbox ----
function sandboxCall(code, state) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 500);
    try { const fn = new Function("state", code + "\nreturn act(state);"); const a = fn(state); clearTimeout(timer); resolve({ ok: true, action: a || { action: "none" } }); }
    catch (e) { clearTimeout(timer); resolve({ ok: false, reason: "crash", error: e.message }); }
  });
}

// ---- RNG ----
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- Map Gen ----
function generateMap(seed) {
  const rand = rng(seed ?? Date.now()), W = 18, H = 12, CX = 9, CY = 6;
  const t = []; for (let y = 0; y < H; y++) { t[y] = []; for (let x = 0; x < W; x++) t[y][x] = { type: "open" }; }
  for (let x = 0; x < W; x++) { t[0][x] = { type: "wall" }; t[H-1][x] = { type: "wall" }; }
  for (let y = 0; y < H; y++) { t[y][0] = { type: "wall" }; t[y][W-1] = { type: "wall" }; }
  const wc = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < wc; i++) {
    const wx = 2 + Math.floor(rand() * (W-6)), wy = 2 + Math.floor(rand() * (H-6));
    for (let dy = 0; dy < 1 + Math.floor(rand() * 2); dy++)
      for (let dx = 0; dx < 1 + Math.floor(rand() * 3); dx++)
        if (wx+dx > 0 && wx+dx < W-1 && wy+dy > 0 && wy+dy < H-1 && Math.abs(wx+dx-1) > 2 && Math.abs(wx+dx-W+2) > 2 && Math.abs(wx+dx-CX) > 2)
          t[wy+dy][wx+dx] = { type: "wall" };
  }
  for (let y = 1; y < H-1; y++) for (let x = 1; x < W-1; x++) if (t[y][x].type === "open" && rand() < 0.15) if (Math.abs(x-CX)+Math.abs(y-CY) > 2 || rand() < 0.3) t[y][x] = { type: "grass" };
  for (let y = CY-2; y <= CY+2; y++) for (let x = CX-2; x <= CX+2; x++) if (y > 0 && y < H-1 && x > 0 && x < W-1 && Math.abs(x-CX)+Math.abs(y-CY) <= 2) t[y][x] = { type: "open" };
  t[CY][CX+2] = { type: "wall" };
  for (const s of [{x:1,y:H-2},{x:W-2,y:1}]) for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) t[s.y+dy][s.x+dx] = { type: "open" };
  const wpns = ["sword","bow","spear"];
  const items = [{x:2+Math.floor(rand()*(CX-5)),y:CY+Math.floor(rand()*(H-2-CY)),type:wpns[Math.floor(rand()*3)]},{x:CX+3+Math.floor(rand()*(W-3-CX-3)),y:2+Math.floor(rand()*(CY-2)),type:wpns[Math.floor(rand()*3)]}];
  return { width:W, height:H, tiles:t, playerSpawns:[{x:1,y:H-2},{x:W-2,y:1}], itemSpawns:items, capturePoint:{x:CX,y:CY,radius:2} };
}

// ---- Engine ----
const WEAPONS = { sword: { dmg: 30, range: 1.5, cd: 8 }, spear: { dmg: 25, range: 3, cd: 10 }, bow: { dmg: 20, range: 8, cd: 6 } };
const SKILLS = {
  shield:   { cd: 20, dur: 4,  desc: "block projectiles" },
  sprint:   { cd: 15, dur: 6,  desc: "double speed, ignore water" },
  cloak:    { cd: 25, dur: 8,  desc: "invisible, longer in grass" },
  freeze:   { cd: 29, dur: 2,  desc: "enemy frozen 2 frames" },
  stun:     { cd: 20, dur: 6,  desc: "randomize enemy direction" },
  poison:   { cd: 20, dur: 4,  desc: "slow enemy actions" },
  teleport: { cd: 40, dur: 1,  desc: "instant move to target tile" },
};
const TERRAIN = { open: { spd: 1, dmg: 1, stealth: false }, grass: { spd: 1, dmg: 1.5, stealth: true }, water: { spd: 0.5, dmg: 0.7, stealth: false }, wall: { spd: 0, dmg: 0, stealth: false } };
const MAX_FRAMES = 200, CAPTURE_WIN = 120, SIGHT = 8;

function tileAt(map, x, y) { if (y<0||y>=map.height||x<0||x>=map.width) return { type:"wall" }; return map.tiles[y][x]; }
function isSolid(map, x, y) { return tileAt(map,x,y).type === "wall"; }
function dist(a,b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2); }
function terrainMod(map, x, y) { return TERRAIN[tileAt(map,Math.round(x),Math.round(y)).type] || TERRAIN.open; }
function inCapture(a, cp) { return Math.abs(a.x-cp.x)+Math.abs(a.y-cp.y) <= cp.radius; }

// Vision: 90° forward cone with wall raycast
function isVisible(observer, tx, ty, map) {
  const dx = tx - observer.x, dy = ty - observer.y;
  let forward = false;
  switch (observer.facing) { case "right": forward = dx > 0 && Math.abs(dy) <= Math.abs(dx); break; case "left": forward = dx < 0 && Math.abs(dy) <= Math.abs(dx); break; case "down": forward = dy > 0 && Math.abs(dx) <= Math.abs(dy); break; case "up": forward = dy < 0 && Math.abs(dx) <= Math.abs(dy); break; }
  if (!forward) return false;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 1; i < steps; i++) { if (tileAt(map, Math.round(observer.x + dx*i/steps), Math.round(observer.y + dy*i/steps)).type === "wall") return false; }
  return true;
}

async function runMatch(codeA, codeB, map, seed, skillA, skillB) {
  const agents = [
    { id:"agentA", x:map.playerSpawns[0].x, y:map.playerSpawns[0].y, facing:"right", hp:100, maxHp:100, weapon:null, weaponCd:0, skill:skillA||"shield", skillCd:0, shielded:false, shieldTimer:0, cloaked:false, cloakTimer:0, sprinting:false, sprintTimer:0, frozen:false, freezeTimer:0, stunned:false, stunTimer:0, poisoned:false, poisonTimer:0, alive:true, capFrames:0 },
    { id:"agentB", x:map.playerSpawns[1].x, y:map.playerSpawns[1].y, facing:"left", hp:100, maxHp:100, weapon:null, weaponCd:0, skill:skillB||"shield", skillCd:0, shielded:false, shieldTimer:0, cloaked:false, cloakTimer:0, sprinting:false, sprintTimer:0, frozen:false, freezeTimer:0, stunned:false, stunTimer:0, poisoned:false, poisonTimer:0, alive:true, capFrames:0 },
  ];
  let projs = [], items = map.itemSpawns.map(s => ({ ...s, active: true, respawn: 0 }));
  const cp = map.capturePoint;
  let winner = null, reason = "", records = [];

  function buildState(idx) {
    const s = agents[idx], e = agents[1-idx];
    const eHidden = !e.alive || e.cloaked || (terrainMod(map,e.x,e.y).stealth && !s.sprinting) || dist(s,e) > SIGHT || !isVisible(s, e.x, e.y, map);
    const terrain = []; for (let y=0;y<map.height;y++) { terrain[y]=[]; for (let x=0;x<map.width;x++) terrain[y][x]={type:map.tiles[y][x].type,speed:TERRAIN[map.tiles[y][x].type].spd}; }
    // Filter projectiles: own always visible, enemy only in vision cone
    const visibleProjs = projs.filter(p => p.owner === s.id || isVisible(s, p.x, p.y, map));
    return {
      self: { x:s.x,y:s.y,facing:s.facing,hp:s.hp,maxHp:s.maxHp,weapon:s.weapon,weaponCooldown:s.weaponCd,skill:s.skill,skillCooldown:s.skillCd,onTerrain:tileAt(map,Math.round(s.x),Math.round(s.y)).type,shielded:s.shielded,cloaked:s.cloaked,sprinting:s.sprinting,frozen:s.frozen,stunned:s.stunned,poisoned:s.poisoned },
      enemy: eHidden?null:{ x:e.x,y:e.y,facing:e.facing,hp:e.hp,maxHp:e.maxHp,weapon:e.weapon,weaponCooldown:e.weaponCd,skill:e.skill,skillCooldown:e.skillCd,onTerrain:tileAt(map,Math.round(e.x),Math.round(e.y)).type,shielded:e.shielded,cloaked:e.cloaked,sprinting:e.sprinting,frozen:e.frozen,stunned:e.stunned,poisoned:e.poisoned },
      items: items.filter(it=>it.active).map(it=>({x:it.x,y:it.y,type:it.type,active:it.active})),
      projectiles: visibleProjs.map(p=>({x:p.x,y:p.y,direction:p.direction,owner:p.owner,damage:p.damage})),
      terrain, capturePoint:cp, captureProgress:{me:idx===0?agents[0].capFrames:agents[1].capFrames,enemy:idx===0?agents[1].capFrames:agents[0].capFrames},
      map:{width:map.width,height:map.height,seed}, frame, maxFrames:MAX_FRAMES
    };
  }

  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const [resA, resB] = await Promise.all([sandboxCall(codeA, buildState(0)), sandboxCall(codeB, buildState(1))]);
    const actA = resA.ok ? resA.action : { action: "none" }, actB = resB.ok ? resB.action : { action: "none" };
    if (!resA.ok && resA.reason === "crash") { agents[0].alive = false; winner = 1; reason = "crashed"; }
    if (!resB.ok && resB.reason === "crash") { agents[1].alive = false; winner = 0; reason = "crashed"; }
    if (winner !== null) break;

    for (const [idx, act] of [[0, actA], [1, actB]]) {
      const a = agents[idx], e = agents[1-idx];
      if (!a.alive || a.frozen) continue;

      // Move (stun randomizes direction)
      if (act.action === "move" && act.direction) {
        let dir = act.direction;
        if (a.stunned) { const dirs = ["up","down","left","right"]; dir = dirs[Math.floor(Math.random()*4)]; }
        let dx=0, dy=0;
        if (dir==="left") dx=-1; if (dir==="right") dx=1; if (dir==="up") dy=-1; if (dir==="down") dy=1;
        a.facing = dir;
        const spd = a.sprinting ? 2 : (a.poisoned ? 1 : 1);
        const tmod = terrainMod(map, a.x, a.y).spd;
        for (let s=0; s<Math.max(1,Math.round(spd*tmod)); s++) {
          const nx=a.x+dx, ny=a.y+dy;
          if (nx<0||nx>=map.width||ny<0||ny>=map.height||isSolid(map,nx,ny)) break;
          a.x=nx; a.y=ny;
        }
        records.push({frame,action:"move",type:"agent",objectId:a.id,to:[a.x,a.y]});
      }

      // Skill
      if (act.action === "skill" && a.skill && a.skillCd === 0) {
        const sd = SKILLS[a.skill];
        switch (a.skill) {
          case "shield": a.shielded=true; a.shieldTimer=sd.dur; break;
          case "sprint": a.sprinting=true; a.sprintTimer=sd.dur; break;
          case "cloak": a.cloaked=true; a.cloakTimer=sd.dur; break;
          case "freeze": e.frozen=true; e.freezeTimer=sd.dur; break;
          case "stun": e.stunned=true; e.stunTimer=sd.dur; break;
          case "poison": e.poisoned=true; e.poisonTimer=sd.dur; break;
          case "teleport":
            const tx = a.x + (a.facing==="right"?3:a.facing==="left"?-3:0);
            const ty = a.y + (a.facing==="down"?3:a.facing==="up"?-3:0);
            if (tx>0&&tx<map.width-1&&ty>0&&ty<map.height-1&&!isSolid(map,tx,ty)&&dist({x:tx,y:ty},e)>1) { a.x=tx; a.y=ty; }
            break;
        }
        a.skillCd = sd.cd;
        records.push({frame,action:"skill",type:"agent",objectId:a.id,skillType:a.skill});
      }

      // Shoot (can't in water)
      if (act.action === "shoot" && a.weapon && a.weaponCd === 0 && terrainMod(map,a.x,a.y).spd > 0) {
        const wd = WEAPONS[a.weapon];
        if (a.weapon === "sword") {
          if (e.alive && dist(a,e) <= wd.range) {
            let dmg = wd.dmg * terrainMod(map,a.x,a.y).dmg;
            if (e.shielded) { e.shielded=false; e.shieldTimer=0; records.push({frame,action:"shield_break",target:e.id}); }
            else { e.hp-=dmg; records.push({frame,action:"damage",target:e.id,damage:dmg,hp:e.hp,weapon:"sword"}); if(e.hp<=0){e.hp=0;e.alive=false;} }
          }
        } else {
          const d = act.direction || a.facing;
          projs.push({ x:a.x, y:a.y, direction:d, owner:a.id, damage:wd.dmg });
          records.push({frame,action:"created",type:"projectile",objectId:"p"+projs.length,x:a.x,y:a.y,direction:d,owner:a.id});
        }
        a.weaponCd = wd.cd;
      }

      // Pickup
      if (act.action === "pickup") {
        for (const it of items) { if (it.active && dist(a,it) < 1.5) { it.active=false; it.respawn=40; a.weapon=it.type; a.weaponCd=0; records.push({frame,action:"pickup",objectId:a.id,weapon:it.type}); break; } }
      }
    }

    // Move projs
    for (const p of projs) { let dx=0,dy=0; if(p.direction==="left")dx=-2; if(p.direction==="right")dx=2; if(p.direction==="up")dy=-2; if(p.direction==="down")dy=2; p.x+=dx; p.y+=dy; }
    projs = projs.filter(p=>!(p.x<0||p.x>=map.width||p.y<0||p.y>=map.height||isSolid(map,Math.round(p.x),Math.round(p.y))));

    // Damage from projs
    for (const a of agents) {
      if (!a.alive) continue;
      for (let i=projs.length-1; i>=0; i--) {
        const p = projs[i]; if (p.owner === a.id) continue;
        if (dist(a,p) < 2) {
          let dmg = p.damage * terrainMod(map,a.x,a.y).dmg;
          if (a.shielded) { a.shielded=false; a.shieldTimer=0; projs.splice(i,1); records.push({frame,action:"shield_block",target:a.id}); continue; }
          a.hp -= dmg; records.push({frame,action:"damage",target:a.id,damage:dmg,hp:a.hp}); projs.splice(i,1);
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
    if (frame >= MAX_FRAMES-1) {
      if (agents[0].hp > agents[1].hp) winner=0; else if (agents[1].hp > agents[0].hp) winner=1;
      else if (agents[0].capFrames > agents[1].capFrames) winner=0; else if (agents[1].capFrames > agents[0].capFrames) winner=1;
      reason="timeout"; break;
    }
    if (!agents[0].alive) { winner=1; reason="killed"; break; }
    if (!agents[1].alive) { winner=0; reason="killed"; break; }

    // Tick timers
    for (const a of agents) {
      if (a.shieldTimer>0&&--a.shieldTimer===0) a.shielded=false;
      if (a.cloakTimer>0) { a.cloakTimer--; if (a.cloakTimer===0) a.cloaked=false; if (terrainMod(map,a.x,a.y).stealth && a.cloakTimer>0) a.cloakTimer++; } // grass extends cloak
      if (a.sprintTimer>0&&--a.sprintTimer===0) a.sprinting=false;
      if (a.freezeTimer>0&&--a.freezeTimer===0) a.frozen=false;
      if (a.stunTimer>0&&--a.stunTimer===0) a.stunned=false;
      if (a.poisonTimer>0&&--a.poisonTimer===0) a.poisoned=false;
      if (a.skillCd>0) a.skillCd--;
      if (a.weaponCd>0) a.weaponCd--;
    }
    for (const it of items) if (!it.active&&it.respawn>0&&--it.respawn===0) it.active=true;
  }

  return { winner, resultReason: reason, totalFrames: records.length ? records[records.length-1]?.frame+1 : 1, records, captureProgress: { a: agents[0].capFrames, b: agents[1].capFrames } };
}

// ---- Helpers ----
function uid() { return crypto.randomUUID().slice(0, 8); }
async function sha256(text) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join(""); }
function elo(rA, rB, winner) { const eA = 1/(1+10**((rB-rA)/400)); const sA = winner===0?1:winner===1?0:0.5; const dA=Math.round(25*(sA-eA)); return { newA: rA + (winner===0?dA:winner===1?-Math.round(25*((1-sA)-(1-eA))):0), newB: rB + (winner===1?dA:winner===0?Math.round(25*((1-sA)-(1-eA))):0), dA: winner===0?dA:winner===1?-Math.round(25*((1-sA)-(1-eA))):0, dB: winner===1?dA:winner===0?Math.round(25*((1-sA)-(1-eA))):0 }; }

// ---- Worker ----
export default {
  async fetch(request, env) {
    const url = new URL(request.url), method = request.method;
    const h = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const json = (d, s=200) => new Response(JSON.stringify(d), { status: s, headers: h });
    const err = (m, s=400) => json({ error: m }, s);
    const body = async () => { try { return await request.json(); } catch { return {}; } };
    const getAgents = async () => { try { const d = await env.AGENTS.get("agents"); return d ? JSON.parse(d) : []; } catch { return []; } };
    const setAgents = async (a) => { await env.AGENTS.put("agents", JSON.stringify(a)); };
    const getMatches = async () => { try { const d = await env.AGENTS.get("matches"); return d ? JSON.parse(d) : []; } catch { return []; } };
    const setMatches = async (m) => { await env.AGENTS.put("matches", JSON.stringify(m)); };

    // ── Health ──
    if (url.pathname === "/api/health") return json({ status: "ok", name: "CodeClash", version: "0.3" });

    // ── Register ──
    if (method === "POST" && url.pathname === "/api/tanks/register") {
      const b = await body();
      const name = b.name || "Agent-" + uid();
      const code = b.code || `function act(s){var e=s.enemy,cp=s.capturePoint;if(!s.self.weapon&&s.items.length){var it=s.items[0];if(Math.abs(it.x-s.self.x)<2)return{action:'pickup'};return{action:'move',direction:it.x>s.self.x?'right':'left'}}if(s.self.skillCooldown===0)return{action:'skill'};if(!e)return{action:'move',direction:cp.x>s.self.x?'right':'left'}if(s.self.weaponCooldown===0)return{action:'shoot',direction:e.x>s.self.x?'right':'left'};return{action:'move',direction:e.x>s.self.x?'right':'left'}}`;
      const skill = b.skill || "shield";
      const model = b.model || "human";
      const agents = await getAgents();
      const battleKey = "tk_" + uid() + uid();
      const hash = await sha256(battleKey);
      agents.push({ name, code, skill, model, elo: 1200, wins: 0, losses: 0, draws: 0, keyHash: hash, createdAt: new Date().toISOString(), lastBattle: null });
      await setAgents(agents);
      return json({ name, battleKey, skill, model, guideUrl: url.origin + "/agent-guide" }, 201);
    }

    // ── Leaderboard ──
    if (url.pathname === "/api/agent/leaderboard") {
      const agents = await getAgents();
      return json(agents.sort((a,b) => b.elo - a.elo).slice(0, 50).map((t,i) => ({ rank:i+1, name:t.name, elo:t.elo, wins:t.wins, losses:t.losses, draws:t.draws, model:t.model, skill:t.skill })));
    }

    // ── Challenge ──
    if (method === "POST" && url.pathname === "/api/agent/tank/challenge") {
      const b = await body();
      const key = (request.headers.get("Authorization")||"").startsWith("Bearer tk_") ? request.headers.get("Authorization").slice(7) : "";
      if (!key) return err("Valid battle key required", 401);
      const agents = await getAgents();
      const reqHash = await sha256(key);
      const me = agents.find(t => t.keyHash === reqHash);
      if (!me) return err("Invalid key", 401);
      const opp = agents.find(t => t.name === b.opponent && t.name !== me.name);
      if (!opp) return err("Opponent not found or same as challenger", 404);

      const seed = Date.now(), map = generateMap(seed);
      const result = await runMatch(me.code, opp.code, map, seed, me.skill, opp.skill);
      const e = elo(me.elo, opp.elo, result.winner);
      me.elo = e.newA; opp.elo = e.newB;
      if (result.winner === 0) { me.wins++; opp.losses++; } else if (result.winner === 1) { opp.wins++; me.losses++; } else { me.draws++; opp.draws++; }
      me.lastBattle = new Date().toISOString(); opp.lastBattle = new Date().toISOString();
      await setAgents(agents);

      // Save match for sharing
      const matchId = uid();
      const matches = await getMatches();
      matches.unshift({ id: matchId, time: new Date().toISOString(), a: me.name, b: opp.name, winner: result.winner===0?me.name:result.winner===1?opp.name:null, reason: result.resultReason, frames: result.totalFrames, capA: result.captureProgress.a, capB: result.captureProgress.b, replay: result.records, map });
      if (matches.length > 100) matches.length = 100;
      await setMatches(matches);

      return json({ matchId, winner: result.winner===0?me.name:result.winner===1?opp.name:null, resultReason: result.resultReason, totalFrames: result.totalFrames, captureProgress: result.captureProgress, eloChange: { [me.name]: e.dA, [opp.name]: e.dB } });
    }

    // ── Simulate ──
    if (method === "POST" && url.pathname === "/api/agent/tank/simulate") {
      const b = await body();
      if (!b.code) return err("code required");
      const map = generateMap(Date.now());
      const result = await runMatch(b.code, "function act(s){return{action:'move',direction:'right'}}", map, Date.now(), b.skillType||"shield", "shield");
      return json({ winner: result.winner, resultReason: result.resultReason, totalFrames: result.totalFrames });
    }

    // ── Generate ──
    if (method === "POST" && url.pathname === "/api/tanks/generate") {
      const b = await body();
      if (!b.prompt || !b.apiKey) return err("prompt and apiKey required");
      const skillList = Object.entries(SKILLS).map(([k,v]) => `${k}: ${v.desc} (CD ${v.cd})`).join(", ");
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json", "x-api-key": b.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5", max_tokens: 1500,
            system: `You write JavaScript battle strategies. Output ONLY function act(state){...}. Game: 18x12 grid, weapons(sword/bow/spear), skills: ${skillList}, capture point center (hold solo 120 frames wins). Enemy null when hidden (grass/cloak/out of 90° vision cone/blocked by walls).`,
            messages: [{ role: "user", content: `Write strategy: ${b.prompt}. Agent skill: ${b.skill||"shield"}.` }]
          })
        });
        const data = await resp.json();
        let code = data.content?.[0]?.text || "";
        const m = code.match(/```[\s\S]*?```/); if (m?.[0]) code = m[0].replace(/```\w*\n?/g, "").trim();
        if (!code.startsWith("function act")) { const i = code.indexOf("function act"); if (i >= 0) code = code.slice(i); }
        return json({ code: code || "function act(s){return{action:'move',direction:'right'}}" });
      } catch (e) { return err("AI generation failed: " + e.message, 500); }
    }

    // ── Improve (AI self-iteration) ──
    if (method === "POST" && url.pathname === "/api/agent/improve") {
      const b = await body();
      if (!b.apiKey) return err("apiKey required");
      const key = (request.headers.get("Authorization")||"").startsWith("Bearer tk_") ? request.headers.get("Authorization").slice(7) : "";
      if (!key) return err("Valid battle key required", 401);
      const agents = await getAgents();
      const reqHash = await sha256(key);
      const me = agents.find(t => t.keyHash === reqHash);
      if (!me) return err("Invalid key", 401);

      // Get recent matches
      const matches = await getMatches();
      const recentMatches = matches.filter(m => m.a === me.name || m.b === me.name).slice(0, 5);

      const skillList = Object.entries(SKILLS).map(([k,v]) => `${k}: ${v.desc}`).join(", ");
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json", "x-api-key": b.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5", max_tokens: 1500,
            system: `You improve battle strategies. Output ONLY function act(state){...}. Game: 18x12 grid, weapons(sword/bow/spear), skills: ${skillList}, capture point center (120 frames to win).`,
            messages: [{ role: "user", content: `Improve this strategy based on recent matches:\n\nCurrent code:\n\`\`\`js\n${me.code}\n\`\`\`\n\nRecent results: ${JSON.stringify(recentMatches.map(m => ({ opponent: m.a===me.name?m.b:m.a, result: m.winner===me.name?'win':m.winner?'loss':'draw', reason: m.reason, frames: m.frames })))}` }]
          })
        });
        const data = await resp.json();
        let code = data.content?.[0]?.text || "";
        const m = code.match(/```[\s\S]*?```/); if (m?.[0]) code = m[0].replace(/```\w*\n?/g, "").trim();
        if (!code.startsWith("function act")) { const i = code.indexOf("function act"); if (i >= 0) code = code.slice(i); }
        if (code && code !== me.code) {
          me.code = code; await setAgents(agents);
          return json({ code, improved: true });
        }
        return json({ code: me.code, improved: false });
      } catch (e) { return err("Improvement failed: " + e.message, 500); }
    }

    // ── Share / Public Replay ──
    if (method === "GET" && url.pathname.startsWith("/match/")) {
      const matchId = url.pathname.split("/")[2];
      const matches = await getMatches();
      const match = matches.find(m => m.id === matchId);
      if (!match) return err("Match not found", 404);
      return json({ id: match.id, time: match.time, a: match.a, b: match.b, winner: match.winner, reason: match.reason, frames: match.frames, captureA: match.capA, captureB: match.capB, replay: match.replay, map: match.map });
    }

    // ── Match history ──
    if (url.pathname === "/api/history") {
      const matches = await getMatches();
      return json(matches.map(m => ({ id: m.id, time: m.time, a: m.a, b: m.b, winner: m.winner, reason: m.reason, frames: m.frames })));
    }

    return json({ status: "ok" });
  }
};
