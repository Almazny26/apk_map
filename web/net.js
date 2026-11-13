/* Карта сети — постоянная карта сети поверх приложения «WiFi Френель».
 *
 * Подключается в index.html после кода приложения (до exchange.js). Добавляет:
 *   - вкладку «Сеть»: узлы доступа и сохранённые линии (радиолинии и ВОЛС), поиск, фильтр, журнал;
 *   - слой сети на карте во всех вкладках, карточка объекта по нажатию;
 *   - «Сохранить в сеть» в панелях «Радио» и «ВОЛС», «Открыть» сохранённую линию для правки;
 *   - перетаскивание точек радиолинии и паспорта, вставку опоры между точками паспорта;
 *   - прилипание точек к узлам сети;
 *   - «Где я» (GPS телефона или местоположение компьютера);
 *   - window.KartaNet для exchange.js: выгрузка и объединение сети из файлов.
 *
 * Хранение: localStorage karta_net = {v: 1, objs: {id: объект}, journal: [...]}.
 * Объект: {id, type: node|radio|fiber, f: {поле: значение}, ft: {поле: время правки}, t, by}.
 * Удаление — поле deleted. При объединении файлов для каждого поля побеждает более поздняя правка,
 * поэтому правки разных бригад в разных полях сохраняются, а повторная загрузка файла ничего не меняет.
 */
