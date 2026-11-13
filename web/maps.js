/* Карта сети — подложка карты.
 *
 * Подключается после кода приложения. У приложения товарища без интернета видна только вшитая
 * офлайн-карта (Крым, Херсон, Запорожье, Ставрополье, масштаб 7–11). Здесь:
 *   - «Схема» — подробная карта OpenStreetMap из интернета, масштаб от 3 до 19, вся Земля;
 *     под ней вшитая офлайн-карта: без связи видно хотя бы её (а на телефоне и на компьютере —
 *     ещё и всё, что уже открывали с интернетом: оболочка и программа хранят плитки);
 *   - «Спутник», «Гибрид» — как у приложения, до масштаба 19;
 *   - выбранная подложка запоминается (karta_map);
 *   - при первом запуске новой версии включается «Онлайн» (заказчик: «пусть карта прогружается
 *     из сети»); выключить можно той же галочкой;
 *   - внизу справа подпись источника карты (условие OpenStreetMap и Esri);
 *   - офлайн-карта районов (3.0): файл karta-offline.pmtiles — векторные плитки OpenStreetMap
 *     (Protomaps) до масштаба 15, страница рисует их сама до 19. Есть файл — он лежит под всеми
 *     подложками (вместо вшитой карты 7–11), а без интернета «Схема» рисуется только из него.
 *     Телефон отдаёт куски файла через KartaFiles.mapBytes, компьютер — через /api/mapbytes.
 */
