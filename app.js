(function () {
  "use strict";

  var SETTINGS_KEY = "su:settings:v1";
  var ENTRIES_KEY = "su:entries:v1";
  var defaultSettings = {
    goal: 2500,
    glasses: { small: 200, medium: 300, large: 400 },
    customAmount: null,
    palette: "ocean",
    mode: "system"
  };
  var allowedPalettes = ["ocean", "olive", "sand", "white"];
  var allowedModes = ["system", "light", "dark"];
  var themeBackgrounds = {
    ocean: { light: "#f2f1eb", dark: "#0d1112" },
    olive: { light: "#f3f1e7", dark: "#11140f" },
    sand: { light: "#f4eee4", dark: "#17130f" },
    white: { light: "#ffffff", dark: "#101314" }
  };

  var today = dayKey(new Date());
  var settings = loadSettings();
  var entryStore = loadEntries();
  var toastTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function dayKey(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function safeNumber(value, fallback, min, max) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function loadSettings() {
    try {
      var parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (!parsed) return structuredClone(defaultSettings);
      return {
        goal: safeNumber(parsed.goal, defaultSettings.goal, 500, 6000),
        glasses: {
          small: safeNumber(parsed.glasses && parsed.glasses.small, defaultSettings.glasses.small, 50, 1500),
          medium: safeNumber(parsed.glasses && parsed.glasses.medium, defaultSettings.glasses.medium, 50, 1500),
          large: safeNumber(parsed.glasses && parsed.glasses.large, defaultSettings.glasses.large, 50, 1500)
        },
        customAmount: parsed.customAmount
          ? safeNumber(parsed.customAmount, null, 50, 3000)
          : null,
        palette: allowedPalettes.includes(parsed.palette) ? parsed.palette : defaultSettings.palette,
        mode: allowedModes.includes(parsed.mode) ? parsed.mode : defaultSettings.mode
      };
    } catch (_error) {
      return structuredClone(defaultSettings);
    }
  }

  function loadEntries() {
    try {
      var parsed = JSON.parse(localStorage.getItem(ENTRIES_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function saveEntries() {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entryStore));
  }

  function applyTheme() {
    document.documentElement.dataset.palette = settings.palette;
    document.documentElement.dataset.mode = settings.mode;
    var systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = settings.mode === "dark" || (settings.mode === "system" && systemIsDark);
    document.documentElement.dataset.resolved = dark ? "dark" : "light";
    byId("theme-color").setAttribute(
      "content",
      themeBackgrounds[settings.palette][dark ? "dark" : "light"]
    );
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
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function addAmount(amount) {
    var entry = { id: makeId(), amount: amount, createdAt: Date.now() };
    entryStore[today] = [entry].concat(entriesForToday());
    saveEntries();
    render();
    showToast(amount + " ml eklendi", function () {
      removeEntry(entry.id);
    });
  }

  function removeEntry(id) {
    entryStore[today] = entriesForToday().filter(function (entry) {
      return entry.id !== id;
    });
    saveEntries();
    render();
  }

  function showToast(message, undoAction) {
    var toast = byId("toast");
    var action = byId("toast-action");
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
    var text = new Intl.DateTimeFormat("tr-TR", {
      weekday: "long",
      day: "numeric",
      month: "long"
    }).format(new Date());
    byId("date-line").textContent = text.charAt(0).toUpperCase() + text.slice(1);
  }

  function renderMeter() {
    var total = totalFor(entriesForToday());
    var percentage = Math.min(100, Math.round((total / settings.goal) * 100));
    var remaining = Math.max(0, settings.goal - total);

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
    var slot = byId("custom-slot");
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
    var entries = entriesForToday();
    byId("record-count").textContent = entries.length ? entries.length + " ekleme" : "Bugün";

    if (!entries.length) {
      byId("entry-content").innerHTML =
        '<p class="empty-log">İlk bardağını yukarıdan ekleyebilirsin.</p>';
      return;
    }

    var items = entries.slice(0, 5).map(function (entry) {
      var time = new Intl.DateTimeFormat("tr-TR", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(entry.createdAt);
      return (
        "<li>" +
          "<time>" + time + "</time>" +
          '<span class="entry-rule" aria-hidden="true"></span>' +
          "<strong>" + entry.amount + " ml</strong>" +
          '<button class="delete-entry" type="button" data-delete="' + entry.id + '" aria-label="' + entry.amount + ' mililitrelik kaydı sil">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>' +
          "</button>" +
        "</li>"
      );
    }).join("");

    byId("entry-content").innerHTML = '<ul class="entry-list">' + items + "</ul>";
  }

  function renderWeek() {
    var html = [];
    for (var index = 6; index >= 0; index -= 1) {
      var date = new Date();
      date.setDate(date.getDate() - index);
      var key = dayKey(date);
      var total = totalFor(entryStore[key]);
      var height = Math.max(5, Math.min(100, (total / settings.goal) * 100));
      var label = new Intl.DateTimeFormat("tr-TR", { weekday: "narrow" }).format(date);
      var totalLabel = total ? (total / 1000).toFixed(1) + "L" : "—";
      html.push(
        '<div class="day-column' + (key === today ? " is-today" : "") + '">' +
          '<span class="day-total">' + totalLabel + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="height:' + height + '%"></span></span>' +
          '<span class="day-label">' + label + "</span>" +
        "</div>"
      );
    }
    byId("week-chart").innerHTML = html.join("");
  }

  function render() {
    renderDate();
    renderMeter();
    renderGlassAmounts();
    renderCustomAmount();
    renderEntries();
    renderWeek();
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

  document.addEventListener("click", function (event) {
    var target = event.target.closest("button");
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
    }
  });

  byId("settings-button").addEventListener("click", openSettingsDialog);

  byId("custom-input").addEventListener("input", function (event) {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
  });

  byId("custom-form").addEventListener("submit", function (event) {
    if (event.submitter && event.submitter.value === "cancel") return;
    event.preventDefault();
    var amount = safeNumber(byId("custom-input").value, settings.customAmount || 250, 50, 3000);
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
    var paletteChoice = document.querySelector('input[name="palette"]:checked');
    var modeChoice = document.querySelector('input[name="mode"]:checked');
    settings.palette = paletteChoice ? paletteChoice.value : settings.palette;
    settings.mode = modeChoice ? modeChoice.value : settings.mode;
    saveSettings();
    applyTheme();
    byId("settings-dialog").close();
    render();
    showToast("Ayarlar kaydedildi");
  });

  [byId("custom-dialog"), byId("settings-dialog")].forEach(function (dialog) {
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close();
    });
  });

  window.setInterval(function () {
    var currentDay = dayKey(new Date());
    if (currentDay !== today) {
      today = currentDay;
      render();
    }
  }, 60000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("/sw.js?release=5", { updateViaCache: "none" })
        .then(function (registration) {
          return registration.update();
        })
        .catch(function () {});
    });
  }

  var colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  if (typeof colorScheme.addEventListener === "function") {
    colorScheme.addEventListener("change", function () {
      if (settings.mode === "system") applyTheme();
    });
  }

  applyTheme();
  render();
})();
