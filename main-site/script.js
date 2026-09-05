// ── State
const state = {
    userLat: null,
    userLng: null,
    searchLat: null,
    searchLng: null,
    radius: 0.5,
    results: [],
    filteredResults: [],
    view: 'map', // 'map' | 'list' | 'fav'
    filters: {
        sheltered: false,
        racks: false,
        yellowBox: false,
    },
    sort: 'distance',
    loading: false,
    locationReady: false,
    currentDetail: null,
    listPage: 0,
    favPage: 0,
};

// ── DOM refs
const $ = (id) => document.getElementById(id);
const els = {
    locDot: $('loc-dot'),
    locText: $('loc-text'),
    searchInput: $('search-input'),
    searchBtn: $('search-btn'),
    locBtn: $('loc-btn'),
    radiusBtns: document.querySelectorAll('.radius-btn'),
    filterSheltered: $('filter-sheltered'),
    filterRacks: $('filter-racks'),
    filterYbox: $('filter-ybox'),
    sortSelect: $('sort-select'),
    viewMap: $('view-map'),
    viewList: $('view-list'),
    viewFav: $('view-fav'),
    mapContainer: $('map-container'),
    listView: $('list-view'),
    contentInner: $('content-inner'),
    resultCount: $('result-count'),
    detailModal: $('detail-modal'),
    mapModal: $('map-modal'),
    toast: $('toast'),
};

// ── Theme
function buildThemeModal() {
    const grid = $('swatchGrid');
    grid.innerHTML = COLOR_THEMES.map(
        (t) => `
      <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
        <span class="swatch-dot"></span>
        <span class="swatch-label">${t.label}</span>
      </button>`
    ).join('');

    syncThemeModalState();

    grid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-theme-id]');
        if (!btn) return;
        applyColorTheme(btn.dataset.themeId);
        syncThemeModalState();
    });

    $('modeToggle').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mode]');
        if (!btn) return;
        applyMode(btn.dataset.mode);
        syncThemeModalState();
    });
}

function syncThemeModalState() {
    const activeTheme = getStoredColorTheme();
    const activeMode = getStoredMode();
    document.querySelectorAll('#swatchGrid .swatch').forEach((el) => {
        el.classList.toggle('active', el.dataset.themeId === activeTheme);
    });
    document.querySelectorAll('#modeToggle .mode-btn').forEach((el) => {
        const on = el.dataset.mode === activeMode;
        el.classList.toggle('active', on);
        el.setAttribute('aria-pressed', String(on));
    });
    updateThemeButtonIcon();
}

function updateThemeButtonIcon() {
    const span = document.querySelector('#themeBtn [data-icon]');
    span.setAttribute('data-icon', getStoredMode() === 'dark' ? 'moon' : 'sun');
    hydrateIcons($('themeBtn'));
}

function wireModals() {
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
        btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) closeModal(backdrop.id);
        });
    });
    $('themeBtn').addEventListener('click', () => openModal('themeModal'));

    // Leaflet teardown for the in-app map modal, previously inside closeModal.
    els.mapModal.addEventListener('click', (e) => {
        if (e.target === els.mapModal || e.target.closest('[data-close-modal="map-modal"]')) {
            MapManager.destroyModal();
        }
    });
}

// ── Toast
let toastTimer;

function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}

// ── Location
function setLocStatus(status, text) {
    els.locDot.className = `loc-dot ${status}`;
    els.locText.textContent = text;
}

function getLocation() {
    if (!navigator.geolocation) {
        setLocStatus('error', 'Geolocation not supported by this browser.');
        return;
    }
    setLocStatus('loading', 'Getting your location…');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            state.userLat = pos.coords.latitude;
            state.userLng = pos.coords.longitude;
            state.searchLat = state.userLat;
            state.searchLng = state.userLng;
            state.locationReady = true;
            const acc = Math.round(pos.coords.accuracy);
            setLocStatus('active', `Location found · ±${acc}m accuracy`);
            MapManager.initMain(state.userLat, state.userLng);
            MapManager.setUserLocation(state.userLat, state.userLng, state.radius);
            fetchParking();
        },
        (err) => {
            let msg = 'Location access denied.';
            if (err.code === err.TIMEOUT) msg = 'Location request timed out.';
            if (err.code === err.POSITION_UNAVAILABLE) msg = 'Location unavailable.';
            setLocStatus('error', msg + ' Please allow location access.');
        }, {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 30000
        }
    );
}

