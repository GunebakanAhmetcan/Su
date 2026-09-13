(() => {
  const report = message => {
    const element = document.getElementById('startup-status');
    if (element) { element.hidden = false; element.textContent = message; }
  };
  window.setTimeout(() => { if (!window.SU_READY) report('Açılış tamamlanamadı. Bağlantını kontrol edip sayfayı yeniden aç.'); }, 10000);
  window.addEventListener('error', () => { if (!window.SU_READY) report('Uygulama açılamadı. Sayfayı yeniden açmayı dene.'); });
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (window.SU_APPLY_UPDATE && !reloading) { reloading = true; location.reload(); }
  });
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(registration => {
    window.SU_REGISTRATION = registration;
    const announce = () => window.dispatchEvent(new Event('su-update'));
    if (registration.waiting) announce();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'redundant' && !registration.active) window.SU_OFFLINE_FAILED = true;
        announce();
      });
    });
    window.addEventListener('online', () => registration.update().catch(() => {}));
  }).catch(() => { window.SU_OFFLINE_FAILED = true; window.dispatchEvent(new Event('su-update')); });
})();
