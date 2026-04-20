// ── SVG Icons
const ICONS = {
    bike: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`,
    ybox: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
    parking: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`,
    umbrella: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 12a11.05 11.05 0 0 0-22 0zm-5 7a3 3 0 0 1-6 0v-7"/></svg>`,
    cloud: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
    warning: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>`,
    hash: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>`,
    ruler: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>`,
};

// ── State
const state = {
    userLat: null,
    userLng: null,
    searchLat: null,
    searchLng: null,
    radius: 0.5,
    results: [],
    filteredResults: [],
    theme: localStorage.getItem('sgbikes_theme') || 'classic',
    view: 'map', // 'map' | 'list'
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
    mapContainer: $('map-container'),
    listView: $('list-view'),
    contentInner: $('content-inner'),
    resultCount: $('result-count'),
    themeBtn: $('theme-btn'),
    themeModal: $('theme-modal'),
    detailModal: $('detail-modal'),
    mapModal: $('map-modal'),
    toast: $('toast'),
};

// ── Theme
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    state.theme = theme;
    localStorage.setItem('sgbikes_theme', theme);
    document.querySelectorAll('.theme-option').forEach((opt) => {
        opt.classList.toggle('active', opt.dataset.theme === theme);
    });
}

applyTheme(state.theme);

els.themeBtn.addEventListener('click', () => openModal(els.themeModal));

document.querySelectorAll('.theme-option').forEach((opt) => {
    opt.addEventListener('click', () => {
        applyTheme(opt.dataset.theme);
    });
});

// ── Toast
let toastTimer;

function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}

// ── Modal helpers
function openModal(el) {
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeModal(el) {
    el.classList.remove('open');
    document.body.style.overflow = '';
    if (el === els.mapModal) MapManager.destroyModal();
}

document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.closeModal);
        if (target) closeModal(target);
    });
});

document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay);
    });
});

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
els.viewMap.addEventListener('click', () => {
    state.view = 'map';
    els.viewMap.classList.add('active');
    els.viewList.classList.remove('active');
    els.mapContainer.style.display = '';
    $('list-view').classList.remove('active');
    setTimeout(() => MapManager.invalidateSize(), 100);
});

els.viewList.addEventListener('click', () => {
    state.view = 'list';
    els.viewList.classList.add('active');
    els.viewMap.classList.remove('active');
    els.mapContainer.style.display = 'none';
    $('list-view').classList.add('active');
    renderList();
});

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

        if (items.length) console.log('[sgbikes debug] raw API fields:', Object.keys(items[0]), items[0]);

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
        showToast(`Offline mode — showing cached data (${age}d old)`);
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

    pageItems.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'parking-card glass';
        const shelterBadge =
            item.ShelterIndicator === 'Y' ?
            `<span class="badge badge-shelter">${ICONS.umbrella} Sheltered</span>` :
            '';
        const rentalBadge =
            item.RackType === 'Yellow Box' ?
            `<span class="badge badge-rental">Rental Zone</span>` :
            '';
        card.innerHTML = `
      <div class="card-icon ${rackClass(item.RackType)}">${rackIcon(item.RackType)}</div>
      <div class="card-body">
        <div class="card-title">${item.Description}</div>
        <div class="card-meta">
          <span class="badge ${rackClass(item.RackType) === 'ybox' ? 'badge-ybox' : 'badge-rack'}">${item.RackType}</span>
          <span class="badge badge-count">${ICONS.hash} ${item.RackCount} lot${item.RackCount !== 1 ? 's' : ''}</span>
          ${shelterBadge}
          ${rentalBadge}
        </div>
        <div class="card-distance">${ICONS.ruler} ${fmtDist(item._dist)} away</div>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary" style="font-size:0.78rem;padding:6px 10px">Details →</button>
      </div>
    `;
        card.querySelector('button').addEventListener('click', () => showDetailModal(item));
        card.addEventListener('click', () => showDetailModal(item));
        lv.appendChild(card);
    });

    if (totalPages > 1) {
        const pager = document.createElement('div');
        pager.className = 'pagination';
        pager.innerHTML = `
      <button class="btn btn-secondary pagination-prev" ${page === 0 ? 'disabled' : ''}>← Prev</button>
      <span class="pagination-info">${page + 1} / ${totalPages}</span>
      <button class="btn btn-secondary pagination-next" ${page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
    `;
        pager.querySelector('.pagination-prev').addEventListener('click', () => {
            state.listPage--;
            renderList();
            lv.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        pager.querySelector('.pagination-next').addEventListener('click', () => {
            state.listPage++;
            renderList();
            lv.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        lv.appendChild(pager);
    }
}

// ── Detail modal
function showDetailModal(item) {
    state.currentDetail = item;

    $('detail-rack-icon').innerHTML = rackIcon(item.RackType);
    $('detail-title').textContent = item.Description;

    const shelterBadge =
        item.ShelterIndicator === 'Y' ?
        `<span class="badge badge-shelter">${ICONS.umbrella} Sheltered</span>` :
        `<span class="badge badge-other">${ICONS.cloud} Unsheltered</span>`;
    const rackBadge = `<span class="badge ${item.RackType === 'Yellow Box' ? 'badge-ybox' : 'badge-rack'}">${item.RackType}</span>`;
    $('detail-badges').innerHTML = rackBadge + shelterBadge;

    $('detail-rack-count').textContent = item.RackCount;
    $('detail-distance').textContent = state.searchLat ?
        fmtDist(item._dist) :
        '—';
    $('detail-coords').textContent = `${item.Latitude.toFixed(6)}, ${item.Longitude.toFixed(6)}`;

    $('detail-rental').style.display = item.RackType === 'Yellow Box' ? '' : 'none';

    // pan to marker
    if (state.view === 'map') {
        MapManager.panTo(item.Latitude, item.Longitude);
    }

    openModal(els.detailModal);
}

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
    closeModal(els.detailModal);
    openModal(els.mapModal);
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

// ── PWA install
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

// ── Service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/js/sw.js').catch(() => {});
}

// ── Init
(function init() {
    // reset content
    const inner = $('content-inner');
    inner.innerHTML = '';

    getLocation();

    // expose globals for inline handlers
    window.getLocation = getLocation;
    window.fetchParking = fetchParking;
})();