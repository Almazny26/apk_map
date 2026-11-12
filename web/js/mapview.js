/* Карта сети — карта на MapLibre GL: подложка, узлы, линии, подписи, поворот, моё местоположение.
 *
 * MapLibre рисует карту через WebGL, поэтому масштаб меняется плавно, карту можно вращать двумя
 * пальцами, а тысячи узлов и линий не тормозят. Узлы и линии — это два GeoJSON-источника,
 * значки и подписи рисуются на canvas и отдаются карте как картинки (шрифты с сервера не нужны,
 * так что подписи работают и без интернета).
 */
(function () {
  'use strict';

  var D = NM.data;

  NM.TILE_LAYERS = [
    { id: 'osm', name: 'Схема', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNativeZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    { id: 'sat', name: 'Спутник',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maxNativeZoom: 18, attribution: '© Esri, Maxar, Earthstar Geographics' }
  ];

  /** В приложении адрес плитки помечается, чтобы оболочка сохранила её на диск для работы без связи. */
  NM.tileUrl = function (layer) {
    return NM.native ? layer.url + (layer.url.indexOf('?') >= 0 ? '&' : '?') + 'nmcache=1' : layer.url;
  };

  var SHAPES = ['circle', 'square', 'diamond', 'triangle', 'hex'];
  var BLUE = '#0b6bcb';
  var EMPTY = { type: 'FeatureCollection', features: [] };

  var M = NM.map = {
    map: null,
    ready: false,
    prefs: { layer: 'osm', view: null, hidden: { node_types: {}, statuses: {}, link_types: {} }, labels: true },
    selected: null,
    myPos: null
  };

  var map = null, touch = false, linkLayerIds = [], watchId = null, follow = false, dirty = false;

  M.savePrefs = NM.debounce(function () { NM.kv.set('prefs', M.prefs); }, 800);

  M.shapeOf = function (typeId) {
    var arr = D.settings.node_types || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === typeId) return SHAPES[i % SHAPES.length];
    return 'circle';
  };

  function statusColor(id) { var st = NM.lookup('statuses', id); return st ? st.color : '#64748b'; }
  function isFirstStatus(id) { var arr = D.settings.statuses || []; return !id || (arr.length && arr[0].id === id); }
  function hidden(o) {
    var h = M.prefs.hidden;
    if (h.statuses[o.data.status]) return true;
    return o.kind === 'node' ? !!h.node_types[o.data.type] : !!h.link_types[o.data.type];
  }
  function ll(p) { return [p[1], p[0]]; }                      // [широта, долгота] -> [долгота, широта]
  function line(points, props) {
    return { type: 'Feature', properties: props || {}, geometry: { type: 'LineString', coordinates: points.map(ll) } };
  }
  function point(p, props) {
    return { type: 'Feature', properties: props || {}, geometry: { type: 'Point', coordinates: ll(p) } };
  }
  function setData(source, features) {
    var s = map && map.getSource(source);
    if (s) s.setData({ type: 'FeatureCollection', features: features });
  }

  // ------------------------------------------------------------------ картинки значков и подписей

  var dpr = Math.min(3, Math.max(2, Math.round(window.devicePixelRatio || 1)));

  function nodeImage(shape, color, pending) {
    var size = 30, c = document.createElement('canvas');
    c.width = c.height = size * dpr;
    var ctx = c.getContext('2d'), s = 9, x = size / 2, y = size / 2;
    ctx.scale(dpr, dpr);
    ctx.beginPath();
    if (shape === 'square') ctx.rect(x - s * 0.9, y - s * 0.9, s * 1.8, s * 1.8);
    else if (shape === 'diamond') { ctx.moveTo(x, y - s * 1.2); ctx.lineTo(x + s * 1.2, y); ctx.lineTo(x, y + s * 1.2); ctx.lineTo(x - s * 1.2, y); ctx.closePath(); }
    else if (shape === 'triangle') { ctx.moveTo(x, y - s * 1.2); ctx.lineTo(x + s * 1.15, y + s * 0.85); ctx.lineTo(x - s * 1.15, y + s * 0.85); ctx.closePath(); }
    else if (shape === 'hex') {
      for (var i = 0; i < 6; i++) { var a = Math.PI / 3 * i; ctx[i ? 'lineTo' : 'moveTo'](x + s * 1.12 * Math.cos(a), y + s * 1.12 * Math.sin(a)); }
      ctx.closePath();
    } else ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6; ctx.stroke();        // белая кайма: видно и на схеме, и на снимке
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = pending ? '#f59e0b' : '#0f172a'; ctx.lineWidth = pending ? 3 : 1.6; ctx.stroke();
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function labelImage(text) {
    var c = document.createElement('canvas'), ctx = c.getContext('2d');
    var font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    ctx.font = font;
    if (text.length > 40) text = text.slice(0, 39) + '…';
    var w = Math.ceil(ctx.measureText(text).width) + 12, h = 20;
    c.width = w * dpr; c.height = h * dpr;
    ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0.5, 0.5, w - 1, h - 1, 5); else ctx.rect(0.5, 0.5, w - 1, h - 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(15,23,42,0.18)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = font; ctx.fillStyle = '#0f172a'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 6, h / 2 + 0.5);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function onImageMissing(e) {
    var id = e.id;
    if (map.hasImage(id)) return;
    if (id.indexOf('n|') === 0) {
      var p = id.split('|');
      map.addImage(id, nodeImage(p[1], p[2], p[3] === '1'), { pixelRatio: dpr });
    } else if (id.indexOf('l|') === 0) {
      map.addImage(id, labelImage(id.slice(2)), { pixelRatio: dpr });
    }
  }

  // ------------------------------------------------------------------ создание карты

  M.init = function () {
    var saved = NM.kv.get('prefs');
    if (saved) {
      for (var k in saved) M.prefs[k] = saved[k];
      M.prefs.hidden = M.prefs.hidden || {};
      ['node_types', 'statuses', 'link_types'].forEach(function (key) { M.prefs.hidden[key] = M.prefs.hidden[key] || {}; });
    }
    touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    var v = M.prefs.view;

    var sources = {};
    NM.TILE_LAYERS.forEach(function (l) {
      sources['base-' + l.id] = { type: 'raster', tiles: [NM.tileUrl(l)], tileSize: 256, maxzoom: l.maxNativeZoom, attribution: l.attribution };
    });
    ['links', 'nodes', 'sel', 'draft', 'edit', 'me'].forEach(function (s) { sources[s] = { type: 'geojson', data: EMPTY }; });

    var layers = [{ id: 'bg', type: 'background', paint: { 'background-color': '#e8ecef' } }];
    NM.TILE_LAYERS.forEach(function (l) {
      layers.push({ id: 'base-' + l.id, type: 'raster', source: 'base-' + l.id,
        layout: { visibility: l.id === M.prefs.layer ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 120 } });
    });
    var round = { 'line-join': 'round', 'line-cap': 'round' };
    layers.push(
      { id: 'link-halo', type: 'line', source: 'links', filter: ['has', 'halo'], layout: round,
        paint: { 'line-color': ['get', 'halo'], 'line-width': 13, 'line-opacity': 0.45 } },
      { id: 'link-case', type: 'line', source: 'links', layout: round,
        paint: { 'line-color': '#ffffff', 'line-width': 7.5, 'line-opacity': 0.85 } },
      // сюда (перед sel-link) вставляются слои линий по видам, см. buildLinkLayers
      { id: 'sel-link', type: 'line', source: 'sel', filter: ['==', ['geometry-type'], 'LineString'], layout: round,
        paint: { 'line-color': BLUE, 'line-width': 15, 'line-opacity': 0.32 } },
      { id: 'sel-node', type: 'circle', source: 'sel', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 19, 'circle-color': BLUE, 'circle-opacity': 0.18, 'circle-stroke-color': BLUE, 'circle-stroke-width': 3 } },
      { id: 'me-acc', type: 'fill', source: 'me', filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': BLUE, 'fill-opacity': 0.1, 'fill-outline-color': BLUE } },
      { id: 'nodes', type: 'symbol', source: 'nodes',
        layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.42, 8, 0.6, 12, 0.85, 15, 1.05] } },
      { id: 'labels', type: 'symbol', source: 'nodes', minzoom: 11.8,
        layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'left', 'icon-offset': [14, 0], 'icon-padding': 3,
          visibility: M.prefs.labels ? 'visible' : 'none' } },
      { id: 'edit-case', type: 'line', source: 'edit', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 } },
      { id: 'edit-line', type: 'line', source: 'edit', layout: round, paint: { 'line-color': BLUE, 'line-width': 4.5 } },
      { id: 'draft-case', type: 'line', source: 'draft', filter: ['==', ['geometry-type'], 'LineString'], layout: round,
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } },
      { id: 'draft-line', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'fixed'], layout: round,
        paint: { 'line-color': BLUE, 'line-width': 4 } },
      { id: 'draft-tail', type: 'line', source: 'draft', filter: ['==', ['get', 'kind'], 'tail'],
        paint: { 'line-color': BLUE, 'line-width': 3.5, 'line-dasharray': [2, 2.4] } },
      { id: 'draft-dots', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': BLUE, 'circle-stroke-width': 2.5 } },
      { id: 'me-dot', type: 'circle', source: 'me', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 7, 'circle-color': BLUE, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } }
    );

    map = M.map = new maplibregl.Map({
      container: 'map',
      style: { version: 8, sources: sources, layers: layers },
      center: v ? [v.c[1], v.c[0]] : [60, 61],
      zoom: v ? v.z : 3.2,
      bearing: v && v.b ? v.b : 0,
      minZoom: 1.5, maxZoom: 19,
      attributionControl: false,
      pitchWithRotate: false, maxPitch: 0,     // карта плоская: вращение есть, наклона нет
      fadeDuration: 120,
      clickTolerance: touch ? 6 : 3
    });
    map.touchPitch.disable();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    if (!touch) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

    map.on('styleimagemissing', onImageMissing);
    map.on('load', function () {
      M.ready = true;
      buildLinkLayers();
      M.rebuild();
      if (!M.prefs.view) setTimeout(M.fitAll, 50);
      NM.emit('mapready');
    });
    map.on('moveend', function () {
      var c = map.getCenter();
      M.prefs.view = { c: [c.lat, c.lng], z: map.getZoom(), b: map.getBearing() };
      M.savePrefs();
    });
    map.on('rotate', function () { NM.emit('bearing', map.getBearing()); });
    map.on('dragstart', function () { if (follow) { follow = false; NM.emit('locate'); } });
    map.on('click', onClick);
    map.on('error', function (e) {
      // плитки без связи не загружаются — это штатно; остальное пишем в консоль
      var msg = e && e.error && e.error.message || '';
      if (msg && !/Failed to fetch|NetworkError|Load failed|AJAXError|\(0\)|504|404/.test(msg)) console.error(e.error);
    });
    document.body.classList.toggle('sat', M.prefs.layer === 'sat');
  };

  /** Нажатие: ищем узел или линию рядом с пальцем; узел важнее линии, из узлов — ближайший. */
  function onClick(e) {
    var t = touch ? 16 : 7, p = e.point;
    var layers = ['nodes'].concat(linkLayerIds).filter(function (id) { return map.getLayer(id); });
    var feats = map.queryRenderedFeatures([[p.x - t, p.y - t], [p.x + t, p.y + t]], { layers: layers });
    var best = null, bestD = Infinity, link = null;
    feats.forEach(function (f) {
      if (f.layer.id === 'nodes') {
        var q = map.project(f.geometry.coordinates), d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bestD) { bestD = d; best = f.properties.id; }
      } else if (!link) link = f.properties.id;
    });
    if (best || link) NM.emit('tap', best || link);
    else NM.emit('maptap', { lat: e.lngLat.lat, lng: e.lngLat.lng });
  }

  /** Пунктир в MapLibre задаётся на слой, а не на объект, поэтому на каждый вид линий — свой слой. */
  function buildLinkLayers() {
    linkLayerIds.forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
    linkLayerIds = [];
    var types = D.settings.link_types || [], ids = types.map(function (t) { return t.id; });
    function add(id, filter, dash) {
      var paint = { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': ['case', ['get', 'pending'], 0.65, 0.96] };
      if (dash) paint['line-dasharray'] = dash;
      map.addLayer({ id: id, type: 'line', source: 'links', filter: filter,
        layout: { 'line-join': 'round', 'line-cap': dash ? 'butt' : 'round' }, paint: paint }, 'sel-link');
      linkLayerIds.push(id);
    }
    types.forEach(function (t, i) {
      var dash = null;
      if (t.dash) {
        dash = t.dash.split(/[\s,]+/).map(function (n) { return Math.max(0.1, parseFloat(n) / 4); });
        if (dash.length < 2 || dash.some(isNaN)) dash = null;
      }
      add('link-t' + i, ['==', ['get', 'type'], t.id], dash);
    });
    add('link-other', ['!', ['in', ['get', 'type'], ['literal', ids]]], null);
  }

  M.setLayer = function (id) {
    var def = NM.TILE_LAYERS.filter(function (l) { return l.id === id; })[0] || NM.TILE_LAYERS[0];
    NM.TILE_LAYERS.forEach(function (l) {
      if (map.getLayer('base-' + l.id)) map.setLayoutProperty('base-' + l.id, 'visibility', l.id === def.id ? 'visible' : 'none');
    });
    M.prefs.layer = def.id;
    M.savePrefs();
    document.body.classList.toggle('sat', def.id === 'sat');
  };

  // ------------------------------------------------------------------ узлы и линии

  function rebuildNow() {
    dirty = false;
    if (!M.ready) return;
    var nodes = [], links = [];
    D.view.forEach(function (o) {
      if (o.kind !== 'node' || hidden(o) || typeof o.data.lat !== 'number' || typeof o.data.lng !== 'number') return;
      nodes.push(point([o.data.lat, o.data.lng], {
        id: o.id,
        icon: 'n|' + M.shapeOf(o.data.type) + '|' + statusColor(o.data.status) + '|' + (o.pending ? 1 : 0),
        label: 'l|' + (o.data.name || '')
      }));
    });
    D.view.forEach(function (o) {
      if (o.kind !== 'link' || hidden(o)) return;
      var pts = D.linkPoints(o);
      if (!pts) return;
      var a = D.view.get(o.data.a), b = D.view.get(o.data.b);
      if (hidden(a) || hidden(b)) return;
      var t = NM.lookup('link_types', o.data.type);
      var props = { id: o.id, type: o.data.type || '', color: t ? t.color : '#475569', pending: !!o.pending };
      if (!isFirstStatus(o.data.status)) props.halo = statusColor(o.data.status);   // необычное состояние подсвечивает линию
      links.push(line(pts, props));
    });
    setData('nodes', nodes);
    setData('links', links);
    if (M.selected && !D.view.has(M.selected)) M.selected = null;
    drawSelection();
  }

  /** Перерисовка откладывается до следующего кадра: сколько бы объектов ни изменилось, она одна. */
  M.rebuild = function () {
    if (dirty) return;
    dirty = true;
    setTimeout(rebuildNow, 16);
  };
  M.refresh = M.rebuild;

  M.setLabels = function (on) {
    M.prefs.labels = !!on; M.savePrefs();
    if (map.getLayer('labels')) map.setLayoutProperty('labels', 'visibility', on ? 'visible' : 'none');
  };

  // ------------------------------------------------------------------ выделение и навигация

  function drawSelection() {
    if (!M.ready) return;
    var o = M.selected && D.view.get(M.selected), feats = [];
    if (o && o.kind === 'node') feats.push(point([o.data.lat, o.data.lng]));
    else if (o) { var pts = D.linkPoints(o); if (pts) feats.push(line(pts)); }
    setData('sel', feats);
  }

  M.select = function (id) { M.selected = id || null; drawSelection(); };

  function padding() {
    var pad = NM.ui ? NM.ui.mapPadding() : { paddingTopLeft: [30, 80], paddingBottomRight: [30, 40] };
    return { left: pad.paddingTopLeft[0], top: pad.paddingTopLeft[1], right: pad.paddingBottomRight[0], bottom: pad.paddingBottomRight[1] };
  }

  /** Показывает набор точек целиком, с учётом панелей поверх карты. */
  M.fitPoints = function (pts, pad, maxZoom) {
    if (!pts || !pts.length) return;
    var b = new maplibregl.LngLatBounds();
    pts.forEach(function (p) { b.extend(ll(p)); });
    map.fitBounds(b, { padding: pad || padding(), maxZoom: maxZoom || 15, duration: 450, bearing: map.getBearing() });
  };

  /** Показывает объект на карте с учётом того, что часть экрана закрыта карточкой. */
  M.focus = function (id, zoomIn) {
    var o = D.view.get(id);
    if (!o) return;
    if (o.kind === 'node') {
      var p = padding();
      // смещаем центр так, чтобы узел оказался посередине свободной от панелей части экрана
      map.easeTo({ center: [o.data.lng, o.data.lat], zoom: zoomIn ? Math.max(map.getZoom(), 14) : map.getZoom(),
        offset: [(p.left - p.right) / 2, (p.top - p.bottom) / 2], duration: 450 });
    } else {
      M.fitPoints(D.linkPoints(o));
    }
  };

  M.fitAll = function () {
    var pts = [];
    D.view.forEach(function (o) { if (o.kind === 'node' && !hidden(o)) pts.push([o.data.lat, o.data.lng]); });
    M.fitPoints(pts, { top: 90, bottom: 60, left: 50, right: 60 }, 14);
  };

  M.center = function () { var c = map.getCenter(); return [c.lat, c.lng]; };
  M.zoom = function () { return map.getZoom(); };
  M.setView = function (p, zoom, instant) {
    var opts = { center: ll(p), zoom: zoom == null ? map.getZoom() : zoom };
    if (instant) map.jumpTo(opts); else { opts.duration = 400; map.easeTo(opts); }
  };
  M.resize = function () { if (map) map.resize(); };
  M.onMove = function (fn) { map.on('move', fn); };
  M.offMove = function (fn) { map.off('move', fn); };
  M.north = function () { map.easeTo({ bearing: 0, duration: 350 }); };
  M.bearing = function () { return map ? map.getBearing() : 0; };

  // ------------------------------------------------------------------ черновик новой линии

  /** Линия, которую сейчас ведут: сплошная часть по поставленным точкам и пунктир до перекрестия. */
  M.draft = function (points, dots) {
    if (!M.ready) return;
    if (!points || points.length < 2) { setData('draft', []); return; }
    var feats = [], fixed = points.slice(0, points.length - 1);
    if (fixed.length > 1) feats.push(line(fixed, { kind: 'fixed' }));
    feats.push(line(points.slice(points.length - 2), { kind: 'tail' }));
    (dots || []).forEach(function (p) { feats.push(point(p)); });
    setData('draft', feats);
  };

  /** Ближайший к точке узел в пределах px экранных пикселей (кроме exceptId) или null. */
  M.nodeNear = function (p, px, exceptId) {
    var c = map.project(ll(p)), best = null, bestD = px;
    D.view.forEach(function (o) {
      if (o.kind !== 'node' || o.id === exceptId || hidden(o)) return;
      var q = map.project([o.data.lng, o.data.lat]), d = Math.hypot(q.x - c.x, q.y - c.y);
      if (d <= bestD) { bestD = d; best = o.id; }
    });
    return best;
  };

  /** Индекс отрезка ломаной, ближайшего к точке (в экранных пикселях). */
  M.nearestSegment = function (points, p) {
    var c = map.project(ll(p)), best = 0, bestD = Infinity;
    for (var i = 0; i < points.length - 1; i++) {
      var a = map.project(ll(points[i])), b = map.project(ll(points[i + 1]));
      var dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
      var t = len ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len)) : 0;
      var d = Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  // ------------------------------------------------------------------ редактор трассы
  // Точки изгиба существуют только в режиме правки. Это перетаскиваемые маркеры: зажал и перенёс.
  // Между соседними точками стоит бледная «средняя» точка: потянули её — появился новый изгиб.

  var ed = null;

  function edPts() { return [ed.a].concat(ed.path, [ed.b]); }
  function edCopy() { return ed.path.map(function (p) { return [+p[0].toFixed(7), +p[1].toFixed(7)]; }); }
  function mid(p, q) { return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; }

  function edMarker(p, cls) {
    var el = document.createElement('div');
    el.className = 'nm-h ' + cls;
    return new maplibregl.Marker({ element: el, draggable: true }).setLngLat(ll(p)).addTo(map);
  }

  function edSync(withMids) {
    var pts = edPts();
    setData('edit', [line(pts)]);
    if (withMids) ed.mids.forEach(function (m, i) { m.setLngLat(ll(mid(pts[i], pts[i + 1]))); });
  }

  function edChanged() {
    // перестраиваем после того, как карта закончит обработку перетаскивания
    setTimeout(function () {
      if (!ed) return;
      ed.path = edCopy();
      edBuild();
      ed.onChange(edCopy());
    }, 0);
  }

  function edClear() {
    ed.verts.concat(ed.mids).forEach(function (m) { m.remove(); });
    ed.verts = []; ed.mids = [];
  }

  function edBuild() {
    edClear();
    var pts = edPts();
    setData('edit', [line(pts)]);
    for (var k = 0; k < pts.length - 1; k++) (function (i) {
      var m = edMarker(mid(pts[i], pts[i + 1]), 'm');
      m.on('dragstart', function () {
        var p = m.getLngLat();
        ed.path.splice(i, 0, [p.lat, p.lng]);
        ed.mids.forEach(function (x) { if (x !== m) x.getElement().style.visibility = 'hidden'; });
        m.getElement().classList.remove('m'); m.getElement().classList.add('v', 'drag');
      });
      m.on('drag', function () { var p = m.getLngLat(); ed.path[i] = [p.lat, p.lng]; edSync(false); });
      m.on('dragend', function () { ed.quietUntil = Date.now() + 400; edChanged(); });
      ed.mids.push(m);
    })(k);
    ed.path.forEach(function (p, i) {
      var m = edMarker(p, 'v');
      m.on('dragstart', function () { m.getElement().classList.add('drag'); });
      m.on('drag', function () { var q = m.getLngLat(); ed.path[i] = [q.lat, q.lng]; edSync(true); });
      m.on('dragend', function () { ed.quietUntil = Date.now() + 400; edChanged(); });
      m.getElement().addEventListener('click', function (e) {
        e.stopPropagation();
        // сразу после перетаскивания браузер может прислать «нажатие» — это не просьба удалить точку
        if (Date.now() < ed.quietUntil) return;
        ed.path.splice(i, 1); edChanged();
      });
      ed.verts.push(m);
    });
  }

  /** Включает правку трассы между точками a и b. onChange(path) вызывается после каждого изменения. */
  M.editPath = function (a, b, path, onChange) {
    M.stopEdit();
    ed = { a: a, b: b, path: path.map(function (p) { return p.slice(); }), onChange: onChange, verts: [], mids: [], quietUntil: 0 };
    edBuild();
  };
  M.editSet = function (path) {
    if (!ed) return;
    ed.path = path.map(function (p) { return p.slice(); });
    edBuild();
  };
  /** Добавляет точку изгиба в ближайший к нажатию отрезок. */
  M.editInsert = function (p) {
    if (!ed || Date.now() < ed.quietUntil) return;
    ed.path.splice(M.nearestSegment(edPts(), [p.lat, p.lng]), 0, [p.lat, p.lng]);
    edChanged();
  };
  M.stopEdit = function () {
    if (!ed) return;
    edClear(); ed = null;
    setData('edit', []);
  };

  // ------------------------------------------------------------------ моё местоположение

  M.following = function () { return follow; };

  function drawMe(acc) {
    var feats = [point(M.myPos)];
    if (acc && acc > 8) {
      var ring = [], lat = M.myPos[0], lng = M.myPos[1], dLat = acc / 111320, dLng = acc / (111320 * Math.cos(lat * Math.PI / 180));
      for (var i = 0; i <= 48; i++) { var a = i / 48 * 2 * Math.PI; ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    setData('me', feats);
  }

  M.locate = function () {
    if (!navigator.geolocation) { NM.emit('toast', 'На этом устройстве определение места недоступно'); return; }
    if (!NM.native && !window.isSecureContext) {
      NM.emit('toast', 'В браузере определение места работает только по HTTPS. В приложении оно доступно всегда.');
      return;
    }
    follow = true;
    if (watchId !== null && M.myPos) {
      // уже следим: повторное нажатие возвращает карту к моему месту
      M.setView(M.myPos, Math.max(map.getZoom(), 15));
      NM.emit('locate');
      return;
    }
    if (watchId === null) {
      watchId = navigator.geolocation.watchPosition(function (pos) {
        M.myPos = [pos.coords.latitude, pos.coords.longitude];
        drawMe(pos.coords.accuracy);
        if (follow) M.setView(M.myPos, Math.max(map.getZoom(), 15));
        NM.emit('locate');
      }, function (err) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null; follow = false;
        NM.emit('toast', err.code === 1 ? 'Нет разрешения на определение места' : 'Не удалось определить место');
        NM.emit('locate');
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    }
    NM.emit('locate');
  };

  // ------------------------------------------------------------------ сохранение карты для работы без связи

  /** Список адресов плиток текущей области от текущего масштаба до maxZoom. */
  M.tilesForView = function (maxZoom) {
    var def = NM.TILE_LAYERS.filter(function (l) { return l.id === M.prefs.layer; })[0] || NM.TILE_LAYERS[0];
    // у MapLibre масштаб считается для плиток 512 px, поэтому номер уровня обычных плиток на единицу больше
    var b = map.getBounds(), z0 = Math.max(0, Math.round(map.getZoom()) + 1), urls = [];
    maxZoom = Math.min(maxZoom, def.maxNativeZoom);
    function tx(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
    function ty(lat, z) {
      var r = lat * Math.PI / 180;
      return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }
    for (var z = z0; z <= maxZoom; z++) {
      var x1 = tx(b.getWest(), z), x2 = tx(b.getEast(), z), y1 = ty(b.getNorth(), z), y2 = ty(b.getSouth(), z);
      for (var x = x1; x <= x2; x++) for (var y = y1; y <= y2; y++) {
        urls.push(NM.tileUrl(def).replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
    }
    return urls;
  };

  NM.on('objects', function () { M.rebuild(); });
  NM.on('settings', function () { if (M.ready) { buildLinkLayers(); M.rebuild(); } });
  NM.on('reset', function () { M.rebuild(); });
})();
