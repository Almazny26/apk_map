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

  var NODE_KINDS = ['узел доступа', 'опорный узел', 'базовая станция', 'коммутатор', 'клиент', 'другое'];
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
    '.nm-node{width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);box-sizing:border-box}',
    '.nm-node.k-big{width:20px;height:20px;border-radius:4px}',
    '.nm-lbl{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:2px;white-space:nowrap;font:600 11px/1.2 sans-serif;' +
      'color:#1a1a1a;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;pointer-events:none}',
    '.nm-nolabels .nm-lbl{display:none}',
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
    '#panelNet .nm-ico{flex:0 0 14px;height:14px;border-radius:50%}',
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
    '@media (max-width:460px){header>span:first-child{display:none}header>span:last-child{display:flex;gap:4px;width:100%;justify-content:space-between}header button{padding:5px 6px}}'
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
    var color = STATES[o.f.state] || '#455a64', big = o.f.kind === 'опорный узел';
    return L.divIcon({
      className: '',
      html: '<div class="nm-node' + (big ? ' k-big' : '') + '" style="background:' + color + '"></div><div class="nm-lbl">' + esc(o.f.name) + '</div>',
      iconSize: big ? [20, 20] : [16, 16], iconAnchor: big ? [10, 10] : [8, 8], popupAnchor: [0, -8]
    });
  }

  function hiddenNow(id) {
    var cur = curGet(), fiber = typeof fiberMode !== 'undefined' && fiberMode;
    return (cur.radio === id && !fiber) || (cur.fiber === id && fiber);
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
      g.addTo(layer);
      drawn[o.id] = g;
    });
    objs.filter(function (o) { return o.type === 'node' && isFinite(o.f.lat) && isFinite(o.f.lng); }).forEach(function (o) {
      var m = L.marker([o.f.lat, o.f.lng], { icon: nodeIcon(o), draggable: netOn, zIndexOffset: 500 });
      m.bindPopup(function () { return card(o.id); });
      m.on('dragend', function () {
        var ll = m.getLatLng();
        put(o.id, 'node', { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }, 'перемещён');
        say('Узел «' + (o.f.name || '') + '» перемещён');
      });
      m.addTo(layer);
      drawn[o.id] = m;
    });
    renderList();
  }

  function labels() { map.getContainer().classList.toggle('nm-nolabels', map.getZoom() < 10); }
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
      btn('Изменить', '', function () { editNode(o.id); });
      btn('Точка A', 'secondary', function () { radioPoint(L.latLng(f.lat, f.lng), 'A'); });
      btn('Точка B', 'secondary', function () { radioPoint(L.latLng(f.lat, f.lng), 'B'); });
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
    ].concat(whoField()), 'Сохранить', function (v) { takeWho(v); put(id, o.type, { name: v.name, note: v.note }); });
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
      points = (o.f.points || []).map(function (p) { return { lat: p.lat, lng: p.lng, height: isFinite(+p.height) ? +p.height : 15 }; });
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
      nodes = (o.f.fnodes || []).map(function (p) { return { lat: p.lat, lng: p.lng, kind: p.kind, name: p.name || '' }; });
      saveNodes();
      cur.fiber = id;
      setTool('fiber');
      fitTo(nodes);
      say('Открыта линия «' + (o.f.name || '') + '». Правьте точки и нажмите «Сохранить изменения».');
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
    window.place = function (ll) { return placeOrig(snap(ll)); };
  }
  if (typeof addNode === 'function') {
    var addNodeOrig = addNode;
    window.addNode = function (ll) {
      // точка паспорта на узле сети: координаты, имя и вид «узел» берутся из узла
      var n = nearNode(ll), nameInp = $('nodeName'), kindSel = $('nodeKind'), was = nameInp.value, wasKind = kindSel.value;
      if (n) { ll = L.latLng(n.f.lat, n.f.lng); if (!was.trim()) nameInp.value = n.f.name || ''; kindSel.value = 'узел'; }
      var r = addNodeOrig(ll);
      nameInp.value = was; kindSel.value = wasKind;
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
    return r;
  };

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
    '<button type="button" class="secondary" id="netJournal">Журнал</button></div>' +
    '<div class="row"><input type="search" id="netSearch" placeholder="Поиск: название, адрес, примечание">' +
    '<select id="netFilter"><option value="all">Всё</option><option value="node">Узлы</option><option value="radio">Радиолинии</option>' +
    '<option value="fiber">ВОЛС</option><option value="авария">Аварии</option><option value="работы">Работы</option><option value="план">План</option></select></div>' +
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
        'Пока пусто. «Добавить узел» — и нажмите на карту. Радиолинию или линию ВОЛС сохраните кнопкой «Сохранить в сеть» во вкладке «Радио» или «ВОЛС».') + '</div>';
      return;
    }
    el.innerHTML = list.slice(0, 300).map(function (o) {
      var f = o.f, ico, sub;
      if (o.type === 'node') {
        ico = '<span class="nm-ico" style="background:' + (STATES[f.state] || '#455a64') + '"></span>';
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
})();
