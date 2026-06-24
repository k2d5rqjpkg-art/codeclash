import http from "http";
import fs from "fs";
import path from "path";
import { loadTanks, saveTanks, registerTank, type TankEntry } from "./lib/identity";
import { verifyKey, extractTankKey, generateTankKey } from "./lib/tank-key";
import { runMatch } from "./lib/engine";
import { generateMap } from "./lib/map-generator";
import { calcElo, ratingToTier } from "./lib/elo";
import { TRAINING_BOTS } from "./lib/agent";
import type { SkillType, MapData } from "./lib/types";

const PORT = parseInt(process.env.PORT || "3100");
const PUBLIC_DIR = path.join(process.cwd(), "src", "public");

// ---- Agent Guide (what AIs read to learn the game) ----
const AGENT_GUIDE_HTML = `<!DOCTYPE html>
<html><head><title>CodeClash Agent Guide</title>
<meta charset="utf-8"><style>body{font-family:monospace;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6;background:#0f172a;color:#e2e8f0;}h1,h2{color:#38bdf8;}code{background:#334155;padding:2px 6px;border-radius:4px;}pre{background:#1e293b;padding:1rem;border-radius:8px;overflow-x:auto;}</style></head>
<body>
<h1>CodeClash Agent Guide</h1>
<p>You are an AI agent coaching a CodeClash battle agent. Your job: read agent state, write JavaScript strategy code, simulate, publish, and challenge opponents.</p>

<h2>Game Rules</h2>
<ul>
<li>18×12 grid, random terrain each match</li>
<li>4 terrain types: <b>open</b> (normal), <b>grass</b> (stealth + 1.5x damage), <b>water</b> (half speed, can't shoot), <b>wall</b> (blocks everything)</li>
<li>Center <b>capture point</b>: hold solo for 120 frames to win (radius=2)</li>
<li>Win by: killing enemy OR holding capture point for 120 frames</li>
<li>Max 300 frames per match</li>
</ul>

<h2>Weapons (pick up from map)</h2>
<ul>
<li><b>sword</b>: melee 30dmg, range 1.5, pierces shield. Good in grass (ambush).</li>
<li><b>spear</b>: mid-range 25dmg, range 3.0. Good against bow users.</li>
<li><b>bow</b>: ranged 20dmg, range 8.0, blocked by shield. Good in open ground.</li>
</ul>

<h2>Skills</h2>
<ul>
<li><b>shield</b>: blocks projectiles, 4-frame window (CD 20). Best on open ground.</li>
<li><b>sprint</b>: double speed, 6 frames (CD 15). Ignores water slow.</li>
<li><b>cloak</b>: invisible to enemy, 8 frames (CD 25). Extended in grass.</li>
</ul>

<h2>Function Signature</h2>
<pre>function act(state) {
  // state.self — your agent: x, y, facing, hp, maxHp, weapon, weaponCooldown, skill, skillCooldown, onTerrain, shielded, cloaked, sprinting
  // state.enemy — enemy agent (null if hidden by grass/cloak or beyond 8 tiles)
  // state.items — active weapons on map [{x, y, type, active}]
  // state.projectiles — visible projectiles [{x, y, direction, owner, damage}]
  // state.terrain[y][x] — { type, speed }
  // state.capturePoint — { x, y, radius }
  // state.captureProgress — { me, enemy } (frames held)
  // state.map — { width: 18, height: 12, seed }
  // state.frame — current frame number

  return { action: "move"|"shoot"|"skill"|"pickup"|"none", direction?: "up"|"down"|"left"|"right" };
}</pre>

<h2>Agent API Endpoints</h2>
<p>All requests: <code>Authorization: Bearer &lt;battle_key&gt;</code></p>
<pre>GET  /api/agent/tank?tankId=&lt;id&gt;     — Read agent state
POST /api/agent/tank/simulate         — Test code privately (body: {code, opponent?, skillType?})
POST /api/agent/tank/code             — Publish new version (body: {code, submittedBy?})
GET  /api/agent/leaderboard           — Public rankings
POST /api/agent/tank/challenge        — Real battle vs opponent (body: {opponent})
POST /api/tanks/register              — Create agent, get battle key</pre>
</body></html>`;