els.locBtn.addEventListener('click', () => {
    state.searchLat = state.userLat;
    state.searchLng = state.userLng;
    if (state.locationReady) {
        MapManager.setUserLocation(state.userLat, state.userLng, state.radius);
        fetchParking();
    } else {
        getLocation();
    }
});

// ── Geocoding
async function geocodeAddress(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + ', Singapore')}&format=json&limit=1`;
    const res = await fetch(url, {
        headers: {
            'Accept-Language': 'en'
        }
    });
    const data = await res.json();
    if (!data.length) return null;
    return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        name: data[0].display_name
    };
}

els.searchBtn.addEventListener('click', async () => {
    const q = els.searchInput.value.trim();
    if (!q) return;

    setLocStatus('loading', `Searching for "${q}"…`);
    const result = await geocodeAddress(q);
    if (!result) {
        setLocStatus('error', `Could not find "${q}". Try a different address.`);
        showToast('Address not found. Try another search.');
        return;
    }
    state.searchLat = result.lat;
    state.searchLng = result.lng;

    if (!state.locationReady) {
        MapManager.initMain(result.lat, result.lng);
    }
    MapManager.setUserLocation(result.lat, result.lng, state.radius);
    setLocStatus('active', `Searching near: ${result.name.split(',').slice(0, 2).join(',')}`);
    fetchParking();
});

els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.searchBtn.click();
});

// ── Radius
els.radiusBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        els.radiusBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.radius = parseFloat(btn.dataset.radius);
        if (state.searchLat) {
            MapManager.setUserLocation(state.searchLat, state.searchLng, state.radius);
            fetchParking();
        }
    });
});

// ── Filters & Sort
[els.filterSheltered, els.filterRacks, els.filterYbox].forEach((chip) => {
    chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        state.filters.sheltered = els.filterSheltered.classList.contains('active');
        state.filters.racks = els.filterRacks.classList.contains('active');
        state.filters.yellowBox = els.filterYbox.classList.contains('active');
        applyFiltersAndRender();
    });
});

els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value;
    applyFiltersAndRender();
});

// ── View toggle
function setView(view) {
    state.view = view;
    [els.viewMap, els.viewList, els.viewFav].forEach((btn) => btn.classList.remove('active'));

    if (view === 'map') {
        els.viewMap.classList.add('active');
        els.mapContainer.style.display = '';
        $('list-view').classList.remove('active');
        setTimeout(() => MapManager.invalidateSize(), 100);
        return;
    }

    els.mapContainer.style.display = 'none';
    $('list-view').classList.add('active');

    if (view === 'list') {
        els.viewList.classList.add('active');
        renderList();
    } else {
        els.viewFav.classList.add('active');
        renderFavourites();
    }
}

els.viewMap.addEventListener('click', () => setView('map'));
els.viewList.addEventListener('click', () => setView('list'));
els.viewFav.addEventListener('click', () => setView('fav'));

// ── API fetch
const CACHE_KEY = 'sgbikes_cache';

async function fetchParking() {
    if (!state.searchLat || !state.searchLng) return;

    const lat = state.searchLat;
    const lng = state.searchLng;
    const dist = state.radius;

    setLoading(true);

    try {
        const res = await fetch(`/api/bicycle-parking?lat=${lat}&long=${lng}&dist=${dist}`);
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const data = await res.json();
        const items = data.value || [];

        // enrich with distance
        items.forEach((item) => {
            item._dist = haversine(lat, lng, item.Latitude, item.Longitude);
        });


        state.results = items;

        // cache to localStorage
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                ts: Date.now(),
                lat,
                lng,
                dist,
                items
            }));
        } catch (_) {}

        applyFiltersAndRender();
    } catch (err) {
        console.error(err);
        // try cache fallback
        loadFromCache(lat, lng);
    } finally {
        setLoading(false);
    }
}

function loadFromCache(lat, lng) {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) {
            renderEmpty('error');
            return;
        }
        const cached = JSON.parse(raw);
        cached.items.forEach((item) => {
            item._dist = haversine(lat, lng, item.Latitude, item.Longitude);
        });
        state.results = cached.items;
        const age = Math.round((Date.now() - cached.ts) / 86400000);
        showToast(`Offline mode, showing cached data (${age}d old)`);
        applyFiltersAndRender();
    } catch (_) {
        renderEmpty('error');
    }
}

// ── Haversine
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(km) {
    if (km < 1) return `${Math.round(km * 1000)}m`;
    return `${km.toFixed(2)}km`;
}

// ── Filter & sort
function applyFiltersAndRender() {
    let items = [...state.results];

    if (state.filters.sheltered) items = items.filter((i) => i.ShelterIndicator === 'Y');
    if (state.filters.racks) items = items.filter((i) => i.RackType === 'Racks');
    if (state.filters.yellowBox) items = items.filter((i) => i.RackType === 'Yellow Box');

    if (state.sort === 'distance') items.sort((a, b) => a._dist - b._dist);
    else if (state.sort === 'count') items.sort((a, b) => b.RackCount - a.RackCount);
    else if (state.sort === 'sheltered') {
        items.sort((a, b) => (b.ShelterIndicator === 'Y') - (a.ShelterIndicator === 'Y'));
    }

    state.filteredResults = items;
    state.listPage = 0;

    els.resultCount.textContent = items.length ?
        `${items.length} location${items.length !== 1 ? 's' : ''} found` :
        '';

    MapManager.plotResults(items, showDetailModal);

    if (state.view === 'list') renderList();
    else if (state.view === 'fav') renderFavourites();
}

// ── Loading state
function setLoading(on) {
    state.loading = on;
    const inner = $('content-inner');
    if (on) {
        inner.innerHTML = `
      <div class="spinner-wrap">
        <div class="spinner"></div>
        <div class="spinner-text">Fetching nearby bicycle parking…</div>
      </div>`;
    } else {
        inner.innerHTML = '';
    }
}

function renderEmpty(type) {
    const inner = $('content-inner');
    if (type === 'no-location') {
        inner.innerHTML = `
      <div class="state-box glass">
        <div class="state-icon">${ICONS.pin}</div>
        <div class="state-title">Allow Location Access</div>
        <div class="state-sub">SG Bike Parking needs your location to find nearby bicycle parking spots.</div>
        <button class="btn btn-primary" onclick="getLocation()">Enable Location</button>
      </div>`;
    } else if (type === 'no-results') {
        inner.innerHTML = `
      <div class="state-box glass">
        <div class="state-icon">${ICONS.bike}</div>
        <div class="state-title">No Parking Found</div>
        <div class="state-sub">No bicycle parking within ${state.radius}km. Try increasing the search radius.</div>
      </div>`;
    } else {
        inner.innerHTML = `
      <div class="state-box glass">
        <div class="state-icon">${ICONS.warning}</div>
        <div class="state-title">Could Not Load Data</div>
        <div class="state-sub">Check your connection and try again. Cached results will be used if available.</div>
        <button class="btn btn-primary" onclick="fetchParking()">Retry</button>
      </div>`;
    }
}

// ── Render list
function rackIcon(type) {
    if (type === 'Yellow Box') return ICONS.ybox;
    if (type === 'Racks') return ICONS.bike;
    return ICONS.parking;
}

function rackClass(type) {
    if (type === 'Yellow Box') return 'ybox';
    if (type === 'Racks') return 'rack';
    return 'other';
}

const PAGE_SIZE = 10;

// Builds one result card. The favourite star sits in the top right corner and
// toggles on the spot, so a tap saves without opening anything.
function buildCard(item) {
    const card = document.createElement('div');
    card.className = 'parking-card glass';

    const shelterBadge =
        item.ShelterIndicator === 'Y' ?
        `<span class="badge badge-shelter">${ICONS.umbrella} Sheltered</span>` :
        '';
    // Favourites reached from the favourites view have no distance to show.
    const distanceRow =
        typeof item._dist === 'number' ?
        `<div class="card-distance">${ICONS.ruler} ${fmtDist(item._dist)} away</div>` :
        '';
    const saved = Sync.has(item.Description);

    card.innerHTML = `
      <button class="fav-star ${saved ? 'active' : ''}" type="button"
              aria-pressed="${saved}"
              aria-label="${saved ? 'Remove from favourites' : 'Save to favourites'}">
        ${saved ? ICONS.starFilled : ICONS.star}
      </button>
      <div class="card-icon ${rackClass(item.RackType)}">${rackIcon(item.RackType)}</div>
      <div class="card-body">
        <div class="card-code-label">Parking Code</div>
        <div class="card-title">${item.Description}</div>
        <div class="card-meta">
          <span class="badge ${rackClass(item.RackType) === 'ybox' ? 'badge-ybox' : 'badge-rack'}">${item.RackType}</span>
          <span class="badge badge-count">${ICONS.hash} ${item.RackCount} lot${item.RackCount !== 1 ? 's' : ''}</span>
          ${shelterBadge}
        </div>
        ${distanceRow}
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary card-details-btn" style="font-size:0.78rem;padding:6px 10px">Details →</button>
      </div>
    `;

    const star = card.querySelector('.fav-star');
    star.addEventListener('click', (e) => {
        // The whole card opens the detail modal, so the star must not bubble.
        e.stopPropagation();
        toggleFavourite(item, star);
    });

    card.querySelector('.card-details-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showDetailModal(item);
    });
    card.addEventListener('click', () => showDetailModal(item));

    return card;
}

// Single place that flips a star, so the card, the modal and the favourites
// view all behave the same way.
function toggleFavourite(item, starEl) {
    const saved = Sync.toggle(item);

    if (starEl) {
        starEl.innerHTML = saved ? ICONS.starFilled : ICONS.star;
        starEl.classList.toggle('active', saved);
        starEl.setAttribute('aria-pressed', String(saved));
        starEl.setAttribute('aria-label', saved ? 'Remove from favourites' : 'Save to favourites');
        if (saved) {
            starEl.classList.remove('just-saved');
            // Force a reflow so the animation replays on a repeat save.
            void starEl.offsetWidth;
            starEl.classList.add('just-saved');
        }
    }

    showToast(saved ? `Saved ${item.Description}` : `Removed ${item.Description}`);
    return saved;
}

function renderPager(container, page, totalPages, onChange) {
    if (totalPages <= 1) return;
    const pager = document.createElement('div');
    pager.className = 'pagination';
    pager.innerHTML = `
      <button class="btn btn-secondary pagination-prev" ${page === 0 ? 'disabled' : ''}>← Prev</button>
      <span class="pagination-info">${page + 1} / ${totalPages}</span>
      <button class="btn btn-secondary pagination-next" ${page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
    `;
    pager.querySelector('.pagination-prev').addEventListener('click', () => onChange(page - 1));
    pager.querySelector('.pagination-next').addEventListener('click', () => onChange(page + 1));
    container.appendChild(pager);
}

function renderList() {
    const lv = $('list-view');
    lv.innerHTML = '';

    if (!state.filteredResults.length) {
        lv.innerHTML = `
      <div class="state-box glass">
        <div class="state-icon">${ICONS.bike}</div>
        <div class="state-title">No results</div>
        <div class="state-sub">Try adjusting your filters or expanding the radius.</div>
      </div>`;
        return;
    }

    const total = state.filteredResults.length;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const page = state.listPage;
    const pageItems = state.filteredResults.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    pageItems.forEach((item) => lv.appendChild(buildCard(item)));

    renderPager(lv, page, totalPages, (next) => {
        state.listPage = next;
        renderList();
        lv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

// ── Favourites view
function renderFavourites() {
    const lv = $('list-view');
    lv.innerHTML = '';

    const items = Sync.list();

    if (!items.length) {
        lv.innerHTML = `
      <div class="state-box glass">
        <div class="state-icon">${ICONS.star}</div>
        <div class="state-title">No favourites yet</div>
        <div class="state-sub">Tap the star on any parking spot to keep it here.</div>
        <div class="fav-empty-hint">Favourites stay on this device until you link Telegram.</div>
      </div>`;
        return;
    }

    // Distance is only meaningful once we know where the person is.
    if (state.searchLat != null && state.searchLng != null) {
        items.forEach((item) => {
            if (item.Latitude != null && item.Longitude != null) {
                item._dist = haversine(state.searchLat, state.searchLng, item.Latitude, item.Longitude);
            }
        });
        items.sort((a, b) => (a._dist ?? Infinity) - (b._dist ?? Infinity));
    }

    const totalPages = Math.ceil(items.length / PAGE_SIZE);
    const page = Math.min(state.favPage, Math.max(0, totalPages - 1));
    state.favPage = page;

    items
        .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        .forEach((item) => lv.appendChild(buildCard(item)));

    renderPager(lv, page, totalPages, (next) => {
        state.favPage = next;
        renderFavourites();
        lv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

// ── Detail modal
function showDetailModal(item) {
    state.currentDetail = item;

    $('detail-rack-icon').innerHTML = rackIcon(item.RackType);
    $('detail-title').textContent = item.Description;

    const copyBtn = $('copy-code-btn');
    copyBtn.onclick = () => {
        navigator.clipboard.writeText(item.Description).then(() => showToast(`Copied: ${item.Description}`));
    };

    const shelterBadge =
        item.ShelterIndicator === 'Y' ?
        `<span class="badge badge-shelter">${ICONS.umbrella} Sheltered</span>` :
        `<span class="badge badge-other">${ICONS.cloud} Unsheltered</span>`;
    const rackBadge = `<span class="badge ${item.RackType === 'Yellow Box' ? 'badge-ybox' : 'badge-rack'}">${item.RackType}</span>`;
    $('detail-badges').innerHTML = rackBadge + shelterBadge;

    $('detail-rack-count').textContent = item.RackCount;
    $('detail-distance').textContent = state.searchLat ?
        fmtDist(item._dist) :
        '-';
    $('detail-coords').textContent =
        item.Latitude != null && item.Longitude != null ?
        `${item.Latitude.toFixed(6)}, ${item.Longitude.toFixed(6)}` :
        '';

    syncDetailFavButton();

    // pan to marker
    if (state.view === 'map') {
        MapManager.panTo(item.Latitude, item.Longitude);
    }

    openModal('detail-modal');
}

// Keeps the detail modal button in step with the stored favourites.
function syncDetailFavButton() {
    const btn = $('detail-fav-btn');
    if (!btn || !state.currentDetail) return;

    const saved = Sync.has(state.currentDetail.Description);
    btn.classList.toggle('active', saved);
    btn.setAttribute('aria-pressed', String(saved));
    btn.querySelector('[data-fav-icon]').innerHTML = saved ? ICONS.starFilled : ICONS.star;
    $('detail-fav-label').textContent = saved ? 'Saved to favourites' : 'Save to favourites';
}

$('detail-fav-btn').addEventListener('click', () => {
    if (!state.currentDetail) return;
    toggleFavourite(state.currentDetail, null);
    syncDetailFavButton();
});

// Navigate buttons
document.getElementById('nav-googlemaps').addEventListener('click', () => {
    if (!state.currentDetail) return;
    const {
        Latitude: lat,
        Longitude: lng,
        Description: name
    } = state.currentDetail;
    window.open(`https://maps.google.com/?daddr=${lat},${lng}&travelmode=bicycling`, '_blank');
});

