// Service worker registration and the update bar. The one place the site
// registers its worker. A new version never activates on its own: it installs,
// waits, and is promoted only when the reader presses Reload.
// Plain script, wrapped so its names stay out of the shared global scope.

(function () {
  const SW_URL = '/sw.js';

  const STRINGS = {
    label: 'Update',
    ready: 'A new version of SG Bike Parking Finder is ready.',
    reload: 'Reload',
    later: 'Not now',
  };

  let registration = null;
  let waitingWorker = null;
  let reloading = false;
  // For this page view only, and never stored: "Not now" means not now.
  let dismissed = false;

  function render() {
    const existing = document.querySelector('.update-notice');

    if (!waitingWorker || dismissed) {
      existing?.remove();
      return;
    }

    const bar = existing ?? document.createElement('div');
    bar.className = 'update-notice';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', STRINGS.label);
    bar.innerHTML = `
      <div class="update-notice-inner">
        <p></p>
        <button type="button" class="btn btn-primary" data-sw-update></button>
        <button type="button" class="btn btn-secondary" data-sw-later></button>
      </div>
    `;
    bar.querySelector('p').textContent = STRINGS.ready;

    const reloadBtn = bar.querySelector('[data-sw-update]');
    reloadBtn.textContent = STRINGS.reload;
    reloadBtn.addEventListener('click', () => {
      // The only place anything asks for skipWaiting. The reload happens on
      // controllerchange, not here.
      waitingWorker?.postMessage('skip-waiting');
    });

    const laterBtn = bar.querySelector('[data-sw-later]');
    laterBtn.textContent = STRINGS.later;
    laterBtn.addEventListener('click', () => {
      dismissed = true;
      render();
    });

    if (!existing) document.body.prepend(bar);
  }

  function watchForUpdate() {
    if (!registration) return;

    // A worker already waiting when the page opened. The ordinary case on the
    // second page view after a deploy.
    if (registration.waiting && navigator.serviceWorker.controller) {
      waitingWorker = registration.waiting;
      render();
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        // installed with a controller is an update. installed with no
        // controller is a first install, with nothing on screen to protect.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = registration.waiting ?? installing;
          render();
        }
      });
    });

    // A tab kept open for days never navigates, which is when the browser
    // would otherwise check for a new worker. Coming back to it is the moment.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker
      .register(SW_URL)
      .then((reg) => {
        registration = reg;
        watchForUpdate();
      })
      .catch((cause) => {
        // A refused registration is not a reason to break the page.
        console.warn('service worker registration failed:', cause);
      });

    // The swap, once somebody has accepted it. Reloading here rather than in
    // the click handler means the reload is served by the new worker. The flag
    // guards against controllerchange firing twice and looping.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  // On load, not immediately: installing fetches everything the worker
  // precaches, and competing with the page's own assets slows a first visit.
  if (document.readyState === 'complete') registerWorker();
  else window.addEventListener('load', registerWorker, { once: true });
})();