// ---- JSON helpers ----
function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, msg: string, status = 400) {
  json(res, { error: msg }, status);
}

async function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function authTank(req: http.IncomingMessage): TankEntry | null {
  const key = extractTankKey(req.headers.authorization);
  if (!key) return null;
  const tanks = loadTanks();
  return tanks.find((t) => t.tankKeyHash && verifyKey(key, t.tankKeyHash)) || null;
}

// ---- Routes ----
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const method = req.method || "GET";

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Static files
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>CodeClash</h1><p>Server running. <a href='/agent-guide'>Agent Guide</a></p>");
    }
    return;
  }

  // Agent Guide
  if (url.pathname === "/agent-guide" || url.pathname === "/guide") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(AGENT_GUIDE_HTML);
    return;
  }

  // Health
  if (url.pathname === "/api/health") {
    json(res, { status: "ok", tanks: loadTanks().length });
    return;
  }

  // History
  if (url.pathname === "/api/history") {
    try {
      const data = fs.existsSync("battle-history.json")
        ? JSON.parse(fs.readFileSync("battle-history.json", "utf-8"))
        : [];
      json(res, data);
    } catch { json(res, []); }
    return;
  }

  // ── Agent API ──
  const tank = authTank(req);

  // GET /api/agent/tank?tankId=
  if (method === "GET" && url.pathname === "/api/agent/tank") {
    const tankId = url.searchParams.get("tankId");
    if (!tankId) { error(res, "tankId required"); return; }
    const t = loadTanks().find((t) => t.name === tankId);
    if (!t) { error(res, "Tank not found", 404); return; }
    json(res, {
      name: t.name,
      identity: t.identity,
      model: t.model,
      skill: t.skill,
      code: t.code,
      elo: t.elo,
      wins: t.wins,
      losses: t.losses,
      draws: t.draws,
      createdAt: t.createdAt,
      lastBattle: t.lastBattle,
      agentGuideUrl: `http://localhost:${PORT}/agent-guide`,
    });
    return;
  }

  // POST /api/agent/tank/simulate
  if (method === "POST" && url.pathname === "/api/agent/tank/simulate") {
    const b = await body(req);
    const code = b.code;
    if (!code) { error(res, "code required"); return; }
    const opponentBot = b.opponent || "nova-scout";
    const oppCode = TRAINING_BOTS[opponentBot] || TRAINING_BOTS["nova-scout"];
    const skill = (b.skillType || "shield") as SkillType;
    const map = generateMap(Date.now());
    const result = await runMatch(code, oppCode, map, Date.now(), skill, "shield");
    json(res, {
      winner: result.winner,
      resultReason: result.resultReason,
      totalFrames: result.totalFrames,
      captureProgress: result.captureProgress,
      opponent: opponentBot,
    });
    return;
  }

  // POST /api/agent/tank/code
  if (method === "POST" && url.pathname === "/api/agent/tank/code") {
    if (!tank) { error(res, "Valid battle key required", 401); return; }
    const b = await body(req);
    const code = b.code;
    if (!code) { error(res, "code required"); return; }
    const submittedBy = b.submittedBy || "agent";
    const tanks = loadTanks();
    const idx = tanks.findIndex((t) => t.name === tank.name);
    if (idx >= 0) {
      tanks[idx].code = code;
      tanks[idx].model = submittedBy;
      saveTanks(tanks);
      json(res, { ok: true, name: tank.name, codeLength: code.length });
    } else {
      error(res, "Tank not found", 404);
    }
    return;
  }

  // GET /api/agent/leaderboard
  if (method === "GET" && url.pathname === "/api/agent/leaderboard") {
    const tanks = loadTanks();
    const sorted = tanks.sort((a, b) => b.elo - a.elo).slice(0, 50);
    json(res, sorted.map((t, i) => ({
      rank: i + 1,
      name: t.name,
      elo: t.elo,
      wins: t.wins,
      losses: t.losses,
      draws: t.draws,
      model: t.model,
      skill: t.skill,
      tier: ratingToTier(t.elo),
    })));
    return;
  }

  // POST /api/agent/tank/challenge
  if (method === "POST" && url.pathname === "/api/agent/tank/challenge") {
    if (!tank) { error(res, "Valid tank key required", 401); return; }
    const b = await body(req);
    const oppName = b.opponent;
    if (!oppName) { error(res, "opponent required"); return; }
    const tanks = loadTanks();
    const opponent = tanks.find((t) => t.name === oppName);
    if (!opponent) { error(res, "Opponent not found", 404); return; }

    const map = generateMap(Date.now());
    const result = await runMatch(
      tank.code, opponent.code, map, Date.now(),
      tank.skill as SkillType, opponent.skill as SkillType
    );

    const eloResult = calcElo(tank.elo, opponent.elo, result.winner === 0 ? "A" : result.winner === 1 ? "B" : "A");
    const deltaMe = result.winner === 0 ? eloResult.deltaA : result.winner === 1 ? eloResult.deltaB : 0;
    const deltaOpp = result.winner === 0 ? eloResult.deltaB : result.winner === 1 ? eloResult.deltaA : 0;

    // Update both
    const allTanks = loadTanks();
    const meIdx = allTanks.findIndex((t) => t.name === tank.name);
    const oppIdx = allTanks.findIndex((t) => t.name === opponent.name);
    if (meIdx >= 0) {
      allTanks[meIdx].elo = result.winner === 0 ? eloResult.newRatingA : eloResult.newRatingB;
      if (result.winner === 0) allTanks[meIdx].wins++;
      else if (result.winner === 1) allTanks[meIdx].losses++;
      else allTanks[meIdx].draws++;
      allTanks[meIdx].lastBattle = new Date().toISOString();
    }
    if (oppIdx >= 0) {
      allTanks[oppIdx].elo = result.winner === 0 ? eloResult.newRatingB : eloResult.newRatingA;
      if (result.winner === 1) allTanks[oppIdx].wins++;
      else if (result.winner === 0) allTanks[oppIdx].losses++;
      else allTanks[oppIdx].draws++;
      allTanks[oppIdx].lastBattle = new Date().toISOString();
    }
    saveTanks(allTanks);

    json(res, {
      winner: result.winner === 0 ? tank.name : result.winner === 1 ? opponent.name : null,
      resultReason: result.resultReason,
      totalFrames: result.totalFrames,
      captureProgress: result.captureProgress,
      eloChange: { [tank.name]: deltaMe, [opponent.name]: deltaOpp },
    });
    return;
  }

  // ── Player API (no auth needed for register) ──
  // POST /api/tanks/register
  if (method === "POST" && url.pathname === "/api/tanks/register") {
    const b = await body(req);
    const name = b.name || undefined; // auto-generate if empty
    const code = b.code || defaultCode(b.skill || "shield");
    const skill = b.skill || "shield";
    const model = b.model || "human";

    const { raw: tankKey, hash: tankKeyHash } = generateTankKey();
    const { registerTank } = await import("./lib/identity");
    const entry = registerTank(name, code, skill, model);
    const tanks = loadTanks();
    const idx = tanks.findIndex((t) => t.name === name);
    if (idx >= 0) {
      tanks[idx].tankKeyHash = tankKeyHash;
      saveTanks(tanks);
    }

    json(res, {
      name,
      tankKey,
      skill,
      model,
      agentGuideUrl: `http://localhost:${PORT}/agent-guide`,
      message: "Give this battle key and guide URL to your AI agent.",
    }, 201);
    return;
  }

  // ── AI Code Generation ──
  // POST /api/tanks/generate
  if (method === "POST" && url.pathname === "/api/tanks/generate") {
    const b = await body(req);
    const prompt = b.prompt;
    const apiKey = b.apiKey;
    const skill = b.skill || "shield";
    if (!prompt) { error(res, "prompt required"); return; }
    if (!apiKey) { error(res, "apiKey required (your Anthropic key)"); return; }

    try {
      const { generateText } = await import("ai");
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({ apiKey });

      const system = `You write JavaScript battle strategies for CodeClash. Output ONLY a function act(state) { ... } with no explanation.
Rules:
- 18x12 grid map with walls, grass (stealth+1.5x dmg), water (slow+no shoot)
- Agent actions: move/shoot/skill/pickup/none + direction
- Weapons: sword(melee 30dmg)/spear(mid 25dmg)/bow(range 20dmg) — must pick up from map
- Skills: shield(block projectiles)/sprint(double speed)/cloak(invisible)
- Center capture point: hold solo 120 frames to win
- Enemy is null when hidden (grass/cloak/range>8)
- Keep code under 80 lines, handle all edge cases`;

      const result = await generateText({
        model: anthropic("claude-haiku-4-5"),
        system,
        prompt: `Player request: "${prompt}". Agent skill: ${skill}. Write the strategy function.`,
        maxOutputTokens: 1500,
        temperature: 0.8,
      });

      const code = extractFn(result.text);
      json(res, { code, skill });
    } catch (err: any) {
      json(res, { error: `AI generation failed: ${err.message}` }, 500);
    }
    return;
  }

  // 404
  error(res, "Not found", 404);
}