document.getElementById('nav-waze').addEventListener('click', () => {
    if (!state.currentDetail) return;
    const {
        Latitude: lat,
        Longitude: lng
    } = state.currentDetail;
    window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, '_blank');
});

document.getElementById('nav-applemaps').addEventListener('click', () => {
    if (!state.currentDetail) return;
    const {
        Latitude: lat,
        Longitude: lng
    } = state.currentDetail;
    window.open(`http://maps.apple.com/?daddr=${lat},${lng}&dirflg=w`, '_blank');
});

document.getElementById('nav-osm').addEventListener('click', () => {
    if (!state.currentDetail) return;
    const {
        Latitude: lat,
        Longitude: lng
    } = state.currentDetail;
    window.open(`https://www.openstreetmap.org/directions?engine=graphhopper_bicycle&route=${state.searchLat},${state.searchLng};${lat},${lng}`, '_blank');
});

document.getElementById('btn-open-map-modal').addEventListener('click', () => {
    if (!state.currentDetail) return;
    closeModal('detail-modal');
    openModal('map-modal');
    MapManager.initModal(state.currentDetail.Latitude, state.currentDetail.Longitude);
    // update map modal title
    $('map-modal-title').textContent = state.currentDetail.Description;
});

// Map modal navigate
document.getElementById('map-modal-nav-google').addEventListener('click', () => {
    if (!state.currentDetail) return;
    const {
        Latitude: lat,
        Longitude: lng
    } = state.currentDetail;
    window.open(`https://maps.google.com/?daddr=${lat},${lng}&travelmode=bicycling`, '_blank');
});

