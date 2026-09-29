import test from 'node:test';
import assert from 'node:assert/strict';
import { WaterStore, SyncEngine, DATA_KEY, amountValue } from '../src/store.js';

class Memory {
  data = new Map();
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k,v) { if (this.full) throw new Error('quota'); this.data.set(k,v); }
}
function fixture() {
  const storage = new Memory(); let serial = 0, time = new Date('2026-09-12T23:59:59').getTime();
  const store = new WaterStore(storage, { now: () => time, id: () => 'id-' + ++serial });
  return { storage, store, setTime: value => { time = value; } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('v4 migration preserves calendar dates, settings, pairing and queued deletes', () => {
  const storage = new Memory();
  storage.setItem('su:entries:v1', JSON.stringify({ '2026-09-01': [{ id:'old',amount:375,createdAt:1788300000000,synced:true }, {clientId:'removed',amount:250,createdAt:1788300000000}] }));
  storage.setItem('su:settings:v1', JSON.stringify({ customAmount:375,palette:'olive' }));
  storage.setItem('su:pair:v1', JSON.stringify({ userId:'me',roomId:'room' }));
  storage.setItem('su:delete-queue:v1', JSON.stringify([{ clientId:'removed' }]));
  const store = new WaterStore(storage);
  assert.equal(store.total('2026-09-01'),375);
  assert.equal(store.state.settings.customAmount,375);
  assert.equal(store.state.settings.palette,'olive');
  assert.equal(store.state.pair.userId,'me');
  assert.equal(store.state.outbox.removed.kind,'delete');
  assert.equal(new WaterStore(storage).total('2026-09-01'),375);
  assert.ok(storage.getItem('su:entries:v1'));
});

test('rapid additions and an in-flight undo drain completely without resurrection', async () => {
  const { store } = fixture(); store.pair({ userId:'me',roomId:'room' });
  const first = store.add(250), started = deferred(), unblock = deferred(), remote = new Map(); let calls=0;
  const engine = new SyncEngine(store, {
    async write(batch) {
      if (++calls === 1) { started.resolve(); await unblock.promise; }
      for (const op of batch) { const id = op.clientId || op.entry.clientId; if(op.kind==='delete') remote.delete(id); else remote.set(id,op.entry.amount); }
      return batch.map(op => ({client_id:op.clientId || op.entry.clientId,id:'remote'}));
    }, async profile() {}
  });
  const task = engine.run(); await started.promise;
  const second = store.add(500); store.remove(first); engine.run(); unblock.resolve(); await task;
  assert.deepEqual([...remote.entries()],[[second,500]]);
  assert.equal(Object.keys(store.state.outbox).length,0);
  assert.equal(store.total(),500);
});

test('network failure preserves operations across reload and retry', async () => {
  const { store, storage } = fixture(); store.pair({userId:'me',roomId:'room'}); store.add(200);
  await assert.rejects(new SyncEngine(store,{async write(){throw new Error('offline');}}).run(),/offline/);
  const reloaded = new WaterStore(storage); let received=0;
  await new SyncEngine(reloaded,{async write(batch){received+=batch.length;return [];},async profile(){}}).run();
  assert.equal(received,1); assert.equal(Object.keys(reloaded.state.outbox).length,0);
  assert.equal(reloaded.state.entries[0].synced,true);
});

test('midnight uses the instant of each addition, not the previous rendered day', () => {
  const { store,setTime }=fixture(); store.add(200);
  setTime(new Date('2026-09-13T00:00:01').getTime()); store.add(300);
  assert.equal(store.total('2026-09-12'),200); assert.equal(store.total(),300);
});

test('undoing deletion makes a newer upsert and stale acknowledgement cannot clear it', () => {
  const {store}=fixture(); const id=store.add(250); const entry=store.remove(id);
  const batch=Object.values(store.state.outbox); store.restore(entry); store.ack(batch);
  assert.equal(store.total(),250); assert.equal(store.state.outbox[id].kind,'upsert');
  assert.ok(store.state.outbox[id].revision>batch[0].revision);
});

test('cached cloud reads cannot resurrect a pending or acknowledged deletion', () => {
  const {store}=fixture(); store.pair({userId:'me',roomId:'room'});
  const id=store.add(250); store.remove(id); store.ack(Object.values(store.state.outbox));
  store.merge([], [{id:'remote',client_id:id,user_id:'me',amount:250,recorded_day:store.today(),recorded_at:new Date().toISOString()}],store.today(),store.today());
  assert.equal(store.total(),0);
});

test('quota failure leaves the last committed state intact', () => {
  const {store,storage}=fixture(); store.add(100); const before=storage.getItem(DATA_KEY); storage.full=true;
  assert.throws(()=>store.add(500),/kaydedilemedi/); assert.equal(store.total(),100); assert.equal(storage.getItem(DATA_KEY),before);
});

test('an older in-flight history response cannot erase a newly synchronized entry', () => {
  const {store}=fixture();store.pair({userId:'me',roomId:'room'});
  const snapshot=store.state.clock;store.add(500);store.ack(Object.values(store.state.outbox));
  store.merge([],[],store.today(),store.today(),snapshot);
  assert.equal(store.total(),500);
});

test('manual validation rejects decimals, blanks and out-of-range values without clamping', () => {
  for (const value of ['', '0', '3001', '1.5', '-25', 'abc']) assert.throws(()=>amountValue(value,1,3000));
  assert.equal(amountValue('375',1,3000),375);
});

test('editing custom amount is persistent and adds no entry', () => {
  const {store,storage}=fixture(); store.settings({customAmount:375});
  assert.equal(store.total(),0); assert.equal(new WaterStore(storage).state.settings.customAmount,375);
});

test('backdated bulk additions keep the selected day across reload and synchronization', async () => {
  const { store, storage, setTime } = fixture();
  setTime(new Date('2026-09-13T00:05:00').getTime());
  store.pair({ userId: 'me', roomId: 'room' });
  const id = store.add(4500, '2026-09-12');
  assert.equal(store.total(), 0);
  assert.equal(store.total('2026-09-12'), 4500);
  const restored = new WaterStore(storage); let uploaded;
  await new SyncEngine(restored, { async write(batch) { uploaded = batch; return []; }, async profile() {} }).run();
  assert.equal(uploaded[0].entry.day, '2026-09-12');
  assert.equal(uploaded[0].entry.clientId, id);
  assert.equal(restored.entriesFor('2026-09-12')[0].amount, 4500);
});

test('editing an in-flight backdated entry keeps its identity and sends the newer amount', async () => {
  const { store } = fixture(); store.pair({ userId: 'me', roomId: 'room' });
  const id = store.add(250, '2026-09-11');
  const original = { ...store.entriesFor('2026-09-11')[0] };
  const started = deferred(), unblock = deferred(), sent = [];
  const engine = new SyncEngine(store, {
    async write(batch) { sent.push(batch); if(sent.length === 1) { started.resolve(); await unblock.promise; } return []; },
    async profile() {}
  });
  const task = engine.run(); await started.promise;
  const previous = store.edit(id, 2000); unblock.resolve(); await task;
  assert.equal(previous.amount, 250);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0].entry.amount, 2000);
  assert.equal(sent[1][0].entry.clientId, id);
  assert.equal(sent[1][0].entry.day, original.day);
  assert.equal(sent[1][0].entry.createdAt, original.createdAt);
  assert.equal(store.state.entries.length, 1);
  assert.equal(Object.keys(store.state.outbox).length, 0);
  store.edit(id, previous.amount);
  assert.equal(store.total('2026-09-11'), 250);
  assert.ok(store.state.outbox[id].revision > sent[1][0].revision);
});

test('backdating rejects impossible and future dates without adding water', () => {
  const { store } = fixture();
  for(const day of ['2026-09-13', '2026-02-30', 'bad', '2026-13-01']) assert.throws(() => store.add(100, day));
  assert.equal(store.state.entries.length, 0);
});

test('editing a missing record or invalid quantity changes nothing', () => {
  const { store } = fixture(); const id = store.add(250, '2026-09-11');
  assert.throws(() => store.edit('missing', 500), /bulunmuyor/);
  for(const amount of [0, -2, 1.5, 10001]) assert.throws(() => store.edit(id, amount));
  assert.equal(store.total('2026-09-11'), 250);
});
