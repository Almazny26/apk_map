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
 *   - подписи источников на карте нет (заказчик убрал), источники перечислены в настройках
 *     (KartaMap.credits);
 *   - офлайн-карта районов (3.2): файлы PMTiles (векторные плитки OpenStreetMap, Protomaps, 0–15)
 *     рисует MapLibre GL через видеокарту — слой L.maplibreGL под остальными подложками. Плитки и
 *     шрифты подписей: на телефоне — прямо из оболочки (KartaFiles.mapTile / asset, свой
 *     «протокол» karta://, без сети), на компьютере — /omap/z/x/y.mvt и /vendor/fonts/.
 *     Внутри района «Схема» рисуется из файла сразу, интернет для неё не нужен; за границей
 *     района — OpenStreetMap из интернета (если включён) или вшитая карта 7–11.
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
    // у приложения рамка у всех canvas (для графика профиля) — у холста карты она не нужна
    '.leaflet-tile-pane canvas{border:0!important;border-radius:0!important;background:none!important;padding:0!important;margin:0!important}' +
    '.leaflet-gl-layer{position:absolute;left:0;top:0;z-index:2}';
  document.head.appendChild(css);
  var link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'vendor/maplibre-gl.css';
  document.head.appendChild(link);

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
  offlineTiles.setZIndex(0); osm.setZIndex(1); sat.setZIndex(3); hybSat.setZIndex(3); hybNames.setZIndex(4);   // офлайн-карта районов — 2

  // ---------------------------------------------------------------- «Онлайн» по умолчанию

  if (!localStorage.getItem(MIGRATED)) {
    localStorage.setItem(MIGRATED, '1');
    if (!online) { $('online').checked = true; applyOnline(true); }
  }


  // ---------------------------------------------------------------- офлайн-карта районов (MapLibre GL)

  var kf = window.KartaFiles, bridge = !!(kf && kf.mapTile);
  var gl = null, info = { files: [] }, key = '', schema = 'auto', glOk = null;
  function webgl() {
    if (glOk == null) {
      try {
        var c = document.createElement('canvas');
        glOk = !!(window.maplibregl && L.maplibreGL && window.KartaStyle && (c.getContext('webgl2') || c.getContext('webgl')));
      } catch (e) { glOk = false; }
    }
    return glOk;
  }
  function b64(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  // телефон: плитки и шрифты берутся прямо из оболочки, без сети
  if (bridge && window.maplibregl) {
    maplibregl.addProtocol('karta', function (params) {
      var s = '', m = /^karta:\/\/t\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
      try {
        if (m) s = kf.mapTile(+m[1], +m[2], +m[3]);
        else if ((m = /^karta:\/\/f\/(.+)\/(\d+-\d+)$/.exec(params.url))) s = kf.asset('vendor/fonts/' + decodeURIComponent(m[1]) + '/' + m[2] + '.pbf');
      } catch (e) { s = ''; }
      return Promise.resolve({ data: s ? b64(s) : new ArrayBuffer(0) });
    });
  }
  function style() {
    var s = JSON.parse(JSON.stringify(window.KartaStyle[document.body.classList.contains('dark') ? 'dark' : 'light']));
    s.glyphs = bridge ? 'karta://f/{fontstack}/{range}' : location.origin + '/vendor/fonts/{fontstack}/{range}.pbf';
    s.sources.p.tiles = [bridge ? 'karta://t/{z}/{x}/{y}?' + key : location.origin + '/omap/{z}/{x}/{y}.mvt?v=' + key];
    return s;
  }
  function readInfo(cb) {
    if (kf && kf.mapList) {
      var files = [];
      try { files = JSON.parse(kf.mapList()) || []; } catch (e) { files = []; }
      cb({ files: files });
    } else if (window.KartaPC) {
      fetch('/api/map').then(function (r) { return r.json(); }).then(function (st) { cb({ files: st.files || [] }); }, function () { cb({ files: [] }); });
    } else cb({ files: [] });
  }
  function loadVec(then) {
    readInfo(function (i) {
      var k = i.files.map(function (f) { return f.slug + '.' + f.size + '.' + f.mtime; }).join('_').replace(/[^0-9A-Za-z_.]/g, '');
      info = i;
      if (k !== key || (!gl && i.files.length)) {
        key = k;
        if (gl && map.hasLayer(gl)) map.removeLayer(gl);
        gl = null;
        if (i.files.length && webgl()) {
          try {
            gl = L.maplibreGL({ style: style(), padding: 0.12, interactive: false, fadeDuration: 0, validateStyle: false,
              pixelRatio: Math.min(window.devicePixelRatio || 1, 2), maxZoom: 22, renderWorldCopies: false });
          } catch (e) { gl = null; }
        }
      }
      sync();
      if (then) then(i);
    });
  }
  /* центр экрана внутри района, для которого есть офлайн-карта */
  function covered() {
    if (!gl || map.getZoom() < 7) return false;
    var c = map.getCenter();
    return info.files.some(function (f) { var b = f.bounds || []; return c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3]; });
  }
  function put(l, on, watch) {
    if (!l) return;
    var has = map.hasLayer(l);
    if (on && !has) { l.addTo(map); if (watch && typeof watchTiles === 'function') watchTiles(l); }
    else if (!on && has) map.removeLayer(l);
  }
  /* какие слои должны быть на карте сейчас */
  function sync() {
    var cov = covered(), sch = current === 'off';
    // вшитая карта 7–11 — в самом низу «Схемы»: видна там, где нет ничего лучше
    put(offlineTiles, sch);
    // интернет — где районов офлайн-карты нет (или так выбрано в настройках)
    put(osm, sch && online && !(cov && schema !== 'online'), true);
    // офлайн-карта районов: поверх схемы внутри района (или когда интернета нет), под снимками — всегда
    put(gl, !!gl && (sch ? (cov || !online) && !(online && schema === 'online') : true));
    put(sat, current === 'sat', true);
    put(hybrid, current === 'hyb', true);
  }
  map.on('moveend zoomend', sync);

  window.KartaMap = {
    info: function () { return { files: info.files, gl: webgl(), drawn: !!gl }; },
    reload: loadVec,
    note: function () {},                       // app.js подставляет всплывающее сообщение
    credits: 'Карты: © участники OpenStreetMap (офлайн-карта — сборка Protomaps), снимки © Esri, подписи на снимках © Яндекс.',
    setSchema: function (v) { schema = v === 'online' ? 'online' : 'auto'; sync(); },
    // тема сменилась — офлайн-карта перерисовывается в светлых или тёмных цветах
    retheme: function () {
      try { if (gl && gl.getMaplibreMap()) gl.getMaplibreMap().setStyle(style()); } catch (e) { /* слой ещё не на карте */ }
    }
  };

  // ---------------------------------------------------------------- выбор подложки

  $('mapOff').textContent = 'Схема';
  var current = localStorage.getItem(KIND) || 'off';

  window.useMap = function (kind) {
    current = kind === 'sat' || kind === 'hyb' ? kind : 'off';
    sync();
    $('mapOff').classList.toggle('on', current === 'off');
    $('mapSat').classList.toggle('on', current === 'sat');
    $('mapHyb').classList.toggle('on', current === 'hyb');
    try { localStorage.setItem(KIND, current); } catch (e) { /* не важно */ }
    if (current !== 'off' && !online) window.KartaMap.note('Интернет для карты выключен: снимки видны только там, где их уже открывали');
  };

  // выключатель «Карта из интернета» сразу меняет подложку
  var applyOrig = window.applyOnline;
  window.applyOnline = function (on) {
    var r = applyOrig.apply(this, arguments);
    sync();
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
