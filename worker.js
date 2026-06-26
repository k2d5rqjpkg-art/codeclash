// CodeClash — Full Engine on Cloudflare Workers
// Uses decision-tree interpreter instead of eval/Function

// ── Decision Tree Engine ──
// Player strategies are compiled into a decision tree JSON at registration time.
// Worker executes the tree without eval/Function.

// Node types:
// { if: { path, op, value }, then: node, else: node }  — conditional
// { action: "move", dir: "enemy"|"capture"|"random"|"up"|... }  — action
// { action: "shoot", dir: "enemy"|"facing" }
// { action: "skill" }
// { action: "pickup" }
// { action: "none" }
// { sequence: [...] }  — try each action in order (first valid wins)

function getProp(obj, path) {
  var parts=path.split("."),v=obj;
  for(var i=0;i<parts.length;i++){if(v==null)return null;v=v[parts[i]]}
  return v;
}

function resolveDir(state, dir) {
  if(dir==="enemy"&&state.enemy){var dx=state.enemy.x-state.self.x;return dx>0?"right":dx<0?"left":"down"}
  if(dir==="capture"){var cx=state.capturePoint.x-state.self.x;return cx>0?"right":cx<0?"left":"up"}
  if(dir==="facing")return state.self.facing;
  if(dir==="toward_enemy"&&state.enemy){
    var ex=state.enemy.x-state.self.x,ey=state.enemy.y-state.self.y;
    return Math.abs(ex)>=Math.abs(ey)?(ex>0?"right":"left"):(ey>0?"down":"up");
  }
  return dir||"right";
}

function evalTree(node, state, map) {
  if(!node) return {action:"none"};
  if(node.sequence) {
    for(var i=0;i<node.sequence.length;i++){
      var r=evalTree(node.sequence[i],state,map);
      if(r.action!=="none")return r;
    }
    return {action:"none"};
  }
  if(node.if) {
    var cond=node.if,match=false,val;
    // Standard comparisons
    if(cond.op==="lt"||cond.op==="lte"||cond.op==="gt"||cond.op==="gte"||cond.op==="eq"||cond.op==="neq"){
      val=getProp(state,cond.path);
      if(cond.op==="lt"&&val<cond.value)match=true;
      else if(cond.op==="lte"&&val<=cond.value)match=true;
      else if(cond.op==="gt"&&val>cond.value)match=true;
      else if(cond.op==="gte"&&val>=cond.value)match=true;
      else if(cond.op==="eq"&&val===cond.value)match=true;
      else if(cond.op==="neq"&&val!==cond.value)match=true;
    }
    // Boolean checks
    else if(cond.op==="truthy")match=!!getProp(state,cond.path);
    else if(cond.op==="falsy")match=!getProp(state,cond.path);
    else if(cond.op==="null")match=getProp(state,cond.path)===null;
    else if(cond.op==="notnull")match=getProp(state,cond.path)!==null;
    else if(cond.op==="active")match=state.items&&state.items.some(function(it){return it.active});
    else if(cond.op==="has_enemy")match=!!state.enemy;
    else if(cond.op==="no_enemy")match=!state.enemy;
    // Distance-based
    else if(cond.op==="dist_lt"&&state.enemy){var d=dist(state.self,state.enemy);match=d<cond.value}
    else if(cond.op==="dist_gt"&&state.enemy){var d=dist(state.self,state.enemy);match=d>cond.value}
    else if(cond.op==="near_item"){
      var found=false;
      if(state.items)for(var ni=0;ni<state.items.length;ni++){
        var it=state.items[ni];
        if(it.active&&dist(state.self,it)<(cond.value||2)){found=true;break}
      }
      match=found;
    }
    // Terrain
    else if(cond.op==="on_terrain"){
      var t=state.self.onTerrain||"open";
      match=(t===cond.value||(cond.value==="cover"&&(t==="grass"||t==="open")));
    }
    // Capture zone
    else if(cond.op==="in_capture"){
      var cp=state.capturePoint;
      match=cp&&Math.abs(state.self.x-cp.x)+Math.abs(state.self.y-cp.y)<=cp.radius;
    }
    // Enemy facing
    else if(cond.op==="enemy_facing"&&state.enemy){
      var ef=state.enemy.facing,sf=state.self.facing;
      if(cond.value==="away"){var dx=state.enemy.x-state.self.x,dy=state.enemy.y-state.self.y;
        match=(ef==="right"&&dx<0)||(ef==="left"&&dx>0)||(ef==="up"&&dy>0)||(ef==="down"&&dy<0)}
      else if(cond.value==="toward"){var dx=state.enemy.x-state.self.x,dy=state.enemy.y-state.self.y;
        match=(ef==="right"&&dx>0)||(ef==="left"&&dx<0)||(ef==="up"&&dy<0)||(ef==="down"&&dy>0)}
    }
    // HP threshold
    else if(cond.op==="hp_below"){
      var hp=getProp(state,"self.hp");match=hp<cond.value;
    }
    return evalTree(match?node.then:node.else,state,map);
  }
  if(node.action==="move"||node.action==="shoot") {
    return {action:node.action, direction:resolveDir(state,node.dir||"right")};
  }
  if(node.action==="flee"){
    var d="left";if(state.enemy){var dx=state.enemy.x-state.self.x;d=dx>0?"left":"right"}
    return {action:"move",direction:d};
  }
  if(node.action==="skill"||node.action==="pickup"||node.action==="none")return {action:node.action};
  return {action:"none"};
}

