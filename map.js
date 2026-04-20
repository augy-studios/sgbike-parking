const MapManager = (() => {
    let mainMap = null;
    let modalMap = null;
    let markersLayer = null;
    let userMarker = null;
    let radiusCircle = null;
    let modalMarker = null;

    // Icon factory
    function makeIcon(type, sheltered) {
        const emoji = type === 'Yellow Box' ? '🟨' : '🟢';
        const shade = type === 'Yellow Box' ? '#f57f17' : '#2e7d32';
        const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
        <defs>
          <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.3"/>
          </filter>
        </defs>
        <ellipse cx="18" cy="40" rx="5" ry="2.5" fill="rgba(0,0,0,0.18)"/>
        <path d="M18 2 C10 2 4 8 4 16 C4 26 18 38 18 38 C18 38 32 26 32 16 C32 8 26 2 18 2Z"
              fill="${shade}" filter="url(#s)"/>
        <text x="18" y="20" text-anchor="middle" font-size="14">${type === 'Yellow Box' ? '🅱' : '🚲'}</text>
        ${sheltered ? `<circle cx="28" cy="6" r="6" fill="#0277bd"/><text x="28" y="10" text-anchor="middle" font-size="8" fill="#fff">☂</text>` : ''}
      </svg>
    `;
        return L.divIcon({
            html: svg,
            className: '',
            iconSize: [36, 44],
            iconAnchor: [18, 44],
            popupAnchor: [0, -44],
        });
    }

    function makeUserIcon() {
        const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="rgba(34,187,34,0.2)" stroke="#22bb22" stroke-width="2"/>
        <circle cx="12" cy="12" r="5" fill="#22bb22"/>
      </svg>
    `;
        return L.divIcon({
            html: svg,
            className: '',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
        });
    }

    function initMain(lat, lng) {
        if (mainMap) return;
        mainMap = L.map('main-map', {
            center: [lat, lng],
            zoom: 16,
            zoomControl: true,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19,
        }).addTo(mainMap);

        markersLayer = L.layerGroup().addTo(mainMap);
    }

    function setUserLocation(lat, lng, radiusKm) {
        if (!mainMap) return;

        if (userMarker) userMarker.remove();
        if (radiusCircle) radiusCircle.remove();

        userMarker = L.marker([lat, lng], {
                icon: makeUserIcon(),
                zIndexOffset: 1000
            })
            .addTo(mainMap)
            .bindPopup('<div class="popup-title">📍 Your Location</div>');

        radiusCircle = L.circle([lat, lng], {
            radius: radiusKm * 1000,
            color: '#22bb22',
            fillColor: '#22bb22',
            fillOpacity: 0.06,
            weight: 2,
            dashArray: '6 4',
        }).addTo(mainMap);

        mainMap.setView([lat, lng], 16);
    }

    function plotResults(results, onSelect) {
        if (!markersLayer) return;
        markersLayer.clearLayers();

        results.forEach((item) => {
            const sheltered = item.ShelterIndicator === 'Y';
            const icon = makeIcon(item.RackType, sheltered);
            const marker = L.marker([item.Latitude, item.Longitude], {
                    icon
                })
                .addTo(markersLayer);

            const shelter = sheltered ? '<span style="color:#0277bd">☂ Sheltered</span>' : 'Unsheltered';
            marker.bindPopup(`
        <div class="popup-title">${item.Description}</div>
        <div class="popup-meta">
          🚲 ${item.RackType} · ${item.RackCount} lot${item.RackCount !== 1 ? 's' : ''}<br>
          ${shelter}
        </div>
        <button class="popup-btn" onclick="window._selectParking('${encodeURIComponent(JSON.stringify(item))}')">
          View Details &amp; Navigate →
        </button>
      `);
        });

        // expose callback
        window._selectParking = (encoded) => {
            const item = JSON.parse(decodeURIComponent(encoded));
            onSelect(item);
        };
    }

    function panTo(lat, lng) {
        if (!mainMap) return;
        mainMap.setView([lat, lng], 17);
    }

    function invalidateSize() {
        if (mainMap) mainMap.invalidateSize();
    }

    // Modal map
    function initModal(lat, lng) {
        if (modalMap) {
            modalMap.remove();
            modalMap = null;
            modalMarker = null;
        }
        setTimeout(() => {
            modalMap = L.map('modal-map', {
                center: [lat, lng],
                zoom: 17,
                zoomControl: false
            });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19,
            }).addTo(modalMap);
            modalMarker = L.marker([lat, lng]).addTo(modalMap);
        }, 150);
    }

    function destroyModal() {
        if (modalMap) {
            modalMap.remove();
            modalMap = null;
        }
    }

    return {
        initMain,
        setUserLocation,
        plotResults,
        panTo,
        invalidateSize,
        initModal,
        destroyModal
    };
})();