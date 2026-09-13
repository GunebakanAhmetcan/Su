import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverJob, restClient, allowedEndpoint } from '../src/server/push.mjs';
import handler from '../netlify/functions/send-push.mjs';

const now=Date.now();
const job={id:'job',room_id:'room',sender_user_id:'me',recipient_user_id:'friend',attempts:1,created_at:new Date(now).toISOString()};
const endpoint='https://web.push.apple.com/example';
function fixture({status,claimed=true}={}) {
  const calls=[],sent=[];
  const rest=async(path,options={})=>{
    calls.push({path,...options});
    if(path==='rpc/claim_push_job') return claimed?[job]:[];
    if(path==='room_members') return [{user_id:'me'},{user_id:'friend'}];
    if(path==='profiles') return [{display_name:'Ahmet'}];
    if(path==='push_subscriptions' && options.method!=='DELETE') return [{endpoint,p256dh:'p',auth:'a'}];
    return null;
  };
  const push={setVapidDetails(){},async sendNotification(...args){sent.push(args);if(status)throw Object.assign(new Error('push'),{statusCode:status});}};
  const options={env:{PUBLIC_VAPID_KEY:'public',VAPID_PRIVATE_KEY:'private',URL:'https://su.test'},push,now:()=>now};
  return {rest,options,calls,sent};
}
test('provider acknowledgement records sent and gives each job a deduplication tag',async()=>{
  const f=fixture(); const result=await deliverJob(f.rest,'job',f.options);
  assert.equal(result.delivered,1);
  assert.equal(f.calls.at(-1).body.p_sent,true);
  assert.equal(JSON.parse(f.sent[0][1]).tag,'su-job');
  assert.ok(f.sent[0][2].TTL<=3600);
});
test('temporary push errors become retryable, never a false sent status',async()=>{
  const f=fixture({status:503}); const result=await deliverJob(f.rest,'job',f.options);
  assert.equal(result.retrying,true);assert.equal(f.calls.at(-1).body.p_sent,false);assert.equal(f.calls.at(-1).body.p_retryable,true);
});
test('expired subscription is removed and reported as unavailable',async()=>{
  const f=fixture({status:410});await deliverJob(f.rest,'job',f.options);
  assert.ok(f.calls.some(call=>call.method==='DELETE' && call.query.endpoint==='eq.'+endpoint));
  assert.equal(f.calls.at(-1).body.p_error,'no_active_subscription');
  assert.equal(f.calls.at(-1).body.p_retryable,false);
});
test('claimed/finished jobs are not sent a second time',async()=>{
  const f=fixture({claimed:false});assert.equal((await deliverJob(f.rest,'job',f.options)).skipped,true);assert.equal(f.sent.length,0);
});
test('only supported HTTPS push hosts are contacted',()=>{
  for(const url of ['http://web.push.apple.com/a','https://localhost/a','https://web.push.apple.com.evil.test/a','https://user@web.push.apple.com/a','https://127.0.0.1/']) assert.equal(allowedEndpoint(url),false);
  assert.equal(allowedEndpoint(endpoint),true);
});
test('REST client normalizes URL and never sends an opaque secret as JWT',async()=>{
  let seen;
  const rest=restClient({PUBLIC_SUPABASE_URL:'https://project.supabase.co/rest/v1/',SUPABASE_SECRET_KEY:'sb_secret_example'},async(url,opts)=>{seen={url,opts};return new Response('[]');});
  await rest('profiles');assert.equal(seen.url.pathname,'/rest/v1/profiles');assert.equal(seen.opts.headers.authorization,undefined);assert.equal(seen.opts.headers.apikey,'sb_secret_example');
});
test('webhook rejects missing secret and GET without contacting the backend',async()=>{
  assert.equal((await handler(new Request('https://su.test/fn'))).status,405);
  assert.equal((await handler(new Request('https://su.test/fn',{method:'POST',body:'{}'}))).status,401);
});
