import { createClient } from '@supabase/supabase-js';
import { WaterStore, SyncEngine, dayKey, shiftDay, amountValue } from './store.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const number = value => Number(value || 0).toLocaleString('tr-TR');
const dateLabel = day => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' }).format(new Date(day + 'T12:00:00'));
const clockLabel = time => new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(time));
const config = window.SU_CONFIG || {};
const background = { ocean: ['#f2f1eb','#0d1112'], olive: ['#f3f1e7','#11140f'], sand: ['#f4eee4','#17130f'], white: ['#ffffff','#101314'] };
const changedHtml = (element, html) => { if (element && element.dataset.html !== html) { element.innerHTML = html; element.dataset.html = html; } };

function deadline(promise, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bağlantı zaman aşımına uğradı. Tekrar denenecek.')), ms); })]).finally(() => clearTimeout(timer));
}

async function boundedFetch(url, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const original = options.signal;
  if (original?.aborted) controller.abort();
  else original?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); original?.removeEventListener('abort', abort); }
}

function errorText(error) {
  const text = String(error?.message || error || '');
  if (/sync_water_changes|su_version|recorded_day|claim_push_job|schema cache|does not exist/i.test(text)) return 'Ortak kullanım güncellemesi henüz tamamlanmamış.';
  if (/fetch|network|abort|timeout|time.?out/i.test(text)) return 'Bağlantı kurulamadı. Cihazdaki kayıtların korunuyor.';
  if (/session_lost/i.test(text)) return 'Bu cihazın eşleşme oturumu değişmiş. Kurtarma kodunla geri dönebilirsin.';
  if (/anonymous|signups/i.test(text)) return 'Ortak kullanıma giriş şu anda kullanılamıyor.';
  return text || 'İşlem tamamlanamadı. Tekrar dene.';
}

