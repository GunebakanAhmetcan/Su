import { createClient } from "@supabase/supabase-js";

(function () {
  "use strict";

  const SETTINGS_KEY = "su:settings:v1";
  const ENTRIES_KEY = "su:entries:v1";
  const PAIR_KEY = "su:pair:v1";
  const DELETE_QUEUE_KEY = "su:delete-queue:v1";
  const config = window.SU_CONFIG || {};

  const defaultSettings = {
    goal: 2500,
    glasses: { small: 200, medium: 300, large: 400 },
    customAmount: null,
    palette: "ocean",
    mode: "system"
  };
  const allowedPalettes = ["ocean", "olive", "sand", "white"];
  const allowedModes = ["system", "light", "dark"];
  const themeBackgrounds = {
    ocean: { light: "#f2f1eb", dark: "#0d1112" },
    olive: { light: "#f3f1e7", dark: "#11140f" },
    sand: { light: "#f4eee4", dark: "#17130f" },
    white: { light: "#ffffff", dark: "#101314" }
  };

  let today = dayKey(new Date());
  let settings = loadSettings();
  let entryStore = loadEntries();
  let pairState = loadJson(PAIR_KEY, null);
  let deleteQueue = loadJson(DELETE_QUEUE_KEY, []);
  let supabase = null;
  let authUser = null;
  let sharedMembers = [];
  let sharedEntries = [];
  let syncInFlight = false;
  let toastTimer = null;
  let togetherRefreshTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function loadJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      return parsed === null ? fallback : parsed;
    } catch (_error) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function dayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function safeNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function loadSettings() {
    const parsed = loadJson(SETTINGS_KEY, null);
    if (!parsed) return structuredClone(defaultSettings);
    return {
      goal: safeNumber(parsed.goal, defaultSettings.goal, 500, 6000),
      glasses: {
        small: safeNumber(parsed.glasses && parsed.glasses.small, defaultSettings.glasses.small, 50, 1500),
        medium: safeNumber(parsed.glasses && parsed.glasses.medium, defaultSettings.glasses.medium, 50, 1500),
        large: safeNumber(parsed.glasses && parsed.glasses.large, defaultSettings.glasses.large, 50, 1500)
      },
      customAmount: parsed.customAmount ? safeNumber(parsed.customAmount, null, 50, 3000) : null,
      palette: allowedPalettes.includes(parsed.palette) ? parsed.palette : defaultSettings.palette,
      mode: allowedModes.includes(parsed.mode) ? parsed.mode : defaultSettings.mode
    };
  }

  function loadEntries() {
    const parsed = loadJson(ENTRIES_KEY, {});
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    Object.keys(parsed).forEach(function (key) {
      if (!Array.isArray(parsed[key])) {
        parsed[key] = [];
        return;
      }
      parsed[key] = parsed[key]
        .filter(function (entry) {
          return entry && Number(entry.amount) > 0 && Number(entry.createdAt) > 0;
        })
        .map(function (entry) {
          const localId = String(entry.clientId || entry.id || makeId());
          return {
            id: localId,
            clientId: localId,
            remoteId: entry.remoteId || null,
            amount: safeNumber(entry.amount, 250, 1, 10000),
            createdAt: Number(entry.createdAt),
            synced: Boolean(entry.synced)
          };
        });
    });
    return parsed;
  }

  function saveSettings() {
    saveJson(SETTINGS_KEY, settings);
  }

  function saveEntries() {
    saveJson(ENTRIES_KEY, entryStore);
  }

  function savePair() {
    saveJson(PAIR_KEY, pairState);
    renderConnectionDot();
  }

  function saveDeleteQueue() {
    saveJson(DELETE_QUEUE_KEY, deleteQueue);
  }

  function applyTheme() {
    document.documentElement.dataset.palette = settings.palette;
    document.documentElement.dataset.mode = settings.mode;
    const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = settings.mode === "dark" || (settings.mode === "system" && systemIsDark);
    document.documentElement.dataset.resolved = dark ? "dark" : "light";
    byId("theme-color").setAttribute("content", themeBackgrounds[settings.palette][dark ? "dark" : "light"]);
  }

  function entriesForToday() {
    return entryStore[today] || [];
  }

  function totalFor(entries) {
    return (entries || []).reduce(function (sum, entry) {
      return sum + Number(entry.amount || 0);
    }, 0);
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function addAmount(amount) {
    const id = makeId();
    const entry = {
      id: id,
      clientId: id,
      remoteId: null,
      amount: amount,
      createdAt: Date.now(),
      synced: false
    };
    entryStore[today] = [entry].concat(entriesForToday());
    saveEntries();
    render();
    showToast(amount + " ml eklendi", function () {
      removeEntry(entry.id);
    });
    if (pairState && navigator.onLine) syncAll().catch(function () {});
  }

  function findEntry(id) {
    for (const key of Object.keys(entryStore)) {
      const entry = (entryStore[key] || []).find(function (item) {
        return item.id === id;
      });
      if (entry) return entry;
    }
    return null;
  }

  function removeEntry(id) {
    const entry = findEntry(id);
    entryStore[today] = entriesForToday().filter(function (item) {
      return item.id !== id;
    });
    if (entry && pairState && (entry.remoteId || entry.synced)) {
      deleteQueue.push({ clientId: entry.clientId, remoteId: entry.remoteId || null });
      saveDeleteQueue();
    }
    saveEntries();
    render();
    if (pairState && navigator.onLine) syncAll().catch(function () {});
  }

  function showToast(message, undoAction) {
    const toast = byId("toast");
    const action = byId("toast-action");
    clearTimeout(toastTimer);
    byId("toast-message").textContent = message;
    action.hidden = !undoAction;
    action.onclick = function () {
      if (undoAction) undoAction();
      toast.hidden = true;
      clearTimeout(toastTimer);
    };
    toast.hidden = false;
    toastTimer = window.setTimeout(function () {
      toast.hidden = true;
    }, 4500);
  }

  function renderDate() {
    const text = new Intl.DateTimeFormat("tr-TR", {
      weekday: "long",
      day: "numeric",
      month: "long"
    }).format(new Date());
    byId("date-line").textContent = text.charAt(0).toUpperCase() + text.slice(1);
  }

  function renderMeter() {
    const total = totalFor(entriesForToday());
    const percentage = Math.min(100, Math.round((total / settings.goal) * 100));
    const remaining = Math.max(0, settings.goal - total);
    byId("total-number").textContent = total.toLocaleString("tr-TR");
    byId("percentage").textContent = "%" + percentage;
    byId("status-line").textContent =
      total >= settings.goal
        ? "Günlük hedef tamamlandı"
        : "Hedefe " + remaining.toLocaleString("tr-TR") + " ml kaldı";
    byId("half-goal").textContent = Math.round(settings.goal / 2).toLocaleString("tr-TR");
    byId("full-goal").textContent = settings.goal.toLocaleString("tr-TR") + " ml";
    byId("progress-fill").style.width = percentage + "%";
    byId("water-progress").setAttribute("aria-valuenow", String(percentage));
  }

  function renderGlassAmounts() {
    byId("small-amount").textContent = settings.glasses.small + " ml";
    byId("medium-amount").textContent = settings.glasses.medium + " ml";
    byId("large-amount").textContent = settings.glasses.large + " ml";
  }

  function renderCustomAmount() {
    const slot = byId("custom-slot");
    if (settings.customAmount) {
      slot.innerHTML =
        '<div class="saved-amount">' +
          '<button class="amount-button saved-value" type="button" data-custom-add>' +
            "<strong>" + settings.customAmount + "</strong><span>ml</span>" +
          "</button>" +
          '<button class="edit-amount" type="button" data-custom-edit aria-label="Kayıtlı özel miktarı değiştir">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z"/><path d="m14.5 7.1 2.8 2.8"/></svg>' +
          "</button>" +
        "</div>";
    } else {
      slot.innerHTML =
        '<button class="amount-button custom-empty" type="button" data-custom-edit>' +
          "<strong>Özel</strong><span>kaydet</span>" +
        "</button>";
    }
  }

  function renderEntries() {
    const entries = entriesForToday();
    byId("record-count").textContent = entries.length ? entries.length + " ekleme" : "Bugün";
    if (!entries.length) {
      byId("entry-content").innerHTML = '<p class="empty-log">İlk bardağını yukarıdan ekleyebilirsin.</p>';
      return;
    }

    const items = entries.slice(0, 5).map(function (entry) {
      const time = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" }).format(entry.createdAt);
      return (
        "<li>" +
          "<time>" + time + "</time>" +
          '<span class="entry-rule" aria-hidden="true"></span>' +
          "<strong>" + entry.amount + " ml</strong>" +
          '<button class="delete-entry" type="button" data-delete="' + escapeHtml(entry.id) + '" aria-label="' + entry.amount + ' mililitrelik kaydı sil">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>' +
          "</button>" +
        "</li>"
      );
    }).join("");
    byId("entry-content").innerHTML = '<ul class="entry-list">' + items + "</ul>";
  }

  function lastSevenDays() {
    const days = [];
    for (let index = 6; index >= 0; index -= 1) {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - index);
      days.push({ date: date, key: dayKey(date) });
    }
    return days;
  }

  function renderWeek() {
    const html = lastSevenDays().map(function (day) {
      const total = totalFor(entryStore[day.key]);
      const height = Math.max(5, Math.min(100, (total / settings.goal) * 100));
      const label = new Intl.DateTimeFormat("tr-TR", { weekday: "narrow" }).format(day.date);
      const totalLabel = total ? (total / 1000).toFixed(1) + "L" : "—";
      return (
        '<div class="day-column' + (day.key === today ? " is-today" : "") + '">' +
          '<span class="day-total">' + totalLabel + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="height:' + height + '%"></span></span>' +
          '<span class="day-label">' + label + "</span>" +
        "</div>"
      );
    });
    byId("week-chart").innerHTML = html.join("");
  }

  function renderConnectionDot() {
    byId("connection-dot").hidden = !pairState;
  }

  function render() {
    renderDate();
    renderMeter();
    renderGlassAmounts();
    renderCustomAmount();
    renderEntries();
    renderWeek();
    renderConnectionDot();
  }

  function openCustomDialog() {
    byId("custom-input").value = settings.customAmount || "";
    byId("custom-dialog").showModal();
    window.setTimeout(function () {
      byId("custom-input").focus();
    }, 50);
  }

  function openSettingsDialog() {
    byId("goal-input").value = settings.goal;
    byId("small-input").value = settings.glasses.small;
    byId("medium-input").value = settings.glasses.medium;
    byId("large-input").value = settings.glasses.large;
    document.querySelector('input[name="palette"][value="' + settings.palette + '"]').checked = true;
    document.querySelector('input[name="mode"][value="' + settings.mode + '"]').checked = true;
    byId("settings-dialog").showModal();
  }

  function backendConfigured() {
    return Boolean(config.supabaseUrl && config.supabaseAnonKey);
  }

  async function ensureBackend() {
    if (!backendConfigured()) throw new Error("Ortak kullanım bağlantısı henüz ayarlanmadı.");
    if (!supabase) {
      supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
    }
    if (!authUser) {
      const sessionResult = await supabase.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      let session = sessionResult.data.session;
      if (!session) {
        const signInResult = await supabase.auth.signInAnonymously();
        if (signInResult.error) throw signInResult.error;
        session = signInResult.data.session;
      }
      if (!session || !session.user) throw new Error("Anonim oturum başlatılamadı.");
      authUser = session.user;
    }
    if (pairState && pairState.userId && pairState.userId !== authUser.id) {
      throw new Error("Bu cihazdaki eşleşme oturumu değişmiş. Tarayıcı verilerini silmeden tekrar dene.");
    }
    return supabase;
  }

  function formatInvite(code) {
    return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase().match(/.{1,4}/g)?.join("-") || "";
  }

  function normalizeInvite(code) {
    return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 12);
  }

  function cleanName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 30);
  }

  function pairErrorMessage(error) {
    const message = String((error && error.message) || error || "");
    if (/anonymous|anonim|signups/i.test(message)) return "Supabase ayarlarında anonim girişleri açmalısın.";
    if (/Davet kodu bulunamadı/i.test(message)) return "Davet kodu bulunamadı.";
    if (/iki kişi/i.test(message)) return "Bu eşleşmede iki kişi zaten var.";
    if (/fetch|network|Failed to fetch/i.test(message)) return "Bağlantı kurulamadı. İnterneti kontrol edip tekrar dene.";
    return message || "İşlem tamamlanamadı.";
  }

  function renderTogetherSetup(message) {
    const content = byId("together-content");
    if (!backendConfigured()) {
      content.innerHTML =
        '<section class="sheet-section">' +
          '<p class="sheet-kicker">Kurulum gerekli</p>' +
          '<h3>Ortak kullanım henüz bağlı değil</h3>' +
          '<p class="sheet-note">ZIP içindeki KURULUM.md adımlarını tamamladığında bu bölüm açılır.</p>' +
        "</section>";
      return;
    }
    content.innerHTML =
      '<section class="sheet-section pair-setup">' +
        '<p class="sheet-kicker">İki kişi</p>' +
        '<h3>İsmini yaz ve eşleş</h3>' +
        '<label class="sheet-field"><span>Senin adın</span><input id="pair-name" autocomplete="name" maxlength="30" placeholder="İsmin" value="' + escapeHtml(pairState?.displayName || "") + '" /></label>' +
        '<button class="primary-action wide-action" type="button" data-pair-action="create">Yeni eşleşme oluştur</button>' +
        '<div class="or-divider"><span>veya</span></div>' +
        '<label class="sheet-field"><span>Davet kodu</span><input id="pair-code" class="code-input" autocapitalize="characters" autocomplete="off" maxlength="14" placeholder="ABCD-EFGH-IJKL" /></label>' +
        '<button class="secondary-action wide-action" type="button" data-pair-action="join">Koda katıl</button>' +
        (message ? '<p class="inline-error" role="alert">' + escapeHtml(message) + "</p>" : "") +
      "</section>";
  }

  function totalsByUserAndDay() {
    const totals = {};
    sharedEntries.forEach(function (entry) {
      const key = dayKey(new Date(entry.recorded_at));
      totals[entry.user_id] ||= {};
      totals[entry.user_id][key] = (totals[entry.user_id][key] || 0) + Number(entry.amount || 0);
    });
    return totals;
  }

  function memberById(userId) {
    return sharedMembers.find(function (member) {
      return member.user_id === userId;
    });
  }

  function renderTogetherPaired(message) {
    const content = byId("together-content");
    const me = memberById(authUser?.id) || {
      user_id: authUser?.id,
      display_name: pairState.displayName || "Sen",
      daily_goal: settings.goal,
      notifications_enabled: false
    };
    const partner = sharedMembers.find(function (member) {
      return member.user_id !== authUser?.id;
    });
    const totals = totalsByUserAndDay();
    const myToday = totals[me.user_id]?.[today] || totalFor(entriesForToday());
    const partnerToday = partner ? totals[partner.user_id]?.[today] || 0 : 0;
    const code = formatInvite(pairState.inviteCode);

    let html =
      '<section class="sheet-section pair-heading">' +
        '<p class="sheet-kicker">' + (partner ? escapeHtml(partner.display_name) + " ile" : "Davet kodun") + "</p>" +
        '<div class="invite-line"><strong>' + escapeHtml(code) + '</strong><button class="text-action" type="button" data-pair-action="copy">Kopyala</button></div>' +
        (!partner ? '<p class="sheet-note">Diğer kişi Birlikte bölümünde bu kodu girsin.</p>' : "") +
      "</section>";

    if (partner) {
      html +=
        '<section class="sheet-section">' +
          '<div class="people-totals">' +
            '<div><span>' + escapeHtml(me.display_name) + '</span><strong>' + myToday.toLocaleString("tr-TR") + ' <small>ml</small></strong></div>' +
            '<div><span>' + escapeHtml(partner.display_name) + '</span><strong>' + partnerToday.toLocaleString("tr-TR") + ' <small>ml</small></strong></div>' +
          "</div>" +
          '<div class="reminder-actions">' +
            (!me.notifications_enabled
              ? '<button class="secondary-action wide-action" type="button" data-pair-action="notifications">Bu cihazda bildirimleri aç</button>'
              : '<p class="notification-ready">Bu cihazda bildirimler açık</p>') +
            '<button class="primary-action wide-action" type="button" data-pair-action="remind" data-recipient="' + escapeHtml(partner.user_id) + '"' + (partner.notifications_enabled ? "" : " disabled") + ">" +
              (partner.notifications_enabled ? escapeHtml(partner.display_name) + " kişisine hatırlat" : escapeHtml(partner.display_name) + " bildirimleri açmadı") +
            "</button>" +
          "</div>" +
        "</section>";
    } else {
      html +=
        '<section class="sheet-section">' +
          (!me.notifications_enabled
            ? '<button class="secondary-action wide-action" type="button" data-pair-action="notifications">Bu cihazda bildirimleri aç</button>'
            : '<p class="notification-ready">Bu cihazda bildirimler açık</p>') +
        "</section>";
    }

    if (partner) {
      const rows = lastSevenDays().slice().reverse().map(function (day) {
        const dayLabel = day.key === today
          ? "Bugün"
          : new Intl.DateTimeFormat("tr-TR", { weekday: "short", day: "numeric", month: "short" }).format(day.date);
        const myTotal = totals[me.user_id]?.[day.key] || 0;
        const partnerTotal = totals[partner.user_id]?.[day.key] || 0;
        return (
          "<tr>" +
            "<th scope=\"row\">" + escapeHtml(dayLabel) + "</th>" +
            "<td>" + (myTotal ? myTotal.toLocaleString("tr-TR") : "—") + "</td>" +
            "<td>" + (partnerTotal ? partnerTotal.toLocaleString("tr-TR") : "—") + "</td>" +
          "</tr>"
        );
      }).join("");
      html +=
        '<section class="sheet-section history-section">' +
          '<div class="section-heading compact-heading"><h3>Geçmiş</h3><button class="text-action" type="button" data-pair-action="refresh">Yenile</button></div>' +
          '<div class="table-wrap"><table class="pair-table">' +
            "<thead><tr><th>Gün</th><th>" + escapeHtml(me.display_name) + "</th><th>" + escapeHtml(partner.display_name) + "</th></tr></thead>" +
            "<tbody>" + rows + "</tbody>" +
          "</table></div>" +
        "</section>";
    }

    if (message) html += '<p class="sheet-message" role="status">' + escapeHtml(message) + "</p>";
    content.innerHTML = html;
  }

  function renderTogetherLoading() {
    byId("together-content").innerHTML = '<p class="loading-line">Yükleniyor…</p>';
  }

  async function createPair() {
    const name = cleanName(byId("pair-name")?.value);
    if (!name) {
      renderTogetherSetup("Önce ismini yaz.");
      return;
    }
    try {
      renderTogetherLoading();
      await ensureBackend();
      const result = await supabase.rpc("create_pair", { p_display_name: name });
      if (result.error) throw result.error;
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row) throw new Error("Eşleşme oluşturulamadı.");
      pairState = {
        roomId: row.room_id,
        inviteCode: row.invite_code,
        userId: authUser.id,
        displayName: name
      };
      savePair();
      await updateMyProfile();
      await syncAll();
      await refreshPairData("Davet kodu hazır.");
    } catch (error) {
      renderTogetherSetup(pairErrorMessage(error));
    }
  }

  async function joinPair() {
    const name = cleanName(byId("pair-name")?.value);
    const code = normalizeInvite(byId("pair-code")?.value);
    if (!name || code.length !== 12) {
      renderTogetherSetup(!name ? "Önce ismini yaz." : "12 karakterli davet kodunu gir.");
      return;
    }
    try {
      renderTogetherLoading();
      await ensureBackend();
      const result = await supabase.rpc("join_pair", { p_invite_code: code, p_display_name: name });
      if (result.error) throw result.error;
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row) throw new Error("Eşleşmeye katılınamadı.");
      pairState = {
        roomId: row.room_id,
        inviteCode: row.invite_code,
        userId: authUser.id,
        displayName: name
      };
      savePair();
      await updateMyProfile();
      await syncAll();
      await refreshPairData("Eşleşme tamamlandı.");
    } catch (error) {
      renderTogetherSetup(pairErrorMessage(error));
    }
  }

  async function updateMyProfile(extra) {
    if (!pairState) return;
    await ensureBackend();
    const values = Object.assign({
      display_name: pairState.displayName,
      daily_goal: settings.goal,
      updated_at: new Date().toISOString()
    }, extra || {});
    const result = await supabase.from("profiles").update(values).eq("user_id", authUser.id);
    if (result.error) throw result.error;
  }

  function allLocalEntries() {
    return Object.values(entryStore).flat();
  }

  async function syncAll() {
    if (!pairState || !navigator.onLine || syncInFlight) return;
    syncInFlight = true;
    try {
      await ensureBackend();

      for (const queued of deleteQueue.slice()) {
        let query = supabase.from("water_entries").delete().eq("user_id", authUser.id);
        query = queued.remoteId ? query.eq("id", queued.remoteId) : query.eq("client_id", queued.clientId);
        const result = await query;
        if (result.error) throw result.error;
        deleteQueue = deleteQueue.filter(function (item) {
          return item.clientId !== queued.clientId;
        });
        saveDeleteQueue();
      }

      const unsynced = allLocalEntries().filter(function (entry) {
        return !entry.synced || !entry.remoteId;
      });
      for (let index = 0; index < unsynced.length; index += 200) {
        const batch = unsynced.slice(index, index + 200);
        const rows = batch.map(function (entry) {
          return {
            room_id: pairState.roomId,
            user_id: authUser.id,
            client_id: entry.clientId,
            amount: entry.amount,
            recorded_at: new Date(entry.createdAt).toISOString()
          };
        });
        const result = await supabase
          .from("water_entries")
          .upsert(rows, { onConflict: "user_id,client_id" })
          .select("id,client_id");
        if (result.error) throw result.error;
        const remoteByClient = new Map((result.data || []).map(function (row) {
          return [row.client_id, row.id];
        }));
        batch.forEach(function (entry) {
          entry.remoteId = remoteByClient.get(entry.clientId) || entry.remoteId;
          entry.synced = true;
        });
        saveEntries();
      }
    } finally {
      syncInFlight = false;
    }
  }

  function mergeOwnRemoteEntries(entries) {
    if (!authUser) return;
    const localByClient = new Map(allLocalEntries().map(function (entry) {
      return [entry.clientId, entry];
    }));
    (entries || []).filter(function (entry) {
      return entry.user_id === authUser.id;
    }).forEach(function (remote) {
      const existing = localByClient.get(remote.client_id);
      if (existing) {
        existing.remoteId = remote.id;
        existing.synced = true;
        return;
      }
      const date = new Date(remote.recorded_at);
      const key = dayKey(date);
      const entry = {
        id: remote.client_id,
        clientId: remote.client_id,
        remoteId: remote.id,
        amount: Number(remote.amount),
        createdAt: date.getTime(),
        synced: true
      };
      entryStore[key] = [entry].concat(entryStore[key] || []);
      localByClient.set(entry.clientId, entry);
    });
    saveEntries();
    render();
  }

  async function refreshPairData(message) {
    if (!pairState) {
      renderTogetherSetup();
      return;
    }
    try {
      await ensureBackend();
      if (navigator.onLine) await syncAll();
      const membershipResult = await supabase
        .from("room_members")
        .select("user_id,joined_at")
        .eq("room_id", pairState.roomId)
        .order("joined_at", { ascending: true });
      if (membershipResult.error) throw membershipResult.error;
      const userIds = (membershipResult.data || []).map(function (row) { return row.user_id; });
      if (!userIds.includes(authUser.id)) throw new Error("Bu eşleşmeye erişilemiyor.");

      const profilesResult = await supabase
        .from("profiles")
        .select("user_id,display_name,daily_goal,notifications_enabled")
        .in("user_id", userIds);
      if (profilesResult.error) throw profilesResult.error;
      sharedMembers = (membershipResult.data || []).map(function (membership) {
        const profile = (profilesResult.data || []).find(function (item) {
          return item.user_id === membership.user_id;
        });
        return Object.assign({}, membership, profile || { display_name: "Kullanıcı", daily_goal: 2500, notifications_enabled: false });
      });

      const start = lastSevenDays()[0].date;
      start.setHours(0, 0, 0, 0);
      const entriesResult = await supabase
        .from("water_entries")
        .select("id,client_id,user_id,amount,recorded_at")
        .eq("room_id", pairState.roomId)
        .gte("recorded_at", start.toISOString())
        .order("recorded_at", { ascending: false });
      if (entriesResult.error) throw entriesResult.error;
      sharedEntries = entriesResult.data || [];
      mergeOwnRemoteEntries(sharedEntries);
      renderTogetherPaired(message);
    } catch (error) {
      if (!navigator.onLine) {
        renderTogetherPaired("Çevrimdışısın. Son görülen bilgiler gösteriliyor.");
      } else {
        const text = pairErrorMessage(error);
        byId("together-content").innerHTML =
          '<section class="sheet-section"><p class="inline-error" role="alert">' + escapeHtml(text) + '</p><button class="secondary-action wide-action" type="button" data-pair-action="refresh">Tekrar dene</button></section>';
      }
    }
  }

  async function copyInviteCode() {
    const code = formatInvite(pairState?.inviteCode);
    try {
      await navigator.clipboard.writeText(code);
      showToast("Davet kodu kopyalandı");
    } catch (_error) {
      showToast("Kod: " + code);
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
    const rawData = window.atob(base64);
    return Uint8Array.from(Array.from(rawData).map(function (character) {
      return character.charCodeAt(0);
    }));
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  async function enableNotifications() {
    try {
      if (!config.vapidPublicKey) throw new Error("Bildirim anahtarı henüz ayarlanmadı.");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Bu tarayıcı bildirimleri desteklemiyor.");
      }
      if (isIos() && !isStandalone()) {
        throw new Error("iPhone’da önce Paylaş → Ana Ekrana Ekle ile uygulamayı kur.");
      }
      await ensureBackend();
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Bildirim izni verilmedi.");
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
        });
      }
      const json = subscription.toJSON();
      if (!json.keys?.p256dh || !json.keys?.auth) throw new Error("Bildirim kaydı alınamadı.");
      const result = await supabase.from("push_subscriptions").upsert({
        user_id: authUser.id,
        endpoint: subscription.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        updated_at: new Date().toISOString()
      }, { onConflict: "endpoint" });
      if (result.error) throw result.error;
      await updateMyProfile({ notifications_enabled: true });
      await refreshPairData("Bildirimler bu cihazda açıldı.");
    } catch (error) {
      renderTogetherPaired(pairErrorMessage(error));
    }
  }

  async function sendReminder(recipientId) {
    try {
      await ensureBackend();
      const result = await supabase.from("notification_jobs").insert({
        room_id: pairState.roomId,
        sender_user_id: authUser.id,
        recipient_user_id: recipientId,
        kind: "drink_water"
      });
      if (result.error) throw result.error;
      renderTogetherPaired("Hatırlatma gönderildi.");
    } catch (error) {
      renderTogetherPaired(pairErrorMessage(error));
    }
  }

  function startTogetherRefreshTimer() {
    clearInterval(togetherRefreshTimer);
    togetherRefreshTimer = window.setInterval(function () {
      if (byId("together-dialog").open && pairState && navigator.onLine) refreshPairData();
    }, 30000);
  }

  function openTogetherDialog() {
    const dialog = byId("together-dialog");
    if (!dialog.open) dialog.showModal();
    startTogetherRefreshTimer();
    if (!pairState) {
      renderTogetherSetup();
      return;
    }
    renderTogetherLoading();
    refreshPairData();
  }

  document.addEventListener("click", function (event) {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.amount) {
      addAmount(Number(target.dataset.amount));
      return;
    }
    if (target.dataset.glass) {
      addAmount(settings.glasses[target.dataset.glass]);
      return;
    }
    if (target.hasAttribute("data-custom-add")) {
      addAmount(settings.customAmount);
      return;
    }
    if (target.hasAttribute("data-custom-edit")) {
      openCustomDialog();
      return;
    }
    if (target.dataset.delete) {
      removeEntry(target.dataset.delete);
      return;
    }

    const pairAction = target.dataset.pairAction;
    if (!pairAction || target.disabled) return;
    if (pairAction === "create") createPair();
    if (pairAction === "join") joinPair();
    if (pairAction === "copy") copyInviteCode();
    if (pairAction === "notifications") enableNotifications();
    if (pairAction === "remind") sendReminder(target.dataset.recipient);
    if (pairAction === "refresh") {
      renderTogetherLoading();
      refreshPairData();
    }
  });

  byId("settings-button").addEventListener("click", openSettingsDialog);
  byId("together-button").addEventListener("click", openTogetherDialog);
  byId("together-close").addEventListener("click", function () {
    byId("together-dialog").close();
  });
  byId("together-dialog").addEventListener("close", function () {
    clearInterval(togetherRefreshTimer);
  });

  byId("custom-input").addEventListener("input", function (event) {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
  });

  byId("custom-form").addEventListener("submit", function (event) {
    if (event.submitter && event.submitter.value === "cancel") return;
    event.preventDefault();
    const amount = safeNumber(byId("custom-input").value, settings.customAmount || 250, 50, 3000);
    settings.customAmount = amount;
    saveSettings();
    byId("custom-dialog").close();
    addAmount(amount);
  });

  byId("settings-form").addEventListener("submit", function (event) {
    if (event.submitter && event.submitter.value === "cancel") return;
    event.preventDefault();
    settings.goal = safeNumber(byId("goal-input").value, settings.goal, 500, 6000);
    settings.glasses.small = safeNumber(byId("small-input").value, settings.glasses.small, 50, 1500);
    settings.glasses.medium = safeNumber(byId("medium-input").value, settings.glasses.medium, 50, 1500);
    settings.glasses.large = safeNumber(byId("large-input").value, settings.glasses.large, 50, 1500);
    const paletteChoice = document.querySelector('input[name="palette"]:checked');
    const modeChoice = document.querySelector('input[name="mode"]:checked');
    settings.palette = paletteChoice ? paletteChoice.value : settings.palette;
    settings.mode = modeChoice ? modeChoice.value : settings.mode;
    saveSettings();
    applyTheme();
    byId("settings-dialog").close();
    render();
    showToast("Ayarlar kaydedildi");
    if (pairState && navigator.onLine) updateMyProfile().catch(function () {});
  });

  [byId("custom-dialog"), byId("settings-dialog")].forEach(function (dialog) {
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close();
    });
  });

  window.setInterval(function () {
    const currentDay = dayKey(new Date());
    if (currentDay !== today) {
      today = currentDay;
      render();
      if (pairState && navigator.onLine) refreshPairData().catch(function () {});
    }
  }, 60000);

  window.addEventListener("online", function () {
    if (!pairState) return;
    syncAll()
      .then(function () { return refreshPairData(); })
      .catch(function () {});
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("/sw.js?release=6", { updateViaCache: "none" })
        .then(function (registration) { return registration.update(); })
        .catch(function () {});
    });
  }

  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  if (typeof colorScheme.addEventListener === "function") {
    colorScheme.addEventListener("change", function () {
      if (settings.mode === "system") applyTheme();
    });
  }

  applyTheme();
  render();

  if (pairState && backendConfigured() && navigator.onLine) {
    window.setTimeout(function () {
      ensureBackend()
        .then(function () { return syncAll(); })
        .then(function () { return refreshPairData(); })
        .catch(function () {});
    }, 300);
  }

  if (new URLSearchParams(window.location.search).get("birlikte") === "1") {
    window.history.replaceState({}, "", window.location.pathname);
    window.setTimeout(openTogetherDialog, 250);
  }
})();
