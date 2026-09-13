import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../sw.js',import.meta.url),'utf8');
function worker({cached,fetcher=()=>{throw new Error('offline');}}={}) {
  const handlers={},deleted=[],store=new Map(cached?[['/index.html',new Response('cached shell')],['/app.js',new Response('cached app')]]:[]);
  let fetches=0,skip=0;
  const self={location:{origin:'https://su.test'},addEventListener:(name,fn)=>{handlers[name]=fn;},clients:{async claim(){}},skipWaiting:()=>{skip++;}};
  const caches={async open(){return {async match(path){return store.get(path)?.clone();},async addAll(requests){for(const r of requests)store.set(new URL(r.url).pathname,new Response('asset'));}};},async keys(){return ['su-shell-old','unrelated'];},async delete(name){deleted.push(name);}};
  class LocalRequest extends Request {constructor(path,opts){super(new URL(path,'https://su.test'),opts);}}
  vm.runInNewContext(source,{self,caches,Request:LocalRequest,Response,URL,AbortController,setTimeout:(fn)=>setTimeout(fn,10),clearTimeout,fetch:(...args)=>{fetches++;return fetcher(...args);}});
  async function request(path,mode='navigate') {let response;handlers.fetch({request:{url:'https://su.test'+path,mode,method:'GET'},respondWith(value){response=value;}});return response;}
  return {handlers,store,deleted,request,get fetches(){return fetches;},get skipped(){return skip;}};
}
test('cached startup and assets do not wait for any network request',async()=>{
  const w=worker({cached:true,fetcher:()=>new Promise(()=>{})});
  assert.equal(await (await w.request('/?birlikte=1')).text(),'cached shell');
  assert.equal(await (await w.request('/app.js','cors')).text(),'cached app');assert.equal(w.fetches,0);
});
test('missing shell plus HTTP failure shows recovery UI rather than a blank screen',async()=>{
  const w=worker({fetcher:async()=>new Response('bad',{status:503})}); const r=await w.request('/');
  assert.equal(r.status,503);assert.match(await r.text(),/Tekrar dene/);
});
test('cache miss on a hanging connection aborts with a readable fallback',async()=>{
  const w=worker({fetcher:(_r,opts)=>new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
  assert.equal((await w.request('/')).status,503);
});
test('install caches the full shell and activation removes only application caches',async()=>{
  const w=worker();let pending;w.handlers.install({waitUntil:p=>{pending=p;}});await pending;
  for(const path of ['/index.html','/app.js','/config.js','/boot.js','/styles.css'])assert.ok(w.store.has(path));
  assert.equal(w.skipped,0);w.handlers.activate({waitUntil:p=>{pending=p;}});await pending;
  assert.deepEqual(w.deleted,['su-shell-old']);
  w.handlers.message({data:{type:'ACTIVATE_UPDATE'}});assert.equal(w.skipped,1);
});
test('API/function responses bypass shell caching',async()=>{
  const w=worker({cached:true});assert.equal(await w.request('/.netlify/functions/send-push','cors'),undefined);assert.equal(w.fetches,0);
});
