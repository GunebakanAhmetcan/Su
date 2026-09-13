export const DATA_KEY = 'su:data:v5';
export const defaults = { goal: 2500, glasses: { small: 200, medium: 300, large: 400 }, customAmount: null, palette: 'ocean', mode: 'system' };

export function dayKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function shiftDay(day, offset) {
  const date = new Date(day + 'T12:00:00');
  date.setDate(date.getDate() + offset);
  return dayKey(date);
}

export function amountValue(value, min, max) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) > max) {
    throw new Error(`${min.toLocaleString('tr-TR')}–${max.toLocaleString('tr-TR')} ml arasında tam sayı gir.`);
  }
  return Number(text);
}

function legacy(storage, key, fallback) {
  const raw = storage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) ?? fallback; }
  catch { throw new Error('Kayıtlar okunamadı. Uygulamayı silmeden tekrar aç.'); }
}

function normalizeSettings(value = {}) {
  const valid = (n, fallback, min, max) => Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  return {
    goal: valid(value.goal, 2500, 500, 6000),
    glasses: Object.fromEntries(Object.entries(defaults.glasses).map(([key, n]) => [key, valid(value.glasses?.[key], n, 50, 1500)])),
    customAmount: valid(value.customAmount, null, 1, 3000),
    palette: ['ocean', 'olive', 'sand', 'white'].includes(value.palette) ? value.palette : 'ocean',
    mode: ['system', 'light', 'dark'].includes(value.mode) ? value.mode : 'system'
  };
}