(function () {
  'use strict';
  if (!window.L || typeof map === 'undefined') return;

  var KEY = 'karta_net', CUR = 'karta_cur', WHO = 'karta_author', TAB = 'karta_tab';
  var JOURNAL_MAX = 1000;
  var pc = !!window.KartaPC, android = window.KartaFiles || null;
  var $ = function (id) { return document.getElementById(id); };

  var NODE_KINDS = ['узел доступа', 'узел агрегации', 'опорный узел', 'базовая станция', 'коммутатор', 'клиент', 'другое'];
  // форма значка по виду узла — как в прежней «Карте сети» 1.3 (кружок, квадрат, ромб, треугольник…)
  var SHAPE = {
    'узел доступа': '<circle cx="12" cy="12" r="8"/>',
    'узел агрегации': '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/>',
    'опорный узел': '<path d="M12 2.2 21.8 12 12 21.8 2.2 12Z"/>',
    'базовая станция': '<path d="M12 2.6 21.6 19.6H2.4Z"/>',
    'коммутатор': '<rect x="2.4" y="6.8" width="19.2" height="10.4" rx="2"/>',
    'клиент': '<circle cx="12" cy="12" r="5.2"/>',
    'другое': '<path d="M12 2.6 20.2 7.3V16.7L12 21.4 3.8 16.7V7.3Z"/>'
  };
  function shapeSvg(kind, color, px) {
    return '<svg class="nm-shape" width="' + px + '" height="' + px + '" viewBox="0 0 24 24"><g fill="' + color +
      '" stroke="#fff" stroke-width="2.4" stroke-linejoin="round">' + (SHAPE[kind] || SHAPE['другое']) + '</g></svg>';
  }
  var STATES = {
    'работает': '#2e7d32',
    'авария': '#c62828',
    'работы': '#ef6c00',
    'план': '#78909c'
  };
  var RESULT = { ok: 'проходит', tight: 'на пределе', blocked: 'не пройдёт', unknown: 'не рассчитана' };
  var TYPE_NAME = { node: 'узел', radio: 'радиолиния', fiber: 'ВОЛС' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function when(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function copy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function km(v) { return (v || 0).toFixed(2) + ' км'; }
  function say(msg) { if (typeof status === 'function') status(msg); }

  // ================================================================== данные

  function empty() { return { v: 1, objs: {}, journal: [] }; }
  function valid(d) { return d && typeof d === 'object' && d.objs && typeof d.objs === 'object'; }
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY));
      if (valid(d)) { if (!Array.isArray(d.journal)) d.journal = []; return d; }
    } catch (e) { /* пусто или повреждено */ }
    return empty();
  }
  var db = load();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { say('Не удалось сохранить сеть: память приложения заполнена.'); }
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function author() { return localStorage.getItem(WHO) || (pc ? 'Компьютер' : android ? 'Телефон' : 'Браузер'); }

  function alive() {
    return Object.keys(db.objs).map(function (k) { return db.objs[k]; }).filter(function (o) { return !o.f.deleted; });
  }
  function get(id) { var o = id && db.objs[id]; return o && !o.f.deleted ? o : null; }

  function log(o, what) {
    var j = db.journal[0], now = Date.now();
    if (j && j.id === o.id && j.what === what && j.by === author() && now - j.t < 10 * 60000) {
      j.t = now; j.name = o.f.name || ''; return;   // правки одной трассы подряд — одна запись
    }
    db.journal.unshift({ t: Date.now(), by: author(), id: o.id, type: o.type, name: o.f.name || '', what: what });
    if (db.journal.length > JOURNAL_MAX) db.journal.length = JOURNAL_MAX;
  }

  /* Записать поля объекта (новый, если id не задан). Возвращает объект. */
  function put(id, type, fields, what) {
    var o = id && db.objs[id], isNew = !o, now = Date.now();
    if (!o) { o = { id: id || uid(), type: type, f: {}, ft: {}, t: now, by: author() }; db.objs[o.id] = o; }
    var changed = [];
    Object.keys(fields).forEach(function (k) {
      if (same(o.f[k], fields[k])) return;
      o.f[k] = copy(fields[k]);
      o.ft[k] = Math.max(now, (o.ft[k] || 0) + 1);   // своя правка всегда позже прежней
      changed.push(k);
    });
    if (!changed.length && !isNew) return o;
    o.t = now; o.by = author();
    log(o, what || (isNew ? 'добавлен' : 'изменён'));
    save();
    refresh();
    return o;
  }
  function remove(id) {
    var o = get(id);
    if (!o) return;
    put(id, o.type, { deleted: true }, 'удалён');
    var cur = curGet();
    if (cur.radio === id) cur.radio = null;
    if (cur.fiber === id) cur.fiber = null;
    curSet(cur);
  }

  // объединение с данными из файла: побеждает более поздняя правка каждого поля
  function mergeInto(target, inc) {
    var res = { added: 0, changed: 0, deleted: 0 };
    if (!valid(inc)) return res;
    Object.keys(inc.objs).forEach(function (id) {
      var io = inc.objs[id];
      if (!io || !io.f || !io.ft || !/^(node|radio|fiber)$/.test(io.type)) return;
      var lo = target.objs[id];
      if (!lo) {
        target.objs[id] = copy(io);
        if (!io.f.deleted) res.added++;
        return;
      }
      var ch = false, wasDeleted = !!lo.f.deleted;
      Object.keys(io.ft).forEach(function (k) {
        var a = io.ft[k] || 0, b = lo.ft[k] || 0;
        if (a > b || (a === b && !same(io.f[k], lo.f[k]) && JSON.stringify(io.f[k]) > JSON.stringify(lo.f[k]))) {
          lo.f[k] = copy(io.f[k]); lo.ft[k] = a; ch = true;
        }
      });
      if (ch) {
        if (!wasDeleted && lo.f.deleted) res.deleted++; else res.changed++;
        if ((io.t || 0) > (lo.t || 0)) { lo.t = io.t; lo.by = io.by; }
      }
    });
    var seen = {}, all = [];
    target.journal.concat(Array.isArray(inc.journal) ? inc.journal : []).forEach(function (j) {
      if (!j || typeof j !== 'object') return;
      var k = j.t + '|' + j.by + '|' + j.id + '|' + j.what;
      if (seen[k]) return;
      seen[k] = true; all.push(j);
    });
    all.sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    target.journal = all.slice(0, JOURNAL_MAX);
    return res;
  }

  function counts(d) {
    var c = { node: 0, radio: 0, fiber: 0 };
    if (valid(d)) Object.keys(d.objs).forEach(function (k) { var o = d.objs[k]; if (o && o.f && !o.f.deleted && c[o.type] != null) c[o.type]++; });
    return c;
  }

  // ================================================================== открытая в редакторе линия

  function curGet() {
    try { var c = JSON.parse(localStorage.getItem(CUR)); if (c && typeof c === 'object') return c; } catch (e) { /* нет */ }
    return { radio: null, fiber: null };
  }
  function curSet(c) { try { localStorage.setItem(CUR, JSON.stringify(c)); } catch (e) { /* не важно */ } curLabels(); refresh(); }

  // ================================================================== стили

  var css = document.createElement('style');
  css.textContent = [
    '.nm-shape{display:block;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))}',
    '.nm-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin:4px 0 2px;font-size:12px;color:var(--muted)}',
    '.nm-legend span{display:inline-flex;align-items:center;gap:4px}',
    '.nm-legend .nm-shape{filter:none}',
    '.nm-lbl{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:2px;white-space:nowrap;font:600 11px/1.2 sans-serif;' +
      'color:#1a1a1a;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;pointer-events:none}',
    '.nm-nolabels .nm-lbl{display:none}',
    '.nm-llbl{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;font:600 11px/1.3 sans-serif;padding:0 5px;' +
      'border-radius:8px;background:rgba(255,255,255,.88);color:#bf360c;border:1px solid #bf360c;pointer-events:none}',
    '.nm-llbl.radio{color:#1565c0;border-color:#1565c0}',
    '.nm-nolinelabels .nm-llbl{display:none}',
    '#nmBar{display:none;position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--sheet-h,26px) + 14px);z-index:99999;' +
      'width:min(560px,calc(100vw - 20px));box-sizing:border-box;align-items:center;gap:8px;padding:8px 8px 8px 14px;border-radius:12px;background:var(--panel);color:var(--text);' +
      'box-shadow:0 6px 24px rgba(0,0,0,.3);font-size:13px;line-height:1.3}',
    '#nmBar.active{display:flex}',
    '#nmBar span{flex:1;min-width:0}',
    '#nmBar small{display:block;color:var(--muted);font-size:12px;margin-top:2px}',
    '#nmBar button{flex:0 0 auto;padding:8px 12px;font-size:14px}',
    '.nm-fit a{font:700 18px/30px sans-serif!important;text-align:center;cursor:pointer}',
    '.nm-mid{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #ef6c00;box-sizing:border-box;' +
      'color:#ef6c00;font:700 11px/10px sans-serif;text-align:center;opacity:.85;box-shadow:0 1px 3px rgba(0,0,0,.4)}',
    '.nm-me{width:16px;height:16px;border-radius:50%;background:#1e88e5;border:3px solid #fff;box-sizing:border-box;box-shadow:0 0 0 2px rgba(30,136,229,.35),0 1px 4px rgba(0,0,0,.5)}',
    '.nm-locate a{font:700 17px/30px sans-serif!important;text-align:center;cursor:pointer}',
    '.nm-pop{font-size:13px;line-height:1.4;min-width:200px}',
    '.nm-pop b{font-size:14px}',
    '.nm-pop .nm-sub{color:#555;font-size:12px}',
    '.nm-pop .nm-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
    '.nm-pop button{padding:5px 9px;font-size:12px}',
    '.nm-st{display:inline-block;padding:0 6px;border-radius:8px;color:#fff;font-size:11px;font-weight:700}',
    '#panelNet .nm-list{margin:6px 0}',
    '#panelNet .nm-item{display:flex;gap:8px;align-items:center;cursor:pointer}',
    '#panelNet .nm-item:hover{border-color:var(--accent)}',
    '#panelNet .nm-ico{flex:0 0 18px;height:14px;border-radius:50%}',
    '#panelNet .nm-item .nm-shape{flex:0 0 18px}',
    '.nm-legend i{display:inline-block}',
    '#panelNet .nm-ico.l{height:4px;border-radius:2px}',
    '#panelNet .nm-ico.r{height:0;border-top:3px dashed #1565c0;border-radius:0}',
    '#panelNet .nm-txt{flex:1;min-width:0}',
    '#panelNet .nm-txt div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#panelNet .nm-muted,.nm-cur{font-size:12px;color:var(--muted)}',
    '#panelNet input[type=search]{flex:1;min-width:120px}',
    '.nm-cur b{color:var(--text)}',
    '.nm-cur a{color:var(--accent);cursor:pointer;margin-left:6px}',
    '#netDlg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2050;align-items:center;justify-content:center}',
    '#netDlg.show{display:flex}',
    '#netDlg>.x{display:none}',
    '#netDlgBox{background:var(--panel);color:var(--text);width:92vw;max-width:460px;max-height:86vh;overflow:auto;border-radius:10px;padding:14px;font-size:14px}',
    '#netDlgBox h3{font-size:15px;margin:0 0 10px}',
    '#netDlgBox label{display:block;margin:8px 0 3px;font-size:13px}',
    '#netDlgBox input,#netDlgBox select,#netDlgBox textarea{width:100%;font-size:14px;padding:7px 8px}',
    '#netDlgBox textarea{min-height:64px;resize:vertical;font-family:inherit}',
    '#netDlgBox .nm-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}',
    '#netDlgBox .nm-row button{padding:8px 14px;font-size:14px}',
    '#netDlgBox .nm-j{border-bottom:1px solid var(--line);padding:6px 0;font-size:13px}',
    '#netDlgBox .nm-j small{color:var(--muted)}',
    ''
  ].join('\n');
  document.head.appendChild(css);

  // ================================================================== окно-диалог (формы, подтверждения, журнал)

  var dlg = document.createElement('div');
  dlg.id = 'netDlg';
  dlg.innerHTML = '<button class="x" id="netDlgClose" type="button">&times;</button><div id="netDlgBox"></div>';
  document.body.appendChild(dlg);
  var dlgBox = $('netDlgBox');
  function closeDlg() { dlg.classList.remove('show'); dlgBox.innerHTML = ''; }
  $('netDlgClose').onclick = closeDlg;
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDlg(); });

  /* fields: [{key, label, type: text|select|textarea, value, options}] → onOk(values) */
  function form(title, fields, okLabel, onOk) {
    dlgBox.innerHTML = '<h3>' + esc(title) + '</h3>' + fields.map(function (f, i) {
      var id = 'nmf' + i, v = f.value == null ? '' : f.value;
      if (f.type === 'select') {
        return '<label for="' + id + '">' + esc(f.label) + '</label><select id="' + id + '">' +
          f.options.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
      }
      if (f.type === 'textarea') return '<label for="' + id + '">' + esc(f.label) + '</label><textarea id="' + id + '">' + esc(v) + '</textarea>';
      return '<label for="' + id + '">' + esc(f.label) + '</label><input id="' + id + '" value="' + esc(v) + '"' +
        (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>';
    }).join('') +
      '<div class="nm-row"><button type="button" id="nmOk">' + esc(okLabel || 'Сохранить') + '</button>' +
      '<button type="button" class="secondary" id="nmCancel">Отмена</button></div>';
    dlg.classList.add('show');
    var first = dlgBox.querySelector('input,select,textarea');
    if (first && pc) first.focus();
    function ok() {
      var vals = {};
      fields.forEach(function (f, i) { vals[f.key] = $('nmf' + i).value.trim(); });
      if (fields[0] && fields[0].required && !vals[fields[0].key]) { $('nmf0').focus(); $('nmf0').style.borderColor = '#c62828'; return; }
      closeDlg();
      onOk(vals);
    }
    $('nmOk').onclick = ok;
    $('nmCancel').onclick = closeDlg;
    dlgBox.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); });
    });
  }
  function confirmDlg(text, okLabel, onOk) {
    dlgBox.innerHTML = '<h3>' + esc(text) + '</h3><div class="nm-row"><button type="button" id="nmOk" style="background:#c62828">' +
      esc(okLabel) + '</button><button type="button" class="secondary" id="nmCancel">Отмена</button></div>';
    dlg.classList.add('show');
    $('nmOk').onclick = function () { closeDlg(); onOk(); };
    $('nmCancel').onclick = closeDlg;
  }
  // поле «подпись» в формах, пока подпись не задана
  function whoField() {
    return localStorage.getItem(WHO) ? [] : [{ key: '_who', label: 'Как подписывать ваши изменения (бригада, фамилия)', value: '', placeholder: 'например: Бригада 2, Иванов' }];
  }
  function takeWho(v) { if (v._who) { localStorage.setItem(WHO, v._who); whoLabel(); } }

  // ================================================================== слой сети на карте

  var layer = L.layerGroup().addTo(map);
  var drawn = {};   // id → слой, для перехода к объекту из списка

  function nodeIcon(o) {
    var color = STATES[o.f.state] || '#455a64', px = o.f.kind === 'опорный узел' || o.f.kind === 'базовая станция' ? 26 : 22;
    return L.divIcon({
      className: '',
      html: shapeSvg(o.f.kind, color, px) + '<div class="nm-lbl">' + esc(o.f.name) + '</div>',
      iconSize: [px, px], iconAnchor: [px / 2, px / 2], popupAnchor: [0, -px / 2]
    });
  }

  function hiddenNow(id) {
    var cur = curGet();
    return cur.radio === id || cur.fiber === id;
  }

  // ------------------------------------------------------------------ работа второй вкладки на карте
  // Приложение показывает только линию открытой вкладки: во «ВОЛС» не видно радиолинии и наоборот.
  // Здесь работа другой вкладки рисуется рядом, бледнее; нажатие — перейти к ней.
  var ghost = L.layerGroup().addTo(map);
  function drawGhost() {
    ghost.clearLayers();
    var fiber = typeof fiberMode !== 'undefined' && fiberMode, cur = curGet(), name;
    if (fiber && points.length) {
      name = get(cur.radio) ? get(cur.radio).f.name : 'Радиолиния (не сохранена)';
      var rl = points.map(function (p) { return [p.lat, p.lng]; });
      if (rl.length >= 2) ghost.addLayer(L.polyline(rl, { color: '#1565c0', weight: 3, dashArray: '9 6', opacity: .75 })
        .bindTooltip(esc(name), { sticky: true }).on('click', function () { netTab(false); setTool('radio'); }));
      points.forEach(function (p, i) {
        ghost.addLayer(L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', weight: 2, fillColor: i === 0 ? '#c62828' : '#1565c0', fillOpacity: .85 })
          .bindTooltip(letter(i) + ' · ' + esc(name)).on('click', function () { netTab(false); setTool('radio'); }));
      });
    }
    if (!fiber && nodes.length) {
      name = get(cur.fiber) ? get(cur.fiber).f.name : 'ВОЛС (не сохранена)';
      var fl = nodes.map(function (p) { return [p.lat, p.lng]; });
      if (fl.length >= 2) ghost.addLayer(L.polyline(fl, { color: '#ef6c00', weight: 3, opacity: .75 })
        .bindTooltip(esc(name), { sticky: true }).on('click', function () { netTab(false); setTool('fiber'); }));
      nodes.forEach(function (p, i) {
        ghost.addLayer(L.circleMarker([p.lat, p.lng], { radius: 4, color: '#fff', weight: 1.5, fillColor: '#ef6c00', fillOpacity: .85 })
          .bindTooltip((i + 1) + '. ' + esc(p.kind) + ' ' + esc(p.name || '')).on('click', function () { netTab(false); setTool('fiber'); }));
      });
    }
  }

  function refresh() {
    layer.clearLayers();
    drawn = {};
    var objs = alive();
    // линии под узлами
    objs.filter(function (o) { return o.type !== 'node' && !hiddenNow(o.id); }).forEach(function (o) {
      var pts = (o.type === 'radio' ? o.f.points : o.f.fnodes) || [];
      if (pts.length < 2) return;
      var ll = pts.map(function (p) { return [p.lat, p.lng]; }), g;
      if (o.type === 'radio') {
        var bad = o.f.result === 'blocked';
        g = L.layerGroup([
          L.polyline(ll, { color: '#fff', weight: 6, opacity: .7, interactive: false }),
          L.polyline(ll, { color: bad ? '#c62828' : '#1565c0', weight: 3, dashArray: '9 6' })
        ]);
      } else {
        g = L.layerGroup([
          L.polyline(ll, { color: '#fff', weight: 7, opacity: .8, interactive: false }),
          L.polyline(ll, { color: '#bf360c', weight: 4 })
        ]);
        pts.forEach(function (p) {
          if (p.kind === 'опора') return;
          g.addLayer(L.circleMarker([p.lat, p.lng], { radius: 4, color: '#fff', weight: 2, fillColor: '#bf360c', fillOpacity: 1, interactive: false }));
        });
      }
      g.eachLayer(function (l) { if (l.options.interactive !== false) l.bindPopup(function () { return card(o.id); }); });
      var mid = pts[Math.floor((pts.length - 1) / 2)], nxt = pts[Math.floor((pts.length - 1) / 2) + 1] || mid;
      if (o.f.name) g.addLayer(L.marker([(mid.lat + nxt.lat) / 2, (mid.lng + nxt.lng) / 2], {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', html: '<div class="nm-llbl ' + o.type + '">' + esc(o.f.name) + '</div>', iconSize: [0, 0] })
      }));
      g.addTo(layer);
      drawn[o.id] = g;
    });
    objs.filter(function (o) { return o.type === 'node' && isFinite(o.f.lat) && isFinite(o.f.lng); }).forEach(function (o) {
      var m = L.marker([o.f.lat, o.f.lng], { icon: nodeIcon(o), draggable: netOn && !drawing(), zIndexOffset: 500 });
      if (drawing()) m.on('click', function () { nodeTap(o.id); });
      else m.bindPopup(function () { return card(o.id); });
      m.on('dragend', function () {
        var ll = m.getLatLng();
        put(o.id, 'node', { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }, 'перемещён');
        var n = follow(o.id);
        say('Узел «' + (o.f.name || '') + '» перемещён' + (n ? ', линий за ним: ' + n : ''));
      });
      m.addTo(layer);
      drawn[o.id] = m;
    });
    drawGhost();
    if ($('netSaveFiber')) curLabels();
    renderList();
  }

  function labels() {
    map.getContainer().classList.toggle('nm-nolabels', map.getZoom() < 10);
    map.getContainer().classList.toggle('nm-nolinelabels', map.getZoom() < 12);
  }
  map.on('zoomend', labels);
  labels();

  // ================================================================== карточка объекта

  function card(id) {
    var o = get(id), el = document.createElement('div');
    el.className = 'nm-pop';
    if (!o) { el.textContent = 'Объект удалён'; return el; }
    var f = o.f, html = '<b>' + esc(f.name || 'без названия') + '</b>';
    if (o.type === 'node') {
      html += '<br><span class="nm-sub">' + esc(f.kind || 'узел') + '</span> <span class="nm-st" style="background:' + (STATES[f.state] || '#455a64') + '">' + esc(f.state || '') + '</span>';
      if (f.addr) html += '<br>' + esc(f.addr);
      var sk = toSK42(f.lat, f.lng);
      html += '<br><span class="nm-sub">' + (+f.lat).toFixed(6) + ', ' + (+f.lng).toFixed(6) + '<br>СК-42 X=' + sk.x + ' Y=' + sk.y + '</span>';
    } else if (o.type === 'radio') {
      html += '<br><span class="nm-sub">радиолиния · ' + km(f.dist) + ' · ' + esc(f.freq || '') + ' МГц</span>';
      if (f.deviceName) html += '<br>' + esc(f.deviceName);
      html += '<br>Расчёт: <b style="font-size:13px;color:' + (f.result === 'ok' ? '#2e7d32' : f.result === 'blocked' ? '#c62828' : f.result === 'tight' ? '#ef6c00' : '#555') + '">' +
        esc(RESULT[f.result] || RESULT.unknown) + '</b>';
    } else {
      var kinds = {};
      (f.fnodes || []).forEach(function (p) { kinds[p.kind] = (kinds[p.kind] || 0) + 1; });
      html += '<br><span class="nm-sub">ВОЛС · ' + km(f.dist) + ' · точек ' + (f.fnodes || []).length + '</span><br>' +
        esc(Object.keys(kinds).map(function (k) { return k + ' ' + kinds[k]; }).join(', '));
    }
    if (f.note) html += '<br><i>' + esc(f.note) + '</i>';
    html += '<br><span class="nm-sub">изм. ' + esc(o.by || '') + ', ' + when(o.t) + '</span><div class="nm-row"></div>';
    el.innerHTML = html;
    var row = el.querySelector('.nm-row');
    function btn(text, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = text; if (cls) b.className = cls;
      b.onclick = function () { map.closePopup(); fn(); };
      row.appendChild(b);
    }
    if (o.type === 'node') {
      var linked = linesAt(o.id);
      if (linked.length) {
        var ul = document.createElement('div');
        ul.className = 'nm-sub';
        ul.innerHTML = 'Линии: ' + linked.map(function (l) { return '<a data-l="' + esc(l.id) + '" style="color:#1565c0;cursor:pointer">' + esc(l.f.name || TYPE_NAME[l.type]) + '</a>'; }).join(', ');
        ul.querySelectorAll('[data-l]').forEach(function (a) { a.onclick = function () { map.closePopup(); focus(a.getAttribute('data-l')); }; });
        el.insertBefore(ul, row);
      }
      btn('ВОЛС до узла', '', function () { startPick('fiber', o.id); });
      btn('ВОЛС по точкам', 'secondary', function () { startRoute(o.id); });
      btn('Радиолиния до узла', 'secondary', function () { startPick('radio', o.id); });
      btn('Изменить', 'secondary', function () { editNode(o.id); });
    } else {
      btn('Открыть', '', function () { openLine(o.id); });
      btn('Изменить', 'secondary', function () { editLine(o.id); });
    }
    btn('Удалить', 'secondary', function () {
      confirmDlg('Удалить ' + TYPE_NAME[o.type] + ' «' + (f.name || '') + '»?', 'Удалить', function () { remove(o.id); say('Удалено: ' + (f.name || '')); });
    });
    return el;
  }

  // ================================================================== узлы

  function nodeFields(f) {
    return [
      { key: 'name', label: 'Название', value: f.name, required: true, placeholder: 'например: УД-15 Садовая 4' },
      { key: 'kind', label: 'Вид', type: 'select', options: NODE_KINDS, value: f.kind || NODE_KINDS[0] },
      { key: 'state', label: 'Состояние', type: 'select', options: Object.keys(STATES), value: f.state || 'работает' },
      { key: 'addr', label: 'Адрес', value: f.addr },
      { key: 'note', label: 'Примечание', type: 'textarea', value: f.note }
    ].concat(whoField());
  }
  function newNode(ll) {
    form('Новый узел', nodeFields({}), 'Добавить', function (v) {
      takeWho(v);
      var o = put(null, 'node', { name: v.name, kind: v.kind, state: v.state, addr: v.addr, note: v.note, lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) });
      say('Узел «' + v.name + '» добавлен');
      return o;
    });
  }
  function editNode(id) {
    var o = get(id);
    if (!o) return;
    form('Узел', nodeFields(o.f), 'Сохранить', function (v) {
      takeWho(v);
      put(id, 'node', { name: v.name, kind: v.kind, state: v.state, addr: v.addr, note: v.note });
      say('Сохранено');
    });
  }

  // ближайший узел сети к точке (в пикселях экрана)
  function nearNode(ll, px) {
    var best = null, bd = px || 22, p = map.latLngToContainerPoint(ll);
    alive().forEach(function (o) {
      if (o.type !== 'node') return;
      var d = p.distanceTo(map.latLngToContainerPoint([o.f.lat, o.f.lng]));
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }
  function snap(ll) { var n = nearNode(ll); return n ? L.latLng(n.f.lat, n.f.lng) : ll; }

  // ================================================================== линии: сохранить, открыть

  var calcKey = null;   // точки и частота, для которых посчитан последний профиль
  function radioKey() { return JSON.stringify([points.map(function (p) { return [p.lat, p.lng, p.height]; }), $('freq').value, $('clutter').value]); }
  if (typeof calc === 'function') {
    var calcOrig = calc;
    window.calc = async function () {
      var key = radioKey(), r = await calcOrig.apply(this, arguments);
      if (lastProfile && lastProfile.report) calcKey = key;
      return r;
    };
  }

  function saveRadio() {
    if (points.length < 2) { say('Сначала поставьте точки A и B'); return; }
    var cur = curGet(), o = get(cur.radio), f = o ? o.f : {};
    var dev = $('device'), result = calcKey === radioKey() && lastProfile && lastProfile.report ? lastProfile.report.state : (o && same(f.points, pts()) ? f.result : 'unknown');
    function pts() { return points.map(function (p) { return { lat: +(+p.lat).toFixed(6), lng: +(+p.lng).toFixed(6), height: +p.height || 0 }; }); }
    var n = alive().filter(function (x) { return x.type === 'radio'; }).length + 1;
    form(o ? 'Сохранить радиолинию' : 'Радиолиния в сеть', [
      { key: 'name', label: 'Название', value: f.name || ('Радиолиния ' + n), required: true },
      { key: 'note', label: 'Примечание', type: 'textarea', value: f.note }
    ].concat(whoField()), 'Сохранить', function (v) {
      takeWho(v);
      var saved = put(o ? o.id : null, 'radio', {
        name: v.name, note: v.note, points: pts(), freq: $('freq').value, clutter: $('clutter').value,
        device: dev.value, deviceName: dev.value === 'none' ? '' : dev.selectedOptions[0].text, dist: +pathLength().toFixed(3), result: result
      });
      cur = curGet(); cur.radio = saved.id; curSet(cur);
      say('Радиолиния «' + v.name + '» сохранена в сети');
    });
  }

  function saveFiber() {
    if (nodes.length < 2) { say('Сначала поставьте хотя бы две точки линии'); return; }
    autosaveFiber();
    var cur0 = curGet();
    if (get(cur0.fiber)) { editLine(cur0.fiber); return; }   // линия ВОЛС сохраняется сама, здесь — название и примечание
    var cur = curGet(), o = get(cur.fiber), f = o ? o.f : {};
    var n = alive().filter(function (x) { return x.type === 'fiber'; }).length + 1;
    form(o ? 'Сохранить линию ВОЛС' : 'Линия ВОЛС в сеть', [
      { key: 'name', label: 'Название', value: f.name || ('ВОЛС ' + n), required: true },
      { key: 'note', label: 'Примечание', type: 'textarea', value: f.note }
    ].concat(whoField()), 'Сохранить', function (v) {
      takeWho(v);
      var saved = put(o ? o.id : null, 'fiber', {
        name: v.name, note: v.note, dist: +nodeLength().toFixed(3),
        fnodes: nodes.map(function (p) { return { lat: +(+p.lat).toFixed(6), lng: +(+p.lng).toFixed(6), kind: p.kind, name: p.name || '' }; })
      });
      cur = curGet(); cur.fiber = saved.id; curSet(cur);
      say('Линия «' + v.name + '» сохранена в сети');
    });
  }

  function editLine(id) {
    var o = get(id);
    if (!o) return;
    form(o.type === 'radio' ? 'Радиолиния' : 'Линия ВОЛС', [
      { key: 'name', label: 'Название', value: o.f.name, required: true },
      { key: 'note', label: 'Примечание', type: 'textarea', value: o.f.note }
    ].concat(whoField()), 'Сохранить', function (v) {
      takeWho(v);
      var fields = { name: v.name, note: v.note };
      if (v.name !== o.f.name) fields.autoName = false;   // своё название больше не меняется по узлам
      put(id, o.type, fields);
    });
  }

  function fitTo(list) {
    if (list.length >= 2) map.fitBounds(list.map(function (p) { return [p.lat, p.lng]; }), { padding: [40, 40], maxZoom: 15 });
    else if (list.length) map.setView([list[0].lat, list[0].lng], Math.max(map.getZoom(), 10));
  }

  function openLine(id) {
    var o = get(id);
    if (!o) return;
    netTab(false);
    var cur = curGet();
    if (o.type === 'radio') {
      points = (o.f.points || []).map(function (p) { var q = { lat: p.lat, lng: p.lng, height: isFinite(+p.height) ? +p.height : 15 }; if (p.nid) q.nid = p.nid; return q; });
      if (o.f.freq) $('freq').value = o.f.freq;
      if (o.f.clutter != null) $('clutter').value = o.f.clutter;
      if (o.f.device && document.querySelector('#device option[value="' + o.f.device + '"]')) $('device').value = o.f.device;
      lastProfile = null; calcKey = null;
      ['deviceResult', 'weatherBox', 'aim', 'masts', 'budget'].forEach(function (k) { var n = $(k); if (n) n.style.display = 'none'; });
      var c = $('profile'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
      cur.radio = id;
      setTool('radio');
      redrawMap(); saveSession();
      fitTo(points);
      say('Открыта радиолиния «' + (o.f.name || '') + '». Нажмите «Рассчитать профиль».');
    } else {
      nodes = (o.f.fnodes || []).map(function (p) { var q = { lat: p.lat, lng: p.lng, kind: p.kind, name: p.name || '' }; if (p.nid) q.nid = p.nid; return q; });
      cur.fiber = id; curSet(cur);
      saveNodes();
      setTool('fiber');
      fitTo(nodes);
      say('Открыта линия «' + (o.f.name || '') + '». Точки тянутся, «+» — вставить опору; всё сохраняется само.');
    }
    curSet(cur);
  }

  // строки «Сохранить в сеть» в панелях приложения
  function addSaveRow(after, btnId, curId, fn) {
    var row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<button type="button" class="secondary" id="' + btnId + '">Сохранить в сеть</button><span class="nm-cur" id="' + curId + '"></span>';
    after.parentNode.insertBefore(row, after.nextSibling);
    $(btnId).onclick = fn;
  }
  addSaveRow($('calc').parentNode, 'netSaveRadio', 'netCurRadio', saveRadio);
  addSaveRow($('nodeShare').parentNode, 'netSaveFiber', 'netCurFiber', saveFiber);

  function curLabels() {
    var cur = curGet();
    [['radio', 'netSaveRadio', 'netCurRadio'], ['fiber', 'netSaveFiber', 'netCurFiber']].forEach(function (x) {
      var o = get(cur[x[0]]), lbl = $(x[2]);
      if (x[0] === 'fiber') {
        // ВОЛС сохраняется сама; кнопка — название и примечание
        $(x[1]).textContent = 'Название…';
        $(x[1]).style.display = o ? '' : 'none';
        lbl.innerHTML = o ? 'Линия: <b>' + esc(o.f.name || '') + '</b> · ' + km(o.f.dist) + ' · сохраняется сама' : '';
        return;
      }
      $(x[1]).textContent = o ? 'Сохранить изменения' : 'Сохранить в сеть';
      if (!o) { lbl.innerHTML = ''; return; }
      lbl.innerHTML = 'Открыта: <b>' + esc(o.f.name || '') + '</b><a data-new="' + x[0] + '" title="Дальнейшие изменения сохранить как новую линию">как новую</a>';
      lbl.querySelector('a').onclick = function () { var c = curGet(); c[x[0]] = null; curSet(c); say('Следующее сохранение создаст новую линию'); };
    });
  }

  // «Очистить» в панелях — работа больше не связана с сохранённой линией
  $('clear').addEventListener('click', function () { var c = curGet(); if (c.radio) { c.radio = null; curSet(c); } calcKey = null; });
  $('nodeClear').addEventListener('click', function () { var c = curGet(); if (c.fiber) { c.fiber = null; curSet(c); } });

  // ================================================================== точки: прилипание, перетаскивание, вставка опоры

  if (typeof place === 'function') {
    var placeOrig = place;
    window.place = function (ll) {
      var n = nearNode(ll), r = placeOrig(n ? L.latLng(n.f.lat, n.f.lng) : ll);
      if (n) { points.forEach(function (p) { if (p.lat === n.f.lat && p.lng === n.f.lng) p.nid = n.id; }); saveSession(); }
      return r;
    };
  }
  if (typeof addNode === 'function') {
    var addNodeOrig = addNode;
    window.addNode = function (ll) {
      // точка паспорта на узле сети: координаты, имя и вид «узел» берутся из узла
      var n = nearNode(ll), nameInp = $('nodeName'), kindSel = $('nodeKind'), was = nameInp.value, wasKind = kindSel.value;
      if (n) { ll = L.latLng(n.f.lat, n.f.lng); if (!was.trim()) nameInp.value = n.f.name || ''; kindSel.value = 'узел'; }
      var r = addNodeOrig(ll);
      nameInp.value = was; kindSel.value = wasKind;
      if (n && nodes.length) { nodes[nodes.length - 1].nid = n.id; saveNodes(); }
      if (route) {
        if (n && nodes.length >= 2) {
          stopRoute();
          say('Линия «' + lineName() + '» дошла до узла «' + (n.f.name || '') + '» и сохранена');
        } else { armNode = true; $('nodeArm').classList.add('active'); }
        bar();
      }
      return r;
    };
  }

  function radioPoint(ll, which) {
    netTab(false);
    if (typeof fiberMode !== 'undefined' && fiberMode) setTool('radio');
    if (which === 'B' && points.length === 0) which = 'A';
    mode = which === 'A' ? 'A' : which === 'B' ? 'B' : 'more';
    place(ll);
  }

  var redrawOrig = window.redrawMap;
  window.redrawMap = function () {
    var r = redrawOrig.apply(this, arguments);
    markers.forEach(function (m, i) {
      if (!m.dragging) return;
      m.dragging.enable();
      m.on('drag', function () {
        if (!line) return;
        var ll = points.map(function (p) { return [p.lat, p.lng]; });
        ll[i] = m.getLatLng();
        line.setLatLngs(ll);
      });
      m.on('dragend', function () {
        var ll = snap(m.getLatLng());
        if (!points[i]) return;
        points[i].lat = ll.lat; points[i].lng = ll.lng;
        calcKey = null;
        redrawMap(); saveSession();
        say('Точка ' + letter(i) + ' перемещена. Пересчитайте профиль.');
      });
    });
    return r;
  };

  var mids = [];
  function clearMids() { mids.forEach(function (m) { map.removeLayer(m); }); mids = []; }
  var drawNodesOrig = window.drawNodes;
  window.drawNodes = function () {
    var r = drawNodesOrig.apply(this, arguments);
    clearMids();
    if (!nodes.length) $('nodeList').textContent = 'Точек пока нет. «Ставить точки» и нажимайте по трассе — или начните от узла: нажмите на узел → «ВОЛС по точкам».';
    nodeMarkers.forEach(function (m, i) {
      if (!m.dragging) return;
      m.dragging.enable();
      m.on('drag', function () {
        if (!nodeLine) return;
        var ll = nodes.map(function (p) { return [p.lat, p.lng]; });
        ll[i] = m.getLatLng();
        nodeLine.setLatLngs(ll);
      });
      m.on('dragend', function () {
        var ll = snap(m.getLatLng());
        if (!nodes[i]) return;
        nodes[i].lat = ll.lat; nodes[i].lng = ll.lng;
        saveNodes(); drawNodes();
        say('Точка ' + (i + 1) + ' перемещена');
      });
    });
    if (typeof fiberMode !== 'undefined' && fiberMode) {
      for (var i = 0; i + 1 < nodes.length; i++) (function (i) {
        var a = nodes[i], b = nodes[i + 1];
        var m = L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
          draggable: true, zIndexOffset: -100, title: 'Вставить опору между ' + (i + 1) + ' и ' + (i + 2),
          icon: L.divIcon({ className: '', html: '<div class="nm-mid">+</div>', iconSize: [14, 14], iconAnchor: [7, 7] })
        }).addTo(map);
        function insert(ll) {
          nodes.splice(i + 1, 0, { lat: ll.lat, lng: ll.lng, kind: 'опора', name: '' });
          saveNodes(); drawNodes();
          say('Вставлена опора ' + (i + 2));
        }
        m.on('click', function () { insert(m.getLatLng()); });
        m.on('dragend', function () { insert(snap(m.getLatLng())); });
        mids.push(m);
      })(i);
    }
    return r;
  };

  var setToolOrig = window.setTool;
  window.setTool = function (which) {
    var r = setToolOrig.apply(this, arguments);
    if (which !== 'fiber') clearMids();
    refresh();
    drawGhost();
    return r;
  };


  // ================================================================== соединения: ВОЛС и радиолинии между узлами
  /* Как соединять:
   *   - «ВОЛС до узла» (карточка узла) → нажать второй узел: линия создаётся сразу, по прямой; потом
   *     её ведут по улицам — тянут точки и «+» между ними (вставка опоры);
   *   - «ВОЛС по точкам» → нажимать на карту по трассе (каждое нажатие — опора), нажатие на узел
   *     завершает линию; «Назад» убирает последнюю точку, «Готово» — закончить где угодно;
   *   - «Новая линия» во вкладке «ВОЛС» — начать линию с пустого места;
   *   - «Радиолиния до узла» → второй узел: радиолиния с точками A и B на узлах, профиль считается.
   * Линия ВОЛС сохраняется в сеть сама при каждом изменении — ничего не теряется и нет
   * «притягивания» к старой линии: новая линия всегда начинается отдельно. Точки на узлах помнят узел
   * (nid): если узел передвинуть, концы линий едут за ним. */
  var route = false, pick = null;
  function drawing() { return route || !!pick; }

  var barEl = document.createElement('div');
  barEl.id = 'nmBar';
  barEl.innerHTML = '<span id="nmBarText"></span><button type="button" class="secondary" id="nmBarBack">Назад</button><button type="button" id="nmBarDone">Готово</button>';
  document.body.appendChild(barEl);

  function lineName() { var o = get(curGet().fiber); return o ? o.f.name : 'новая линия'; }
  function bar() {
    var on = drawing();
    barEl.classList.toggle('active', on);
    if (!on) return;
    if (pick) {
      var from = get(pick.from);
      $('nmBarText').innerHTML = '<b>' + (pick.type === 'fiber' ? 'ВОЛС' : 'Радиолиния') + ' от «' + esc(from ? from.f.name : '') + '»</b><small>Нажмите на второй узел</small>';
      $('nmBarBack').style.display = 'none';
      $('nmBarDone').textContent = 'Отмена';
    } else {
      $('nmBarText').innerHTML = '<b>«' + esc(lineName()) + '» · точек ' + nodes.length + '</b><small>Нажимайте по трассе — опоры; на узел — конец линии</small>';
      $('nmBarBack').style.display = nodes.length ? '' : 'none';
      $('nmBarDone').textContent = 'Готово';
    }
  }
  $('nmBarBack').onclick = function () {
    if (!nodes.length) return;
    nodes.pop(); saveNodes(); drawNodes(); bar();
  };
  $('nmBarDone').onclick = function () { if (pick) cancelPick(); else stopRoute(); };

  function nodePoint(o, kind) { return { lat: +o.f.lat, lng: +o.f.lng, kind: kind || 'узел', name: o.f.name || '', nid: o.id }; }
  function lengthOf(list) {
    var d = 0;
    for (var i = 1; i < list.length; i++) d += haversine(list[i - 1].lat, list[i - 1].lng, list[i].lat, list[i].lng);
    return +d.toFixed(3);
  }
  function autoName(list, old) {
    var a = list[0], b = list[list.length - 1];
    var an = a && a.nid && get(a.nid) ? get(a.nid).f.name : '', bn = b && b.nid && get(b.nid) ? get(b.nid).f.name : '';
    if (an && bn) return an + ' — ' + bn;
    if (an) return an + ' — …';
    if (bn) return '… — ' + bn;
    if (old && old.f.name) return old.f.name;
    return 'ВОЛС ' + (alive().filter(function (x) { return x.type === 'fiber'; }).length + 1);
  }

  // линия ВОЛС из редактора — в сеть, при каждом изменении
  var saving = false;
  function autosaveFiber() {
    if (saving || nodes.length < 2) return;
    saving = true;
    try {
      var cur = curGet(), o = get(cur.fiber);
      var list = nodes.map(function (p) {
        var q = { lat: +(+p.lat).toFixed(6), lng: +(+p.lng).toFixed(6), kind: p.kind, name: p.name || '' };
        if (p.nid) q.nid = p.nid;
        return q;
      });
      var keepName = o && o.f.autoName === false;
      var fields = { fnodes: list, dist: lengthOf(list), from: list[0].nid || '', to: list[list.length - 1].nid || '' };
      if (!keepName) { fields.name = autoName(list, o); fields.autoName = true; }
      var saved = put(o ? o.id : null, 'fiber', fields, o ? 'трасса изменена' : 'добавлен');
      if (!o) { cur.fiber = saved.id; curSet(cur); }
    } finally { saving = false; }
  }
  var saveNodesOrig = window.saveNodes;
  window.saveNodes = function () {
    var r = saveNodesOrig.apply(this, arguments);
    autosaveFiber();
    return r;
  };

  // новая линия: прежняя уже в сети, редактор освобождается
  function newFiber() {
    var cur = curGet();
    cur.fiber = null; curSet(cur);
    nodes = []; saveNodesOrig(); drawNodes();
  }

  function startRoute(fromId) {
    if (pick) cancelPick();
    netTab(false);
    if (typeof fiberMode === 'undefined' || !fiberMode) setTool('fiber');
    if (fromId !== undefined) {
      newFiber();
      var from = get(fromId);
      if (from) { nodes.push(nodePoint(from)); saveNodes(); drawNodes(); map.panTo([from.f.lat, from.f.lng]); }
    }
    route = true;
    armNode = true; $('nodeArm').classList.add('active');
    refresh(); bar();
  }
  function stopRoute() {
    route = false;
    armNode = false; $('nodeArm').classList.remove('active');
    autosaveFiber();
    refresh(); bar();
  }

  function startPick(type, fromId) {
    if (route) stopRoute();
    pick = { type: type, from: fromId };
    refresh(); bar();
  }
  function cancelPick() { pick = null; refresh(); bar(); }

  function nodeTap(id) {
    var o = get(id);
    if (!o) return;
    if (pick) {
      if (id === pick.from) { say('Выберите другой узел'); return; }
      var from = get(pick.from), type = pick.type;
      pick = null; bar();
      if (!from) { refresh(); return; }
      var created;
      if (type === 'fiber') {
        var list = [nodePoint(from), nodePoint(o)];
        created = put(null, 'fiber', { name: from.f.name + ' — ' + o.f.name, autoName: true, fnodes: list, dist: lengthOf(list), from: from.id, to: o.id });
        openLine(created.id);
        say('ВОЛС «' + created.f.name + '» создана по прямой. Ведите её по улицам: тяните точки и «+» между ними.');
      } else {
        var pts = [{ lat: +from.f.lat, lng: +from.f.lng, height: 15, nid: from.id }, { lat: +o.f.lat, lng: +o.f.lng, height: 15, nid: o.id }];
        var dev = $('device');
        created = put(null, 'radio', {
          name: from.f.name + ' — ' + o.f.name, points: pts, freq: $('freq').value, clutter: $('clutter').value,
          device: dev.value, deviceName: dev.value === 'none' ? '' : dev.selectedOptions[0].text, dist: lengthOf(pts), result: 'unknown'
        });
        openLine(created.id);
        if (typeof calc === 'function') calc().then(function () {
          if (lastProfile && lastProfile.report) put(created.id, 'radio', { result: lastProfile.report.state }, 'рассчитана');
        });
      }
      return;
    }
    if (route) addNode(L.latLng(o.f.lat, o.f.lng));
  }

  // все линии, проходящие через узел
  function linesAt(id) {
    return alive().filter(function (l) {
      return l.type !== 'node' && ((l.type === 'radio' ? l.f.points : l.f.fnodes) || []).some(function (p) { return p.nid === id; });
    });
  }
  // узел передвинули — точки линий на нём едут за ним
  function follow(id) {
    var n = get(id);
    if (!n) return 0;
    var lat = +n.f.lat, lng = +n.f.lng, count = 0;
    linesAt(id).forEach(function (l) {
      var key = l.type === 'radio' ? 'points' : 'fnodes', list = copy(l.f[key]);
      list.forEach(function (p) { if (p.nid === id) { p.lat = lat; p.lng = lng; } });
      var fields = { dist: lengthOf(list) };
      fields[key] = list;
      if (l.type === 'radio') fields.result = 'unknown';
      put(l.id, l.type, fields, 'конец перенесён за узлом');
      count++;
    });
    var ch = false;
    nodes.forEach(function (p) { if (p.nid === id) { p.lat = lat; p.lng = lng; ch = true; } });
    if (ch) { saveNodesOrig(); drawNodes(); }
    ch = false;
    points.forEach(function (p) { if (p.nid === id) { p.lat = lat; p.lng = lng; ch = true; } });
    if (ch) { redrawMap(); saveSession(); }
    return count;
  }

  // кнопки вкладки «ВОЛС»: «Поставить» — ставить точки подряд, «Очистить» — новая линия
  $('nodeArm').textContent = 'Ставить точки';
  $('nodeArm').onclick = function () { if (route) stopRoute(); else startRoute(); };
  $('nodeClear').textContent = 'Новая линия';
  $('nodeClear').onclick = function () { if (route) stopRoute(); newFiber(); say('Новая линия: нажмите «Ставить точки» или начните от узла (карточка узла → «ВОЛС по точкам»).'); };

  // выбор второго узла — можно нажать и рядом с ним
  map.on('click', function (e) {
    if (!pick) return;
    var n = nearNode(e.latlng, 34);
    if (n) nodeTap(n.id); else say('Нажмите на узел (значок на карте)');
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !drawing()) return;
    e.stopImmediatePropagation();
    if (pick) cancelPick(); else stopRoute();
  });

  // ================================================================== вкладка «Сеть»

  var netOn = false, armed = false, filter = 'all', query = '';

  var tab = document.createElement('button');
  tab.id = 'tabNet'; tab.type = 'button'; tab.textContent = 'Сеть';
  var tr = $('tabRadio');
  tr.parentNode.insertBefore(tab, tr);
  tr.parentNode.insertBefore(document.createTextNode(' '), tr);

  var panel = document.createElement('div');
  panel.className = 'panel off';
  panel.id = 'panelNet';
  panel.innerHTML =
    '<b>Сеть</b> <span class="nm-muted" id="netCount"></span>' +
    '<div class="row"><button type="button" id="netAdd">Добавить узел</button>' +
    '<button type="button" class="secondary" id="netLocate">Где я</button>' +
    '<button type="button" class="secondary" id="netJournal">Журнал</button>' +
    '<button type="button" class="secondary" id="netFit">Вся сеть</button></div>' +
    '<div class="row"><input type="search" id="netSearch" placeholder="Поиск: название, адрес, примечание">' +
    '<select id="netFilter"><option value="all">Всё</option><option value="node">Узлы</option><option value="radio">Радиолинии</option>' +
    '<option value="fiber">ВОЛС</option><option value="авария">Аварии</option><option value="работы">Работы</option><option value="план">План</option></select></div>' +
    '<div class="nm-legend">' + NODE_KINDS.map(function (k) { return '<span>' + shapeSvg(k, '#607d8b', 14) + esc(k) + '</span>'; }).join('') + '</div>' +
    '<div class="nm-legend">' + Object.keys(STATES).map(function (k) { return '<span><i style="width:10px;height:10px;border-radius:50%;background:' + STATES[k] + '"></i>' + k + '</span>'; }).join('') + '</div>' +
    '<div id="netList" class="nm-list"></div>' +
    '<div class="nm-muted">Подпись изменений: <b id="netWho"></b> <a id="netWhoEdit" style="color:var(--accent);cursor:pointer">изменить</a></div>';
  $('panelFiber').parentNode.insertBefore(panel, $('panelFiber').nextSibling);

  function netTab(on) {
    netOn = !!on;
    panel.classList.toggle('off', !netOn);
    if (netOn) {
      $('panel').classList.add('off');
      $('panelFiber').classList.add('off');
      $('tabRadio').classList.remove('on');
      $('tabFiber').classList.remove('on');
      panel.classList.toggle('hidden', $('panel').classList.contains('hidden'));
    } else {
      var fiber = typeof fiberMode !== 'undefined' && fiberMode;
      $('panel').classList.toggle('off', fiber);
      $('panelFiber').classList.toggle('off', !fiber);
      $('tabRadio').classList.toggle('on', !fiber);
      $('tabFiber').classList.toggle('on', fiber);
      arm(false);
    }
    tab.classList.toggle('on', netOn);
    try { localStorage.setItem(TAB, netOn ? 'net' : 'tool'); } catch (e) { /* не важно */ }
    refresh();   // узлы перетаскиваются только во вкладке «Сеть»
    setTimeout(function () { map.invalidateSize(); }, 200);
  }
  tab.onclick = function () { netTab(true); };
  $('tabRadio').addEventListener('click', function () { netTab(false); });
  $('tabFiber').addEventListener('click', function () { netTab(false); });
  $('toggle').addEventListener('click', function () { panel.classList.toggle('hidden', $('panel').classList.contains('hidden')); });

  function arm(on) {
    armed = !!on;
    $('netAdd').classList.toggle('active', armed);
    if (armed) say('Нажмите на карту, где поставить узел. Отмена — ещё раз «Добавить узел».');
  }
  $('netAdd').onclick = function () { arm(!armed); };
  map.on('click', function (e) {
    if (!armed) return;
    arm(false);
    newNode(e.latlng);
  });

  $('netSearch').addEventListener('input', function () { query = this.value.trim().toLowerCase(); renderList(); });
  $('netFilter').onchange = function () { filter = this.value; renderList(); };

  function renderList() {
    var c = counts(db);
    $('netCount').textContent = 'узлов ' + c.node + ', радиолиний ' + c.radio + ', ВОЛС ' + c.fiber;
    var list = alive().filter(function (o) {
      if (filter === 'node' || filter === 'radio' || filter === 'fiber') { if (o.type !== filter) return false; }
      else if (filter !== 'all' && (o.type !== 'node' || o.f.state !== filter)) return false;
      if (!query) return true;
      return [o.f.name, o.f.addr, o.f.note, o.f.kind].join(' ').toLowerCase().indexOf(query) >= 0;
    });
    list.sort(function (a, b) {
      var order = { node: 0, fiber: 1, radio: 2 };
      return order[a.type] - order[b.type] || String(a.f.name || '').localeCompare(String(b.f.name || ''), 'ru', { numeric: true });
    });
    var el = $('netList');
    if (!list.length) {
      el.innerHTML = '<div class="nm-muted">' + (alive().length ? 'Ничего не найдено.' :
        'Пока пусто. 1) «Добавить узел» и нажмите на карту. 2) Соедините узлы: нажмите на узел → «ВОЛС до узла» или «Радиолиния до узла».') + '</div>';
      return;
    }
    el.innerHTML = list.slice(0, 300).map(function (o) {
      var f = o.f, ico, sub;
      if (o.type === 'node') {
        ico = shapeSvg(f.kind, STATES[f.state] || '#455a64', 18);
        sub = esc(f.kind || '') + ' · ' + esc(f.state || '') + (f.addr ? ' · ' + esc(f.addr) : '');
      } else if (o.type === 'radio') {
        ico = '<span class="nm-ico r"></span>';
        sub = 'радиолиния · ' + km(f.dist) + ' · ' + esc(RESULT[f.result] || RESULT.unknown);
      } else {
        ico = '<span class="nm-ico l" style="background:#bf360c"></span>';
        sub = 'ВОЛС · ' + km(f.dist) + ' · точек ' + (f.fnodes || []).length;
      }
      return '<div class="pt nm-item" data-id="' + esc(o.id) + '">' + ico + '<div class="nm-txt"><div><b>' + esc(f.name || 'без названия') +
        '</b></div><div class="nm-muted">' + sub + '</div></div></div>';
    }).join('') + (list.length > 300 ? '<div class="nm-muted">Показаны первые 300. Уточните поиск.</div>' : '');
    el.querySelectorAll('[data-id]').forEach(function (it) { it.onclick = function () { focus(it.getAttribute('data-id')); }; });
  }

  function focus(id) {
    var o = get(id);
    if (!o) return;
    if (hiddenNow(id)) { say('Эта линия сейчас открыта в редакторе'); }
    var g = drawn[id];
    if (o.type === 'node') map.setView([o.f.lat, o.f.lng], Math.max(map.getZoom(), 11));
    else fitTo((o.type === 'radio' ? o.f.points : o.f.fnodes) || []);
    if (g) {
      setTimeout(function () {
        var ll = o.type === 'node' ? L.latLng(o.f.lat, o.f.lng) : null;
        if (!ll) { var pts = (o.type === 'radio' ? o.f.points : o.f.fnodes) || []; var mid = pts[Math.floor(pts.length / 2)]; ll = mid ? L.latLng(mid.lat, mid.lng) : null; }
        if (ll) L.popup().setLatLng(ll).setContent(card(id)).openOn(map);
      }, 350);
    }
  }

  function whoLabel() { $('netWho').textContent = author(); }
  $('netWhoEdit').onclick = function () {
    form('Подпись изменений', [{ key: 'who', label: 'Как подписывать ваши изменения (бригада, фамилия)', value: localStorage.getItem(WHO) || '', required: true }], 'Сохранить', function (v) {
      localStorage.setItem(WHO, v.who); whoLabel();
    });
  };

  $('netJournal').onclick = function () {
    var list = db.journal.slice(0, 300);
    dlgBox.innerHTML = '<h3>Журнал изменений</h3>' + (list.length ? list.map(function (j) {
      return '<div class="nm-j"><b>' + esc(j.name || 'без названия') + '</b> — ' + esc(TYPE_NAME[j.type] || '') + ' ' + esc(j.what) +
        '<br><small>' + when(j.t) + ' · ' + esc(j.by || '') + '</small></div>';
    }).join('') : '<p class="nm-muted">Пока пусто.</p>') + '<div class="nm-row"><button type="button" class="secondary" id="nmCancel">Закрыть</button></div>';
    dlg.classList.add('show');
    $('nmCancel').onclick = closeDlg;
  };

  // ================================================================== «Где я»

  var me = null, meCircle = null;
  function showMe(lat, lng, acc) {
    var ll = L.latLng(lat, lng);
    if (!me) {
      me = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="nm-me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 }).addTo(map);
      meCircle = L.circle(ll, { radius: acc || 0, color: '#1e88e5', weight: 1, fillOpacity: .1, interactive: false }).addTo(map);
      me.bindPopup(function () {
        var el = document.createElement('div'), p = me.getLatLng(), sk = toSK42(p.lat, p.lng);
        el.className = 'nm-pop';
        el.innerHTML = '<b>Вы здесь</b><br><span class="nm-sub">' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + (meCircle.getRadius() ? ' · ±' + Math.round(meCircle.getRadius()) + ' м' : '') +
          '<br>СК-42 X=' + sk.x + ' Y=' + sk.y + '</span><div class="nm-row"></div>';
        var row = el.querySelector('.nm-row');
        [['Узел здесь', function () { netTab(true); newNode(p); }],
         ['Точка радиолинии', function () { radioPoint(p, points.length === 0 ? 'A' : points.length === 1 ? 'B' : 'more'); }],
         ['Точка паспорта', function () { netTab(false); setTool('fiber'); addNode(p); }]].forEach(function (x, i) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = x[0]; if (i) b.className = 'secondary';
          b.onclick = function () { map.closePopup(); x[1](); };
          row.appendChild(b);
        });
        return el;
      });
    } else { me.setLatLng(ll); meCircle.setLatLng(ll).setRadius(acc || 0); }
    map.setView(ll, Math.max(map.getZoom(), Math.min(map.getMaxZoom(), 15)));
    me.openPopup();
    say('Местоположение: ' + lat.toFixed(5) + ', ' + lng.toFixed(5) + (acc ? ' (±' + Math.round(acc) + ' м)' : ''));
  }
  window.__kartaGeo = function (lat, lng, acc, err) {
    if (err) { say('Местоположение не определено: ' + err); return; }
    showMe(lat, lng, acc);
  };
  function locate() {
    say('Определяю местоположение…');
    if (android && android.locate) { android.locate(); return; }
    if (!navigator.geolocation) { say('Это устройство не сообщает местоположение'); return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      showMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
    }, function (e) {
      say('Местоположение не определено: ' + (e.code === 1 ? 'нет разрешения' : e.code === 3 ? 'не успели' : 'нет данных'));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }
  $('netLocate').onclick = locate;
  $('netFit').onclick = function () { fitAll(); };
  var LocCtl = L.Control.extend({
    options: { position: pc ? 'bottomright' : 'topleft' },
    onAdd: function () {
      var d = L.DomUtil.create('div', 'leaflet-bar nm-locate'), a = L.DomUtil.create('a', '', d);
      a.innerHTML = '&#9673;'; a.title = 'Где я'; a.href = '#';
      L.DomEvent.on(a, 'click', function (e) { L.DomEvent.stop(e); locate(); });
      L.DomEvent.disableClickPropagation(d);
      return d;
    }
  });
  map.addControl(new LocCtl());

  /* Показать всю сеть: все узлы и линии, а также несохранённую работу обеих вкладок. Окна (ПК) и
   * шторка (телефон) не закрывают карту — для них оставляется место по краю. */
  function fitAll() {
    var b = L.latLngBounds([]);
    alive().forEach(function (o) {
      if (o.type === 'node') b.extend([o.f.lat, o.f.lng]);
      else ((o.type === 'radio' ? o.f.points : o.f.fnodes) || []).forEach(function (p) { b.extend([p.lat, p.lng]); });
    });
    points.forEach(function (p) { b.extend([p.lat, p.lng]); });
    nodes.forEach(function (p) { b.extend([p.lat, p.lng]); });
    if (!b.isValid()) { say('В сети пока ничего нет'); return; }
    var tl = [30, 30], br = [30, 30], mr = map.getContainer().getBoundingClientRect();
    var tool = document.getElementById('pcTool');
    if (tool && getComputedStyle(tool).display !== 'none' && !tool.classList.contains('pcw-min')) {
      var r = tool.getBoundingClientRect();
      if (r.right - mr.left < mr.width * 0.6) tl[0] = r.right - mr.left + 30;
    }
    var sh = parseInt(getComputedStyle(document.body).getPropertyValue('--sheet-h'), 10);
    if (sh > 0) br[1] = Math.min(sh + 20, mr.height * 0.6);
    map.fitBounds(b, { paddingTopLeft: tl, paddingBottomRight: br, maxZoom: 16 });
    say('Вся сеть: ' + alive().length + ' объектов');
  }
  var FitCtl = L.Control.extend({
    options: { position: pc ? 'bottomright' : 'topleft' },
    onAdd: function () {
      var d = L.DomUtil.create('div', 'leaflet-bar nm-fit'), a = L.DomUtil.create('a', '', d);
      a.innerHTML = '&#10530;'; a.title = 'Показать всю сеть'; a.href = '#';
      L.DomEvent.on(a, 'click', function (e) { L.DomEvent.stop(e); fitAll(); });
      L.DomEvent.disableClickPropagation(d);
      return d;
    }
  });
  map.addControl(new FitCtl());

  // ------------------------------------------------------------------ «Очистить» без потери работы
  // Перед «Очистить» несохранённая линия предлагается к сохранению в сеть — чтобы она осталась на схеме.
  function unsaved(kind) {
    var cur = curGet(), o = get(cur[kind]);
    if (kind === 'radio') {
      if (points.length < 2) return false;
      return !o || !same(o.f.points.map(function (p) { return [p.lat, p.lng]; }), points.map(function (p) { return [+(+p.lat).toFixed(6), +(+p.lng).toFixed(6)]; }));
    }
    if (nodes.length < 2) return false;
    return !o || !same(o.f.fnodes.map(function (p) { return [p.lat, p.lng, p.kind, p.name || '']; }),
      nodes.map(function (p) { return [+(+p.lat).toFixed(6), +(+p.lng).toFixed(6), p.kind, p.name || '']; }));
  }
  var clearing = false;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#clear,#nodeClear');
    if (!b || clearing) return;
    var kind = b.id === 'clear' ? 'radio' : 'fiber';
    if (!unsaved(kind)) return;
    e.stopPropagation(); e.preventDefault();
    var what = kind === 'radio' ? 'радиолинию' : 'линию ВОЛС';
    dlgBox.innerHTML = '<h3>Сохранить ' + what + ' в сеть?</h3><p class="nm-muted">Иначе после «Очистить» её не будет на схеме.</p>' +
      '<div class="nm-row"><button type="button" id="nmSaveClear">Сохранить</button>' +
      '<button type="button" class="secondary" id="nmJustClear">Очистить без сохранения</button>' +
      '<button type="button" class="secondary" id="nmCancel">Отмена</button></div>';
    dlg.classList.add('show');
    function doClear() { clearing = true; try { b.click(); } finally { clearing = false; } }
    $('nmCancel').onclick = closeDlg;
    $('nmJustClear').onclick = function () { closeDlg(); doClear(); };
    $('nmSaveClear').onclick = function () {
      closeDlg();
      var before = db.journal.length ? db.journal[0].t : 0;
      (kind === 'radio' ? saveRadio : saveFiber)();
      // форма сохранения открыта; очистить после того, как её подтвердят
      var wait = setInterval(function () {
        if (dlg.classList.contains('show')) return;
        clearInterval(wait);
        if (db.journal.length && db.journal[0].t !== before && !unsaved(kind)) doClear();
      }, 200);
    };
  }, true);

  // ================================================================== для exchange.js

  window.KartaNet = {
    data: function () { return copy(db); },
    counts: counts,
    preview: function (inc) { var t = copy(db); return mergeInto(t, inc); },
    valid: function (d) { return d == null || valid(d); },
    // объединение пишется в хранилище; страница после импорта перезагружается
    merge: function (inc) { var r = mergeInto(db, inc); save(); return r; }
  };

  // ================================================================== запуск

  whoLabel();
  curLabels();
  if (localStorage.getItem(TAB) === 'net') netTab(true); else refresh();
  drawGhost();
})();
