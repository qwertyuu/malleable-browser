/**
 * The `mal` handle handed to a bubble-member edit's JS.
 *
 * Built as a source literal and passed as the IIFE argument by the injector, so
 * it is a local inside the edit's closure and never appears on `window`. The
 * edit talks to the bubble server with plain `fetch` / `EventSource` — no
 * preload, nothing new exposed to the page world.
 *
 * On the token: authorization at the server is the `Origin` header, which the
 * browser sets and page JS cannot forge. So a page can only ever reach bubbles
 * its own host belongs to, which means a page script that hooks `fetch` and
 * steals this token gains nothing it couldn't already do from its own origin.
 * The token is there to keep NON-browser local processes out, not page scripts.
 *
 * The honest limit of origin-based auth: membership is granted to the ORIGIN, not
 * to this specific edit. Any script running on a member page — including the
 * site's own — can reach that bubble's state. The bubble is the blast radius.
 */
export function buildMalSource(args: {
  endpoint: string
  token: string
  bubbleId: string
  bubbleName: string
  hosts: string[]
  editId: string
}): string {
  const j = (v: unknown): string => JSON.stringify(v)
  return `(function(){
  var EP=${j(args.endpoint)},TK=${j(args.token)},B=${j(args.bubbleId)};
  var qs=function(extra){return "?bubble="+encodeURIComponent(B)+(extra||"")};
  var hdr={"authorization":"Bearer "+TK,"content-type":"application/json"};
  var handlers={state:{},bus:{}},es=null;
  function fire(map,key,value){
    var list=(map[key]||[]).concat(map["*"]||[]);
    for(var i=0;i<list.length;i++){try{list[i](value,key)}catch(e){console.error("[malleable ${args.editId}] watcher",e)}}
  }
  function connect(){
    if(es)return;
    try{
      es=new EventSource(EP+"/watch"+qs("&token="+encodeURIComponent(TK)));
      es.onmessage=function(ev){
        var m;try{m=JSON.parse(ev.data)}catch(_){return}
        if(m.type==="state")fire(handlers.state,m.key,m.value);
        else if(m.type==="bus")fire(handlers.bus,m.ch,m.value);
      };
      // Let the browser handle reconnection; only log a hard failure once.
      es.onerror=function(){if(es&&es.readyState===2){es=null}};
    }catch(e){console.error("[malleable ${args.editId}] watch",e)}
  }
  function req(method,path,body){
    return fetch(EP+path,{method:method,headers:hdr,body:body===undefined?undefined:JSON.stringify(body)})
      .then(function(r){
        if(!r.ok)return r.json().catch(function(){return{}}).then(function(e){
          throw new Error("bubble "+r.status+": "+(e&&e.error||r.statusText))});
        return r.json();
      });
  }
  return {
    bubble:{id:B,name:${j(args.bubbleName)},hosts:${j(args.hosts)}},
    edit:${j(args.editId)},
    state:{
      all:function(){return req("GET","/state"+qs())},
      get:function(k){return req("GET","/state"+qs()).then(function(s){return s[k]})},
      set:function(k,v){return req("PUT","/state"+qs("&key="+encodeURIComponent(k)),v===undefined?null:v)},
      remove:function(k){return req("PUT","/state"+qs("&key="+encodeURIComponent(k)),null)},
      watch:function(k,fn){connect();(handlers.state[k]=handlers.state[k]||[]).push(fn);return function(){
        handlers.state[k]=(handlers.state[k]||[]).filter(function(f){return f!==fn})}}
    },
    bus:{
      publish:function(ch,v){return req("POST","/publish"+qs("&ch="+encodeURIComponent(ch)),v===undefined?null:v)},
      subscribe:function(ch,fn){connect();(handlers.bus[ch]=handlers.bus[ch]||[]).push(fn);return function(){
        handlers.bus[ch]=(handlers.bus[ch]||[]).filter(function(f){return f!==fn})}}
    }
  };
})()`
}