export class WaterStore {
  constructor(storage, { now = () => Date.now(), id = () => crypto.randomUUID() } = {}) {
    this.storage = storage;
    this.now = now;
    this.id = id;
    this.listeners = new Set();
    const saved = legacy(storage, DATA_KEY, null);
    if (saved && (saved.version !== 5 || !Array.isArray(saved.entries) || !saved.outbox || !saved.deleted)) {
      throw new Error('Yerel kayıt biçimi okunamadı. Uygulamayı silmeden tekrar aç.');
    }
    if (saved) {
      this.state = saved;
      return;
    }
    const old = legacy(storage, 'su:entries:v1', {});
    const entries = [];
    const known = new Set();
    let clock = now();
    const outbox = {};
    for (const [day, records] of Object.entries(old)) {
      for (const record of Array.isArray(records) ? records : []) {
        if (!(record?.amount > 0) || !(record.createdAt > 0)) continue;
        const clientId = String(record.clientId || record.id || id());
        if (known.has(clientId)) continue;
        known.add(clientId);
        const entry = { ...record, id: clientId, clientId, day, revision: ++clock, synced: false };
        entries.push(entry);
        // Re-upload idempotently to preserve the original local calendar day.
        outbox[clientId] = { kind: 'upsert', revision: entry.revision, entry: { ...entry } };
      }
    }
    const deleted = {};
    for (const item of legacy(storage, 'su:delete-queue:v1', [])) {
      if (!item.clientId) continue;
      deleted[item.clientId] = ++clock;
      outbox[item.clientId] = { kind: 'delete', revision: clock, clientId: item.clientId };
    }
    this.state = {
      version: 5, clock, settings: normalizeSettings(legacy(storage, 'su:settings:v1', {})),
      pair: legacy(storage, 'su:pair:v1', null), entries: entries.filter(e => !deleted[e.clientId]),
      outbox, deleted, profileRevision: ++clock,
      shared: { members: [], entries: [], updatedAt: null }, lastSync: null
    };
    this.storage.setItem(DATA_KEY, JSON.stringify(this.state));
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  commit(change) {
    const next = structuredClone(this.state);
    change(next);
    try { this.storage.setItem(DATA_KEY, JSON.stringify(next)); }
    catch { throw new Error('Cihaza kaydedilemedi. Depolama alanını kontrol et; bu işlem kaydedilmedi.'); }
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  revision(state) { return state.clock = Math.max(state.clock + 1, this.now()); }
  today() { return dayKey(new Date(this.now())); }
  entriesFor(day = this.today()) { return this.state.entries.filter(e => e.day === day).sort((a, b) => b.createdAt - a.createdAt); }
  total(day = this.today()) { return this.entriesFor(day).reduce((sum, e) => sum + e.amount, 0); }

  add(amount) {
    amount = amountValue(amount, 1, 3000);
    const clientId = this.id();
    this.commit(state => {
      const createdAt = this.now();
      const entry = { id: clientId, clientId, amount, createdAt, day: dayKey(new Date(createdAt)), revision: this.revision(state), synced: false, remoteId: null };
      state.entries.push(entry);
      state.outbox[clientId] = { kind: 'upsert', revision: entry.revision, entry: { ...entry } };
    });
    return clientId;
  }

  remove(clientId) {
    const entry = this.state.entries.find(e => e.clientId === clientId);
    if (!entry) return null;
    this.commit(state => {
      const revision = this.revision(state);
      state.entries = state.entries.filter(e => e.clientId !== clientId);
      state.deleted[clientId] = revision;
      state.outbox[clientId] = { kind: 'delete', clientId, revision };
    });
    return { ...entry };
  }

  restore(entry) {
    this.commit(state => {
      const revision = this.revision(state);
      const restored = { ...entry, revision, synced: false };
      state.entries = state.entries.filter(e => e.clientId !== entry.clientId).concat(restored);
      delete state.deleted[entry.clientId];
      state.outbox[entry.clientId] = { kind: 'upsert', revision, entry: restored };
    });
  }

  settings(values) {
    this.commit(state => {
      state.settings = { ...state.settings, ...values };
      state.profileRevision = this.revision(state);
    });
  }

  pair(pair) {
    this.commit(state => { state.pair = pair; state.profileRevision = this.revision(state); });
  }

  ack(batch, rows = []) {
    this.commit(state => {
      for (const operation of batch) {
        const clientId = operation.clientId || operation.entry.clientId;
        const current = state.outbox[clientId];
        if (!current || current.revision !== operation.revision) continue;
        delete state.outbox[clientId];
        const entry = state.entries.find(e => e.clientId === clientId);
        const row = rows.find(r => r.client_id === clientId);
        if (entry && operation.kind === 'upsert') { entry.synced = true; entry.remoteId = row?.id || entry.remoteId; }
      }
      state.lastSync = this.now();
    });
  }

  ackProfile(revision) {
    this.commit(state => { if (state.profileRevision === revision) state.profileRevision = 0; });
  }

  merge(members, records, from, to, snapshotRevision = this.state.clock) {
    const own = this.state.pair?.userId;
    this.commit(state => {
      const incoming = records.map(row => ({ ...row, day: row.recorded_day || dayKey(new Date(row.recorded_at)) }));
      const ids = new Set(incoming.filter(row => row.user_id === own).map(row => row.client_id));
      state.entries = state.entries.filter(entry => state.outbox[entry.clientId] || !entry.synced || entry.revision > snapshotRevision || entry.day < from || entry.day > to || ids.has(entry.clientId));
      for (const row of incoming.filter(r => r.user_id === own)) {
        state.clock = Math.max(state.clock, Number(row.sync_revision) || 0);
        if (state.outbox[row.client_id] || state.deleted[row.client_id]) continue;
        const entry = { id: row.client_id, clientId: row.client_id, remoteId: row.id, amount: row.amount, createdAt: new Date(row.recorded_at).getTime(), day: row.day, revision: Number(row.sync_revision) || 0, synced: true };
        const index = state.entries.findIndex(e => e.clientId === entry.clientId);
        if (index >= 0 && state.entries[index].revision > entry.revision) continue;
        if (index < 0) state.entries.push(entry); else state.entries[index] = entry;
      }
      state.shared = {
        members,
        entries: state.shared.entries.filter(e => e.day < from || e.day > to).concat(incoming),
        loadedDays: { ...state.shared.loadedDays, ...Object.fromEntries(Array.from({ length: 64 }, (_, i) => shiftDay(from, i)).filter(day => day <= to).map(day => [day, this.now()])) },
        updatedAt: this.now()
      };
    });
  }
}

export class SyncEngine {
  constructor(store, adapter) { this.store = store; this.adapter = adapter; this.running = null; }
  run() {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  async drain() {
    if (!this.store.state.pair) return;
    while (true) {
      const batch = Object.values(this.store.state.outbox).slice(0, 100);
      if (batch.length) {
        const rows = await this.adapter.write(batch, this.store.state.pair);
        this.store.ack(batch, rows);
        continue;
      }
      const revision = this.store.state.profileRevision;
      if (revision) {
        await this.adapter.profile(this.store.state.settings, this.store.state.pair);
        this.store.ackProfile(revision);
        continue;
      }
      return;
    }
  }
}