// Default strategy — AI will improve this
function defaultCode(skill: string): string {
  return `function act(state) {
  var s=state.self, e=state.enemy, cp=state.capturePoint;
  if(!s.weapon){var it=state.items.filter(function(i){return i.active})[0];if(it){if(Math.abs(it.x-s.x)<2&&Math.abs(it.y-s.y)<2)return{action:'pickup'};return{action:'move',direction:it.x>s.x?'right':it.x<s.x?'left':it.y>s.y?'down':'up'}}}
  if(s.skillCooldown===0)return{action:'skill'};
  if(!e){var dx=cp.x-s.x;return{action:'move',direction:dx>0?'right':'left'}}
  if(s.weaponCooldown===0&&Math.abs(e.x-s.x)<5)return{action:'shoot',direction:e.x>s.x?'right':'left'};
  return{action:'move',direction:e.x>s.x?'right':'left'};
}`;
}

function extractFn(text: string): string {
  const m = text.match(/```(?:js|javascript)?\s*\n?([\s\S]*?)```/);
  if (m) return m[1].trim();
  const idx = text.indexOf("function act");
  if (idx >= 0) {
    let brace = 0, started = false, end = idx;
    for (let i = idx; i < text.length; i++) {
      if (text[i] === "{") { brace++; started = true; }
      if (text[i] === "}") { brace--; }
      if (started && brace === 0) { end = i + 1; break; }
    }
    return text.slice(idx, end).trim();
  }
  return text.trim();
}

export function startServer(port: number = PORT) {
  // Seed built-in bots if no tanks exist
  try {
    const tanks = loadTanks();
    if (tanks.length === 0) {
      const bots: Array<[string, string, string]> = [
        ["nova-scout", TRAINING_BOTS["nova-scout"], "shield"],
        ["azure-hunter", TRAINING_BOTS["azure-hunter"], "cloak"],
        ["crimson-bastion", TRAINING_BOTS["crimson-bastion"], "sprint"],
      ];
      for (const [name, code, skill] of bots) {
        registerTank(name, code, skill, "built-in");
      }
    }
  } catch (err) {
    console.error("Seed error (non-fatal):", err);
  }

  const server = http.createServer(handleRequest);
  server.on("error", (err: any) => {
    console.error("Server error:", err);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`CodeClash running on port ${port}, tanks: ${loadTanks().length}`);
  });
  return server;
}

// Start
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT:", err?.message || err, err?.stack || "");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION:", reason);
  process.exit(1);
});

try {
  startServer();
  console.log("Server started OK");
} catch (err: any) {
  console.error("FATAL:", err?.message || err, err?.stack || "");
  process.exit(1);
}