document.getElementById('map-modal-nav-waze').addEventListener('click', () => {
    if (!state.currentDetail) return;
    const {
        Latitude: lat,
        Longitude: lng
    } = state.currentDetail;
    window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, '_blank');
});

// ── Favourites and Telegram sync UI
let backupPollTimer = null;

function setSyncStatus(kind, text) {
    $('sync-status-dot').className = `sync-status-dot ${kind}`;
    $('sync-status-text').textContent = text;
}

function updateSyncBadge() {
    const badge = $('sync-badge');
    const n = Sync.count();
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
}

function renderSyncActions(linked) {
    const box = $('sync-actions');
    box.innerHTML = linked ?
        `<button class="btn btn-secondary" id="sync-unlink">${ICONS.unlink} Unlink Telegram</button>` :
        `<button class="btn btn-primary" id="sync-link">${ICONS.telegram} Link Telegram</button>`;

    $('backup-section').hidden = !linked;
    $('redeem-section').hidden = linked;

    if (linked) {
        $('sync-unlink').addEventListener('click', doUnlink);
    } else {
        $('sync-link').addEventListener('click', doLink);
    }
}

function renderSyncStats(info) {
    const cells = [
        ['Favourites', info.favourites ?? Sync.count()],
    ];
    if (info.linked) {
        cells.push(['Devices', info.devices ?? 1]);
        cells.push(['Backup codes', info.backup_codes_remaining ?? 0]);
    }
    $('sync-stats').innerHTML = cells
        .map(
            ([label, value]) => `
      <div class="sync-stat">
        <span class="sync-stat-value">${value}</span>
        <span class="sync-stat-label">${label}</span>
      </div>`
        )
        .join('');
}

