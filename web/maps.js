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
      // там, где есть загруженные снимки района, растянутая мелкая плитка хуже них — пусть видны они
      if (c && this._kSat && z < 15 && satAt(c)) up = 9;
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
  sat._kSat = hybSat._kSat = true;
  offlineTiles.setZIndex(0); osm.setZIndex(1); sat.setZIndex(3); hybSat.setZIndex(3); hybNames.setZIndex(4);

  // ---------------------------------------------------------------- поворот двумя пальцами — не сразу

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
  $('online').checked = true;
  if (!online) applyOnline(true);

  // ---------------------------------------------------------------- офлайн-карта районов (MapLibre GL)

  /* Файлы районов: <район>.pmtiles — схема (векторные плитки), <район>-sat.pmtiles — снимки
   * Sentinel-2 (10 м на точку, масштаб до 14). И то и другое рисует одна карта MapLibre:
   * «Схема» — вектор, «Спутник» — снимки, «Гибрид» — снимки, дороги и подписи схемы поверх. */
  function inBox(f, lat, lng) { var b = f.bounds || []; return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]; }
  function files(kind) { return info.files.filter(function (f) { return (f.kind === 'sat') === (kind === 'sat'); }); }
  function hasSat() { return files('sat').length > 0; }
  function hasVec() { return files('map').length > 0; }
  /* плитка {x, y, z} попадает в район, для которого загружены снимки */
  function satAt(c) {
    var n = Math.pow(2, c.z), lng = (c.x + 0.5) / n * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (c.y + 0.5) / n))) * 180 / Math.PI;
    return files('sat').some(function (f) { return inBox(f, lat, lng); });
  }

  var kf = window.KartaFiles, bridge = !!(kf && kf.mapTile);
  var gl = null, info = { files: [] }, key = '', schema = 'auto', glOk = null;
  var current = localStorage.getItem(KIND) || 'off';      // вид карты: off — схема, sat — спутник, hyb — гибрид
  function webgl() {
    if (glOk == null) {
      try {
        var c = document.createElement('canvas');
        glOk = !!(window.maplibregl && window.KartaStyle && (c.getContext('webgl2') || c.getContext('webgl')));
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
    /* Ответ оболочки — в фоне (tileAsync → window.__kartaTile): пока Java читает плитку, страница
     * и жесты не ждут. Base64 раскладывается в байты тоже без остановки страницы (fetch data:). */
    var pend = {}, seq = 0;
    window.__kartaTile = function (id, s) { var f = pend[id]; if (f) { delete pend[id]; f(s); } };
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
    var BLANK_BUF = b64(BLANK.split(',')[1]);
    maplibregl.addProtocol('karta', function (params, ac) {
      var u = params.url, m, got;
      if (kf.tileAsync) {
        if ((m = /^karta:\/\/t\/(\d+)\/(\d+)\/(\d+)/.exec(u))) got = ask('t', +m[1], +m[2], +m[3], '', ac);
        else if ((m = /^karta:\/\/s\/(\d+)\/(\d+)\/(\d+)/.exec(u))) {
          return ask('s', +m[1], +m[2], +m[3], '', ac).then(function (s) {
            return s ? bytes(s).then(function (d) { return { data: d }; }) : { data: BLANK_BUF.slice(0) };     // снимка нет — прозрачная плитка
          });
        } else if ((m = /^karta:\/\/f\/(.+)\/(\d+-\d+)$/.exec(u))) got = ask('f', 0, 0, 0, 'vendor/fonts/' + decodeURIComponent(m[1]) + '/' + m[2] + '.pbf', ac);
        else got = Promise.resolve('');
        return got.then(bytes).then(function (d) { return { data: d }; });
      }
      // старая оболочка — как раньше, синхронно
      var s = '';
      try {
        if ((m = /^karta:\/\/t\/(\d+)\/(\d+)\/(\d+)/.exec(u))) s = kf.mapTile(+m[1], +m[2], +m[3]);
        else if ((m = /^karta:\/\/s\/(\d+)\/(\d+)\/(\d+)/.exec(u))) {
          s = kf.satTile ? kf.satTile(+m[1], +m[2], +m[3]) : '';
          if (!s) return Promise.resolve({ data: BLANK_BUF.slice(0) });
        } else if ((m = /^karta:\/\/f\/(.+)\/(\d+-\d+)$/.exec(u))) s = kf.asset('vendor/fonts/' + decodeURIComponent(m[1]) + '/' + m[2] + '.pbf');
      } catch (e) { s = ''; }
      return Promise.resolve({ data: s ? b64(s) : new ArrayBuffer(0) });
    });
  }
  function union(list) {
    var b = [180, 85, -180, -85];
    list.forEach(function (f) { var x = f.bounds || [-180, -85, 180, 85]; b = [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])]; });
    return b;
  }
  var HYB = { minor: .35, major: .5, hw: .6 };          // дороги схемы поверх снимков — полупрозрачные
  function style() {
    var s = JSON.parse(JSON.stringify(window.KartaStyle[document.body.classList.contains('dark') ? 'dark' : 'light']));
    var vec = hasVec(), img = hasSat() && current !== 'off', all = s.layers;
    s.glyphs = bridge ? 'karta://f/{fontstack}/{range}' : location.origin + '/vendor/fonts/{fontstack}/{range}.pbf';
    s.sources.p.tiles = [bridge ? 'karta://t/{z}/{x}/{y}?' + key : location.origin + '/omap/{z}/{x}/{y}.mvt?v=' + key];
    if (vec) s.sources.p.bounds = union(files('map'));
    else { delete s.sources.p; all = []; }
    if (img) {
      s.sources.s = { type: 'raster', tileSize: 256, minzoom: 0, maxzoom: 14, bounds: union(files('sat')),
        tiles: [bridge ? 'karta://s/{z}/{x}/{y}?' + key : location.origin + '/osat/{z}/{x}/{y}.jpg?v=' + key] };
      // «Гибрид»: поверх снимков — дороги и подписи схемы; «Спутник»: только снимки
      all = current === 'hyb' ? all.filter(function (l) { return l.type === 'symbol' || HYB[l.id]; }) : [];
      all.forEach(function (l) {
        if (HYB[l.id]) { l.paint = l.paint || {}; l.paint['line-opacity'] = HYB[l.id]; }
        if (l.type === 'symbol') { l.paint = l.paint || {}; l.paint['text-halo-width'] = 1.8; }
      });
      all.unshift({ id: 'sat', type: 'raster', source: 's', paint: { 'raster-fade-duration': 0 } });
    }
    s.layers = all;
    return s;
  }
  var styled = '';
  function restyle() {
    var k = current + (document.body.classList.contains('dark') ? 'd' : 'l');
    if (!gl || k === styled) return;
    styled = k;
    try { gl.setStyle(style()); } catch (e) { /* карта ещё не готова */ }
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
      map.on('move zoom rotate', follow);
      map.on('resize', function () { if (gl) { gl.resize(); follow(); } });
      map.on('zoomanim', function (e) {
        if (!gl || glDiv.style.display === 'none') return;
        zooming = true;
        gl.easeTo({ center: [e.center.lng, e.center.lat], zoom: e.zoom - 1, bearing: bearing(), duration: 250, easing: ease });
      });
      map.on('zoomend', function () { zooming = false; if (gl) gl.stop(); follow(); });
    }
    var c = map.getCenter();
    styled = current + (document.body.classList.contains('dark') ? 'd' : 'l');
    return new maplibregl.Map({ container: glDiv, style: style(), center: [c.lng, c.lat], zoom: map.getZoom() - 1, bearing: bearing(),
      interactive: false, attributionControl: false, fadeDuration: 0, validateStyle: false, maxZoom: 22, renderWorldCopies: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
  }
  function showGl(on) {
    if (!glDiv) return;
    var was = glDiv.style.display !== 'none';
    glDiv.style.display = on ? '' : 'none';
    if (on && !was && gl) { gl.resize(); follow(); }
  }
  function loadVec(then) {
    readInfo(function (i) {
      var k = i.files.map(function (f) { return f.slug + '.' + f.size + '.' + f.mtime; }).join('_').replace(/[^0-9A-Za-z_.]/g, '');
      info = i;
      if (k !== key || (!gl && i.files.length)) {
        key = k;
        if (gl) { try { gl.remove(); } catch (e) { /* уже убрана */ } gl = null; }
        if (i.files.length && webgl()) {
          try { gl = makeGl(); gl.on('error', function () { /* нет плитки — не страшно */ }); } catch (e) { gl = null; }
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
    return files('map').some(function (f) { return inBox(f, c.lat, c.lng); });
  }
  function put(l, on, watch) {
    if (!l) return;
    var has = map.hasLayer(l);
    if (on && !has) { l.addTo(map); if (watch && typeof watchTiles === 'function') watchTiles(l); }
    else if (!on && has) map.removeLayer(l);
  }
  /* какие слои должны быть на карте сейчас */
  function sync() {
    var cov = covered(), sch = current === 'off', net = sch && !(cov && schema !== 'online');
    // офлайн-карта районов — в самом низу. «Схема»: видна в своём районе, если над ней нет схемы из
    // интернета. «Спутник» и «Гибрид»: загруженные снимки района (нет их — офлайн-схема), а поверх —
    // подробные снимки из интернета и те, что уже просматривались.
    restyle();
    showGl(!!gl && (sch ? cov && schema !== 'online' : true));
    // вшитая карта 7–11 и схема из интернета — там, где районов офлайн-карты нет (или так выбрано)
    put(offlineTiles, sch && !cov);
    put(osm, net, true);
    put(sat, current === 'sat', true);
    put(hybrid, current === 'hyb', true);
  }
  map.on('moveend zoomend', sync);

  window.KartaMap = {
    info: function () { return { files: info.files, gl: webgl(), drawn: !!gl }; },
    glMap: function () { return gl; },
    reload: loadVec,
    note: function () {},                       // app.js подставляет всплывающее сообщение
    credits: 'Карты: © участники OpenStreetMap (офлайн-схема — сборка Protomaps); снимки © Esri; загруженные снимки районов — Sentinel-2 cloudless, https://s2maps.eu, EOX IT Services GmbH (содержит изменённые данные Copernicus Sentinel 2016–2017); подписи на снимках © Яндекс.',
    setSchema: function (v) { schema = v === 'online' ? 'online' : 'auto'; sync(); },
    // тема сменилась — офлайн-карта перерисовывается в светлых или тёмных цветах
    retheme: restyle
  };

  // ---------------------------------------------------------------- выбор подложки

  $('mapOff').textContent = 'Схема';

  window.useMap = function (kind) {
    current = kind === 'sat' || kind === 'hyb' ? kind : 'off';
    sync();
    $('mapOff').classList.toggle('on', current === 'off');
    $('mapSat').classList.toggle('on', current === 'sat');
    $('mapHyb').classList.toggle('on', current === 'hyb');
    try { localStorage.setItem(KIND, current); } catch (e) { /* не важно */ }
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
