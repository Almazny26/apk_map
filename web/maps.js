/* Карта сети — подложка карты.
 *
 *   - офлайн-схема левого берега (PMTiles, векторные плитки OpenStreetMap и Protomaps, масштаб 0–15)
 *     рисуется MapLibre GL через видеокарту, слоем под остальными. Плитки и шрифты подписей на
 *     телефоне идут прямо из оболочки (tileAsync, «протокол» karta://, без сети), на компьютере —
 *     /omap/z/x/y.mvt и /vendor/fonts/. Без WebGL та же схема рисуется на холсте (protomaps-leaflet);
 *   - телефон со связью: «Схема» внутри левобережья — вшитая, за его границей — OpenStreetMap из
 *     интернета; «Спутник», «Гибрид» — снимки Esri и подписи Яндекса, до масштаба 19;
 *   - телефон без связи: везде вшитая схема (3.5.3: растровая карта 7–11 убрана), вне её — подсказка;
 *   - компьютер: только офлайн-схема, в интернет страница не ходит;
 *   - выбранная подложка запоминается (karta_map); источники перечислены в настройках (KartaMap.credits).
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
  if (map.hasLayer(offlineTiles)) map.removeLayer(offlineTiles);   // старая растровая карта 7–11 убрана в 3.5.3
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
    '.leaflet-tile-pane canvas,.karta-gl canvas{border:0!important;border-radius:0!important;background:none!important;padding:0!important;margin:0!important}' +
    '.karta-gl{position:absolute!important;left:0;top:0;width:100%;height:100%;z-index:0}.karta-gl canvas{outline:none}';
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
      if (tile._kbase == null) tile._kbase = tile.style.transform || '';
      tile.style.transformOrigin = '0 0';
      tile.style.transform = tile._kbase + ' translate(' + (-ox * k) + 'px,' + (-oy * k) + 'px) scale(' + k + ')';
      tile.style.clipPath = 'inset(' + oy + 'px ' + (ts - ox - part) + 'px ' + (ts - oy - part) + 'px ' + ox + 'px)';
      tile.src = url;
    };
  }
  [osm, sat, hybSat].forEach(fallback);
  osm.setZIndex(1); sat.setZIndex(3); hybSat.setZIndex(3); hybNames.setZIndex(4);

  // ---------------------------------------------------------------- поворот двумя пальцами — не сразу

  /* leaflet-rotate 0.6 вызывает _onZoomTransitionEnd на каждом движении пальцев
   * через _animateZoomNoDelay. Это запускает zoomend/moveend посреди жеста:
   * карта перегружает плитки, а схема перестраивает маркеры. Сам _onTouchMove
   * уже применяет дробный масштаб через _move(..., {pinch:true, round:false}).
   * Оставляем этот кадр, завершение и привязку масштаба — штатному _onTouchEnd. */
  (function () {
    var frame = map._animateZoomNoDelay;
    if (!frame) return;
    map._animateZoomNoDelay = function () {
      if (this.touchGestures && this.touchGestures._gesture === 'pinch') return;
      return frame.apply(this, arguments);
    };
  })();

  /* Плагин поворачивает карту при любом движении двух пальцев, и обычное изменение масштаба чуть
   * сбивало север. Теперь поворот начинается, только когда пальцы провернулись больше чем на 10°
   * (как в привычных картах); до этого меняется один масштаб. */
  (function () {
    var TG = L.Map.TouchGestures && L.Map.TouchGestures.prototype;
    if (!TG || !TG._onTouchMove) return;
    var move = TG._onTouchMove, FREE = 10;
    function ang(a, b) { return Math.atan2(a.x - b.x, a.y - b.y) * 180 / Math.PI; }
    TG._onTouchMove = function (e) {
      if (this._kStart !== this._startP1) { this._kStart = this._startP1; this._kFree = false; }      // новый жест
      if (!this._rotating || this._kFree || !this._startP1 || !this._startP2 || !e.touches || e.touches.length !== 2) return move.apply(this, arguments);
      var t = e.touches, rot = ang({ x: t[0].clientX, y: t[0].clientY }, { x: t[1].clientX, y: t[1].clientY }) - ang(this._startP1, this._startP2);
      rot = ((rot + 180) % 360 + 360) % 360 - 180;
      if (Math.abs(rot) >= FREE) {
        this._kFree = true;
        this._startBearing += rot;            // поворот считается от этого положения пальцев — без рывка
        return move.apply(this, arguments);
      }
      this._rotating = false;
      try { return move.apply(this, arguments); } finally { this._rotating = true; }
    };
  })();

  // ---------------------------------------------------------------- интернет включён всегда

  /* Выключателя «Карта из интернета» больше нет (заказчик, 3.3): есть связь — карта грузится, нет —
   * показывается загруженное. Флажок приложения товарища просто всегда включён. */
  var offlineOnly = !!window.KartaOfflineOnly;
  $('online').checked = !offlineOnly;
  if (online !== !offlineOnly) applyOnline(!offlineOnly);

  // ---------------------------------------------------------------- офлайн-карта районов (MapLibre GL)

  /* Файлы схемы (.pmtiles, векторные плитки): в приложении — вшитая схема левобережья, на ПК — папка map.
   * В «Спутнике» и «Гибриде» MapLibre остаётся под снимками из интернета: пока они не пришли, видна схема. */
  function inBox(f, lat, lng) { var b = f.bounds || []; return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]; }
  function files(kind) { return info.files.filter(function (f) { return (f.kind === 'sat') === (kind === 'sat'); }); }
  function hasVec() { return files('map').length > 0; }
  var kf = window.KartaFiles, bridge = !!(kf && kf.mapTile);
  var GLKEY = 'karta_gl';      // 'off' — схема всегда упрощённая, без WebGL (выбрано в «Проверке карты»)
  var gl = null, info = { files: [] }, infoLoaded = false, key = '', schema = 'auto', glOk = null;
  var current = window.KartaPC ? 'off' : localStorage.getItem(KIND) || 'off'; // ПК — только схема; Android сохраняет выбор подложки.
  function webgl() {
    if (glOk == null) {
      try {
        var c = document.createElement('canvas');
        var forced = false;
        try { forced = localStorage.getItem(GLKEY) === 'off' || /[?&]nogl=1/.test(location.search); } catch (e) { forced = false; }
        glOk = !forced && !!(window.maplibregl && window.KartaStyle && c.getContext('webgl2'));   // MapLibre 5 работает только с WebGL 2
      } catch (e) { glOk = false; }
    }
    return glOk;
  }
  function b64(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  // телефон: плитки и шрифты из оболочки в фоне (и для MapLibre, и для упрощённой схемы без WebGL)
  /* Ответ оболочки — в фоне (tileAsync → window.__kartaTile): пока Java читает плитку, страница
   * и жесты не ждут. Base64 раскладывается в байты тоже без остановки страницы (fetch data:). */
  var pend = {}, seq = 0;
  if (bridge) window.__kartaTile = function (id, s) { var f = pend[id]; if (f) { delete pend[id]; f(s); } };
  function ask(kind, z, x, y, path, ac) {
    return new Promise(function (done) {
      var id = ++seq, sig = ac && ac.signal;
      pend[id] = done;
      if (sig) sig.addEventListener('abort', function () {
        if (!pend[id]) return;
        delete pend[id];
        try { kf.tileCancel(id); } catch (e) { /* нет */ }
        done('');
      });
      try { kf.tileAsync(id, kind, z, x, y, path || ''); } catch (e) { delete pend[id]; done(''); }
    });
  }
  function bytes(s) {
    if (!s) return Promise.resolve(new ArrayBuffer(0));
    return fetch('data:application/octet-stream;base64,' + s).then(function (r) { return r.arrayBuffer(); }, function () { return b64(s); });
  }
  if (bridge && window.maplibregl) {
    maplibregl.addProtocol('karta', function (params, ac) {
      var u = params.url, m, got;
      if (kf.tileAsync) {
        if ((m = /^karta:\/\/t\/(\d+)\/(\d+)\/(\d+)/.exec(u))) got = ask('t', +m[1], +m[2], +m[3], '', ac);
        else if ((m = /^karta:\/\/f\/(.+)\/(\d+-\d+)$/.exec(u))) got = ask('f', 0, 0, 0, 'vendor/fonts/' + decodeURIComponent(m[1]) + '/' + m[2] + '.pbf', ac);
        else got = Promise.resolve('');
        return got.then(bytes).then(function (d) { return { data: d }; });
      }
      // старая оболочка — как раньше, синхронно
      var s = '';
      try {
        if ((m = /^karta:\/\/t\/(\d+)\/(\d+)\/(\d+)/.exec(u))) s = kf.mapTile(+m[1], +m[2], +m[3]);
        else if ((m = /^karta:\/\/f\/(.+)\/(\d+-\d+)$/.exec(u))) s = kf.asset('vendor/fonts/' + decodeURIComponent(m[1]) + '/' + m[2] + '.pbf');
      } catch (e) { s = ''; }
      return Promise.resolve({ data: s ? b64(s) : new ArrayBuffer(0) });
    });
  }
  function union(list) {
    var b = [180, 85, -180, -85];
    list.forEach(function (f) { var x = f.bounds || [-180, -85, 180, 85]; b = [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])]; });
    return b;
  }
  function style() {
    var theme = document.body.classList.contains('dark') ? 'dark' : 'light';
    var palette = richStyle() ? window.KartaStylePC : window.KartaStyle;
    var s = JSON.parse(JSON.stringify(palette[theme]));
    var cur = shown(), vec = hasVec(), all = s.layers;
    s.glyphs = bridge ? 'karta://f/{fontstack}/{range}' : location.origin + '/vendor/fonts/{fontstack}/{range}.pbf';
    s.sources.p.tiles = [bridge ? 'karta://t/{z}/{x}/{y}?' + key : location.origin + '/omap/{z}/{x}/{y}.mvt?v=' + key];
    if (vec) { s.sources.p.bounds = union(files('map')); s.sources.p.maxzoom = Math.max.apply(null,files('map').map(function (f) { return f.maxzoom || 15; })); }
    else { delete s.sources.p; all = []; }
    if (window.__kartaTestBadLayer) all.splice(3, 0, window.__kartaTestBadLayer);   // только для проверки самолечения
    s.layers = all.filter(function (l) { return !skipLayers[l.id]; });
    if (richStyle() && window.KartaCoverage && !skipLayers['coverage-mask']) {
      s.sources.coverage = {type:'geojson',data:{type:'Feature',properties:{},geometry:KartaCoverage.mask},tolerance:0};
      s.layers.push({id:'coverage-mask',type:'fill',source:'coverage',paint:{'fill-color':theme === 'dark' ? '#171a1f' : '#e4e2dd','fill-antialias':false}});
    }
    lastLayers = s.layers.slice();
    return s;
  }
  /* Схема левобережья с подробными слоями (та же, что на ПК): на ПК и в приложении со вшитой картой */
  function richStyle() { return !!window.KartaStylePC && (!!window.KartaPC || info.files.some(function (f) { return f.builtin; })); }
  /* Связь: есть — подложки из интернета; нет — только офлайн-схема ,
   * без ожидания плиток, которые всё равно не придут. Оболочка сообщает о смене сети сама. */
  var netUp = true;
  try { netUp = kf && kf.networkUp ? !!kf.networkUp() : navigator.onLine !== false; } catch (e) { netUp = true; }
  function shown() { return netUp ? current : 'off'; }
  function setNet(up) {
    up = !!up;
    if (up === netUp) return;
    netUp = up;
    if (!window.KartaPC && current !== 'off') KartaMap.note(up ? 'Связь появилась — снимки снова загружаются' : 'Нет связи — показана офлайн-схема');
    kindsUi();
    sync();
    if (window.KartaApp && KartaApp.mapChanged) KartaApp.mapChanged();
  }
  window.__kartaNet = setNet;
  window.addEventListener('online', function () { if (!(kf && kf.networkUp)) setNet(true); });
  window.addEventListener('offline', function () { if (!(kf && kf.networkUp)) setNet(false); });
  function kindsUi() {
    ['mapSat', 'mapHyb'].forEach(function (id) { var b = $(id); if (b) b.classList.toggle('dis', !netUp); });
  }
  var styled = '';
  function restyle() {
    var k = shown() + (document.body.classList.contains('dark') ? 'd' : 'l');
    if (!gl || k === styled) return;
    styled = k;
    // без «diff»: стиль заменяется целиком — частично применённая разница ломала подписи MapLibre
    try { gl.setStyle(style(), { diff: false }); heal(gl); } catch (e) { /* карта ещё не готова */ }
  }
  function readInfo(cb) {
    if (kf && kf.mapList) {
      var files = [];
      try { files = JSON.parse(kf.mapList()) || []; } catch (e) { files = []; }
      cb({ files: files });
    } else if (window.KartaPC) {
      fetch('/api/map').then(function (r) { return r.json(); }).then(function (st) { cb({ files: (st.files || []).filter(function (f) { return f.kind !== 'sat'; }) }); }, function () { cb({ files: [] }); });
    } else cb({ files: [] });
  }
  /* Слой офлайн-карты — карта MapLibre в неподвижном блоке под всеми слоями Leaflet. Она повторяет
   * центр, масштаб и поворот основной карты (у MapLibre масштаб на 1 меньше, поворот — в другую
   * сторону); при плавной смене масштаба едет сама за то же время, что и остальные слои. */
  var glDiv = null, zooming = false;
  function bearing() { return map.getBearing ? -map.getBearing() : 0; }
  function follow() {
    if (!gl || zooming || glDiv.style.display === 'none') return;
    var c = map.getCenter();
    gl.jumpTo({ center: [c.lng, c.lat], zoom: map.getZoom() - 1, bearing: bearing() });
  }
  function ease(t) {                       // как у Leaflet: cubic-bezier(0, 0, .25, 1)
    var lo = 0, hi = 1, u = t, i, x;
    for (i = 0; i < 20; i++) { u = (lo + hi) / 2; x = 3 * u * u * (1 - u) * 0.25 + u * u * u; if (x < t) lo = u; else hi = u; }
    return 3 * u * (1 - u) * (1 - u) * 0 + 3 * u * u * (1 - u) * 1 + u * u * u;
  }
  function makeGl() {
    if (!glDiv) {
      glDiv = document.createElement('div');
      glDiv.className = 'karta-gl';
      var mc = map.getContainer();
      mc.insertBefore(glDiv, mc.firstChild);
      // Leaflet emits both zoom and move for a single pinch frame.
      map.on('move rotate', follow);
      map.on('resize', function () { if (gl) { gl.resize(); follow(); } });
      map.on('zoomanim', function (e) {
        if (!gl || glDiv.style.display === 'none') return;
        zooming = true;
        gl.easeTo({ center: [e.center.lng, e.center.lat], zoom: e.zoom - 1, bearing: bearing(), duration: 250, easing: ease });
      });
      map.on('zoomend', function () { zooming = false; if (gl) gl.stop(); follow(); });
    }
    var c = map.getCenter();
    styled = shown() + (document.body.classList.contains('dark') ? 'd' : 'l');
    return new maplibregl.Map({ container: glDiv, style: style(), center: [c.lng, c.lat], zoom: map.getZoom() - 1, bearing: bearing(),
      interactive: false, attributionControl: false, fadeDuration: 0, validateStyle: false, maxZoom: 22, renderWorldCopies: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
  }
  /* Запасной путь без WebGL (выключен в браузере, видеокарта в чёрном списке, старый WebView):
   * та же схема из тех же плиток рисуется на холсте Leaflet (protomaps-leaflet) — проще, без рельефа
   * и маски области, но карта не пустая. Библиотека грузится только в этом случае. */
  var raster = null, rasterWant = false, rasterTheme = '';
  function loadRaster(cb) {
    if (window.protomapsL) { cb(); return; }
    if (loadRaster.busy) return;
    loadRaster.busy = true;
    var sc = document.createElement('script');
    sc.src = 'vendor/protomaps-leaflet.js';
    sc.onload = function () { loadRaster.busy = false; cb(); };
    sc.onerror = function () { loadRaster.busy = false; };
    document.head.appendChild(sc);
  }
  function makeRaster() {
    var dark = document.body.classList.contains('dark'), list = files('map');
    var src = bridge ? { getZxy: function (z, x, y, signal) {
      // как у MapLibre: плитка приходит из оболочки в фоне (tileAsync), страница не ждёт Java
      if (kf.tileAsync) return ask('t', z, x, y, '', signal ? { signal: signal } : null)
        .then(function (t) { return t ? bytes(t).then(function (d) { return { data: d }; }) : undefined; });
      var t = '';
      try { t = kf.mapTile(z, x, y); } catch (e) { t = ''; }
      return Promise.resolve(t ? { data: b64(t) } : undefined);
    } } : location.origin + '/omap/{z}/{x}/{y}.mvt?v=' + key;
    rasterTheme = dark ? 'd' : 'l';
    var l = protomapsL.leafletLayer({ url: src, flavor: dark ? 'dark' : 'light', lang: 'ru', attribution: '',
      maxDataZoom: Math.max.apply(null, list.map(function (f) { return f.maxzoom || 15; })), maxZoom: 22, noWrap: true,
      bounds: L.latLngBounds([[union(list)[1], union(list)[0]], [union(list)[3], union(list)[2]]]) });
    l.setZIndex(0);
    return l;
  }
  /* Наблюдение за схемой: ошибки MapLibre, пришедшие плитки, потеря WebGL. Если за 12 секунд внутри
   * области схемы не пришло ни одной плитки — сверху кнопка «Проверка карты» (что именно не так). */
  var stat = { errors: [], tiles: 0, lost: 0, restored: 0, since: 0 }, lostT = 0, watchT = 0;
  function watchGl(m) {
    stat.since = Date.now(); stat.tiles = 0;
    m.on('style.load', function () { heal(m, 99); });
    m.on('error', function (e) {
      var t = e && e.error && (e.error.message || String(e.error));
      if (t && stat.errors.length < 8 && stat.errors.indexOf(t) < 0) stat.errors.push(t);
    });
    m.on('sourcedata', function (e) { if (e && e.sourceId === 'p' && e.tile) stat.tiles++; });
    // видеодрайвер отобрал WebGL (сбой, сон, «exit_on_context_lost»): ждём восстановления 3 с, затем — холст
    m.on('webglcontextlost', function () { stat.lost++; clearTimeout(lostT); lostT = setTimeout(glLost, 3000); });
    m.on('webglcontextrestored', function () { stat.restored++; clearTimeout(lostT); try { m.triggerRepaint(); } catch (e) { /* нет */ } });
    clearTimeout(watchT);
    watchT = setTimeout(function check() {
      if (gl !== m) return;
      if (!stat.tiles && covered() && glDiv && glDiv.style.display !== 'none') { stat.stuck = true; glNotice(); }
      else if (!stat.tiles) watchT = setTimeout(check, 4000);
    }, 12000);
  }
  function diag() {
    var c = map.getCenter(), z = Math.max(0, Math.min(15, Math.round(map.getZoom()))), n = Math.pow(2, z);
    var tx = Math.floor((c.lng + 180) / 360 * n), r = c.lat * Math.PI / 180, ty = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    var lines = ['Карта сети ' + (window.KartaPCVersion || '') + ' · ' + new Date().toLocaleString('ru-RU'), navigator.userAgent];
    try {
      var cv = document.createElement('canvas'), g2 = cv.getContext('webgl2'), g1 = g2 || cv.getContext('webgl'), ext = g1 && g1.getExtension('WEBGL_debug_renderer_info');
      lines.push('WebGL2: ' + (g2 ? 'да' : 'нет') + ', WebGL: ' + (g1 ? 'да' : 'нет') + (ext ? ', ' + g1.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''));
    } catch (e) { lines.push('WebGL: ошибка ' + e.message); }
    var forced = ''; try { forced = localStorage.getItem(GLKEY) || ''; } catch (e) { forced = '?'; }
    lines.push('Схема: ' + (gl ? 'MapLibre' : raster ? 'упрощённая (холст)' : 'не создана') + (forced === 'off' ? ', выбрана упрощённая' : '') +
      ', плиток пришло: ' + stat.tiles + ', потерь WebGL: ' + stat.lost + ', восстановлений: ' + stat.restored);
    lines.push('Файлы: ' + (info.files.map(function (f) { return f.slug + ' ' + Math.round(f.size / 1048576) + ' МБ z' + (f.minzoom || 0) + '–' + (f.maxzoom || 15); }).join('; ') || 'нет'));
    lines.push('Вид: ' + c.lat.toFixed(4) + ', ' + c.lng.toFixed(4) + ', z' + map.getZoom().toFixed(1) + (covered() ? ' (в области схемы)' : ' (вне области схемы)') + ', подложка ' + shown() + (netUp ? '' : ', нет связи'));
    if (stat.errors.length) lines.push('Ошибки MapLibre: ' + stat.errors.join(' | '));
    var url = bridge ? null : location.origin + '/omap/' + z + '/' + tx + '/' + ty + '.mvt?v=diag' + Date.now();
    if (!url) return Promise.resolve(lines.join('\n'));
    return fetch(url, { cache: 'no-store' }).then(function (rs) {
      return rs.arrayBuffer().then(function (b) {
        var u = new Uint8Array(b).slice(0, 4), hex = Array.prototype.map.call(u, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(' ');
        lines.push('Проба плитки ' + z + '/' + tx + '/' + ty + ': ' + rs.status + ', ' + (rs.headers.get('Content-Type') || '?') + ', ' + b.byteLength + ' байт' + (hex ? ', начало ' + hex : '') +
          (u[0] === 0x1f && u[1] === 0x8b ? ' — ПЛИТКА ОСТАЛАСЬ СЖАТОЙ (её меняет антивирус или прокси)' : ''));
        return lines.join('\n');
      });
    }, function (e) { lines.push('Проба плитки: ошибка сети — ' + e.message); return lines.join('\n'); });
  }
  /* Самолечение (3.5.1). Если MapLibre не смог создать какой-то слой стиля (на одном рабочем ПК так и
   * было: «Cannot read properties of undefined (reading 'type') at _updatePlacement» на каждом кадре,
   * схема пустая), список слоёв расходится с созданными слоями. Тогда: убрать сломанные из порядка
   * (кадры перестают падать), запомнить первый несозданный слой, пересоздать карту без него; после
   * шести попыток — упрощённая схема на холсте. */
  var skipLayers = {}, heals = 0, healT = 0, lastLayers = [];
  function broken(m) {
    var st = m && m.style;
    if (!st || !st._order || !st._layers) return null;
    var miss = st._order.filter(function (id) { return !st._layers[id]; });
    return miss.length ? miss : null;
  }
  /* Какие из несозданных слоёв сломаны на самом деле: MapLibre бросает создание на первой ошибке,
   * остальные слои просто не дошли до очереди. Каждый пробуется отдельно; пропускаются только те,
   * что и поодиночке не создаются. Упрощённая схема — только если не создаётся ни один слой. */
  function sortOut(m, miss) {
    var bad = [], why = '';
    miss.forEach(function (id) {
      var def = null, before, i;
      for (i = 0; i < lastLayers.length; i++) if (lastLayers[i].id === id) { def = lastLayers[i]; break; }
      if (!def) { bad.push(id); return; }
      for (i++; i < lastLayers.length && !before; i++) if (m.getLayer(lastLayers[i].id)) before = lastLayers[i].id;   // на своё место
      try { if (!m.getLayer(id)) m.addLayer(JSON.parse(JSON.stringify(def)), before); }
      catch (e) { if (!why) why = (e && e.message) || String(e); }
      if (!m.getLayer(id)) bad.push(id);
    });
    return { bad: bad, why: why };
  }
  function heal(m, tries) {
    clearTimeout(healT);
    tries = tries || 0;
    var miss = broken(m);
    if (miss) {
      var st = m.style;
      st._order = st._order.filter(function (id) { return !!st._layers[id]; });
      var r = sortOut(m, miss);
      if (stat.errors.length < 8) stat.errors.push('не создались слои: ' + (r.bad.slice(0, 6).join(', ') || 'нет') +
        (r.bad.length > 6 ? ' и ещё ' + (r.bad.length - 6) : '') + ' из ' + lastLayers.length + (r.why ? ' — ' + r.why : ''));
      r.bad.forEach(function (id) { skipLayers[id] = true; });
      if (gl !== m) return;
      if (lastLayers.length && r.bad.length >= lastLayers.length) { glLost(); return; }   // не создаётся ничего — холст
      if (!r.bad.length) { try { m.triggerRepaint(); } catch (e) { /* нет */ } return; }   // все слои досозданы на месте
      if (++heals > 3) { glLost(); return; }
      // карта пересоздаётся целиком (у оборванной загрузки стиля нет освещения и события style.load)
      try { m.remove(); } catch (e) { /* уже убрана */ }
      gl = null;
      try { gl = makeGl(); watchGl(gl); heal(gl); } catch (e) { gl = null; glOk = false; startRaster(); }
      sync();
      return;
    }
    if (gl === m && tries < 40 && !(m.style && m.style._loaded)) healT = setTimeout(function () { heal(m, tries + 1); }, 250);
  }
  function onPageError(msg, stack) {
    if (!gl || !/maplibre|_updatePlacement|reading 'type'|of undefined/.test(String(msg) + ' ' + String(stack || ''))) return;
    if (stat.errors.length < 8 && stat.errors.indexOf(String(msg)) < 0) stat.errors.push(String(msg).slice(0, 200));
    heal(gl, 99);
  }
  window.addEventListener('error', function (e) { onPageError(e.message, e.error && e.error.stack); });
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; onPageError(r && (r.message || r), r && r.stack); });
  function glLost() {
    glOk = false;
    if (gl) { try { gl.remove(); } catch (e) { /* уже убрана */ } gl = null; }
    if (glDiv) glDiv.style.display = 'none';
    startRaster();
  }
  function startRaster() {
    rasterWant = true;
    loadRaster(function () {
      if (!rasterWant) return;
      if (raster) map.removeLayer(raster);
      try { raster = makeRaster(); } catch (e) { raster = null; }
      sync(); glNotice();
      if (window.KartaApp && KartaApp.mapChanged) KartaApp.mapChanged();
    });
  }
  /* Объяснение, почему схема упрощена или её нет: вместо пустой карты — что сделать */
  var glNote = null;
  function glNotice() {
    var need = infoLoaded && hasVec() && (!webgl() || (stat.stuck && !stat.tiles));
    if (!need) { if (glNote) glNote.hidden = true; return; }
    if (!glNote) {
      glNote = document.createElement('button'); glNote.type = 'button'; glNote.id = 'mapGlNotice';
      glNote.style.cssText = 'position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 62px);transform:translateX(-50%);z-index:1001;max-width:calc(100% - 24px);' +
        'border:0;border-radius:12px;padding:9px 14px;background:#fff4e5;color:#7a4100;font:600 13px/1.35 var(--font,system-ui);box-shadow:0 2px 10px rgba(0,0,0,.2);cursor:pointer;text-align:center';
      map.getContainer().appendChild(glNote);
      var st = document.createElement('style'); st.textContent = 'body.dark #mapGlNotice{background:#3d2c12!important;color:#ffd08a!important}'; document.head.appendChild(st);
      L.DomEvent.disableClickPropagation(glNote); L.DomEvent.disableScrollPropagation(glNote);
      glNote.onclick = function () {   // «Как включить» — сразу объяснение; «Проверка карты» — сведения
        var A = window.KartaApp; if (!A) return;
        if (!webgl() && !gl && A.webglHelp && !/Проверка/.test(glNote.textContent)) A.webglHelp(); else if (A.mapCheck) A.mapCheck();
      };
    }
    glNote.hidden = false;
    var off = false; try { off = localStorage.getItem(GLKEY) === 'off'; } catch (e) { off = false; }
    glNote.textContent = gl ? 'Схема не загрузилась · Проверка карты' : off ? 'Выбрана упрощённая схема · Проверка карты' :
      raster ? 'Нет WebGL — схема показана упрощённо · Как включить' : 'Нет WebGL — подробная схема не рисуется · Как включить';
  }
  function showGl(on) {
    if (raster) {
      var rt = document.body.classList.contains('dark') ? 'd' : 'l';
      if (on && rt !== rasterTheme) { map.removeLayer(raster); raster = makeRaster(); }
      put(raster, on);
    }
    if (!glDiv) return;
    var was = glDiv.style.display !== 'none';
    glDiv.style.display = on ? '' : 'none';
    if (on && !was && gl) { gl.resize(); follow(); }
  }
  function loadVec(then) {
    readInfo(function (i) {
      var k = i.files.map(function (f) { return f.slug + '.' + f.size + '.' + f.mtime; }).join('_').replace(/[^0-9A-Za-z_.]/g, '');
      info = i;
      infoLoaded = true;
      kindsUi();
      if (k !== key || (!gl && !rasterWant && i.files.length)) {
        key = k;
        if (gl) { try { gl.remove(); } catch (e) { /* уже убрана */ } gl = null; }
        if (raster) { map.removeLayer(raster); raster = null; }
        if (i.files.length && webgl()) {
          try {
            gl = makeGl();
            watchGl(gl);
            heal(gl);
          } catch (e) { gl = null; glOk = false; }
        }
        if (i.files.length && !gl) startRaster();
      }
      glNotice();
      sync();
      if (then) then(i);
    });
  }
  /* центр экрана внутри района, для которого есть офлайн-карта */
  function covered() {
    if (!(gl || raster) || (!offlineOnly && map.getZoom() < 7)) return false;
    var c = map.getCenter();
    return files('map').some(function (f) { return inBox(f, c.lat, c.lng); });
  }
  function put(l, on, watch) {
    if (!l) return;
    var has = map.hasLayer(l);
    if (on && !has) { l.addTo(map); if (watch && typeof watchTiles === 'function') watchTiles(l); }
    else if (!on && has) map.removeLayer(l);
  }
  var coverageNotice = null;
  function insideCoverage(lat, lng) {
    if (!window.KartaCoverage) return true;
    var area = KartaCoverage.area, polys = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
    function ring(points) {
      var inside = false;
      for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
        var a = points[i], b = points[j];
        if ((a[1] > lat) !== (b[1] > lat) && lng < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }
    return polys.some(function (poly) { return ring(poly[0]) && !poly.slice(1).some(ring); });
  }
  function showCoverageNotice() {
    // телефон — только без связи (со связью вне левобережья видна схема из интернета)
    var phoneOff = !window.KartaPC && !netUp;
    if ((!window.KartaPC && !phoneOff) || !infoLoaded) { if (coverageNotice) coverageNotice.hidden = true; return; }
    if (!coverageNotice) {
      coverageNotice = document.createElement('button'); coverageNotice.type = 'button'; coverageNotice.id = 'mapCoverageNotice';
      if (!window.KartaPC) coverageNotice.style.cssText = 'position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 62px);transform:translateX(-50%);z-index:1000;max-width:calc(100% - 24px);' +
        'border:0;border-radius:12px;padding:9px 14px;background:var(--panel,#fff);color:var(--text,#1c1c1e);font:600 13px/1.35 var(--font,system-ui);box-shadow:0 2px 10px rgba(0,0,0,.2);text-align:center';
      map.getContainer().appendChild(coverageNotice);
      L.DomEvent.disableClickPropagation(coverageNotice); L.DomEvent.disableScrollPropagation(coverageNotice);
      coverageNotice.onclick = function () {
        var b = window.KartaCoverage && KartaCoverage.bounds;
        if (b) map.fitBounds([[b[1],b[0]],[b[3],b[2]]],{padding:[40,40]});
      };
    }
    var c = map.getCenter(), outside = !insideCoverage(c.lat,c.lng);
    var drawnMap = !!(gl || raster);
    coverageNotice.hidden = (drawnMap && !outside) || (!gl && hasVec() && !webgl());   // без WebGL — своё объяснение сверху
    coverageNotice.disabled = !drawnMap;
    coverageNotice.textContent = !hasVec() ? 'Файл схемы не найден. Перенесите папку map вместе с программой.' : !gl ?
      'Карта не отрисовалась. Проверьте аппаратное ускорение браузера.' :
      phoneOff ? 'Нет связи, здесь схемы нет · Показать схему' : 'Вне загруженной области · Показать схему';
  }
  /* какие слои должны быть на карте сейчас */
  function sync() {
    var cur = shown(), cov = covered(), sch = cur === 'off', net = netUp && sch && !(cov && schema !== 'online');
    // офлайн-схема — в самом низу. «Схема»: видна в своей области, если над ней нет схемы из
    // интернета. «Спутник» и «Гибрид»: под ними та же схема, а поверх —
    // подробные снимки из интернета и те, что уже просматривались.
    restyle();
    // 3.5.3: растровой карты 7–11 нет — без связи вшитая схема видна везде (за её границей — фон и маска)
    showGl(!!(gl || raster) && (offlineOnly || (sch ? !netUp || (cov && schema !== 'online') : true)));
    put(osm, !offlineOnly && net, true);
    put(sat, !offlineOnly && netUp && cur === 'sat', true);
    put(hybrid, !offlineOnly && netUp && cur === 'hyb', true);
    showCoverageNotice();
  }
  map.on('moveend zoomend', sync);

  window.KartaMap = {
    info: function () { return { files: info.files, gl: webgl(), drawn: !!gl, raster: !!raster, tiles: stat.tiles, stuck: !!stat.stuck }; },
    diag: diag,
    simple: function (on) { try { if (on) localStorage.setItem(GLKEY, 'off'); else localStorage.removeItem(GLKEY); } catch (e) { /* нет */ } location.reload(); },
    simpleOn: function () { try { return localStorage.getItem(GLKEY) === 'off'; } catch (e) { return false; } },
    photo: function () { return shown() !== 'off'; },          // под линиями снимки — линиям нужна тёмная тень
    glMap: function () { return gl; },
    reload: loadVec,
    note: function () {},                       // app.js подставляет всплывающее сообщение
    credits: (function () {
      var schemaTxt = 'Схема: © участники OpenStreetMap, ODbL (выгрузка 18.11.2026); контуры домов, которых нет в OpenStreetMap, — Microsoft Global ML Building Footprints, ODbL; горизонтали — Copernicus GLO-30 DEM (© DLR e.V. 2010–2014 и © Airbus Defence and Space GmbH 2014–2018, предоставлено по программе Copernicus ЕС); плитки — схема Protomaps (Planetiler). Границы областей — OpenStreetMap. Номера домов показаны там, где они есть в OpenStreetMap.';
      return window.KartaPC ? schemaTxt : schemaTxt + ' Снимки © Esri; подписи на снимках © Яндекс.';
    })(),
    setSchema: function (v) { schema = !offlineOnly && v === 'online' ? 'online' : 'auto'; sync(); },
    // тема сменилась — офлайн-карта перерисовывается в светлых или тёмных цветах
    retheme: function () { restyle(); sync(); }
  };

  // ---------------------------------------------------------------- выбор подложки

  $('mapOff').textContent = 'Схема';
  if (window.KartaPC) $('mapKinds').style.setProperty('display','none','important');

  window.useMap = function (kind) {
    current = !window.KartaPC && (kind === 'sat' || kind === 'hyb') ? kind : 'off';
    if (current !== 'off' && !netUp) KartaMap.note('Нет связи — снимки появятся, когда она будет. Пока показана офлайн-схема.');
    sync();
    $('mapOff').classList.toggle('on', current === 'off');
    $('mapSat').classList.toggle('on', current === 'sat');
    $('mapHyb').classList.toggle('on', current === 'hyb');
    try { localStorage.setItem(KIND, current); } catch (e) { /* не важно */ }
    if (window.KartaApp && KartaApp.mapChanged) KartaApp.mapChanged();
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
