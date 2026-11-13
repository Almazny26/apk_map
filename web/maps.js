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
 *   - внизу справа подпись источника карты (условие OpenStreetMap и Esri).
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
  [sat, hybSat].forEach(function (l) { l.options.attribution = 'Снимки &copy; Esri'; l.options.errorTileUrl = BLANK; l.setZIndex(2); });
  hybNames.options.attribution = 'Подписи &copy; Яндекс';
  hybNames.options.errorTileUrl = BLANK;
  hybNames.setZIndex(3);

  var css = document.createElement('style');
  css.textContent =
    '.leaflet-container .leaflet-control-attribution.nm-attr{display:block!important;font-size:10px;background:rgba(255,255,255,.75);padding:0 4px}' +
    'body.dark .leaflet-container .leaflet-control-attribution.nm-attr{background:rgba(0,0,0,.55);color:#ccc}' +
    'body.dark .leaflet-container .leaflet-control-attribution.nm-attr a{color:#9ecbff}';
  document.head.appendChild(css);
  var attr = L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);
  L.DomUtil.addClass(attr.getContainer(), 'nm-attr');

  // ---------------------------------------------------------------- «Онлайн» по умолчанию

  if (!localStorage.getItem(MIGRATED)) {
    localStorage.setItem(MIGRATED, '1');
    if (!online) { $('online').checked = true; applyOnline(true); }
  }

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
      if (!map.hasLayer(offlineTiles)) offlineTiles.addTo(map);
      var layer = current === 'sat' ? sat : current === 'hyb' ? hybrid : (online ? osm : null);
      if (layer) { layer.addTo(map); if (typeof watchTiles === 'function') watchTiles(layer); }
      $('mapOff').classList.toggle('on', current === 'off');
      $('mapSat').classList.toggle('on', current === 'sat');
      $('mapHyb').classList.toggle('on', current === 'hyb');
      try { localStorage.setItem(KIND, current); } catch (e) { /* не важно */ }
      if (current === 'sat') status('Спутник. Нужен интернет, открытое ранее видно и без него.');
      else if (current === 'hyb') status('Гибрид: снимок и подписи. Нужен интернет, открытое ранее видно и без него.');
      else if (online) status('Схема: подробная карта из интернета. Открытое ранее видно и без связи.');
      else status('Без интернета: офлайн-карта (Крым, Херсон, Запорожье, Ставрополье) и то, что открывали раньше.');
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
  status('');
})();