function main() {
  let store;
  try { store = new WaterStore(localStorage); }
  catch (error) { $('startup-status').hidden = false; $('startup-status').textContent = errorText(error); return; }
  let client, authTask, user, apiReady = false, sessionLost = false;
  let syncTimer, syncBackoff = 1500, syncMessage = '', syncing = false;
  let refreshTask, refreshMessage = '', historyDay = store.today(), historyEnd = store.today();
  let toastTimer, toastUndo, pairBusy = false, reminderBusy = false, deviceBusy = false;
  let deviceState = 'checking', deviceNote = '', lastDay = store.today(), recoveryCode = '';
  let nextReminderAt = 0, lastJob = null, jobTimer, refreshTimer, deviceTask;
  const pair = () => store.state.pair;
  const settings = () => store.state.settings;

  function showToast(message, undo) {
    const toast = $('toast');
    clearTimeout(toastTimer);
    toastUndo = undo;
    const modal = Array.from(document.querySelectorAll('dialog[open]')).at(-1);
    (modal || document.body).append(toast);
    $('toast-message').textContent = message;
    $('toast-action').hidden = !undo;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; toastUndo = null; }, 6500);
  }
  async function action(task) {
    try { await task(); } catch (error) { showToast(errorText(error)); }
  }
  function openDialog(dialog) {
    dialog.classList.remove('is-closing');
    if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add('modal-open');
  }
  function closeDialog(dialog) {
    if (!dialog?.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140;
    setTimeout(() => { dialog.close(); dialog.classList.remove('is-closing'); }, delay);
  }
  function getClient() {
    if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error('Ortak kullanım henüz ayarlanmamış.');
    if (!client) {
      const url = config.supabaseUrl.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
      client = createClient(url, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        global: { fetch: boundedFetch }
      });
      client.auth.onAuthStateChange((_event, session) => { user = session?.user || null; });
    }
    return client;
  }
  async function backend({ recover = false, create = true } = {}) {
    if (!navigator.onLine) throw new Error('Çevrimdışısın. Cihazdaki kayıtların korunuyor.');
    const api = getClient();
    if (!authTask) {
      authTask = (async () => {
        const result = await api.auth.getSession();
        if (result.error) throw result.error;
        const session = result.data.session;
        user = session?.user || null;
        return user;
      })().finally(() => { authTask = null; });
    }
    let current = await deadline(authTask);
    if (!current && create) {
      if (!authTask) authTask = api.auth.signInAnonymously().then(signed => {
        if (signed.error) throw signed.error;
        user = signed.data.user; return user;
      }).finally(() => { authTask = null; });
      current = await deadline(authTask);
    }
    if (!current) return null;
    if (pair() && pair().userId !== current.id && !recover) {
      sessionLost = true;
      throw new Error('session_lost');
    }
    sessionLost = false;
    if (!apiReady) {
      const version = await api.rpc('su_version');
      if (version.error) throw version.error;
      apiReady = version.data === 5;
      if (!apiReady) throw new Error('su_version');
    }
    return api;
  }

  const engine = new SyncEngine(store, {
    async write(batch, currentPair) {
      const api = await backend();
      const result = await api.rpc('sync_water_changes', {
        p_room_id: currentPair.roomId,
        p_changes: batch.map(operation => ({
          kind: operation.kind, revision: operation.revision,
          client_id: operation.clientId || operation.entry.clientId,
          ...(operation.entry ? { amount: operation.entry.amount, recorded_at: new Date(operation.entry.createdAt).toISOString(), recorded_day: operation.entry.day } : {})
        }))
      });
      if (result.error) throw result.error;
      return result.data;
    },
    async profile(values, currentPair) {
      const api = await backend();
      const result = await api.from('profiles').update({ display_name: currentPair.displayName, daily_goal: values.goal, updated_at: new Date().toISOString() }).eq('user_id', currentPair.userId);
      if (result.error) throw result.error;
    }
  });

  async function sync() {
    clearTimeout(syncTimer);
    if (!pair() || !navigator.onLine || document.hidden) { renderSync(); return; }
    syncing = true; renderSync();
    try {
      await engine.run();
      syncMessage = ''; syncBackoff = 1500;
    } catch (error) {
      syncMessage = errorText(error);
      if (!sessionLost) {
        syncTimer = setTimeout(sync, syncBackoff);
        syncBackoff = Math.min(60000, syncBackoff * 2);
      }
    } finally { syncing = false; renderSync(); }
  }
  function requestSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 120); }
  function renderSync() {
    const pending = Object.keys(store.state.outbox).length;
    const element = $('sync-status');
    element.hidden = !pair() || (!pending && !syncMessage && !syncing && navigator.onLine);
    element.textContent = syncMessage || (!navigator.onLine ? 'Çevrimdışı · Kayıtlar bu cihazda' : syncing ? 'Eşitleniyor…' : pending + ' işlem eşitlenmeyi bekliyor');
    $('connection-dot').hidden = !pair();
    $('connection-dot').dataset.state = navigator.onLine && !syncMessage && !pending ? 'ready' : 'pending';
  }
  function applyTheme() {
    const theme = settings();
    const dark = theme.mode === 'dark' || (theme.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    Object.assign(document.documentElement.dataset, { palette: theme.palette, mode: theme.mode, resolved: dark ? 'dark' : 'light' });
    $('theme-color').content = background[theme.palette][dark ? 1 : 0];
  }
  function add(amount) {
    const id = store.add(amount);
    showToast(number(amount) + ' ml eklendi', () => { store.remove(id); requestSync(); });
    requestSync();
  }
  function remove(id) {
    const entry = store.remove(id);
    if (entry) showToast(number(entry.amount) + ' ml silindi', () => { store.restore(entry); requestSync(); });
    requestSync();
  }
  function renderList(container, entries) {
    if (!container.querySelector('.entry-list')) container.innerHTML = '<ul class="entry-list"></ul><p class="empty-log">Bu gün için kayıt yok.</p>';
    const list = container.querySelector('ul');
    container.querySelector('p').hidden = entries.length > 0;
    const existing = new Map(Array.from(list.children).map(element => [element.dataset.id, element]));
    const ids = new Set(entries.map(entry => entry.clientId));
    for (const [id, node] of existing) if (!ids.has(id)) node.remove();
    entries.forEach((entry, index) => {
      let node = existing.get(entry.clientId);
      if (!node) {
        node = document.createElement('li'); node.dataset.id = entry.clientId;
        node.innerHTML = '<time></time><span class="entry-rule" aria-hidden="true"></span><strong></strong><button class="delete-entry" type="button" aria-label="Kaydı sil"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg></button>';
      }
      node.querySelector('time').textContent = clockLabel(entry.createdAt);
      node.querySelector('time').dateTime = new Date(entry.createdAt).toISOString();
      node.querySelector('strong').textContent = number(entry.amount) + ' ml';
      node.querySelector('button').dataset.delete = entry.clientId;
      node.querySelector('button').ariaLabel = clockLabel(entry.createdAt) + ', ' + number(entry.amount) + ' ml kaydını sil';
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
    });
  }
  function renderWeek() {
    const today = store.today();
    const dates = Array.from({ length: 7 }, (_, i) => shiftDay(today, i - 6));
    if ($('week-chart').dataset.end !== today) {
      $('week-chart').dataset.end = today;
      $('week-chart').innerHTML = dates.map(day => '<button class="day-column" type="button" data-history-day="' + day + '"><span class="day-total"></span><span class="bar-track"><span class="bar-fill"></span></span><span class="day-label"></span></button>').join('');
    }
    Array.from($('week-chart').children).forEach((node, index) => {
      const day = dates[index], total = store.total(day);
      node.classList.toggle('is-today', day === today);
      node.querySelector('.day-total').textContent = total ? (total / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' L' : '0';
      node.querySelector('.bar-fill').style.height = Math.min(100, total / settings().goal * 100) + '%';
      node.querySelector('.day-label').textContent = new Intl.DateTimeFormat('tr-TR', { weekday: 'short' }).format(new Date(day + 'T12:00:00'));
      node.ariaLabel = dateLabel(day) + ', ' + number(total) + ' ml, kayıtları aç';
    });
  }
  function render() {
    const total = store.total(), goal = settings().goal, remaining = Math.max(0, goal - total);
    const percent = Math.min(100, Math.round(total / goal * 100));
    $('date-line').textContent = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    $('total-number').textContent = number(total);
    $('percentage').textContent = '%' + percent;
    $('status-line').textContent = remaining ? 'Hedefe ' + number(remaining) + ' ml kaldı' : 'Günlük hedef tamamlandı';
    $('half-goal').textContent = number(Math.round(goal / 2)); $('full-goal').textContent = number(goal) + ' ml';
    $('progress-fill').style.width = percent + '%'; $('water-progress').setAttribute('aria-valuenow', String(percent));
    for (const [key, amount] of Object.entries(settings().glasses)) $(key + '-amount').textContent = number(amount) + ' ml';
    const custom = settings().customAmount;
    changedHtml($('custom-slot'), custom
      ? '<button class="amount-button" type="button" data-custom-add><strong>' + number(custom) + '</strong><span>ml</span></button>'
      : '<button class="amount-button custom-empty" type="button" data-custom-new><strong>Özel</strong><span>ml gir</span></button>');
    $('custom-edit-link').hidden = !custom;
    const entries = store.entriesFor();
    $('record-count').textContent = entries.length ? entries.length + ' kayıt' : 'Bugün';
    renderList($('entry-content'), entries.slice(0, 5));
    $('all-records').textContent = entries.length > 5 ? 'Tüm kayıtlar (' + entries.length + ')' : 'Geçmişi aç';
    renderWeek(); renderSync();
    if ($('history-dialog').open) renderHistory();
    if ($('together-dialog').open) renderTogether();
  }
  function renderHistory() {
    $('history-date').value = historyDay; $('history-date').max = store.today();
    $('history-total').textContent = number(store.total(historyDay)) + ' ml';
    $('history-next').disabled = historyDay >= store.today();
    renderList($('history-entries'), store.entriesFor(historyDay));
  }
  function openHistory(day = store.today()) {
    historyDay = day; renderHistory(); openDialog($('history-dialog'));
    if (pair() && navigator.onLine) action(() => loadRange(day, day));
  }
  async function loadRange(from, to) {
    const api = await backend();
    await engine.run();
    const snapshotRevision = store.state.clock;
    const membership = await api.from('room_members').select('user_id,joined_at').eq('room_id', pair().roomId).order('joined_at');
    if (membership.error) throw membership.error;
    if (!membership.data.some(member => member.user_id === pair().userId)) throw new Error('Eşleşmeye erişilemiyor. Kurtarma kodunla geri dönebilirsin.');
    const profiles = await api.from('profiles').select('user_id,display_name,daily_goal,notifications_enabled').in('user_id', membership.data.map(m => m.user_id));
    if (profiles.error) throw profiles.error;
    const records = [];
    for (let offset = 0; ; offset += 500) {
      const result = await api.rpc('get_pair_entries', { p_from: from, p_to: to, p_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }).range(offset, offset + 499);
      if (result.error) throw result.error;
      records.push(...result.data);
      if (result.data.length < 500) break;
    }
    store.merge(profiles.data, records, from, to, snapshotRevision);
  }
  async function refreshTogether() {
    if (refreshTask || !pair() || !navigator.onLine || document.hidden) { renderTogether(); return; }
    const end = historyEnd;
    refreshMessage = ''; renderTogether();
    refreshTask = (async () => { await loadRange(shiftDay(end, -6), end); if (end !== store.today()) await loadRange(store.today(), store.today()); })();
    try { await refreshTask; }
    catch (error) { refreshMessage = errorText(error); }
    finally {
      refreshTask = null; renderTogether();
      if (end !== historyEnd && $('together-dialog').open) refreshTogether();
    }
  }
  function setupHtml() {
    return '<section class="sheet-section pair-setup"><h3>İsmini yaz ve eşleş</h3><label class="sheet-field"><span>Senin adın</span><input id="pair-name" autocomplete="name" maxlength="30"></label><button class="primary-action" type="button" data-pair-action="create">Davet kodu oluştur</button><div class="or-divider"><span>veya</span></div><label class="sheet-field"><span>Davet kodu</span><input id="pair-code" class="code-input" autocapitalize="characters" autocomplete="off" maxlength="14" placeholder="ABCD-EFGH-IJKL"></label><button class="secondary-action" type="button" data-pair-action="join">Davet koduna katıl</button></section>' + recoveryInput();
  }
  function recoveryInput() {
    return '<details class="recovery-section"><summary>Eşleşmemi geri getir</summary><label class="sheet-field"><span>Kurtarma kodu</span><textarea id="restore-code" rows="3" autocomplete="off" autocapitalize="characters" spellcheck="false"></textarea></label><p class="sheet-note">Kendi kurtarma kodunu kullan. Aktarım tamamlandığında eski cihazın bağlantısı kapanır.</p><button class="secondary-action wide-action" type="button" data-pair-action="restore">Bu cihaza aktar</button></details>';
  }
  function renderTogether() {
    if (!pair()) {
      if ($('together-content').dataset.frame !== 'setup') { $('together-content').dataset.frame = 'setup'; $('together-content').innerHTML = setupHtml(); }
      return;
    }
    const members = store.state.shared.members;
    const me = members.find(m => m.user_id === pair().userId);
    const partner = members.find(m => m.user_id !== pair().userId);
    const key = pair().roomId + ':' + (partner?.user_id || 'waiting') + ':' + sessionLost;
    if ($('together-content').dataset.frame !== key) {
      $('together-content').dataset.frame = key;
      $('together-content').innerHTML = [
        '<section class="sheet-section"><div class="people-totals"><div><span id="my-name"></span><strong id="my-total"></strong></div><div><span id="partner-name"></span><strong id="partner-total"></strong></div></div>',
        '<p id="shared-status" class="sheet-note" role="status"></p>',
        '<details class="invite-details"' + (partner ? '' : ' open') + '><summary>Davet kodu</summary><div class="invite-line"><strong>' + escape(pair().inviteCode.match(/.{1,4}/g)?.join('-') || pair().inviteCode) + '</strong><button class="text-action" type="button" data-pair-action="copy">Kopyala</button></div></details></section>',
        '<section class="sheet-section"><div data-device-controls></div><button id="remind-button" class="primary-action wide-action" type="button" data-pair-action="remind">Hatırlat</button><p id="reminder-status" class="sheet-note" role="status"></p></section>',
        '<section class="sheet-section"><div class="section-heading"><h3>Geçmiş · ml</h3><button class="text-action" type="button" data-pair-action="refresh">Yenile</button></div>',
        '<div class="history-nav"><button type="button" data-range="-7" aria-label="Önceki hafta">‹</button><label><span class="sr-only">Son gün</span><input id="pair-history-date" type="date"></label><button id="pair-next" type="button" data-range="7" aria-label="Sonraki hafta">›</button></div><p id="history-range" class="sheet-note"></p>',
        '<div class="table-wrap"><table class="pair-table"><thead><tr><th scope="col">Gün</th><th scope="col" id="table-me"></th><th scope="col" id="table-partner"></th></tr></thead><tbody id="pair-rows"></tbody></table></div></section>',
        sessionLost ? recoveryInput() : ''
      ].join('');
    }
    $('my-name').textContent = me?.display_name || pair().displayName;
    $('partner-name').textContent = partner?.display_name || 'Diğer kişi';
    $('my-total').textContent = number(store.total()) + ' ml';
    const total = day => store.state.shared.entries.filter(e => e.user_id === partner?.user_id && e.day === day).reduce((sum, e) => sum + e.amount, 0);
    const loaded = day => Boolean(store.state.shared.loadedDays?.[day]);
    $('partner-total').textContent = partner && loaded(store.today()) ? number(total(store.today())) + ' ml' : '—';
    const updated = store.state.shared.loadedDays?.[store.today()];
    $('shared-status').textContent = refreshMessage || (!navigator.onLine ? 'Çevrimdışı · ' : refreshTask ? 'Güncelleniyor · ' : '') + (updated ? 'Son güncelleme ' + dateLabel(dayKey(new Date(updated))) + ' ' + clockLabel(updated) : 'Eşleşme bilgileri henüz alınmadı.');
    $('table-me').textContent = pair().displayName; $('table-partner').textContent = partner?.display_name || 'Diğer kişi';
    $('pair-history-date').value = historyEnd; $('pair-history-date').max = store.today();
    $('pair-next').disabled = historyEnd >= store.today();
    $('history-range').textContent = dateLabel(shiftDay(historyEnd, -6)) + ' – ' + dateLabel(historyEnd);
    changedHtml($('pair-rows'), Array.from({ length: 7 }, (_, i) => shiftDay(historyEnd, -i)).map(day =>
      '<tr><th scope="row">' + (day === store.today() ? 'Bugün' : dateLabel(day)) + '</th><td>' + number(store.total(day)) + '</td><td>' + (partner && loaded(day) ? number(total(day)) : '—') + '</td></tr>').join(''));
    renderDeviceControls();
    const cooling = Date.now() < nextReminderAt;
    $('remind-button').disabled = !partner || !navigator.onLine || reminderBusy || cooling || sessionLost;
    $('remind-button').textContent = reminderBusy ? 'İstek kaydediliyor…' : cooling ? 'Birazdan tekrar hatırlatabilirsin' : (partner?.display_name || 'Diğer kişi') + ' kişisine hatırlat';
    $('reminder-status').textContent = jobLabel(lastJob);
  }
  function jobLabel(job) {
    if (!job) return '';
    if (job.status === 'sent') return 'Bildirim gönderim servisine iletildi.';
    if (job.status === 'failed') return job.error === 'no_active_subscription' ? 'Gönderilemedi. Diğer kişi bu cihazda bildirimleri yeniden açmalı.' : job.error === 'expired' ? 'Gönderim süresi doldu.' : 'Bildirim gönderilemedi. Biraz sonra tekrar deneyebilirsin.';
    if (job.status === 'retry') return 'Gönderim aksadı. Otomatik tekrar denenecek.';
    return 'Bildirim gönderilmeyi bekliyor…';
  }
  async function pairAction(kind) {
    if (pairBusy) return;
    const name = $('pair-name')?.value.trim().replace(/\s+/g, ' ');
    const code = $('pair-code')?.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const restore = $('restore-code')?.value;
    if (kind !== 'restore' && (!name || name.length > 30)) throw new Error('İsmini yaz. En fazla 30 karakter kullan.');
    if (kind === 'join' && code?.length !== 12) throw new Error('12 karakterli davet kodunu gir.');
    pairBusy = true;
    document.querySelectorAll('[data-pair-action="create"],[data-pair-action="join"],[data-pair-action="restore"]').forEach(button => { button.disabled = true; });
    try {
      const api = await backend({ recover: kind === 'restore' });
      const result = kind === 'restore'
        ? await api.rpc('recover_pair', { p_code: restore })
        : await api.rpc(kind === 'create' ? 'create_pair' : 'join_pair', { p_display_name: name, ...(kind === 'join' ? { p_invite_code: code } : {}) });
      if (result.error) throw result.error;
      const row = result.data?.[0];
      if (!row) throw new Error('Eşleşme tamamlanamadı.');
      store.pair({ roomId: row.room_id, inviteCode: row.invite_code, userId: user.id, displayName: row.display_name || name });
      if (kind === 'restore') store.settings({ goal: row.daily_goal });
      sessionLost = false;
      renderTogether(); requestSync();
      await refreshTogether(); await inspectDevice();
    } finally {
      pairBusy = false;
      document.querySelectorAll('[data-pair-action="create"],[data-pair-action="join"],[data-pair-action="restore"]').forEach(button => { button.disabled = false; });
    }
  }
  function isIos() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function deviceCapability() {
    if (isIos() && !standalone()) return 'install';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    return null;
  }
  function keyBytes(key) { return Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(key.length / 4) * 4, '=')), c => c.charCodeAt(0)); }
  async function registerSubscription(api, subscription) {
    const data = subscription.toJSON();
    if (!data.keys?.auth || !data.keys?.p256dh) throw new Error('Bildirim aboneliği okunamadı.');
    const result = await api.from('push_subscriptions').upsert({ user_id: pair().userId, endpoint: subscription.endpoint, auth: data.keys.auth, p256dh: data.keys.p256dh, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
    if (result.error) throw result.error;
  }
  function inspectDevice() {
    if (deviceTask) return deviceTask;
    deviceTask = (async () => {
      const capability = deviceCapability();
      if (capability) { deviceState = capability; return; }
      if (Notification.permission === 'denied') { deviceState = 'denied'; return; }
      if (Notification.permission !== 'granted' || store.state.notificationsWanted === false) { deviceState = 'off'; return; }
      try {
        const registration = await deadline(navigator.serviceWorker.ready, 5000);
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription) { deviceState = 'repair'; return; }
        const actualKey = subscription.options?.applicationServerKey;
        if (config.vapidPublicKey && actualKey && String(new Uint8Array(actualKey)) !== String(keyBytes(config.vapidPublicKey))) { deviceState = 'repair'; return; }
        if (!navigator.onLine || !pair()) { deviceState = 'unverified'; return; }
        const api = await backend();
        // Refresh an existing, already-authorized device subscription.
        await registerSubscription(api, subscription);
        deviceState = 'on';
      } catch { deviceState = 'unverified'; }
    })().finally(() => { deviceTask = null; renderDeviceControls(); });
    return deviceTask;
  }
  function renderDeviceControls() {
    const labels = { checking: 'Bildirim durumu kontrol ediliyor…', on: 'Bu cihazda bildirimler açık', off: 'Bu cihazda bildirimler kapalı', repair: 'Bildirim aboneliği yenilenmeli', unverified: 'Cihaz izni açık · Bağlantı doğrulanamadı', denied: 'Bildirim izni kapalı. Telefon ayarlarından Su bildirimlerine izin ver.', install: 'Bildirimler için Paylaş → Ana Ekrana Ekle ile uygulamayı kur.', unsupported: 'Bu tarayıcı bildirimleri desteklemiyor.' };
    const unavailable = ['denied','install','unsupported'].includes(deviceState);
    const enabled = deviceState === 'on';
    const html = '<p class="notification-ready" role="status">' + escape(deviceNote || labels[deviceState]) + '</p>' +
      (!unavailable ? '<button class="secondary-action wide-action" type="button" data-notifications="' + (enabled ? 'off' : 'on') + '"' + (deviceBusy || !navigator.onLine || !pair() ? ' disabled' : '') + '>' + (deviceBusy ? 'İşleniyor…' : enabled ? 'Bu cihazda kapat' : ['repair','unverified'].includes(deviceState) ? 'Bildirim bağlantısını yenile' : 'Bu cihazda bildirimleri aç') + '</button>' : '');
    document.querySelectorAll('[data-device-controls]').forEach(element => changedHtml(element, html));
  }
  async function notifications(enable) {
    if (deviceBusy) return;
    if (!pair()) throw new Error('Önce Birlikte bölümünden eşleş.');
    const capability = deviceCapability();
    if (capability) { deviceState = capability; renderDeviceControls(); return; }
    deviceBusy = true; deviceNote = ''; renderDeviceControls();
    try {
      // Permission is requested directly from the user's tap, before network awaits.
      if (enable && await Notification.requestPermission() !== 'granted') throw new Error('Bildirim izni verilmedi.');
      const api = await backend();
      const registration = await deadline(navigator.serviceWorker.ready, 6000);
      let subscription = await registration.pushManager.getSubscription();
      if (enable) {
        if (!config.vapidPublicKey) throw new Error('Bildirim kurulumu tamamlanmamış.');
        const wantedKey = keyBytes(config.vapidPublicKey);
        if (subscription?.options.applicationServerKey && String(new Uint8Array(subscription.options.applicationServerKey)) !== String(wantedKey)) {
          const removed = await api.from('push_subscriptions').delete().eq('user_id', pair().userId).eq('endpoint', subscription.endpoint);
          if (removed.error) throw removed.error;
          await subscription.unsubscribe(); subscription = null;
        }
        subscription ||= await deadline(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wantedKey }), 10000);
        await registerSubscription(api, subscription);
      } else if (subscription) {
        const result = await api.from('push_subscriptions').delete().eq('user_id', pair().userId).eq('endpoint', subscription.endpoint);
        if (result.error) throw result.error;
        await subscription.unsubscribe();
      }
      store.commit(state => { state.notificationsWanted = enable; });
      deviceState = enable ? 'on' : 'off';
    } catch (error) { deviceNote = errorText(error); }
    finally { deviceBusy = false; renderDeviceControls(); }
  }
  async function sendReminder() {
    if (reminderBusy || Date.now() < nextReminderAt) return;
    const partner = store.state.shared.members.find(member => member.user_id !== pair()?.userId);
    if (!partner) throw new Error('Diğer kişi henüz eşleşmeye katılmadı.');
    reminderBusy = true; renderTogether();
    try {
      const api = await backend();
      const result = await api.from('notification_jobs').insert({ room_id: pair().roomId, sender_user_id: pair().userId, recipient_user_id: partner.user_id, kind: 'drink_water' }).select('id,status,error,created_at').single();
      if (result.error) throw result.error;
      lastJob = result.data; nextReminderAt = Date.now() + 30000;
      store.commit(state => { state.lastJob = lastJob; });
      pollJob();
    } finally { reminderBusy = false; renderTogether(); }
  }
  async function pollJob() {
    clearTimeout(jobTimer);
    if (!lastJob || ['sent','failed'].includes(lastJob.status) || !navigator.onLine || document.hidden) return;
    try {
      const api = await backend();
      const result = await api.from('notification_jobs').select('id,status,error,created_at').eq('id', lastJob.id).maybeSingle();
      if (result.error) throw result.error;
      if (result.data) { lastJob = result.data; store.commit(state => { state.lastJob = lastJob; }); }
    } catch { /* Keep the last known state; never report unconfirmed success. */ }
    finally {
      if ($('together-dialog').open) renderTogether();
      if (lastJob && !['sent','failed'].includes(lastJob.status)) jobTimer = setTimeout(pollJob, lastJob.status === 'retry' ? 30000 : 4000);
    }
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); showToast('Kopyalandı'); }
    catch { showToast('Metne basılı tutarak kopyalayabilirsin.'); }
  }
  async function createRecovery() {
    const button = $('generate-recovery'); button.disabled = true;
    try {
      const api = await backend();
      const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const result = await api.rpc('set_recovery_code', { p_hash: hash });
      if (result.error) throw result.error;
      recoveryCode = raw.match(/.{1,8}/g).join('-');
      $('recovery-code').value = recoveryCode; $('recovery-result').hidden = false;
      button.textContent = 'Yeni kod oluştur';
    } finally { button.disabled = false; }
  }
  function openSettings() {
    for (const [key, value] of Object.entries(settings().glasses)) $(key + '-input').value = value;
    $('goal-input').value = settings().goal;
    document.querySelector('input[name="palette"][value="' + settings().palette + '"]').checked = true;
    document.querySelector('input[name="mode"][value="' + settings().mode + '"]').checked = true;
    $('settings-error').textContent = ''; openDialog($('settings-dialog'));
    $('recovery-open').hidden = !pair();
    renderDeviceControls(); inspectDevice(); renderUpdate();
  }
  function renderUpdate() {
    $('update-app').hidden = !window.SU_REGISTRATION?.waiting;
    $('offline-status').textContent = window.SU_OFFLINE_FAILED ? 'Çevrimdışı dosyalar yüklenemedi. Bağlantıyla yeniden aç.' : navigator.serviceWorker?.controller ? 'Çevrimdışı açılış hazır' : 'Çevrimdışı dosyalar hazırlanıyor…';
  }
  function openTogether() {
    renderTogether(); openDialog($('together-dialog'));
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden) { refreshTogether(); pollJob(); } }, 30000);
    if (pair()) { refreshTogether(); inspectDevice(); pollJob(); }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    action(async () => {
      if (button.dataset.amount) add(Number(button.dataset.amount));
      else if (button.dataset.glass) add(settings().glasses[button.dataset.glass]);
      else if (button.hasAttribute('data-custom-add')) add(settings().customAmount);
      else if (button.hasAttribute('data-custom-new') || button.hasAttribute('data-custom-edit')) {
        $('custom-form').dataset.add = button.hasAttribute('data-custom-new') ? 'yes' : 'no';
        $('custom-input').value = settings().customAmount || '';
        $('custom-save').textContent = button.hasAttribute('data-custom-new') ? 'Kaydet ve ekle' : 'Kaydet';
        $('custom-error').textContent = ''; openDialog($('custom-dialog')); $('custom-input').focus({ preventScroll: true });
      } else if (button.dataset.delete) remove(button.dataset.delete);
      else if (button.dataset.close) closeDialog($(button.dataset.close));
      else if (button.dataset.historyDay) openHistory(button.dataset.historyDay);
      else if (button.dataset.notifications) await notifications(button.dataset.notifications === 'on');
      else if (button.dataset.range) { historyEnd = [shiftDay(historyEnd, Number(button.dataset.range)), store.today()].sort()[0]; renderTogether(); refreshTogether(); }
      else if (button.dataset.pairAction) {
        const kind = button.dataset.pairAction;
        if (['create','join','restore'].includes(kind)) await pairAction(kind);
        else if (kind === 'copy') await copy(pair().inviteCode);
        else if (kind === 'refresh') await refreshTogether();
        else if (kind === 'remind') await sendReminder();
      }
    });
  });
  $('toast-action').addEventListener('click', () => action(() => { const undo = toastUndo; toastUndo = null; $('toast').hidden = true; if (undo) undo(); }));
  $('settings-button').addEventListener('click', openSettings);
  $('together-button').addEventListener('click', openTogether);
  $('all-records').addEventListener('click', () => openHistory());
  $('history-previous').addEventListener('click', () => openHistory(shiftDay(historyDay, -1)));
  $('history-next').addEventListener('click', () => { if (historyDay < store.today()) openHistory(shiftDay(historyDay, 1)); });
  $('history-date').addEventListener('change', event => { if (/^\d{4}-\d\d-\d\d$/.test(event.target.value) && event.target.value <= store.today()) openHistory(event.target.value); });
  document.addEventListener('change', event => {
    if (event.target.id === 'pair-history-date' && /^\d{4}-\d\d-\d\d$/.test(event.target.value) && event.target.value <= store.today()) {
      historyEnd = event.target.value; renderTogether(); refreshTogether();
    }
  });
  $('custom-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const amount = amountValue($('custom-input').value, 1, 3000);
      store.settings({ customAmount: amount });
      if ($('custom-form').dataset.add === 'yes') add(amount); else showToast('Özel miktar kaydedildi');
      closeDialog($('custom-dialog')); requestSync();
    } catch (error) { $('custom-error').textContent = errorText(error); }
  });
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const goal = amountValue($('goal-input').value, 500, 6000);
      const glasses = Object.fromEntries(['small','medium','large'].map(key => [key, amountValue($(key + '-input').value, 50, 1500)]));
      store.settings({ goal, glasses, palette: document.querySelector('input[name="palette"]:checked').value, mode: document.querySelector('input[name="mode"]:checked').value });
      applyTheme(); closeDialog($('settings-dialog')); requestSync(); showToast('Ayarlar kaydedildi');
    } catch (error) { $('settings-error').textContent = errorText(error); }
  });
  $('recovery-open').addEventListener('click', () => { $('recovery-result').hidden = true; openDialog($('recovery-dialog')); });
  $('generate-recovery').addEventListener('click', () => action(createRecovery));
  $('copy-recovery').addEventListener('click', () => action(() => copy(recoveryCode)));
  $('update-app').addEventListener('click', () => {
    window.SU_APPLY_UPDATE = true; window.SU_REGISTRATION?.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog); });
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeDialog(dialog);
    });
    dialog.addEventListener('close', () => {
      if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('modal-open');
      if (dialog.id === 'together-dialog') clearInterval(refreshTimer);
      if (dialog.id === 'recovery-dialog') { recoveryCode = ''; $('recovery-code').value = ''; }
    });
  });
  const wake = () => {
    if (document.hidden) { clearTimeout(syncTimer); clearTimeout(jobTimer); return; }
    const today = store.today();
    if (lastDay !== today) {
      if (historyEnd === lastDay) historyEnd = today;
      if (historyDay === lastDay) historyDay = today;
      lastDay = today;
    }
    render(); requestSync();
    if ($('together-dialog').open) refreshTogether();
    if (pair()) { inspectDevice(); pollJob(); }
  };
  window.addEventListener('online', wake);
  window.addEventListener('offline', () => { render(); renderDeviceControls(); });
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('su-update', renderUpdate);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  setInterval(() => {
    if (document.hidden) return;
    if (lastDay !== store.today()) wake();
    if (nextReminderAt && Date.now() >= nextReminderAt) { nextReminderAt = 0; if ($('together-dialog').open) renderTogether(); }
  }, 1000);
  const viewport = () => { if (!window.visualViewport || window.visualViewport.scale === 1) document.documentElement.style.setProperty('--visible-height', (window.visualViewport?.height || innerHeight) + 'px'); };
  window.visualViewport?.addEventListener('resize', viewport); viewport();
  store.subscribe(render);
  lastJob = store.state.lastJob || null;
  applyTheme(); render(); window.SU_READY = true; $('startup-status').hidden = true;
  if (pair()) { requestSync(); inspectDevice(); }
  else if (navigator.onLine && config.supabaseUrl) action(async () => {
    const api = await backend({ create: false });
    if (!api) return;
    const result = await api.rpc('current_pair');
    if (result.error) throw result.error;
    const row = result.data?.[0];
    if (row) {
      store.pair({ roomId: row.room_id, inviteCode: row.invite_code, userId: row.user_id, displayName: row.display_name });
      store.settings({ goal: row.daily_goal }); requestSync();
      await loadRange(shiftDay(store.today(), -6), store.today());
    }
  });
  if (new URLSearchParams(location.search).get('birlikte') === '1') { history.replaceState({}, '', location.pathname); openTogether(); }
}
main();