// Default strategies compiled as trees
var DEFAULT_TREES={
  aggressive:{
    sequence:[
      {sequence:[
        {if:{path:"self.skillCooldown",op:"eq",value:0},then:{action:"skill"}},
        {if:{path:"self.weaponCooldown",op:"eq",value:0},then:{action:"shoot",dir:"enemy"}},
        {action:"move",dir:"enemy"}
      ]}
    ]
  },
  tactical:{
    sequence:[
      {if:{path:"self.weapon",op:"null"},then:{sequence:[
        {if:{op:"active"},then:{action:"pickup"},else:{action:"move",dir:"toward_item"}}
      ]}},
      {if:{path:"self.skillCooldown",op:"eq",value:0},then:{action:"skill"}},
      {if:{path:"enemy",op:"null"},then:{action:"move",dir:"capture"}},
      {if:{path:"self.weaponCooldown",op:"eq",value:0},then:{action:"shoot",dir:"enemy"}},
      {action:"move",dir:"capture"}
    ]
  },
  capturer:{
    sequence:[
      {if:{path:"self.skillCooldown",op:"eq",value:0},then:{action:"skill"}},
      {action:"move",dir:"capture"}
    ]
  }
};

function parseStrategy(code) {
  // Extract decision logic from code string into tree
  // Default: aggressive strategy
  if(!code)return DEFAULT_TREES.aggressive;
  // Simple pattern matching for common strategy patterns
  if(code.indexOf("capture")>code.indexOf("enemy"))return DEFAULT_TREES.capturer;
  if(code.indexOf("cloak")>0||code.indexOf("grass")>0)return DEFAULT_TREES.tactical;
  return DEFAULT_TREES.aggressive;
}

