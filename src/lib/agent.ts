// Training bots for simulation — external AIs test against these
export const TRAINING_BOTS: Record<string, string> = {
  "nova-scout": `
function act(state) {
  var self=state.self, enemy=state.enemy, cp=state.capturePoint;
  if(!self.weapon){var it=state.items.filter(function(i){return i.active})[0];if(it){if(Math.abs(it.x-self.x)<2&&Math.abs(it.y-self.y)<2)return{action:'pickup'};return{action:'move',direction:it.x>self.x?'right':it.x<self.x?'left':it.y>self.y?'down':'up'}}}
  if(self.skillCooldown===0)return{action:'skill'};
  if(!enemy){var dx=cp.x-self.x;return{action:'move',direction:dx>0?'right':'left'}}
  if(self.weaponCooldown===0&&Math.abs(enemy.x-self.x)<5)return{action:'shoot',direction:enemy.x>self.x?'right':'left'};
  return{action:'move',direction:enemy.x>self.x?'right':'left'};
}`,
  "azure-hunter": `
function act(state) {
  var self=state.self, enemy=state.enemy, cp=state.capturePoint;
  var tile=state.terrain[Math.round(self.y)][Math.round(self.x)];
  if(!self.weapon){var items=state.items.filter(function(i){return i.active});if(items.length>0){var it=items[0],md=99;for(var i=0;i<items.length;i++){var d=Math.abs(items[i].x-self.x)+Math.abs(items[i].y-self.y);if(d<md){md=d;it=items[i]}}if(md<2)return{action:'pickup'};return{action:'move',direction:it.x>self.x?'right':it.x<self.x?'left':it.y>self.y?'down':'up'}}}
  if(tile.type==='open'){for(var dy=-2;dy<=2;dy++){for(var dx=-2;dx<=2;dx++){var ty=Math.round(self.y)+dy,tx=Math.round(self.x)+dx;if(ty>=0&&ty<state.map.height&&tx>=0&&tx<state.map.width&&state.terrain[ty][tx].type==='grass')return{action:'move',direction:dx>0?'right':dx<0?'left':dy>0?'down':'up'}}}}
  if(self.skillCooldown===0&&tile.type==='grass')return{action:'skill'};
  if(Math.abs(cp.x-self.x)+Math.abs(cp.y-self.y)<=cp.radius&&!enemy)return{action:'none'};
  if(enemy&&self.weaponCooldown===0&&tile.type==='grass')return{action:'shoot',direction:enemy.x>self.x?'right':'left'};
  return{action:'move',direction:cp.x>self.x?'right':'left'};
}`,
  "crimson-bastion": `
function act(state) {
  var self=state.self, cp=state.capturePoint;
  if(!self.weapon){var items=state.items.filter(function(i){return i.active});if(items.length>0){var it=items[0],md=99;for(var i=0;i<items.length;i++){var d=Math.abs(items[i].x-self.x)+Math.abs(items[i].y-self.y);if(d<md){md=d;it=items[i]}}if(md<2)return{action:'pickup'};return{action:'move',direction:it.x>self.x?'right':it.x<self.x?'left':it.y>self.y?'down':'up'}}}
  var dx=cp.x-self.x,dy=cp.y-self.y;
  if(Math.abs(dx)+Math.abs(dy)>cp.radius)return{action:'move',direction:dx>0?'right':dx<0?'left':dy>0?'down':'up'};
  if(self.skillCooldown===0)return{action:'skill'};
  return{action:'none'};
}`,
};