async function refreshSyncModal() {
    setSyncStatus('waiting', 'Checking…');
    try {
        const info = await Sync.status();
        if (info.linked) {
            const who = info.username ? `@${info.username}` : info.first_name || 'your Telegram account';
            setSyncStatus('linked', `Linked to ${who}`);
        } else {
            setSyncStatus('', 'Saved on this device only');
        }
        renderSyncStats(info);
        renderSyncActions(Boolean(info.linked));
    } catch (err) {
        setSyncStatus('error', 'Sync is unavailable right now');
        renderSyncStats({ linked: false, favourites: Sync.count() });
        renderSyncActions(false);
    }
    hydrateIcons($('syncModal'));
}

async function doLink() {
    const btn = $('sync-link');
    btn.disabled = true;
    btn.textContent = 'Preparing…';

    try {
        const { url } = await Sync.startLink();
        window.open(url, '_blank', 'noopener');
        setSyncStatus('waiting', 'Waiting for you to tap Start in Telegram…');

        const linked = await Sync.waitForLink();
        if (linked) {
            showToast('Telegram linked. Favourites merged.');
            await refreshSyncModal();
        } else {
            setSyncStatus('', 'Still not linked. Try again when you are ready.');
            renderSyncActions(false);
            hydrateIcons($('syncModal'));
        }
    } catch (err) {
        showToast('Could not start linking. Try again shortly.');
        await refreshSyncModal();
    }
}

