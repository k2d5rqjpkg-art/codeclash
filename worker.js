// Cloudflare Worker — CodeClash v0.3
// Workers handles: register, leaderboard, history, share (lightweight API)
// Local server handles: match execution, code generation, AI improve (needs CPU)

function rng(seed) { return () => { seed|=0;seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}; }
function uid() { return crypto.randomUUID().slice(0,8); }
async function sha256(t) { const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)); return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,"0")).join(""); }
function elo(rA,rB,w){ const eA=1/(1+10**((rB-rA)/400)),sA=w===0?1:w===1?0:.5,dA=Math.round(25*(sA-eA)); return{newA:rA+(w===0?dA:w===1?-Math.round(25*((1-sA)-(1-eA))):0),newB:rB+(w===1?dA:w===0?Math.round(25*((1-sA)-(1-eA))):0),dA:w===0?dA:w===1?-Math.round(25*((1-sA)-(1-eA))):0,dB:w===1?dA:w===0?Math.round(25*((1-sA)-(1-eA))):0}; }

export default {
  async fetch(request, env) {
    const url = new URL(request.url), method = request.method;
    const h = { "Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization" };
    if (method === "OPTIONS") return new Response(null,{status:204,headers:h});
    const json = (d,s=200) => new Response(JSON.stringify(d),{status:s,headers:h});
    const err = (m,s=400) => json({error:m},s);
    const body = async () => { try{return await request.json();}catch{return{};} };
    const get = async (k) => { try{const d=await env.AGENTS.get(k);return d?JSON.parse(d):[];}catch{return[];} };
    const set = async (k,v) => { await env.AGENTS.put(k,JSON.stringify(v)); };

    // ── Health ──
    if (url.pathname === "/api/health") return json({ status:"ok",name:"CodeClash",version:"0.3-cf" });

    // ── Register ──
    if (method === "POST" && url.pathname === "/api/tanks/register") {
      const b = await body();
      const agents = await get("agents");
      const key = "tk_"+uid()+uid();
      agents.push({ name:b.name||"Agent-"+uid(), code:b.code||"function act(s){return{action:'move',direction:'right'}}", skill:b.skill||"shield", model:b.model||"human", elo:1200,wins:0,losses:0,draws:0,keyHash:await sha256(key),createdAt:new Date().toISOString(),lastBattle:null });
      await set("agents",agents);
      return json({ name:agents[agents.length-1].name, battleKey:key, skill:agents[agents.length-1].skill },201);
    }

    // ── Leaderboard ──
    if (url.pathname === "/api/agent/leaderboard") {
      const agents = await get("agents");
      return json(agents.sort((a,b)=>b.elo-a.elo).slice(0,50).map((t,i)=>({rank:i+1,name:t.name,elo:t.elo,wins:t.wins,losses:t.losses,draws:t.draws,model:t.model,skill:t.skill})));
    }

    // ── History ──
    if (url.pathname === "/api/history") {
      const matches = await get("matches");
      return json(matches.map(m=>({id:m.id,time:m.time,a:m.a,b:m.b,winner:m.winner,reason:m.reason,frames:m.frames})));
    }

    // ── Share replay ──
    if (method === "GET" && url.pathname.startsWith("/match/")) {
      const matches = await get("matches");
      const m = matches.find(m=>m.id===url.pathname.split("/")[2]);
      return m ? json(m) : err("Match not found",404);
    }

    // ── Heavy endpoints → proxied to local server ──
    if (["/api/agent/tank/challenge","/api/agent/tank/simulate","/api/tanks/generate","/api/agent/improve"].includes(url.pathname)) {
      return json({ error:"Match engine requires local server", hint:"Run: pnpm server + cloudflared tunnel run codeclash. Workers (10ms CPU limit) can't run the game engine." },503);
    }

    return json({ status:"ok" });
  }
};
