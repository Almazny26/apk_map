/* Карта сети — отрисовка карты: подложка, узлы, линии, подписи, моё местоположение. */
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

  // Маркер-фигура на общем холсте: тысячи узлов рисуются быстро, а вид узла различим по форме.
  var ShapeMarker = L.CircleMarker.extend({
    _updatePath: function () {
      var r = this._renderer, shape = this.options.shape;
      if (!r._ctx || !shape || shape === 'circle') { r._updateCircle(this); return; }
      if (!r._drawing || this._empty()) return;
      var p = this._point, ctx = r._ctx, s = Math.max(Math.round(this._radius), 1);
      ctx.beginPath();
      if (shape === 'square') {
        ctx.rect(p.x - s * 0.9, p.y - s * 0.9, s * 1.8, s * 1.8);
      } else if (shape === 'diamond') {
        ctx.moveTo(p.x, p.y - s * 1.25); ctx.lineTo(p.x + s * 1.25, p.y);
        ctx.lineTo(p.x, p.y + s * 1.25); ctx.lineTo(p.x - s * 1.25, p.y); ctx.closePath();
      } else if (shape === 'triangle') {
        ctx.moveTo(p.x, p.y - s * 1.25); ctx.lineTo(p.x + s * 1.2, p.y + s * 0.9);
        ctx.lineTo(p.x - s * 1.2, p.y + s * 0.9); ctx.closePath();
      } else {
        for (var i = 0; i < 6; i++) {
          var a = Math.PI / 3 * i;
          ctx[i ? 'lineTo' : 'moveTo'](p.x + s * 1.15 * Math.cos(a), p.y + s * 1.15 * Math.sin(a));
        }
        ctx.closePath();
      }
      r._fillStroke(ctx, this);
    }
  });

  var M = NM.map = {
    map: null,
    prefs: { layer: 'osm', view: null, hidden: { node_types: {}, statuses: {}, link_types: {} }, labels: true },
    nodeMarkers: new Map(),   // id узла -> маркер
    linkLines: new Map(),     // id линии -> {line, halo}
    selected: null,
    myPos: null
  };

  var baseLayer = null, linkGroup, haloGroup, nodeGroup, labelGroup, selGroup, draftGroup, meGroup;
  var watchId = null, follow = false;

  M.savePrefs = NM.debounce(function () { NM.kv.set('prefs', M.prefs); }, 800);

  M.shapeOf = function (typeId) {
    var arr = D.settings.node_types || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === typeId) return SHAPES[i % SHAPES.length];
    return 'circle';
  };

  function radius() {
    var z = M.map.getZoom();
    return z < 9 ? 4 : z < 12 ? 6 : z < 15 ? 8 : 10;
  }

  function statusColor(id) {
    var st = NM.lookup('statuses', id);
    return st ? st.color : '#64748b';
  }

  function isFirstStatus(id) {
    var arr = D.settings.statuses || [];
    return !id || (arr.length && arr[0].id === id);
  }

  function hidden(o) {
    var h = M.prefs.hidden;
    if (h.statuses[o.data.status]) return true;
    return o.kind === 'node' ? !!h.node_types[o.data.type] : !!h.link_types[o.data.type];
  }

  M.init = function () {
    var saved = NM.kv.get('prefs');
    if (saved) {
      for (var k in saved) M.prefs[k] = saved[k];
      M.prefs.hidden = M.prefs.hidden || {};
      ['node_types', 'statuses', 'link_types'].forEach(function (key) {
        M.prefs.hidden[key] = M.prefs.hidden[key] || {};
      });
    }
    var touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    var map = M.map = L.map('map', {
      zoomControl: false,
      preferCanvas: true,
      renderer: L.canvas({ tolerance: touch ? 14 : 5, padding: 0.4 }),
      minZoom: 3, maxZoom: 19,
      worldCopyJump: true
    });
    map.attributionControl.setPrefix(false);
    if (!touch) L.control.zoom({ position: 'bottomleft', zoomInTitle: 'Приблизить', zoomOutTitle: 'Отдалить' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    haloGroup = L.layerGroup().addTo(map);
    linkGroup = L.layerGroup().addTo(map);
    selGroup = L.layerGroup().addTo(map);
    nodeGroup = L.layerGroup().addTo(map);
    draftGroup = L.layerGroup().addTo(map);
    meGroup = L.layerGroup().addTo(map);
    labelGroup = L.layerGroup().addTo(map);

    M.setLayer(M.prefs.layer);
    if (M.prefs.view) map.setView(M.prefs.view.c, M.prefs.view.z);
    else map.setView([61, 60], 4);

    map.on('moveend', function () {
      var c = map.getCenter();
      M.prefs.view = { c: [c.lat, c.lng], z: map.getZoom() };
      M.savePrefs();
      updateLabels();
    });
    map.on('zoomend', function () {
      var r = radius();
      M.nodeMarkers.forEach(function (m) { m.setRadius(r); });
      drawSelection();
    });
    map.on('click', function (e) { NM.emit('maptap', e.latlng); });
    map.on('dragstart', function () { if (follow) { follow = false; NM.emit('locate'); } });

    M.rebuild();
    if (!M.prefs.view) M.fitAll();
  };

  M.setLayer = function (id) {
    var def = NM.TILE_LAYERS.filter(function (l) { return l.id === id; })[0] || NM.TILE_LAYERS[0];
    if (baseLayer) M.map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(NM.tileUrl(def), {
      maxZoom: 19, maxNativeZoom: def.maxNativeZoom, attribution: def.attribution,
      keepBuffer: 3, updateWhenIdle: false
    }).addTo(M.map);
    baseLayer.bringToBack();
    M.prefs.layer = def.id;
    M.savePrefs();
    document.body.classList.toggle('sat', def.id === 'sat');
  };

  // ------------------------------------------------------------------ узлы и линии

  function drawNode(o) {
    var old = M.nodeMarkers.get(o.id);
    if (old) { nodeGroup.removeLayer(old); M.nodeMarkers.delete(o.id); }
    if (hidden(o) || typeof o.data.lat !== 'number' || typeof o.data.lng !== 'number') return;
    var m = new ShapeMarker([o.data.lat, o.data.lng], {
      radius: radius(),
      shape: M.shapeOf(o.data.type),
      color: o.pending ? '#f59e0b' : '#0f172a',
      weight: o.pending ? 3 : 1.5,
      fillColor: statusColor(o.data.status),
      fillOpacity: 1,
      bubblingMouseEvents: false
    });
    m.on('click', function () { NM.emit('tap', o.id); });
    m.addTo(nodeGroup);
    M.nodeMarkers.set(o.id, m);
  }

  function removeLink(id) {
    var old = M.linkLines.get(id);
    if (!old) return;
    linkGroup.removeLayer(old.line);
    if (old.halo) haloGroup.removeLayer(old.halo);
    M.linkLines.delete(id);
  }

  function drawLink(o) {
    removeLink(o.id);
    var pts = D.linkPoints(o);
    if (!pts || hidden(o)) return;
    var a = D.view.get(o.data.a), b = D.view.get(o.data.b);
    if (hidden(a) || hidden(b)) return;
    var t = NM.lookup('link_types', o.data.type);
    var line = L.polyline(pts, {
      color: t ? t.color : '#475569',
      weight: 4,
      opacity: o.pending ? 0.7 : 0.95,
      dashArray: t && t.dash ? t.dash : null,
      lineCap: t && t.dash ? 'butt' : 'round',
      bubblingMouseEvents: false
    });
    line.on('click', function () { NM.emit('tap', o.id); });
    line.addTo(linkGroup);
    var halo = null;
    if (!isFirstStatus(o.data.status)) {
      // состояние линии, отличное от обычного, показываем цветной подложкой под ней
      halo = L.polyline(pts, { color: statusColor(o.data.status), weight: 12, opacity: 0.45, interactive: false });
      halo.addTo(haloGroup);
    }
    M.linkLines.set(o.id, { line: line, halo: halo });
  }

  // Всё рисуется на одном холсте, и при нажатии Leaflet выбирает объект, нарисованный последним.
  // Поэтому порядок такой: подсветка состояния, линии, узлы — узел всегда «сверху» своей линии.
  function restack() {
    haloGroup.eachLayer(function (l) { l.bringToBack(); });
    M.nodeMarkers.forEach(function (m) { m.bringToFront(); });
  }

  /** Перерисовывает изменившиеся объекты (и линии, приходящие в изменившиеся узлы). */
  M.refresh = function (ids) {
    if (!M.map) return;
    var nodeIds = {}, linkIds = {};
    ids.forEach(function (id) {
      var o = D.view.get(id);
      if (o) { (o.kind === 'node' ? nodeIds : linkIds)[id] = true; return; }
      if (M.nodeMarkers.has(id)) { nodeGroup.removeLayer(M.nodeMarkers.get(id)); M.nodeMarkers.delete(id); nodeIds[id] = true; }
      removeLink(id);
    });
    if (Object.keys(nodeIds).length) {
      D.view.forEach(function (o) {
        if (o.kind === 'link' && (nodeIds[o.data.a] || nodeIds[o.data.b])) linkIds[o.id] = true;
      });
    }
    Object.keys(nodeIds).forEach(function (id) { var o = D.view.get(id); if (o) drawNode(o); });
    Object.keys(linkIds).forEach(function (id) { var o = D.view.get(id); if (o) drawLink(o); else removeLink(id); });
    if (Object.keys(linkIds).length) restack();
    if (M.selected && !D.view.has(M.selected)) M.selected = null;
    drawSelection();
    updateLabels();
  };

  M.rebuild = function () {
    if (!M.map) return;
    nodeGroup.clearLayers(); linkGroup.clearLayers(); haloGroup.clearLayers();
    M.nodeMarkers.clear(); M.linkLines.clear();
    D.view.forEach(function (o) { if (o.kind === 'node') drawNode(o); });
    D.view.forEach(function (o) { if (o.kind === 'link') drawLink(o); });
    restack();
    drawSelection();
    updateLabels();
  };

  var updateLabels = NM.debounce(function () {
    labelGroup.clearLayers();
    var map = M.map;
    if (!M.prefs.labels || map.getZoom() < 13) return;
    var b = map.getBounds().pad(0.05), n = 0;
    M.nodeMarkers.forEach(function (m, id) {
      if (n >= 250 || !b.contains(m.getLatLng())) return;
      var o = D.view.get(id);
      if (!o) return;
      n++;
      L.tooltip({ permanent: true, direction: 'right', offset: [radius() + 3, 0], className: 'nm-label', interactive: false })
        .setLatLng(m.getLatLng()).setContent(NM.esc(o.data.name)).addTo(labelGroup);
    });
  }, 120);
  M.updateLabels = updateLabels;

  // ------------------------------------------------------------------ выделение и навигация

  function drawSelection() {
    selGroup.clearLayers();
    var o = M.selected && D.view.get(M.selected);
    if (!o) return;
    if (o.kind === 'node') {
      L.circleMarker([o.data.lat, o.data.lng], {
        radius: radius() + 8, color: '#0b6bcb', weight: 3, fillColor: '#0b6bcb', fillOpacity: 0.18, interactive: false
      }).addTo(selGroup);
    } else {
      var pts = D.linkPoints(o);
      if (pts) L.polyline(pts, { color: '#0b6bcb', weight: 14, opacity: 0.35, interactive: false }).addTo(selGroup);
    }
  }

  M.select = function (id) { M.selected = id || null; drawSelection(); };
  M.restack = restack;

  /** Показывает объект на карте с учётом того, что нижняя часть экрана закрыта карточкой. */
  M.focus = function (id, zoomIn) {
    var o = D.view.get(id);
    if (!o) return;
    var pad = NM.ui ? NM.ui.mapPadding() : { paddingTopLeft: [20, 70], paddingBottomRight: [20, 20] };
    if (o.kind === 'node') {
      var z = zoomIn ? Math.max(M.map.getZoom(), 15) : M.map.getZoom();
      M.map.fitBounds(L.latLngBounds([o.data.lat, o.data.lng], [o.data.lat, o.data.lng]),
        { paddingTopLeft: pad.paddingTopLeft, paddingBottomRight: pad.paddingBottomRight, maxZoom: z });
    } else {
      var pts = D.linkPoints(o);
      if (pts) M.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: pad.paddingTopLeft, paddingBottomRight: pad.paddingBottomRight, maxZoom: 16 });
    }
  };

  M.fitAll = function () {
    var pts = [];
    M.nodeMarkers.forEach(function (m) { pts.push(m.getLatLng()); });
    if (pts.length) M.map.fitBounds(L.latLngBounds(pts), { padding: [40, 80], maxZoom: 15 });
  };

  M.center = function () { var c = M.map.getCenter(); return [c.lat, c.lng]; };

  // ------------------------------------------------------------------ черновик (новая линия, правка трассы)

  /** Рисует временную линию и точки-ручки. onHandle(index) вызывается при нажатии на ручку. */
  M.draft = function (points, handles, onHandle) {
    draftGroup.clearLayers();
    if (points && points.length > 1) {
      L.polyline(points, { color: '#0b6bcb', weight: 4, dashArray: '6 8', interactive: false }).addTo(draftGroup);
    }
    (handles || []).forEach(function (p, i) {
      var h = L.circleMarker(p, {
        radius: 9, color: '#0b6bcb', weight: 3, fillColor: '#ffffff', fillOpacity: 1, bubblingMouseEvents: false
      });
      h.on('click', function () { onHandle(i); });
      h.addTo(draftGroup);
    });
  };

  /** Индекс отрезка ломаной, ближайшего к точке (в экранных пикселях). */
  M.nearestSegment = function (points, latlng) {
    var p = M.map.latLngToLayerPoint(latlng), best = 0, bestD = Infinity;
    for (var i = 0; i < points.length - 1; i++) {
      var d = L.LineUtil.pointToSegmentDistance(p, M.map.latLngToLayerPoint(points[i]), M.map.latLngToLayerPoint(points[i + 1]));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  // ------------------------------------------------------------------ моё местоположение

  M.locating = function () { return watchId !== null; };
  M.following = function () { return follow; };

  M.locate = function () {
    if (!navigator.geolocation) { NM.emit('toast', 'На этом устройстве определение места недоступно'); return; }
    if (!NM.native && !window.isSecureContext) {
      NM.emit('toast', 'В браузере определение места работает только по HTTPS. В приложении оно доступно всегда.');
      return;
    }
    if (watchId !== null && M.myPos) {
      // уже следим: повторное нажатие возвращает карту к моему месту
      follow = true;
      M.map.setView(M.myPos, Math.max(M.map.getZoom(), 16));
      NM.emit('locate');
      return;
    }
    follow = true;
    if (watchId === null) {
      watchId = navigator.geolocation.watchPosition(function (pos) {
        M.myPos = [pos.coords.latitude, pos.coords.longitude];
        M.myAcc = pos.coords.accuracy;
        meGroup.clearLayers();
        L.circle(M.myPos, { radius: pos.coords.accuracy, color: '#0b6bcb', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(meGroup);
        L.circleMarker(M.myPos, { radius: 7, color: '#ffffff', weight: 3, fillColor: '#0b6bcb', fillOpacity: 1, interactive: false }).addTo(meGroup);
        if (follow) M.map.setView(M.myPos, Math.max(M.map.getZoom(), 16));
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
    var b = M.map.getBounds(), z0 = Math.max(0, Math.floor(M.map.getZoom())), urls = [];
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

  NM.on('objects', function (ids) { M.refresh(ids); });
  NM.on('settings', function () { M.rebuild(); });
  NM.on('reset', function () { M.rebuild(); });
})();