async function doUnlink() {
    const btn = $('sync-unlink');
    btn.disabled = true;
    btn.textContent = 'Unlinking…';
    try {
        await Sync.unlink();
        showToast('Telegram unlinked. Your favourites stay on this device.');
    } catch (err) {
        showToast('Could not unlink. Try again shortly.');
    }
    await refreshSyncModal();
}

// Backup codes are only released after someone approves the request in chat,
// so this raises the request and then waits on the bot.
async function doGenerateBackupCodes() {
    const btn = $('backup-generate');
    const out = $('backup-codes');
    btn.disabled = true;
    btn.textContent = 'Waiting for approval…';
    out.classList.add('hidden');

    try {
        const { request_id: requestId } = await Sync.requestBackupCodes();
        showToast('Approve the request in Telegram to continue.');

        clearInterval(backupPollTimer);
        const started = Date.now();

        backupPollTimer = setInterval(async () => {
            // The request itself expires after ten minutes on the server.
            if (Date.now() - started > 10 * 60 * 1000) {
                clearInterval(backupPollTimer);
                btn.disabled = false;
                btn.textContent = 'Generate codes';
                setSyncStatus('error', 'The approval request timed out.');
                return;
            }

            try {
                const res = await Sync.pollBackupCodes(requestId);
                if (res.status === 'approved' && res.codes) {
                    clearInterval(backupPollTimer);
                    showBackupCodes(res.codes);
                    btn.disabled = false;
                    btn.textContent = 'Generate new codes';
                    await refreshSyncModal();
                } else if (['declined', 'expired'].includes(res.status)) {
                    clearInterval(backupPollTimer);
                    btn.disabled = false;
                    btn.textContent = 'Generate codes';
                    showToast(
                        res.status === 'declined' ?
                        'The request was declined in Telegram.' :
                        'The request expired. Start it again.'
                    );
                }
            } catch (_) {}
        }, 2500);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Generate codes';
        showToast(err.message || 'Could not request backup codes.');
    }
}