// ── Game Engine (same as before, uses evalTree instead of new Function) ──
var uid=function(){return crypto.randomUUID().slice(0,8)};
async function sha256(t){var h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t));return Array.from(new Uint8Array(h)).map(function(b){return b.toString(16).padStart(2,"0")}).join("")}
function dist(a,b){return Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2)}
function rng(s){return function(){s|=0;s=(s+0x6d2b79f5)|0;var t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}

function genMap(seed){var R=rng(seed||Date.now()),W=18,H=12,CX=9,CY=6,t=[],y,x,i;for(y=0;y<H;y++){t[y]=[];for(x=0;x<W;x++)t[y][x]={type:"open"}}for(x=0;x<W;x++){t[0][x]={type:"wall"};t[H-1][x]={type:"wall"}}for(y=0;y<H;y++){t[y][0]={type:"wall"};t[y][W-1]={type:"wall"}}for(i=0;i<3+Math.floor(R()*3);i++){var wx=2+Math.floor(R()*(W-6)),wy=2+Math.floor(R()*(H-6)),dy,dx;for(dy=0;dy<1+Math.floor(R()*2);dy++)for(dx=0;dx<1+Math.floor(R()*3);dx++)if(wx+dx>0&&wx+dx<W-1&&wy+dy>0&&wy+dy<H-1&&Math.abs(wx+dx-1)>2&&Math.abs(wx+dx-W+2)>2&&Math.abs(wx+dx-CX)>2)t[wy+dy][wx+dx]={type:"wall"}}for(y=1;y<H-1;y++)for(x=1;x<W-1;x++)if(t[y][x].type==="open"&&R()<0.15)if(Math.abs(x-CX)+Math.abs(y-CY)>2||R()<0.3)t[y][x]= {type:"grass"};for(y=CY-2;y<=CY+2;y++)for(x=CX-2;x<=CX+2;x++)if(y>0&&y<H-1&&x>0&&x<W-1&&Math.abs(x-CX)+Math.abs(y-CY)<=2)t[y][x]={type:"open"};t[CY][CX+2]={type:"wall"};var sp;for(sp of[{x:1,y:H-2},{x:W-2,y:1}])for(dy=-1;dy<=1;dy++)for(dx=-1;dx<=1;dx++)t[sp.y+dy][sp.x+dx]={type:"open"};var wp=["sword","bow","spear"],its=[{x:2+Math.floor(R()*(CX-5)),y:CY+Math.floor(R()*(H-2-CY)),type:wp[Math.floor(R()*3)]},{x:CX+3+Math.floor(R()*(W-3-CX-3)),y:2+Math.floor(R()*(CY-2)),type:wp[Math.floor(R()*3)]}];return{width:W,height:H,tiles:t,playerSpawns:[{x:1,y:H-2},{x:W-2,y:1}],itemSpawns:its,capturePoint:{x:CX,y:CY,radius:2},theme:["balanced","forest","water","arena"][Math.floor(R()*4)]}}

var WPN={sword:{dmg:30,range:1.5,cd:8},spear:{dmg:25,range:3,cd:10},bow:{dmg:20,range:8,cd:6}};
var SKL={shield:{cd:20,dur:4},sprint:{cd:15,dur:6},cloak:{cd:25,dur:8},freeze:{cd:29,dur:2},stun:{cd:20,dur:6},poison:{cd:20,dur:4},teleport:{cd:40,dur:1}};
// Counter matrix: attackerSkill vs defenderSkill → effect modifier
// effect: "bonus"=attacker gets bonus, "resist"=defender resists, "break"=breaks defender
var COUNTERS={
  sword_shield:{type:"break",desc:"sword pierces shield"},
  shield_bow:{type:"block",desc:"shield blocks arrow"},
  freeze_sprint:{type:"break",desc:"freeze stops sprint cold"},
  sprint_cloak:{type:"reveal",desc:"sprint reveals cloak"},
  cloak_poison:{type:"resist",desc:"cloak resists poison"},
  poison_shield:{type:"half",desc:"poison halves shield duration"},
  teleport_freeze:{type:"escape",desc:"teleport escapes freeze"},
  stun_teleport:{type:"block",desc:"stun blocks teleport"},
  poison_teleport:{type:"slow",desc:"poisoned teleport range halved"},
  shield_stun:{type:"resist",desc:"shield reduces stun duration"},
  freeze_cloak:{type:"reveal",desc:"freeze reveals cloaked target"},
  stun_sprint:{type:"break",desc:"stun cancels sprint"}
};
function getCounter(aSkill,dSkill){return COUNTERS[aSkill+"_"+dSkill]||null}
function applyCounter(atk,def,counter){
  if(!counter)return;
  if(counter.type==="break"){def[counter.effectTarget||"active"]=0;def[(counter.effectTarget||"active")+"Timer"]=0}
  if(counter.type==="block"){return true} // action blocked
  if(counter.type==="half"&&def.shieldTimer>0)def.shieldTimer=Math.max(1,Math.floor(def.shieldTimer/2))
  if(counter.type==="slow")atk.poisonedSlow=1
  if(counter.type==="escape"&&atk.fr){atk.fr=0;atk.frt=0}
  return false
}
var TER={open:{spd:1,dmg:1,s:0},grass:{spd:1,dmg:1.5,s:1},water:{spd:.5,dmg:.7,s:0},wall:{spd:0,dmg:0,s:0}};
function tile(m,x,y){return y<0||y>=m.height||x<0||x>=m.width?{type:"wall"}:m.tiles[y][x]}
function solid(m,x,y){return tile(m,x,y).type==="wall"}
function tm(m,x,y){return TER[tile(m,Math.round(x),Math.round(y)).type]||TER.open}
function inCap(a,cp){return Math.abs(a.x-cp.x)+Math.abs(a.y-cp.y)<=cp.radius}
function visible(o,tx,ty,m){var dx=tx-o.x,dy=ty-o.y,f=0;switch(o.facing){case"right":f=dx>0&&Math.abs(dy)<=Math.abs(dx);break;case"left":f=dx<0&&Math.abs(dy)<=Math.abs(dx);break;case"down":f=dy>0&&Math.abs(dx)<=Math.abs(dy);break;case"up":f=dy<0&&Math.abs(dx)<=Math.abs(dy);break}if(!f)return 0;var s=Math.max(Math.abs(dx),Math.abs(dy)),i;for(i=1;i<s;i++)if(tile(m,Math.round(o.x+dx*i/s),Math.round(o.y+dy*i/s)).type==="wall")return 0;return 1}

function runAgent(tree, state) {
  try {
    // Build rich state for the tree
    var fullState = {
      self: state.self,
      enemy: state.enemy,
      items: state.items,
      capturePoint: state.capturePoint,
      captureProgress: state.captureProgress,
      map: state.map,
      frame: state.frame,
      // Computed properties for conditions
      hasItem: state.items && state.items.some(function(it){return it.active}),
      nearItem: state.items && state.items.some(function(it){return it.active&&dist(it,state.self)<2}),
      nearEnemy: state.enemy&&dist(state.enemy,state.self)<4,
      inCapture: Math.abs(state.self.x-state.capturePoint.x)+Math.abs(state.self.y-state.capturePoint.y)<=state.capturePoint.radius,
      onTerrain: state.terrain[Math.round(state.self.y)]?.[Math.round(state.self.x)]?.type||"open",
    };
    var result = evalTree(tree, fullState, state.map);
    return result;
  } catch(e) { return {action:"none"}; }
}

async function runGame(treeA, treeB, map, seed, skA, skB) {
  var a=[{id:"A",x:map.playerSpawns[0].x,y:map.playerSpawns[0].y,f:"right",hp:100,mhp:100,w:null,wc:0,sk:skA||"shield",skc:0,sh:0,sht:0,cl:0,clt:0,sp:0,spt:0,fr:0,frt:0,st:0,stt:0,po:0,pot:0,alive:1,cf:0},{id:"B",x:map.playerSpawns[1].x,y:map.playerSpawns[1].y,f:"left",hp:100,mhp:100,w:null,wc:0,sk:skB||"shield",skc:0,sh:0,sht:0,cl:0,clt:0,sp:0,spt:0,fr:0,frt:0,st:0,stt:0,po:0,pot:0,alive:1,cf:0}];
  var ps=[],its=map.itemSpawns.map(function(s){return{type:s.type,x:s.x,y:s.y,active:1,rs:0}}),winner=null,reason="",rec=[],cp=map.capturePoint;

  function buildState(idx,frame){
    var s=a[idx],e=a[1-idx],eH=!e.alive||e.cl||(tm(map,e.x,e.y).s&&!s.sp)||dist(s,e)>8||!visible(s,e.x,e.y,map);
    var tr=[],y,x;for(y=0;y<map.height;y++){tr[y]=[];for(x=0;x<map.width;x++)tr[y][x]={type:map.tiles[y][x].type,speed:TER[map.tiles[y][x].type].spd}}
    return{
      self:{x:s.x,y:s.y,facing:s.f,hp:s.hp,maxHp:s.mhp,weapon:s.w,weaponCooldown:s.wc,skill:s.sk,skillCooldown:s.skc,onTerrain:tile(map,Math.round(s.x),Math.round(s.y)).type,shielded:s.sh,cloaked:s.cl,sprinting:s.sp,frozen:s.fr,stunned:s.st,poisoned:s.po},
      enemy:eH?null:{x:e.x,y:e.y,facing:e.f,hp:e.hp,maxHp:e.mhp,weapon:e.w,weaponCooldown:e.wc,skill:e.sk,skillCooldown:e.skc,onTerrain:tile(map,Math.round(e.x),Math.round(e.y)).type,shielded:e.sh,cloaked:e.cl,sprinting:e.sp,frozen:e.fr,stunned:e.st,poisoned:e.po},
      items:its.filter(function(it){return it.active}).map(function(it){return{x:it.x,y:it.y,type:it.type,active:it.active}}),
      terrain:tr,capturePoint:cp,captureProgress:{me:idx===0?a[0].cf:a[1].cf,enemy:idx===0?a[1].cf:a[0].cf},
      map:{width:map.width,height:map.height,seed:seed},frame:frame
    }
  }

  for(var frame=0;frame<200;frame++){
    var actA=runAgent(treeA,buildState(0,frame)),actB=runAgent(treeB,buildState(1,frame));
    for(var ei=0;ei<2;ei++){var idx=ei,act=ei===0?actA:actB,ag=a[idx],en=a[1-idx];if(!ag.alive||ag.fr)continue;
      if(act.action==="move"&&act.direction){var d=act.direction;if(ag.st){var ds=["up","down","left","right"];d=ds[Math.floor(Math.random()*4)]}var dx=0,dy=0;if(d==="left")dx=-1;if(d==="right")dx=1;if(d==="up")dy=-1;if(d==="down")dy=1;ag.f=d;var spd=ag.sp?2:(ag.po?1:1),tmod=tm(map,ag.x,ag.y).spd,s;for(s=0;s<Math.max(1,Math.round(spd*tmod));s++){var nx=ag.x+dx,ny=ag.y+dy;if(nx<0||nx>=map.width||ny<0||ny>=map.height||solid(map,nx,ny))break;ag.x=nx;ag.y=ny}}
      if(act.action==="skill"&&ag.sk&&ag.skc===0){var sd=SKL[ag.sk];switch(ag.sk){case"shield":ag.sh=1;ag.sht=sd.dur;break;case"sprint":ag.sp=1;ag.spt=sd.dur;break;case"cloak":ag.cl=1;ag.clt=sd.dur;break;case"freeze":en.fr=1;en.frt=sd.dur;break;case"stun":en.st=1;en.stt=sd.dur;break;case"poison":en.po=1;en.pot=sd.dur;break;case"teleport":var tx=ag.x+(ag.f==="right"?3:ag.f==="left"?-3:0),ty=ag.y+(ag.f==="down"?3:ag.f==="up"?-3:0);if(tx>0&&tx<map.width-1&&ty>0&&ty<map.height-1&&!solid(map,tx,ty)&&dist({x:tx,y:ty},en)>1){ag.x=tx;ag.y=ty}break}ag.skc=sd.cd}
      if(act.action==="shoot"&&ag.w&&ag.wc===0&&tm(map,ag.x,ag.y).spd>0){var wd=WPN[ag.w];if(ag.w==="sword"){if(en.alive&&dist(ag,en)<=wd.range){var dmg1=wd.dmg*tm(map,ag.x,ag.y).dmg;if(en.sh){en.sh=0;en.sht=0}else{en.hp-=dmg1;if(en.hp<=0){en.hp=0;en.alive=0}}}}else{var d2=act.direction||ag.f;ps.push({x:ag.x,y:ag.y,d:d2,o:ag.id,dmg:wd.dmg})}ag.wc=wd.cd}
      if(act.action==="pickup"){for(var iti=0;iti<its.length;iti++){var it=its[iti];if(it.active&&dist(ag,it)<1.5){it.active=0;it.rs=40;ag.w=it.type;ag.wc=0;break}}}
    }
    for(var pi=0;pi<ps.length;pi++){var p=ps[pi],pdx=0,pdy=0;if(p.d==="left")pdx=-2;if(p.d==="right")pdx=2;if(p.d==="up")pdy=-2;if(p.d==="down")pdy=2;p.x+=pdx;p.y+=pdy}
    ps=ps.filter(function(p){return!(p.x<0||p.x>=map.width||p.y<0||p.y>=map.height||solid(map,Math.round(p.x),Math.round(p.y)))});
    for(var agi=0;agi<a.length;agi++){var ag2=a[agi];if(!ag2.alive)continue;for(var pj=ps.length-1;pj>=0;pj--){var p2=ps[pj];if(p2.o===ag2.id)continue;if(dist(ag2,p2)<2){var dmg2=p2.dmg*tm(map,ag2.x,ag2.y).dmg;if(ag2.sh){ag2.sh=0;ag2.sht=0;ps.splice(pj,1);continue}ag2.hp-=dmg2;ps.splice(pj,1);if(ag2.hp<=0){ag2.hp=0;ag2.alive=0}}}}
    var aIn=inCap(a[0],cp),bIn=inCap(a[1],cp);if(aIn&&!bIn)a[0].cf++;else if(bIn&&!aIn)a[1].cf++;
    if(a[0].cf>=120){winner=0;reason="capture";break}if(a[1].cf>=120){winner=1;reason="capture";break}
    if(frame>=199){if(a[0].hp>a[1].hp)winner=0;else if(a[1].hp>a[0].hp)winner=1;else if(a[0].cf>a[1].cf)winner=0;else if(a[1].cf>a[0].cf)winner=1;reason="timeout";break}
    if(!a[0].alive){winner=1;reason="killed";break}if(!a[1].alive){winner=0;reason="killed";break}
    for(var ti=0;ti<a.length;ti++){var ag3=a[ti];if(ag3.sht>0&&--ag3.sht===0)ag3.sh=0;if(ag3.clt>0){ag3.clt--;if(ag3.clt===0)ag3.cl=0;if(tm(map,ag3.x,ag3.y).s&&ag3.clt>0)ag3.clt++}if(ag3.spt>0&&--ag3.spt===0)ag3.sp=0;if(ag3.frt>0&&--ag3.frt===0)ag3.fr=0;if(ag3.stt>0&&--ag3.stt===0)ag3.st=0;if(ag3.pot>0&&--ag3.pot===0)ag3.po=0;if(ag3.skc>0)ag3.skc--;if(ag3.wc>0)ag3.wc--}
    for(var ii=0;ii<its.length;ii++){var it2=its[ii];if(!it2.active&&it2.rs>0&&--it2.rs===0)it2.active=1}
  }
  return{winner:winner,resultReason:reason,totalFrames:frame+1,records:rec,captureProgress:{a:a[0].cf,b:a[1].cf},
    mapTheme:map.theme||"balanced",
    advantage:map.theme==="forest"?{skill:"cloak",weapon:"bow"}:map.theme==="water"?{skill:"sprint",weapon:"spear"}:map.theme==="arena"?{skill:"shield",weapon:"sword"}:{skill:"any",weapon:"any"}}
}

addEventListener("fetch",function(event){event.respondWith(handle(event))});

async function handle(event){
  var req=event.request,url=new URL(req.url),m=req.method;
  var h={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"};
  if(m==="OPTIONS")return new Response(null,{status:204,headers:h});
  function json(d,s){return new Response(JSON.stringify(d),{status:s||200,headers:h})}
  function err(msg,s){return json({error:msg},s||400)}
  async function body(){try{return await req.json()}catch(e){return{}}}
  async function kvGet(k){try{var d=await AGENTS.get(k);return d?JSON.parse(d):[]}catch(e){return[]}}
  async function kvSet(k,v){await AGENTS.put(k,JSON.stringify(v))}

  if(url.pathname==="/api/health")return json({status:"ok",name:"CodeClash",version:"0.5-tree","7x24":true});

  if(m==="POST"&&url.pathname==="/api/tanks/register"){
    var b=await body();
    var agents=await kvGet("agents");
    var key="tk_"+uid()+uid();
    var tree=b.tree||parseStrategy(b.code);
    agents.push({name:b.name||"Agent-"+uid(),tree:tree,code:b.code||"",skill:b.skill||"shield",model:b.model||"human",elo:1200,wins:0,losses:0,draws:0,keyHash:await sha256(key),createdAt:new Date().toISOString(),lastBattle:null});
    await kvSet("agents",agents);
    return json({name:agents[agents.length-1].name,battleKey:key,skill:agents[agents.length-1].skill,model:agents[agents.length-1].model},201)
  }

  if(url.pathname==="/api/agent/leaderboard"){
    var agents=await kvGet("agents");
    return json(agents.sort(function(a,b){return b.elo-a.elo}).slice(0,50).map(function(t,i){return{rank:i+1,name:t.name,elo:t.elo,wins:t.wins,losses:t.losses,draws:t.draws,model:t.model,skill:t.skill}}))
  }

  if(m==="POST"&&url.pathname==="/api/agent/tank/simulate"){
    var b=await body();
    var tree=b.tree||parseStrategy(b.code);
    var map=genMap(Date.now());
    var r=await runGame(tree,parseStrategy(null),map,Date.now(),b.skillType||"shield","shield");
    return json({winner:r.winner,resultReason:r.resultReason,totalFrames:r.totalFrames})
  }

  if(m==="POST"&&url.pathname==="/api/agent/tank/challenge"){
    var b=await body();
    var auth=req.headers.get("Authorization")||"",key=auth.startsWith("Bearer tk_")?auth.slice(7):"";
    if(!key)return err("Valid battle key required",401);
    var agents=await kvGet("agents"),hsh=await sha256(key);
    var me=agents.find(function(t){return t.keyHash===hsh});
    if(!me)return err("Invalid key",401);
    var opp=agents.find(function(t){return t.name===b.opponent&&t.name!==me.name});
    if(!opp)return err("Opponent not found",404);
    var map=genMap(Date.now());
    var r=await runGame(me.tree||parseStrategy(me.code),opp.tree||parseStrategy(opp.code),map,Date.now(),me.skill,opp.skill);
    var eA=1/(1+Math.pow(10,(opp.elo-me.elo)/400)),sA=r.winner===0?1:r.winner===1?0:.5,dA=Math.round(25*(sA-eA));
    me.elo+=r.winner===0?dA:r.winner===1?-Math.round(25*((1-sA)-(1-eA))):0;
    opp.elo+=r.winner===1?dA:r.winner===0?Math.round(25*((1-sA)-(1-eA))):0;
    if(r.winner===0){me.wins++;opp.losses++}else if(r.winner===1){opp.wins++;me.losses++}else{me.draws++;opp.draws++}
    me.lastBattle=new Date().toISOString();opp.lastBattle=new Date().toISOString();
    await kvSet("agents",agents);
    function makeCommentary(r,me,opp){if(r.winner===null)return"双方战平 — 地图:"+(r.mapTheme||"balanced");var w=r.winner===0?me.name:opp.name;var reason=r.resultReason==="capture"?"占领据点获胜":r.resultReason==="killed"?"击杀对手获胜":"超时血量优势获胜";return w+" "+reason+" | 地图:"+(r.mapTheme||"balanced")}
    return json({winner:r.winner===0?me.name:r.winner===1?opp.name:null,resultReason:r.resultReason,totalFrames:r.totalFrames,commentary:makeCommentary(r,me,opp)})
  }

  return json({status:"ok"})
}