(function () {
  'use strict';
  if (!window.L || typeof map === 'undefined' || typeof offlineTiles === 'undefined') return;

  var KIND = 'karta_map', MIGRATED = 'karta_maps_v';
  var $ = function (id) { return document.getElementById(id); };
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // ---------------------------------------------------------------- масштаб без ограничений

  map.setMinZoom(3);
  map.setMaxZoom(19);
  offlineTiles.options.maxZoom = 19;          // выше 11 — увеличенные плитки, лучше, чем пусто
  offlineTiles.options.maxNativeZoom = 11;
  offlineTiles.setZIndex(0);

  offlineTiles.options.attribution = '&copy; участники OpenStreetMap';   // одна подпись вместо двух
  var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    minZoom: 3, maxZoom: 19, maxNativeZoom: 19, zIndex: 1, errorTileUrl: BLANK,
    attribution: '&copy; участники OpenStreetMap'
  });
  [sat, hybSat].forEach(function (l) {
    l.options.attribution = 'Снимки &copy; Esri'; l.options.errorTileUrl = BLANK; l.setZIndex(2);
    // где снимка такого масштаба нет, Esri по умолчанию отдаёт картинку «Map data not yet available»;
    // с blankTile=false — ошибку, и тогда показывается увеличенный снимок мельче (см. ниже).
    // На компьютере адрес уже заменён на программу (pc.js), она добавляет параметр сама.
    if (/^https:\/\/server\.arcgisonline\.com\//.test(l._url) && l._url.indexOf('blankTile') < 0) l.setUrl(l._url + '?blankTile=false', true);
  });
  hybNames.options.attribution = 'Подписи &copy; Яндекс';
  hybNames.options.errorTileUrl = BLANK;
  hybNames.setZIndex(3);

  var css = document.createElement('style');
  css.textContent =
    // у приложения рамка у всех canvas (для графика профиля) — у плиток офлайн-карты она давала сетку
    '.leaflet-tile-pane canvas{border:0!important;border-radius:0!important;background:none!important;padding:0!important;margin:0!important}' +
    '.leaflet-container .leaflet-control-attribution.nm-attr{display:block!important;font-size:10px;background:rgba(255,255,255,.75);padding:0 4px}' +
    'body.dark .leaflet-container .leaflet-control-attribution.nm-attr{background:rgba(0,0,0,.55);color:#ccc}' +
    'body.dark .leaflet-container .leaflet-control-attribution.nm-attr a{color:#9ecbff}';
  document.head.appendChild(css);
  var attr = L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);
  L.DomUtil.addClass(attr.getContainer(), 'nm-attr');

  // ---------------------------------------------------------------- плитки не пришли — показать крупнее

  /* Если плитки нет (снимка такого масштаба нет или связь оборвалась), вместо пустого квадрата
   * берётся плитка на 1–5 уровней мельче, и из неё вырезается и растягивается нужная четверть.
   * Мельче плитки обычно уже есть в запасе, поэтому карта не превращается в лоскутное одеяло. */
  function fallback(layer) {
    var create = layer.createTile;
    layer.createTile = function (coords, done) {
      var t = create.call(this, coords, done);
      t._kc = { x: coords.x, y: coords.y, z: coords.z };
      return t;
    };
    layer._tileOnError = function (done, tile, e) {
      var c = tile._kc, up = (tile._kup || 0) + 1, z = c && c.z - up;
      if (!c || up > 5 || z < 1) return L.TileLayer.prototype._tileOnError.call(this, done, tile, e);
      tile._kup = up;
      var k = 1 << up, x = c.x >> up, y = c.y >> up, ts = this.getTileSize().x, part = ts / k;
      var ox = (c.x - x * k) * part, oy = (c.y - y * k) * part;
      var url = L.Util.template(this._url, L.extend({ s: this._getSubdomain({ x: x, y: y }), x: x, y: y, z: z, r: '' }, this.options));
      if (window.__kartaTileUrl) url = window.__kartaTileUrl(url, x, y);
      if (tile._kbase == null) tile._kbase = tile.style.transform || '';
      tile.style.transformOrigin = '0 0';
      tile.style.transform = tile._kbase + ' translate(' + (-ox * k) + 'px,' + (-oy * k) + 'px) scale(' + k + ')';
      tile.style.clipPath = 'inset(' + oy + 'px ' + (ts - ox - part) + 'px ' + (ts - oy - part) + 'px ' + ox + 'px)';
      tile.src = url;
    };
  }
  [osm, sat, hybSat].forEach(fallback);

  // ---------------------------------------------------------------- «Онлайн» по умолчанию

  if (!localStorage.getItem(MIGRATED)) {
    localStorage.setItem(MIGRATED, '1');
    if (!online) { $('online').checked = true; applyOnline(true); }
  }


  // ---------------------------------------------------------------- офлайн-карта районов (векторная)

  var vec = null, vecInfo = { present: false };
  function b64(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function makeSource(key) {
    var kf = window.KartaFiles;
    if (kf && kf.mapBytes) return {
      getKey: function () { return key; },
      getBytes: function (o, l) {
        var s = kf.mapBytes(o, l);
        return s == null || s === '' ? Promise.reject(new Error('нет данных')) : Promise.resolve({ data: b64(s) });
      }
    };
    return {
      getKey: function () { return key; },
      getBytes: function (o, l, signal) {
        return fetch('/api/mapbytes?o=' + o + '&l=' + l, { signal: signal }).then(function (r) {
          if (!r.ok) throw new Error('нет данных');
          return r.arrayBuffer();
        }).then(function (d) { return { data: d }; });
      }
    };
  }
  function vecLayer(info) {
    if (!window.protomapsL) return null;
    var src = new protomapsL.PmtilesSource('karta-offline.pmtiles', true);
    src.p.source = makeSource('karta-offline-' + info.size + '-' + (info.mtime || 0));
    var dark = document.body.classList.contains('dark');
    var bg = dark ? '#1f1f1f' : '#e2dfda';   // фон плитки — цвет суши (море рисуется поверх)
    var l = protomapsL.leafletLayer({ url: src.p, flavor: dark ? 'dark' : 'light', lang: 'ru', maxDataZoom: 15, minZoom: 3, maxZoom: 19,
      attribution: '&copy; участники OpenStreetMap' });
    l.backgroundColor = bg;
    l.options.className = 'karta-vec';   // в тёмной теме карта уже тёмная — приглушать её не надо
    l.setZIndex && l.setZIndex(0);
    return l;
  }
  function readInfo(cb) {
    var kf = window.KartaFiles;
    if (kf && kf.mapSize) {
      var size = +kf.mapSize() || 0;
      cb(size > 0 ? { present: true, size: size, mtime: +(kf.mapDate ? kf.mapDate() : 0) || 0 } : { present: false });
      return;
    }
    if (window.KartaPC) {
      fetch('/api/map').then(function (r) { return r.json(); }).then(cb, function () { cb({ present: false }); });
      return;
    }
    cb({ present: false });
  }
  function loadVec(then) {
    readInfo(function (info) {
      var same = vec && vecInfo.present && info.present && info.size === vecInfo.size && info.mtime === vecInfo.mtime;
      vecInfo = info;
      if (!same) {
        if (vec && map.hasLayer(vec)) map.removeLayer(vec);
        vec = info.present ? vecLayer(info) : null;
      }
      useMap(current);
      if (then) then(info);
    });
  }
  /* нет связи: галочка «Онлайн» снята или телефон/компьютер сообщает, что сети нет */
  function noNet() { return !online || navigator.onLine === false; }
  window.addEventListener('online', function () { useMap(current); });
  window.addEventListener('offline', function () { useMap(current); });
  window.KartaMap = { info: function () { return vecInfo; }, reload: loadVec,
    // тема сменилась — офлайн-карта перерисовывается в светлых или тёмных цветах
    retheme: function () {
      if (!vec) return;
      if (map.hasLayer(vec)) map.removeLayer(vec);
      vec = vecLayer(vecInfo);
      useMap(current);
    } };

  // ---------------------------------------------------------------- выбор подложки

  $('mapOff').textContent = 'Схема';
  var current = localStorage.getItem(KIND) || 'off', busy = false;

  window.useMap = function (kind) {
    if (busy) return;
    busy = true;
    try {
      current = kind === 'sat' || kind === 'hyb' ? kind : 'off';
      if (current !== 'off' && !online) { $('online').checked = true; applyOnline(true); }
      [osm, sat, hybrid].forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
      // подложка: офлайн-карта районов, если файл есть; иначе вшитая схема 7–11 (только под «Схемой»:
      // под снимками она давала лоскуты)
      var under = vec || (current === 'off' ? offlineTiles : null);
      [offlineTiles, vec].forEach(function (l) { if (l && l !== under && map.hasLayer(l)) map.removeLayer(l); });
      if (under && !map.hasLayer(under)) under.addTo(map);
      // без связи «Схема» рисуется только из файла — без лоскутов из запаса
      var layer = current === 'sat' ? sat : current === 'hyb' ? hybrid : (online && !(vec && noNet()) ? osm : null);
      if (layer) { layer.addTo(map); if (typeof watchTiles === 'function') watchTiles(layer); }
      $('mapOff').classList.toggle('on', current === 'off');
      $('mapSat').classList.toggle('on', current === 'sat');
      $('mapHyb').classList.toggle('on', current === 'hyb');
      try { localStorage.setItem(KIND, current); } catch (e) { /* не важно */ }
      if (current === 'sat') status('Спутник. Нужен интернет, открытое ранее видно и без него.');
      else if (current === 'hyb') status('Гибрид: снимок и подписи. Нужен интернет, открытое ранее видно и без него.');
      else if (online) status('Схема: подробная карта из интернета. Открытое ранее видно и без связи.');
      else status(vec ? 'Без интернета: офлайн-карта районов.' : 'Без интернета: офлайн-карта (Крым, Херсон, Запорожье, Ставрополье) и то, что открывали раньше.');
    } finally { busy = false; }
  };

  // галочка «Онлайн» сразу меняет подложку
  var applyOrig = window.applyOnline;
  window.applyOnline = function (on) {
    var r = applyOrig.apply(this, arguments);
    if (!busy) useMap(current);
    return r;
  };

  // у приложения на масштабе больше 11 было сообщение «офлайн-карта до зума 11» — теперь не нужно
  var evs = map._events && map._events.zoomend;
  if (evs) evs.slice().forEach(function (h) {
    if (h && h.fn && String(h.fn).indexOf('зума 11') >= 0) map.off('zoomend', h.fn, h.ctx);
  });

  useMap(current);
  loadVec();
  status('');
})();