function showBackupCodes(codes) {
    const out = $('backup-codes');
    out.classList.remove('hidden');
    out.innerHTML = `
      <div class="backup-warning">
        ${ICONS.warning}
        <span>These are shown once and cannot be retrieved again. Save them somewhere safe and offline. Each code works a single time.</span>
      </div>
      <div class="backup-code-grid">
        ${codes.map((c) => `<div class="backup-code">${c}</div>`).join('')}
      </div>
      <button class="btn btn-secondary" id="backup-copy" style="width:100%;justify-content:center">${ICONS.copy} Copy all codes</button>
    `;
    $('backup-copy').addEventListener('click', () => {
        navigator.clipboard
            .writeText(codes.join('\n'))
            .then(() => showToast('Backup codes copied.'))
            .catch(() => showToast('Copy failed. Write them down instead.'));
    });
}

async function doRedeem() {
    const input = $('redeem-input');
    const code = input.value.trim();
    if (!code) return;

    const btn = $('redeem-btn');
    btn.disabled = true;
    btn.textContent = 'Restoring…';

    try {
        const res = await Sync.redeemBackupCode(code);
        if (res.ok) {
            input.value = '';
            showToast(`Restored. You now have ${res.total} favourites.`);
            await refreshSyncModal();
        }
    } catch (err) {
        showToast((err.body && err.body.message) || 'That backup code is not valid.');
    }

    btn.disabled = false;
    btn.textContent = 'Restore';
}

function wireSync() {
    Sync.onChange(() => {
        updateSyncBadge();
        if (state.view === 'fav') renderFavourites();
    });

    $('syncBtn').addEventListener('click', () => {
        openModal('syncModal');
        refreshSyncModal();
    });

    $('backup-generate').addEventListener('click', doGenerateBackupCodes);
    $('redeem-btn').addEventListener('click', doRedeem);
    $('redeem-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doRedeem();
    });

    // Stop polling for an approval once the modal is out of the way.
    $('syncModal').addEventListener('click', (e) => {
        if (e.target === $('syncModal') || e.target.closest('[data-close-modal="syncModal"]')) {
            clearInterval(backupPollTimer);
        }
    });

    Sync.init();
    updateSyncBadge();
}

// ── PWA install
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

// ── Service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Init
(function init() {
    // reset content
    const inner = $('content-inner');
    inner.innerHTML = '';

    initTheme();
    hydrateIcons();
    updateThemeButtonIcon();
    buildThemeModal();
    wireModals();
    wireSync();

    getLocation();

    // expose globals for inline handlers
    window.getLocation = getLocation;
    window.fetchParking = fetchParking;
})();