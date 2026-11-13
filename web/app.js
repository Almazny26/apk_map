/* Карта сети 3.0 — приложение целиком (телефон и компьютер).
 *
 * От приложения товарища «WiFi Френель» остаются карта (Leaflet), вшитые плитки, подложки
 * (maps.js), СК-42 и расстояния. Его панели (расчёт радиолинии, паспорт ВОЛС, история) скрыты —
 * по решению заказчика расчёты убраны, у линии остаётся протяжённость.
 *
 * Два режима (кнопки сверху):
 *   - «Просмотр» — ничего нельзя сдвинуть; нажатие на узел или линию — сведения;
 *   - «Редактирование» — «+» (узел, линия ВОЛС, радиолиния), перекрестие в центре карты и кнопка
 *     «Поставить точку» (можно и просто нажать на место), перетаскивание точек, «+» между точками,
 *     долгое нажатие — меню точки, линии, узла.
 * Линия ВОЛС — точки (опора, колодец, муфта, кросс, точка, узел) и участки между ними: «по опорам»
 * (сплошная) или «в земле» (пунктир). Одна линия может идти сначала по опорам, потом в земле.
 *
 * Данные — localStorage karta_net (как в 2.x): {v, objs: {id: {id, type: node|fiber|radio,
 * f: поля, ft: время правки поля, t, by}}, journal}. Линия ВОЛС: f.fnodes (точки), f.lay (участки:
 * 'air' | 'ground', на один меньше точек), f.dist, f.from/f.to (узлы на концах).
 * Обмен — файл JSON {format: 'karta-seti', kind: 'fresnel', version: 3, data: {net}}. Загрузка файла
 * показывает список изменений и заменяет карту целиком (старых точек не остаётся); прежняя карта
 * сохраняется в karta_prev («Вернуть как было»).
 */
(function () {
  'use strict';
  if (!window.L || typeof map === 'undefined') return;

  var pc = !!window.KartaPC, android = window.KartaFiles || null;
  var KEY = 'karta_net', WHO = 'karta_author', PREV = 'karta_prev', FORMAT = 'karta-seti', JOURNAL_MAX = 1000;
  var $ = function (id) { return document.getElementById(id); };

  // ================================================================== справочники

  var NODE_KINDS = ['узел доступа', 'узел агрегации', 'опорный узел', 'базовая станция', 'коммутатор', 'клиент', 'другое'];
  var SHAPE = {
    'узел доступа': '<circle cx="12" cy="12" r="8"/>',
    'узел агрегации': '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/>',
    'опорный узел': '<path d="M12 2.2 21.8 12 12 21.8 2.2 12Z"/>',
    'базовая станция': '<path d="M12 2.6 21.6 19.6H2.4Z"/>',
    'коммутатор': '<rect x="2.4" y="6.8" width="19.2" height="10.4" rx="2"/>',
    'клиент': '<circle cx="12" cy="12" r="5.2"/>',
    'другое': '<path d="M12 2.6 20.2 7.3V16.7L12 21.4 3.8 16.7V7.3Z"/>'
  };
  var STATES = { 'работает': '#2e7d32', 'авария': '#c62828', 'работы': '#ef6c00', 'план': '#78909c' };
  var PT_KINDS = ['опора', 'колодец', 'муфта', 'кросс', 'точка'];
  var PT_COLOR = { 'опора': '#5d4037', 'колодец': '#455a64', 'муфта': '#ef6c00', 'кросс': '#2e7d32', 'точка': '#78909c', 'узел': '#1565c0' };
  var LAY = {
    air: { name: 'по опорам', color: '#e8590c', dash: null },
    ground: { name: 'в земле', color: '#6d4c41', dash: '10 8' }
  };
  /* значки точек линии: по виду их можно отличить не вглядываясь */
  var PT_PX = { 'опора': 18, 'колодец': 20, 'муфта': 24, 'кросс': 22, 'точка': 13, 'узел': 13 };
  function ptSvg(kind, px, ring) {
    var c = PT_COLOR[kind] || PT_COLOR['точка'], st = ' fill="' + c + '" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"', w = ' fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"', g;
    if (kind === 'опора') g = '<circle cx="12" cy="12" r="7.5"' + st + '/><circle cx="12" cy="12" r="2" fill="#fff"/>';
    else if (kind === 'колодец') g = '<rect x="3.5" y="3.5" width="17" height="17" rx="3"' + st + '/><circle cx="12" cy="12" r="4"' + w + '/>';
    else if (kind === 'муфта') g = '<path d="M12 1.8 22.2 12 12 22.2 1.8 12Z"' + st + '/><path d="M7.5 12h9"' + w + '/>';
    else if (kind === 'кросс') g = '<rect x="3" y="3" width="18" height="18" rx="2.5"' + st + '/><path d="M8 8l8 8M16 8l-8 8"' + w + '/>';
    else g = '<circle cx="12" cy="12" r="6.5"' + st + '/>';
    return '<svg class="ap-pt' + (ring ? ' ring' : '') + '" width="' + px + '" height="' + px + '" viewBox="0 0 24 24">' + g + '</svg>';
  }
  var TYPE_NAME = { node: 'узел', fiber: 'линия ВОЛС', radio: 'радиолиния' };

  // ================================================================== мелочи

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function when(ms) { var d = new Date(ms); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()); }
  function len(km) { km = +km || 0; return km < 1 ? Math.round(km * 1000) + ' м' : km.toFixed(2).replace('.', ',') + ' км'; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function copy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function sk(lat, lng) { try { var s = toSK42(lat, lng); return 'X=' + s.x + ' Y=' + s.y; } catch (e) { return ''; } }
  function shapeSvg(kind, color, px, ring) {
    return '<svg class="ap-shape' + (ring ? ' ring' : '') + '" width="' + px + '" height="' + px + '" viewBox="0 0 24 24"><g fill="' + color +
      '" stroke="#fff" stroke-width="2.4" stroke-linejoin="round">' + (SHAPE[kind] || SHAPE['другое']) + '</g></svg>';
  }

  // ================================================================== данные

  function empty() { return { v: 1, objs: {}, journal: [] }; }
  function valid(d) { return !!(d && typeof d === 'object' && d.objs && typeof d.objs === 'object'); }
  function load() {
    try { var d = JSON.parse(localStorage.getItem(KEY)); if (valid(d)) { if (!Array.isArray(d.journal)) d.journal = []; return d; } } catch (e) { /* пусто */ }
    return empty();
  }
  var db = load();
  /* «Отменить»: перед каждой серией правок (паузы меньше четверти секунды — одна серия) запоминается прежняя сеть */
  var undoStack = [], lastJson = JSON.stringify(db.objs), lastPush = 0;
  function save() {
    var now = Date.now(), cur = JSON.stringify(db.objs);
    if (cur !== lastJson) {
      if (now - lastPush > 250) { undoStack.push(lastJson); if (undoStack.length > 30) undoStack.shift(); }
      lastPush = now; lastJson = cur;
    }
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Не удалось сохранить: память заполнена'); }
    document.body.classList.toggle('ap-canundo', undoStack.length > 0);
  }
  function undo() {
    if (!undoStack.length || tool || mode !== 'edit') return;
    db.objs = JSON.parse(undoStack.pop());
    lastJson = JSON.stringify(db.objs); lastPush = 0;
    db.journal.unshift({ t: Date.now(), by: author(), id: '', type: '', name: 'Отмена', what: 'последнее изменение отменено' });
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* уже сообщали */ }
    document.body.classList.toggle('ap-canundo', undoStack.length > 0);
    sel = null; if (view && view.k !== 'search') closeSheet();
    refresh();
    toast('Последнее изменение отменено');
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function author() { return localStorage.getItem(WHO) || (pc ? 'Компьютер' : android ? 'Телефон' : 'Браузер'); }
  function alive() { return Object.keys(db.objs).map(function (k) { return db.objs[k]; }).filter(function (o) { return o && o.f && !o.f.deleted; }); }
  function get(id) { var o = id && db.objs[id]; return o && !o.f.deleted ? o : null; }

  function log(o, what) {
    var j = db.journal[0], now = Date.now();
    if (j && j.id === o.id && j.what === what && j.by === author() && now - j.t < 10 * 60000) { j.t = now; j.name = o.f.name || ''; return; }
    db.journal.unshift({ t: now, by: author(), id: o.id, type: o.type, name: o.f.name || '', what: what });
    if (db.journal.length > JOURNAL_MAX) db.journal.length = JOURNAL_MAX;
  }
  /* записать поля объекта (новый, если id нет) */
  function put(id, type, fields, what, quiet) {
    var o = id && db.objs[id], isNew = !o, now = Date.now();
    if (!o) { o = { id: id || uid(), type: type, f: {}, ft: {}, t: now, by: author() }; db.objs[o.id] = o; }
    var changed = false;
    Object.keys(fields).forEach(function (k) {
      if (same(o.f[k], fields[k])) return;
      o.f[k] = copy(fields[k]);
      o.ft[k] = Math.max(now, (o.ft[k] || 0) + 1);
      changed = true;
    });
    if (!changed && !isNew) return o;
    o.t = now; o.by = author();
    log(o, what || (isNew ? 'добавлен' : 'изменён'));
    save();
    if (!quiet) refresh();
    return o;
  }
  function removeObj(id) {
    var o = get(id);
    if (!o) return;
    if (o.type === 'node') linesAt(id).forEach(function (l) {
      var key = l.type === 'radio' ? 'points' : 'fnodes', list = copy(ptsOf(l)), f = {};
      list.forEach(function (p) { if (p.nid === id) { delete p.nid; p.name = ''; if (p.kind === 'узел') p.kind = 'точка'; } });
      f[key] = list; f.from = (list[0] && list[0].nid) || ''; f.to = (list[list.length - 1] && list[list.length - 1].nid) || '';
      put(l.id, l.type, f, 'узел на конце удалён', true);
    });
    put(id, o.type, { deleted: true }, 'удалён');
  }

  function counts(d) {
    var c = { node: 0, radio: 0, fiber: 0 };
    if (valid(d)) Object.keys(d.objs).forEach(function (k) { var o = d.objs[k]; if (o && o.f && !o.f.deleted && c[o.type] != null) c[o.type]++; });
    return c;
  }

  // ================================================================== геометрия линий

  function ptsOf(o) { return (o.type === 'radio' ? o.f.points : o.f.fnodes) || []; }
  function layOf(o) {
    var n = Math.max(0, ptsOf(o).length - 1), l = (o.f.lay || []).slice(0, n);
    while (l.length < n) l.push('air');
    return l;
  }
  function lenOf(pts) {
    var d = 0;
    for (var i = 1; i < pts.length; i++) d += haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    return +d.toFixed(4);
  }
  function lens(o) {
    var p = ptsOf(o), l = layOf(o), r = { air: 0, ground: 0 };
    for (var i = 1; i < p.length; i++) r[l[i - 1] === 'ground' ? 'ground' : 'air'] += haversine(p[i - 1].lat, p[i - 1].lng, p[i].lat, p[i].lng);
    return r;
  }
  function nodeName(id) { var n = get(id); return n ? n.f.name || '' : ''; }
  function autoName(type, pts, old) {
    var a = pts[0], b = pts[pts.length - 1], self = old ? old.id : null;
    var an = type === 'fiber' ? endLabel(a, self) : (a && a.nid ? nodeName(a.nid) : '');
    var bn = pts.length > 1 ? (type === 'fiber' ? endLabel(b, self) : (b && b.nid ? nodeName(b.nid) : '')) : '';
    if (an && bn) return an + ' — ' + bn;
    if (an) return an + ' — …';
    if (bn) return '… — ' + bn;
    if (old && old.f.name) return old.f.name;
    return (type === 'radio' ? 'Радиолиния ' : 'ВОЛС ') + (alive().filter(function (x) { return x.type === type; }).length + 1);
  }
  /* Соединения. Точки разных линий ВОЛС в одном и том же месте — одна опора, колодец или муфта на
   * несколько линий (ответвление, общая подвеска). Отдельной записи о соединении нет: совпали
   * координаты — точки связаны и переносятся вместе. */
  function samePt(a, b) { return Math.abs(a.lat - b.lat) < 1.5e-6 && Math.abs(a.lng - b.lng) < 1.5e-6; }
  function joinedAt(p, selfId) {
    var r = [];
    if (!p) return r;
    alive().forEach(function (l) {
      if (l.type !== 'fiber' || l.id === selfId) return;
      ptsOf(l).forEach(function (q, k) { if (samePt(p, q)) r.push({ id: l.id, i: k }); });
    });
    return r;
  }
  function joined(id, i) { var o = get(id); return o && o.type === 'fiber' ? joinedAt(ptsOf(o)[i], id) : []; }
  function endLabel(p, selfId) {
    if (!p) return '';
    if (p.nid) return nodeName(p.nid);
    var j = joinedAt(p, selfId);
    return j.length ? (p.name || 'отв. от «' + (get(j[0].id).f.name || 'линии') + '»') : '';
  }
  function linesAt(id) {
    return alive().filter(function (l) { return l.type !== 'node' && ptsOf(l).some(function (p) { return p.nid === id; }); });
  }
  /* узел передвинули — точки линий на нём едут следом */
  function follow(id) {
    var n = get(id), count = 0;
    if (!n) return 0;
    linesAt(id).forEach(function (l) {
      var key = l.type === 'radio' ? 'points' : 'fnodes', list = copy(ptsOf(l));
      list.forEach(function (p) { if (p.nid === id) { p.lat = +n.f.lat; p.lng = +n.f.lng; p.name = n.f.name || ''; } });
      var fields = { dist: lenOf(list) };
      fields[key] = list;
      put(l.id, l.type, fields, 'конец перенесён за узлом', true);
      count++;
    });
    refresh();
    return count;
  }

  // ================================================================== настройки (хранение)

  var SET = 'karta_set';
  var DEF = { theme: localStorage.getItem('wf_theme') === 'dark' ? 'dark' : 'light', ui: 1, mapDim: true,
    nodeLbl: 'zoom', lineLbl: 'zoom', nodeSize: 1, lineW: 1, linePts: 'near', scale: true, zoomBtns: true,
    start: 'view', tap: true, longMs: 550, vibro: true, coords: 'sk42', pcPanel: 380, pcCoords: true,
    ptSize: 1, ptLbl: 'near', lineLen: false, snap: true, keep: false, schema: 'auto' };
  var S = (function () {
    var r = {}, st = {};
    try { st = JSON.parse(localStorage.getItem(SET)) || {}; } catch (e) { st = {}; }
    Object.keys(DEF).forEach(function (k) { r[k] = st[k] != null && typeof st[k] === typeof DEF[k] ? st[k] : DEF[k]; });
    return r;
  })();
  function coord(lat, lng) {
    var w = (+lat).toFixed(6) + ', ' + (+lng).toFixed(6);
    if (S.coords === 'wgs') return w;
    return S.coords === 'both' ? sk(lat, lng) + ' · ' + w : sk(lat, lng);
  }

  // ================================================================== стили

  var css = el('style'), cssMap = el('style');
  var RULES = [
    ':root{--bg:#f2f2f7;--panel:#fff;--text:#000;--muted:#6c6c70;--line:#d1d1d6;--accent:#007aff;--tonal:#e5e5ea;--card:#f2f2f7;' +
      '--danger:#ff3b30;--ok:#34c759;--shadow:0 1px 3px rgba(0,0,0,.12),0 6px 16px rgba(0,0,0,.16);--font:-apple-system,"SF Pro Text","SF Pro Display",system-ui,"Helvetica Neue",Roboto,Arial,sans-serif}',
    'body.dark{--bg:#000;--panel:#1c1c1e;--text:#fff;--muted:#98989f;--line:#38383a;--accent:#0a84ff;--tonal:#2c2c2e;--card:#2c2c2e;' +
      '--danger:#ff453a;--ok:#30d158;--shadow:0 1px 3px rgba(0,0,0,.5),0 8px 20px rgba(0,0,0,.6)}',
    'html,body{font-family:var(--font);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}',
    // всё от прежних панелей — скрыть
    'header,.panel,#toggle,#modal,#hist,#kartaEx,#btnFile{display:none!important}',
    '#map{top:56px!important;bottom:0!important;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}',
    'body.dark.ap-dim .leaflet-tile-pane .leaflet-layer:not(.karta-vec){filter:brightness(.82) contrast(1.08)}',
    'body.dark .leaflet-tile-pane .karta-vec{filter:brightness(1.75) contrast(.92)}',
    'body.ap-nocoords #apCoords{display:none}',
    '@media (max-width:899px){body.ap-nozoom .ap-ctl .grp.zoom{display:none}}',
    '.ap-ctl .grp.undo{display:none}body.ap-edit.ap-canundo:not(.ap-tool) .ap-ctl .grp.undo{display:flex}',
    '#apHint{position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:900;max-width:min(320px,80vw);text-align:center;background:var(--panel);color:var(--text);'+
      'border-radius:16px;padding:14px 18px;box-shadow:var(--shadow);font:14px/1.4 var(--font);pointer-events:none;display:none}',
    '#apHint b{display:block;font-size:16px;margin-bottom:4px}',
    '.ap .srow{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}',
    '.ap .srow>span{flex:1 1 150px;font-size:14px}.ap .srow .chips{margin:0;flex:0 1 auto}.ap .srow .chip{min-height:32px;padding:5px 11px;font-size:13px}',
    '.ap .srow small{display:block;color:var(--muted);font-size:12px}',
    '.ap .sw{margin-left:auto;width:51px;height:31px;border-radius:16px;background:#e9e9ea;position:relative;flex:0 0 51px;cursor:pointer;border:0;padding:0;transition:background .2s}',
    '.ap .sw::after{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 2px 4px rgba(0,0,0,.25)}',
    '.ap .sw.on{background:#34c759}.ap .sw.on::after{left:22px}body.dark .ap .sw{background:#39393d}body.dark .ap .sw.on{background:#30d158}',
    '.ap details.hlp{border-bottom:1px solid var(--line)}.ap details.hlp summary{padding:12px 2px;font-weight:600;font-size:15px;cursor:pointer;list-style:none;display:flex;align-items:center}',
    '.ap details.hlp summary::-webkit-details-marker{display:none}.ap details.hlp summary::after{content:"+";margin-left:auto;color:var(--muted);font-size:20px;font-weight:400}',
    '.ap details.hlp[open] summary::after{content:"−"}.ap details.hlp p{margin:0 2px 12px;font-size:14px;line-height:1.45;color:var(--text)}',
    '.ap .lgd{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;font-size:14px;margin:6px 0 10px}.ap .lgd>div{display:flex;align-items:center;gap:8px}',
    // верхняя панель
    '#apBar{position:fixed;left:0;right:0;top:0;height:56px;z-index:1100;display:flex;align-items:center;gap:10px;padding:0 8px 0 12px;' +
      'background:var(--panel);color:var(--text);box-shadow:0 1px 0 var(--line),0 2px 10px rgba(0,0,0,.06)}',
    '.ap-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;white-space:nowrap}',
    '.ap-seg{display:flex;background:#e3e3e8;border-radius:9px;padding:2px;gap:0}body.dark .ap-seg{background:#2c2c2e}',
    '.ap-seg button{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--muted);border-radius:7px;padding:7px 14px;' +
      'font:600 14px var(--font);cursor:pointer;white-space:nowrap}',
    '.ap-seg button{color:var(--text)}.ap-seg button.on{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.2)}body.dark .ap-seg button.on{background:#636366;color:#fff}',
    '.ap-seg button.on[data-mode=edit],body.dark .ap-seg button.on[data-mode=edit]{background:var(--accent);color:#fff}',
    '.ap-sp{flex:1}',
    '.ap-ib{width:42px;height:42px;border:0;border-radius:50%;background:transparent;color:var(--text);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}',
    '.ap-ib:hover{background:var(--bg)}',
    '.ap-ib svg{width:22px;height:22px}',
    '.ap-ib{flex:0 0 auto}',
    // телефон: переключатель режимов растягивается и сжимается сам, значки справа всегда на месте
    // (с крупным системным шрифтом раньше «⋮» уезжал к самому краю экрана)
    '@media (max-width:560px){#apBar{gap:4px;padding:0 max(10px,env(safe-area-inset-right)) 0 max(10px,env(safe-area-inset-left))}' +
      '.ap-logo span{display:none}.ap-seg{flex:1 1 auto;min-width:0}.ap-seg button{flex:1 1 0;min-width:0;justify-content:center;padding:8px 6px;font-size:14px}' +
      '.ap-seg button svg{display:none}.ap-sp{display:none}.ap-ib{width:40px;height:40px}}',
    '.ap-seg .sht{display:none}',
    '@media (max-width:420px){.ap-logo{display:none}.ap-seg .lng{display:none}.ap-seg .sht{display:inline}}',
    '.ap-seg button{overflow:hidden;text-overflow:ellipsis}',
    // кнопки и поля
    '.ap button.b{border:0;border-radius:12px;padding:10px 16px;min-height:44px;font:600 15px var(--font);cursor:pointer;background:var(--accent);color:#fff}',
    '.ap button.b:active{opacity:.7}',
    '.ap button.b.t,body.dark .ap button.b.t{background:var(--tonal);color:var(--accent)}',
    '.ap button.b.d,body.dark .ap button.b.d{background:var(--tonal);color:var(--danger);border:0}',
    '.ap button.b:disabled{opacity:.45}',
    '.ap button.b.big{width:100%;min-height:48px;font-size:15px}',
    '.ap input,.ap select,.ap textarea{width:100%;box-sizing:border-box;font:15px var(--font);border:0;border-radius:10px;background:var(--tonal);' +
      'color:var(--text);padding:10px 12px;min-height:44px}',
    '.ap textarea{min-height:70px;resize:vertical}',
    '.ap input:focus,.ap select:focus,.ap textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}',
    '.ap label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin:10px 0 4px}',
    '.ap .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
    '.ap .row>button{flex:1 1 auto}',
    '.ap .chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}',
    '.ap .chips.tight{margin:6px 0 0}.ap .chips.scroll{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding-right:16px}.ap .chips.scroll::-webkit-scrollbar{display:none}',
    '.ap .lrow{display:flex;align-items:center;gap:10px;margin-top:6px}.ap .lrow>.muted{flex:0 0 58px}.ap .lrow .chips{margin:0}',
    '.ap .row.tool{flex-wrap:nowrap}.ap .row.tool>button{flex:0 0 auto}',
    '.ap .chip{border:0;background:var(--tonal);color:var(--text);border-radius:999px;padding:7px 13px;min-height:36px;font:500 14px var(--font);cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
    '.ap .chip.on,body.dark .ap .chip.on{background:var(--accent);color:#fff;font-weight:600}',
    '.ap .chip .ap-pt{filter:none}',
    '.ap .chip i{width:10px;height:10px;border-radius:50%;display:inline-block}',
    '.ap .chip .ln{width:22px;height:0;border-top:4px solid}',
    '.ap .muted{color:var(--muted);font-size:13px}',
    '.ap .lg{display:inline-block;width:26px;border-top:4px solid;vertical-align:middle}',
    '.ap .sec{font-size:13px;font-weight:400;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:18px 0 6px}',
    '.ap table.kv{width:100%;border-collapse:collapse;font-size:14px;margin-top:6px}',
    '.ap table.kv td{padding:7px 2px;border-bottom:1px solid var(--line);vertical-align:top}',
    '.ap table.kv td:first-child{color:var(--muted);width:40%}',
    '.ap .badge{display:inline-block;border-radius:999px;padding:1px 9px;color:#fff;font-size:12px;font-weight:700}',
    '.ap .item{display:flex;gap:10px;align-items:center;padding:11px 12px;border:0;border-radius:12px;margin:6px 0;cursor:pointer;background:var(--tonal)}',
    '.ap .item:hover{border-color:var(--accent)}',
    '.ap .item .tx{flex:1;min-width:0}',
    '.ap .item .tx div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ap .mi{display:flex;align-items:center;gap:12px;width:100%;border:0;background:transparent;color:var(--text);border-radius:12px;padding:12px;' +
      'font:500 15px var(--font);cursor:pointer;text-align:left}',
    '.ap .mi:hover{background:var(--bg)}',
    '.ap .mi.d{color:var(--danger)}',
    '.ap .mi svg{width:22px;height:22px;flex:0 0 22px;color:var(--muted)}',
    '.ap .mi.d svg{color:var(--danger)}',
    // нижняя карточка (телефон) / боковая панель (компьютер)
    '#apSheet{position:fixed;left:0;right:0;bottom:0;z-index:1050;background:var(--panel);color:var(--text);border-radius:14px 14px 0 0;' +
      'box-shadow:0 -6px 26px rgba(0,0,0,.22);max-height:48vh;display:none;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}',
    '#apSheet.show{display:flex;animation:apUp .18s ease-out}',
    '@keyframes apUp{from{transform:translateY(30px);opacity:.5}to{transform:none;opacity:1}}',
    '.ap-grip{width:36px;height:5px;border-radius:3px;background:#c7c7cc;margin:6px auto 0;flex:0 0 auto}body.dark .ap-grip{background:#5a5a5f}',
    '.ap-head{display:flex;align-items:center;gap:8px;padding:8px 12px 4px 16px;flex:0 0 auto;touch-action:none}',
    '.ap-tt{flex:1;min-width:0}.ap-sub{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none}',
    '#apSheet.peek .ap-body{display:none}#apSheet.peek .ap-sub{display:block}#apSheet.peek .ap-head{padding-bottom:12px;cursor:pointer}',
    '.ap-quick{display:none;gap:8px;padding:0 16px 12px}#apSheet.peek .ap-quick:not(:empty){display:flex}#apSheet.peek .ap-quick:not(:empty)~.ap-body{display:none}',
    '.ap .ap-quick button.b{flex:1 1 0;min-width:0;min-height:38px;padding:8px 6px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#apSheet.peek .ap-head{padding-bottom:8px}',
    '.ap-title{font-weight:700;font-size:17px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ap-x{width:30px;height:30px;border:0;border-radius:50%;background:var(--tonal);color:var(--muted);font-size:13px;font-weight:700;cursor:pointer}',
    '.ap-body{overflow-y:auto;padding:0 16px 16px;overscroll-behavior:contain}',
    '@media (min-width:900px){#apSheet{left:12px;right:auto;top:68px;bottom:12px;width:var(--pw);max-height:none;border-radius:16px;box-shadow:var(--shadow)}' +
      '#apSheet.show{animation:none}.ap-grip{display:none}' +
      'body.ap-sheet .leaflet-bottom.leaflet-left,body.ap-sheet #apCoords{left:calc(var(--pw) + 150px)}}',
    // диалог
    '#apDlg{position:fixed;inset:0;z-index:2100;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}',
    '#apDlg.show{display:flex}',
    '#apDlgBox{background:var(--panel);color:var(--text);width:min(520px,calc(100vw - 24px));max-height:88vh;overflow:auto;border-radius:14px;padding:18px;box-sizing:border-box;box-shadow:0 10px 40px rgba(0,0,0,.3)}',
    '.ap-dhead{position:sticky;top:-18px;z-index:3;margin:-18px -18px 0;padding:0 12px;height:34px;background:var(--panel);display:flex;align-items:center;justify-content:flex-end;border-radius:14px 14px 0 0}',
    '.ap-dhead .ap-grip{position:absolute;left:50%;top:6px;margin:0 0 0 -18px;display:none}#apDlg.lock .ap-dx{display:none}',
    '@media (max-width:899px){.ap-dhead .ap-grip{display:block}}',
    '#apDlgBox h3{margin:0 0 6px;font-size:18px}',
    '@media (max-width:899px){#apDlg{align-items:flex-end}#apDlgBox{width:100%;border-radius:20px 20px 0 0;max-height:92vh;padding-bottom:calc(18px + env(safe-area-inset-bottom))}}',
    // меню настроек
    '#apMenu{position:fixed;top:58px;right:8px;z-index:2000;min-width:270px;background:var(--panel);color:var(--text);border-radius:13px;box-shadow:0 10px 40px rgba(0,0,0,.28);padding:6px;display:none}',
    '#apMenu.show{display:block}',
    '#apMenu hr{border:0;border-top:1px solid var(--line);margin:4px 8px}',
    // всплывающее сообщение
    '#apToast{position:fixed;left:50%;bottom:calc(var(--sheet-h,0px) + 18px);transform:translateX(-50%);text-align:center;z-index:3000;background:#3a3a3c;color:#fff;border-radius:14px;padding:10px 16px;' +
      'font:14px var(--font);max-width:calc(100vw - 32px);box-shadow:0 6px 20px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .2s}',
    '#apToast.show{opacity:1}',
    // перекрестие
    '#apCross{position:fixed;z-index:1040;width:0;height:0;pointer-events:none;display:none}',
    '#apCross.show{display:block}',
    '#apCross svg{position:absolute;left:-22px;top:-22px;width:44px;height:44px;filter:drop-shadow(0 0 2px #fff) drop-shadow(0 0 2px #fff)}',
    '#apCross.snap svg{color:#188038!important}',
    '#apCross span{position:absolute;left:50%;top:26px;transform:translateX(-50%);white-space:nowrap;background:#188038;color:#fff;border-radius:999px;padding:2px 10px;font:600 12px var(--font);display:none}',
    '#apCross.snap span{display:block}',
    // кнопки карты
    '.leaflet-bottom{transition:bottom .2s;bottom:var(--sheet-h,0px)}',
    '.ap-ctl{display:flex;flex-direction:column;gap:10px;align-items:flex-end}',
    '@media (max-width:899px){body.ap-sheet .ap-ctl .grp.zoom{display:none}}',
    '.ap-ctl .grp{display:flex;flex-direction:column;background:var(--panel);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}',
    '.ap-ctl .grp button{width:46px;height:46px;border:0;background:var(--panel);color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.ap-ctl .grp button+button{border-top:1px solid var(--line)}',
    '.ap-ctl .grp button:hover{background:var(--bg)}',
    '.ap-ctl svg{width:22px;height:22px}',
    '.ap-fab{width:58px;height:58px;border:0;border-radius:50%;background:var(--accent);color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3);display:none;align-items:center;justify-content:center;cursor:pointer}',
    'body.ap-edit .ap-fab{display:flex}',
    'body.ap-tool .ap-fab{display:none}',
    '.ap-fab svg{width:28px;height:28px}',
    '#mapKinds{top:66px!important;right:10px!important;gap:0!important;flex-direction:row!important;background:var(--panel);border-radius:12px;box-shadow:var(--shadow);padding:3px}',
    '#mapKinds button{background:transparent!important;color:var(--text)!important;border:0!important;box-shadow:none!important;border-radius:9px!important;' +
      'padding:6px 10px!important;font:600 13px var(--font)!important;min-height:32px}',
    '#mapKinds button.on{background:var(--tonal)!important;color:var(--accent)!important}',
    '.leaflet-control-scale-line{border-color:var(--muted)!important;background:var(--panel)!important;color:var(--text)!important}',
    'body.dark #apToast{background:#48484a;color:#fff}',
    '#apCoords{position:fixed;left:140px;bottom:8px;z-index:900;font:12px var(--font);color:var(--text);background:var(--panel);box-shadow:var(--shadow);' +
      'border-radius:8px;padding:3px 8px;font-variant-numeric:tabular-nums;pointer-events:none}',
    // объекты на карте
    '.ap-shape{display:block;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))}',
    '.ap-shape.ring{filter:drop-shadow(0 0 0 #fff) drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 3px var(--accent))}',
    '.ap-lbl{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:2px;white-space:nowrap;font:600 11px/1.2 var(--font);' +
      'color:#1a1a1a;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;pointer-events:none}',
    '.ap-z-lo .ap-lbl,.ap-z-lo2 .ap-llbl{display:none}',
    '.ap-llbl{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;font:600 11px/1.3 var(--font);padding:1px 7px;border-radius:9px;' +
      'background:#fff;color:#b23c00;border:1px solid #e8590c;pointer-events:none}',
    '.ap-llbl.radio{color:#1565c0;border-color:#1565c0}',
    '.ap-h{width:22px;height:22px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);color:#fff;font:700 10px/17px var(--font);text-align:center;box-sizing:border-box}',
    '.ap-pt{display:block;overflow:visible;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.55))}',
    '.ap-pt.ring{filter:drop-shadow(0 0 4px #1a73e8) drop-shadow(0 0 2px #1a73e8)}',
    '.ap-plbl{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:1px;white-space:nowrap;font:600 10.5px/1.2 var(--font);color:#3e2723;'+
      'text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;pointer-events:none}',
    '.ap-hd{cursor:grab}',
    '.ap-mid{width:20px;height:20px;border-radius:50%;background:#fff;border:2px solid #e8590c;color:#e8590c;font:700 14px/15px var(--font);text-align:center;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.4)}',
    '.ap-me{width:18px;height:18px;border-radius:50%;background:#1e88e5;border:3px solid #fff;box-sizing:border-box;box-shadow:0 0 0 3px rgba(30,136,229,.3),0 1px 4px rgba(0,0,0,.5)}',
    '.leaflet-container{font-family:var(--font)}',
    '.leaflet-tooltip{font:13px var(--font);border-radius:8px}'
  ];
  /* Правила объектов на карте не масштабируются (их размеры заданы и в коде), остальной интерфейс
   * масштабируется настройкой «Размер кнопок и текста»: все px умножаются, кроме условий @media. */
  var MAPRULE = /^(#apCross|\.ap-pt|\.ap-plbl|\.ap-hd|\.ap-shape|\.ap-lbl|\.ap-z-lo|\.ap-llbl|\.ap-h\{|\.ap-mid|\.ap-me|\.leaflet-)/;
  function cssText(k) {
    var t = RULES.filter(function (r) { return !MAPRULE.test(r); }).join('\n');
    return k === 1 ? t : t.replace(/@media \([^)]*\)|(\d*\.?\d+)px/g, function (m, n) { return n == null ? m : Math.round(n * k * 100) / 100 + 'px'; });
  }
  css.textContent = cssText(S.ui);
  cssMap.textContent = RULES.filter(function (r) { return MAPRULE.test(r); }).join('\n');
  document.documentElement.style.setProperty('--pw', Math.round(S.pcPanel * S.ui) + 'px');
  document.head.appendChild(css);
  document.head.appendChild(cssMap);
  document.body.classList.add('ap');

  // ================================================================== значки (SVG)

  function ic(d, w) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; }
  var I = {
    eye: ic('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    pen: ic('<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>'),
    search: ic('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
    dots: ic('<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>'),
    plus: ic('<path d="M12 5v14M5 12h14"/>', 2.4),
    minus: ic('<path d="M5 12h14"/>', 2.4),
    fit: ic('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
    locate: ic('<circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="8"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>'),
    file: ic('<path d="M7 4v13M3 13l4 4 4-4M17 20V7M13 11l4-4 4 4"/>'),
    list: ic('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', 2.2),
    web: ic('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>'),
    moon: ic('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
    user: ic('<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-5.5 8-5.5s6.5 1.5 8 5.5"/>'),
    node: ic('<circle cx="12" cy="12" r="6"/>'),
    fiber: ic('<path d="M3 18l6-6 4 4 8-9"/><circle cx="3" cy="18" r="1.5" fill="currentColor"/><circle cx="21" cy="7" r="1.5" fill="currentColor"/>'),
    radio: ic('<path d="M5 19L12 5l7 14"/><path d="M8.5 12.5h7" stroke-dasharray="2 2"/>'),
    trash: ic('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
    edit: ic('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'),
    branch: ic('<path d="M4 12h16M12 12v8"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>'),
    cont: ic('<path d="M4 18l6-6M14 8l6-6M14 2h6v6"/>'),
    move: ic('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
    ins: ic('<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>'),
    undo: ic('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    map: ic('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>'),
    help: ic('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8M12 17h.01"/>'),
    gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
    cross: ic('<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 1v7M12 16v7M1 12h7M16 12h7"/>', 2.2)
  };

  // ================================================================== каркас интерфейса

  var bar = el('div', 'ap', '<div class="ap-logo"><svg width="30" height="30" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#17324D"/>' +
    '<path d="M24 12 L14 31 L34 31 Z" fill="none" stroke="#7FD1FF" stroke-width="2.6" stroke-linejoin="round"/><circle cx="24" cy="12" r="5" fill="#fff"/>' +
    '<circle cx="14" cy="31" r="5" fill="#fff"/><circle cx="34" cy="31" r="5" fill="#FFB547"/></svg><span>Карта сети</span></div>' +
    '<div class="ap-seg"><button type="button" data-mode="view">' + I.eye.replace('<svg', '<svg width="18" height="18"') + 'Просмотр</button>' +
    '<button type="button" data-mode="edit">' + I.pen.replace('<svg', '<svg width="18" height="18"') + '<span class="lng">Редактирование</span><span class="sht">Правка</span></button></div>' +
    '<div class="ap-sp"></div><button type="button" class="ap-ib" id="apFind" title="Поиск">' + I.search + '</button>' +
    '<button type="button" class="ap-ib" id="apMenuBtn" title="Настройки">' + I.dots + '</button>');
  bar.id = 'apBar';
  document.body.appendChild(bar);

  var sheet = el('div', 'ap', '<div class="ap-grip"></div><div class="ap-head"><div class="ap-tt"><div class="ap-title"></div><div class="ap-sub"></div></div><button type="button" class="ap-x" title="Закрыть">&#10005;</button></div><div class="ap-quick"></div><div class="ap-body"></div>');
  sheet.id = 'apSheet';
  document.body.appendChild(sheet);
  var sheetTitle = sheet.querySelector('.ap-title'), sheetSub = sheet.querySelector('.ap-sub'), sheetQuick = sheet.querySelector('.ap-quick'), sheetBody = sheet.querySelector('.ap-body');

  var dlg = el('div', 'ap', '<div id="apDlgBox"></div>');
  dlg.id = 'apDlg';
  document.body.appendChild(dlg);
  var dlgBox = $('apDlgBox');

  var menu = el('div', 'ap');
  menu.id = 'apMenu';
  document.body.appendChild(menu);

  var toastEl = el('div');
  toastEl.id = 'apToast';
  document.body.appendChild(toastEl);
  var toastT = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  var cross = el('div', '', I.cross.replace('<svg', '<svg style="color:#d93025"') + '<span></span>');
  cross.id = 'apCross';
  document.body.appendChild(cross);

  // прежние слои приложения товарища (точки радиолинии и паспорта) — убрать с карты
  try {
    (typeof markers !== 'undefined' ? markers : []).forEach(function (m) { map.removeLayer(m); });
    if (typeof line !== 'undefined' && line) map.removeLayer(line);
    (typeof nodeMarkers !== 'undefined' ? nodeMarkers : []).forEach(function (m) { map.removeLayer(m); });
    if (typeof nodeLine !== 'undefined' && nodeLine) map.removeLayer(nodeLine);
  } catch (e) { /* не важно */ }
  if (map.zoomControl) map.removeControl(map.zoomControl);
  var scaleCtl = L.control.scale({ position: 'bottomleft', imperial: false });
  setTimeout(function () { map.invalidateSize(); }, 30);

  // кнопки карты справа внизу
  var Ctl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: function () {
      var d = L.DomUtil.create('div', 'ap-ctl');
      d.innerHTML = '<div class="grp zoom"><button type="button" data-c="in" title="Приблизить">' + I.plus + '</button><button type="button" data-c="out" title="Отдалить">' + I.minus + '</button></div>' +
        '<div class="grp undo"><button type="button" data-c="undo" title="Отменить последнее изменение">' + I.undo + '</button></div>' +
        '<div class="grp"><button type="button" data-c="fit" title="Показать всю сеть">' + I.fit + '</button><button type="button" data-c="loc" title="Где я">' + I.locate + '</button></div>' +
        '<button type="button" class="ap-fab" data-c="add" title="Добавить">' + I.plus + '</button>';
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      d.addEventListener('click', function (e) {
        var b = e.target.closest('[data-c]');
        if (!b) return;
        var c = b.getAttribute('data-c');
        if (c === 'in') map.zoomIn(); else if (c === 'out') map.zoomOut();
        else if (c === 'undo') undo(); else if (c === 'fit') fitAll(); else if (c === 'loc') locate(); else if (c === 'add') showAdd();
      });
      return d;
    }
  });
  map.addControl(new Ctl());

  // ================================================================== нижняя карточка / боковая панель

  var view = null;   // что показано: {k: 'card'|'pt'|'line'|'nodemenu'|'tool'|'add'|'search', ...}
  function wide() { return window.innerWidth >= 900; }
  /* На телефоне у карточки два положения: «свёрнута» (только название и строка сведений — карта
   * видна почти вся) и «развёрнута». Сведения об объекте открываются свёрнутыми; смахивание вниз
   * сворачивает, ещё раз — прячет карточку, но выделение и правка остаются (заказчик: «чтобы
   * редактирование не останавливалось при смахивании меню»). Нажатие на свёрнутую — развернуть. */
  var PEEKABLE = { card: 1, pt: 1, line: 1, nodemenu: 1 }, sheetKey = null, peek = false;
  function keyOf(v) { return v ? v.k + ':' + (v.id || '') + ':' + (v.i == null ? '' : v.i) + ':' + (v.seg == null ? '' : v.seg) : ''; }
  function subOf(v) {
    var o = v && get(v.id);
    if (!o) return '';
    if (v.k === 'pt') { var p = ptsOf(o)[v.i] || {}; return p.nid ? 'на узле' : (p.kind || 'точка') + (p.name ? ' ' + p.name : ''); }
    if (o.type === 'node') return [o.f.kind, o.f.state].filter(Boolean).join(' · ');
    var L2 = lens(o), t = [TYPE_NAME[o.type], len(L2.air + L2.ground)];
    if (o.type === 'fiber') { if (L2.air) t.push('опоры ' + len(L2.air)); if (L2.ground) t.push('земля ' + len(L2.ground)); }
    return t.join(' · ');
  }
  /* в свёрнутой карточке в режиме правки — главные действия одной строкой */
  function quick(v) {
    var o = v && v.k === 'card' && mode === 'edit' ? get(v.id) : null, acts = [];
    if (o && o.type === 'node') acts = [['+ ВОЛС', function () { startLine('fiber', o.id); }], ['+ Радио', function () { startLine('radio', o.id); }], ['Изменить', function () { editNode(o.id); }]];
    else if (o) acts = (o.type === 'fiber' ? [['Продолжить', function () { startLine('fiber', null, o.id); }]] : []).concat([['Название', function () { editLine(o.id); }], ['Подробнее', function () { setPeek(false); }]]);
    sheetQuick.innerHTML = acts.map(function (a, i) { return '<button type="button" class="b t" data-q="' + i + '">' + a[0] + '</button>'; }).join('');
    sheetQuick.querySelectorAll('[data-q]').forEach(function (b) { b.onclick = function () { acts[+b.getAttribute('data-q')][1](); }; });
  }
  function setPeek(on) {
    peek = !!on && !wide() && !!view && !!PEEKABLE[view.k];
    sheet.classList.toggle('peek', peek);
    sizeChanged();
  }
  function openSheet(title, v) {
    var key = keyOf(v);
    if (key !== sheetKey) { peek = v.k === 'card'; sheetBody.scrollTop = 0; }
    sheetKey = key;
    view = v;
    sheetTitle.textContent = title;
    sheetSub.textContent = subOf(v);
    quick(v);
    sheet.classList.add('show');
    setPeek(peek);
    return sheetBody;
  }
  function closeSheet() {
    if (view && view.k === 'tool') { finishTool(); return; }
    view = null;
    sheetKey = null;
    sheet.classList.remove('show');
    sizeChanged();
  }
  sheet.querySelector('.ap-head').addEventListener('click', function (e) { if (peek && !e.target.closest('.ap-x')) setPeek(false); });
  sheet.querySelector('.ap-x').onclick = function () {
    if (view && (view.k === 'card' || view.k === 'pt' || view.k === 'line' || view.k === 'nodemenu')) select(null);
    closeSheet();
  };
  function sheetH() { return sheet.classList.contains('show') && !wide() ? sheet.getBoundingClientRect().height : 0; }
  function panelW() { return sheet.classList.contains('show') && wide() ? sheet.getBoundingClientRect().right : 0; }
  function sizeChanged() {
    document.body.classList.toggle('ap-sheet', sheet.classList.contains('show'));
    document.body.style.setProperty('--sheet-h', sheetH() + 'px');
    placeCross();
  }
  if (window.ResizeObserver) new ResizeObserver(sizeChanged).observe(sheet);
  window.addEventListener('resize', sizeChanged);
  // смахнуть карточку вниз
  (function () {
    var y0 = null, head = sheet.querySelector('.ap-head'), grip = sheet.querySelector('.ap-grip');
    function st(e) { if (!wide()) y0 = e.touches[0].clientY; }
    function mv(e) { if (y0 == null) return; var dy = e.touches[0].clientY - y0; if (dy > 0 && view && view.k !== 'tool') sheet.style.transform = 'translateY(' + dy + 'px)'; }
    function en(e) {
      if (y0 == null) return;
      var dy = (e.changedTouches[0] || {}).clientY - y0;
      sheet.style.transform = '';
      y0 = null;
      if (Math.abs(dy) < 8 && !e.target.closest('.ap-x')) { if (peek) setPeek(false); return; }   // нажатие
      if (dy < -40 && peek) { setPeek(false); return; }
      if (dy > 60) {
        if (!view || view.k === 'tool') return;            // панель нанесения смахиванием не закрывается
        if (PEEKABLE[view.k] && !peek) setPeek(true);       // развёрнута → свёрнута
        else closeSheet();                                  // свёрнута → спрятана, выделение остаётся
      }
    }
    [head, grip].forEach(function (h) {
      h.addEventListener('touchstart', st, { passive: true });
      h.addEventListener('touchmove', mv, { passive: true });
      h.addEventListener('touchend', en);
    });
  })();

  // ================================================================== диалоги

  var dlgLock = false;      // окно нельзя закрыть, не ответив (имя при первом запуске)
  function openDlg(html) { dlgBox.removeAttribute('data-offline'); dlgBox.removeAttribute('data-set'); dlgLock = false; dlg.classList.remove('lock'); dlgBox.style.transform = '';
    dlgBox.innerHTML = '<div class="ap-dhead"><div class="ap-grip"></div><button type="button" class="ap-x ap-dx" title="Закрыть">&#10005;</button></div>' + html;
    dlgBox.querySelector('.ap-dx').onclick = function () { if (!dlgLock) closeDlg(); }; dlg.classList.add('show'); return dlgBox; }
  function closeDlg() { dlg.classList.remove('show'); dlgBox.innerHTML = ''; dlgBox.removeAttribute('data-offline'); dlgBox.removeAttribute('data-set'); }
  dlg.addEventListener('click', function (e) { if (e.target === dlg && !dlgLock) closeDlg(); });
  // телефон: окно можно смахнуть вниз (когда его содержимое прокручено к началу)
  (function () {
    var y0 = null, dy = 0;
    dlgBox.addEventListener('touchstart', function (e) {
      y0 = null;
      if (wide() || dlgLock || e.touches.length !== 1 || dlgBox.scrollTop > 0 || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    dlgBox.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy < 0 || dlgBox.scrollTop > 0) { y0 = null; dlgBox.style.transform = ''; return; }
      if (dy > 12) dlgBox.style.transform = 'translateY(' + (dy - 12) + 'px)';
    }, { passive: true });
    function end() {
      if (y0 == null) return;
      y0 = null;
      dlgBox.style.transform = '';
      if (dy > 90) closeDlg();
    }
    dlgBox.addEventListener('touchend', end);
    dlgBox.addEventListener('touchcancel', end);
  })();
  /* fields: [{key, label, type: text|select|textarea, value, options, required, placeholder}] */
  function form(title, fields, okLabel, onOk) {
    openDlg('<h3>' + esc(title) + '</h3>' + fields.map(function (f, i) {
      var id = 'apf' + i, v = f.value == null ? '' : f.value;
      if (f.type === 'select') return '<label for="' + id + '">' + esc(f.label) + '</label><select id="' + id + '">' +
        f.options.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
      if (f.type === 'textarea') return '<label for="' + id + '">' + esc(f.label) + '</label><textarea id="' + id + '">' + esc(v) + '</textarea>';
      return '<label for="' + id + '">' + esc(f.label) + '</label><input id="' + id + '" value="' + esc(v) + '"' + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>';
    }).join('') + '<div class="row"><button type="button" class="b" id="apOk">' + esc(okLabel || 'Сохранить') + '</button>' +
      '<button type="button" class="b t" id="apNo">Отмена</button></div>');
    if (pc) { var f0 = $('apf0'); if (f0) f0.focus(); }
    function ok() {
      var v = {};
      fields.forEach(function (f, i) { v[f.key] = $('apf' + i).value.trim(); });
      for (var i = 0; i < fields.length; i++) if (fields[i].required && !v[fields[i].key]) { $('apf' + i).focus(); $('apf' + i).style.borderColor = 'var(--danger)'; return; }
      closeDlg();
      if (v._who) localStorage.setItem(WHO, v._who);
      onOk(v);
    }
    $('apOk').onclick = ok;
    $('apNo').onclick = closeDlg;
    dlgBox.querySelectorAll('input').forEach(function (i) { i.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); }); });
  }
  function confirmDlg(text, okLabel, onOk, sub) {
    openDlg('<h3>' + esc(text) + '</h3>' + (sub ? '<p class="muted">' + esc(sub) + '</p>' : '') +
      '<div class="row"><button type="button" class="b" id="apOk" style="background:var(--danger);color:#fff">' + esc(okLabel) + '</button>' +
      '<button type="button" class="b t" id="apNo">Отмена</button></div>');
    $('apOk').onclick = function () { closeDlg(); onOk(); };
    $('apNo').onclick = closeDlg;
  }
  function whoField() {
    return localStorage.getItem(WHO) ? [] : [{ key: '_who', label: 'Как подписывать ваши изменения (бригада, фамилия)', placeholder: 'например: Бригада 2, Иванов' }];
  }

  // ================================================================== режимы

  var mode = 'view';   // при запуске — просмотр (ничего не сдвинуть случайно), если в настройках не выбрано иное
  function setMode(m) {
    if (tool) finishTool();
    mode = m;
    document.body.classList.toggle('ap-edit', m === 'edit');
    bar.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === m); });
    select(null);
    if (view && view.k !== 'search') closeSheet();
    try { localStorage.setItem('karta_mode', m); } catch (e) { /* не важно */ }
    updHint();
    toast(m === 'edit' ? 'Редактирование: «+» — добавить, долгое нажатие — меню' : 'Просмотр: ничего не сдвинется');
  }
  bar.querySelectorAll('[data-mode]').forEach(function (b) { b.onclick = function () { if (mode !== b.getAttribute('data-mode')) setMode(b.getAttribute('data-mode')); }; });

  // ================================================================== отрисовка

  var layer = L.layerGroup().addTo(map), ptsLayer = L.layerGroup().addTo(map), toolLayer = L.layerGroup().addTo(map);
  var sel = null;          // {type: 'node'|'line', id}
  var tool = null;         // инструмент нанесения
  var lastDrag = 0, lastLong = 0;

  function zoomCls() {
    var c = map.getContainer(), z = map.getZoom();
    c.classList.toggle('ap-z-lo', S.nodeLbl === 'never' || (S.nodeLbl === 'zoom' && z < 12));
    c.classList.toggle('ap-z-lo2', S.lineLbl === 'never' || (S.lineLbl === 'zoom' && z < 13));
  }
  map.on('zoomend', function () { zoomCls(); refresh(); });
  zoomCls();

  function nodeIcon(o, ring) {
    var color = STATES[o.f.state] || '#455a64', big = o.f.kind === 'опорный узел' || o.f.kind === 'базовая станция', px = Math.round((big ? 28 : 24) * S.nodeSize);
    return L.divIcon({ className: '', html: shapeSvg(o.f.kind, color, px, ring) + '<div class="ap-lbl">' + esc(o.f.name) + '</div>',
      iconSize: [px, px], iconAnchor: [px / 2, px / 2] });
  }
  function handleIcon(p, type) {
    var kind = p.nid ? 'узел' : type === 'radio' ? 'узел' : (p.kind || 'точка'), px = Math.round(Math.max(20, (PT_PX[kind] || 14) * 1.35) * S.ptSize);
    return L.divIcon({ className: 'ap-hd', html: ptSvg(kind, px, true), iconSize: [px, px], iconAnchor: [px / 2, px / 2] });
  }
  /* с какого масштаба видна точка линии: муфты и кроссы — раньше опор и колодцев */
  function ptShown(kind, z) {
    var base = S.linePts === 'always' ? 12 : S.linePts === 'never' ? 99 : 14;
    return z >= (kind === 'муфта' || kind === 'кросс' ? base - 2 : base);
  }
  function drawPoints() {
    ptsLayer.clearLayers();
    var z = map.getZoom(), b = map.getBounds().pad(0.25), lblZ = S.ptLbl === 'always' ? 14 : S.ptLbl === 'never' ? 99 : 16, n = 0;
    alive().forEach(function (o) {
      if (o.type !== 'fiber') return;
      if (sel && sel.type === 'line' && sel.id === o.id && mode === 'edit' && !tool) return;      // у выделенной линии — ручки
      ptsOf(o).forEach(function (p) {
        if (p.nid || n > 1500 || !ptShown(p.kind, z) || !b.contains([p.lat, p.lng])) return;
        n++;
        var px = Math.round((PT_PX[p.kind] || 12) * S.ptSize);
        L.marker([p.lat, p.lng], { interactive: false, keyboard: false, zIndexOffset: p.kind === 'муфта' || p.kind === 'кросс' ? 350 : 300,
          icon: L.divIcon({ className: '', html: ptSvg(p.kind, px) + (p.name && z >= lblZ ? '<div class="ap-plbl">' + esc(p.name) + '</div>' : ''), iconSize: [px, px], iconAnchor: [px / 2, px / 2] }) }).addTo(ptsLayer);
      });
    });
  }
  map.on('moveend', drawPoints);

  function refresh() {
    layer.clearLayers();
    var z = map.getZoom(), objs = alive();
    objs.filter(function (o) { return o.type !== 'node'; }).forEach(function (o) { drawLine(o, z); });
    objs.filter(function (o) { return o.type === 'node' && isFinite(o.f.lat) && isFinite(o.f.lng); }).forEach(drawNode);
    drawPoints();
    drawTool();
    updHint();
    if (view && (view.k === 'card' || view.k === 'pt' || view.k === 'line' || view.k === 'nodemenu' || view.k === 'tool')) renderView();
  }

  function drawNode(o) {
    var isSel = sel && sel.type === 'node' && sel.id === o.id;
    var m = L.marker([o.f.lat, o.f.lng], {
      icon: nodeIcon(o, isSel), draggable: mode === 'edit' && isSel && !tool, bubblingMouseEvents: true, keyboard: false, zIndexOffset: isSel ? 900 : 500
    });
    if (pc && mode === 'view') m.bindTooltip(esc(o.f.name || '') + (o.f.kind ? ' · ' + esc(o.f.kind) : ''), { direction: 'top', offset: [0, -12] });
    m.on('dragend', function () {
      lastDrag = Date.now();
      var ll = m.getLatLng();
      put(o.id, 'node', { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }, 'перемещён', true);
      var n = follow(o.id);
      toast('Узел перемещён' + (n ? ', линий за ним: ' + n : ''));
    });
    m.addTo(layer);
  }

  function drawLine(o, z) {
    var pts = ptsOf(o);
    if (pts.length < 2) return;
    var isSel = sel && sel.type === 'line' && sel.id === o.id, editSel = isSel && mode === 'edit' && !tool;
    var ll = pts.map(function (p) { return [p.lat, p.lng]; });
    if (isSel) L.polyline(ll, { color: '#1a73e8', weight: 16, opacity: .25, interactive: false }).addTo(layer);
    if (o.type === 'radio') {
      L.polyline(ll, { color: '#fff', weight: (isSel ? 9 : 7) * S.lineW, opacity: .8, interactive: false }).addTo(layer);
      L.polyline(ll, { color: '#1565c0', weight: (isSel ? 5 : 3.5) * S.lineW, dashArray: '9 7', bubblingMouseEvents: true }).addTo(layer);
    } else {
      var lay = layOf(o), runs = [], cur = null;
      for (var i = 0; i < lay.length; i++) {
        if (!cur || cur.lay !== lay[i]) { cur = { lay: lay[i], ll: [ll[i]] }; runs.push(cur); }
        cur.ll.push(ll[i + 1]);
      }
      runs.forEach(function (r) {
        L.polyline(r.ll, { color: '#fff', weight: (isSel ? 10 : 8) * S.lineW, opacity: .85, interactive: false }).addTo(layer);
      });
      runs.forEach(function (r) {
        var s = LAY[r.lay] || LAY.air;
        L.polyline(r.ll, { color: s.color, weight: (isSel ? 6 : 4.5) * S.lineW, dashArray: s.dash, lineCap: s.dash ? 'butt' : 'round', bubblingMouseEvents: true }).addTo(layer);
      });
    }
    if (pc && mode === 'view') {
      // в просмотре на компьютере — подсказка при наведении
      L.polyline(ll, { color: '#000', opacity: 0, weight: 16, bubblingMouseEvents: true })
        .bindTooltip(esc(o.f.name || '') + ' · ' + len(lenOf(pts)), { sticky: true }).addTo(layer);
    }
    // точки линии
    if (editSel) {
      pts.forEach(function (p, i) {
        var h = L.marker([p.lat, p.lng], { icon: handleIcon(p, o.type), draggable: true, bubblingMouseEvents: true, keyboard: false, zIndexOffset: 1000 });
        var prev = null;
        h.on('drag', function () {
          var a = [];
          if (pts[i - 1]) a.push([pts[i - 1].lat, pts[i - 1].lng]);
          a.push(h.getLatLng());
          if (pts[i + 1]) a.push([pts[i + 1].lat, pts[i + 1].lng]);
          if (!prev) prev = L.polyline(a, { color: '#1a73e8', weight: 3, dashArray: '6 5', interactive: false }).addTo(toolLayer);
          else prev.setLatLngs(a);
        });
        h.on('dragend', function () {
          lastDrag = Date.now();
          if (prev) toolLayer.removeLayer(prev);
          movePoint(o.id, i, h.getLatLng());
        });
        h.addTo(layer);
      });
      for (var j = 0; o.type === 'fiber' && j + 1 < pts.length; j++) (function (j) {
        var a = pts[j], b = pts[j + 1];
        var m = L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
          icon: L.divIcon({ className: '', html: '<div class="ap-mid">+</div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
          draggable: true, keyboard: false, zIndexOffset: 800, title: 'Добавить точку'
        });
        m.on('click', function (e) { L.DomEvent.stopPropagation(e); insertPoint(o.id, j, m.getLatLng()); });
        m.on('dragend', function () { lastDrag = Date.now(); insertPoint(o.id, j, m.getLatLng()); });
        m.addTo(layer);
      })(j);
    }
    // подпись линии
    if (o.f.name && !editSel) {
      var k = Math.floor((pts.length - 1) / 2), a2 = pts[k], b2 = pts[k + 1] || a2;
      L.marker([(a2.lat + b2.lat) / 2, (a2.lng + b2.lng) / 2], { interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', html: '<div class="ap-llbl ' + o.type + '">' + esc(o.f.name) + (S.lineLen ? ' · ' + len(lenOf(pts)) : '') + '</div>', iconSize: [0, 0] }) }).addTo(layer);
    }
  }

  // ================================================================== попадание пальцем: узел, точка, линия

  function cp(lat, lng) { return map.latLngToContainerPoint([lat, lng]); }
  function nearNode(p, px) {
    var best = null, bd = px || 24;
    alive().forEach(function (o) {
      if (o.type !== 'node') return;
      var d = p.distanceTo(cp(o.f.lat, o.f.lng));
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }
  /* ближайшая точка чужой линии ВОЛС (не на узле); skip — точки, которые не считать */
  function nearPt(p, px, skipId, skip, shownOnly) {
    var best = null, bd = px, z = map.getZoom();
    alive().forEach(function (o) {
      if (o.type !== 'fiber' || o.id === skipId) return;
      ptsOf(o).forEach(function (q, i) {
        if (q.nid || (shownOnly && !ptShown(q.kind, z))) return;
        if (skip && skip.some(function (j) { return j.id === o.id && j.i === i; })) return;
        var d = p.distanceTo(cp(q.lat, q.lng));
        if (d < bd) { bd = d; best = { id: o.id, i: i, p: q }; }
      });
    });
    return best;
  }
  function nearSeg(p, px, skipId, fiberOnly) {
    var best = null, bd = px;
    alive().forEach(function (o) {
      if (o.type === 'node' || o.id === skipId || (fiberOnly && o.type !== 'fiber')) return;
      var pts = ptsOf(o);
      for (var i = 0; i + 1 < pts.length; i++) {
        var a = cp(pts[i].lat, pts[i].lng), b = cp(pts[i + 1].lat, pts[i + 1].lng);
        var d = L.LineUtil.pointToSegmentDistance(p, a, b);
        if (d < bd) { bd = d; best = { type: 'line', id: o.id, seg: i, at: L.LineUtil.closestPointOnSegment(p, a, b) }; }
      }
    });
    return best;
  }
  function hitTest(p) {
    // точки выделенной линии
    if (sel && sel.type === 'line' && mode === 'edit' && !tool) {
      var so = get(sel.id);
      if (so) {
        var pts = ptsOf(so), bi = -1, bd = 24;
        pts.forEach(function (q, i) { var d = p.distanceTo(cp(q.lat, q.lng)); if (d < bd) { bd = d; bi = i; } });
        if (bi >= 0) return { type: 'pt', id: so.id, i: bi };
      }
    }
    var n = nearNode(p, 22);
    if (n) return { type: 'node', id: n.id };
    // значок точки любой линии (опора, колодец, муфта, кросс) — раньше самой линии
    var q = nearPt(p, pc ? 13 : 20, null, null, true);
    if (q) return { type: 'pt', id: q.id, i: q.i };
    return nearSeg(p, pc ? 9 : 16);
  }

  function select(s) {
    sel = s;
    refresh();
  }

  // нажатие
  map.on('click', function (e) {
    var now = Date.now();
    if (now - lastLong < 700 || now - lastDrag < 400) return;
    closeMenu();
    var h = hitTest(e.containerPoint);
    if (tool) { toolTap(e.latlng, h); return; }
    if (!h) { if (sel || (view && view.k !== 'search')) { select(null); closeSheet(); } return; }
    if (h.type === 'pt') { showPoint(h.id, h.i); return; }
    sel = { type: h.type === 'node' ? 'node' : 'line', id: h.id };
    refresh();
    showCard(h.id);
  });

  // долгое нажатие: на компьютере — правая кнопка; на телефоне — своё (событие браузера бывает не всегда)
  function longPress(p) {
    lastLong = Date.now();
    if (tool) return;
    var h = hitTest(p);
    if (!h) return;
    if (S.vibro && navigator.vibrate) try { navigator.vibrate(25); } catch (e) { /* нет */ }
    if (mode !== 'edit') { if (h.type === 'pt') { showPoint(h.id, h.i); return; } sel = { type: h.type === 'node' ? 'node' : 'line', id: h.id }; refresh(); showCard(h.id); return; }
    if (h.type === 'node') { sel = { type: 'node', id: h.id }; refresh(); showNodeMenu(h.id); }
    else if (h.type === 'pt') showPoint(h.id, h.i);
    else { sel = { type: 'line', id: h.id }; refresh(); showLineMenu(h.id, h.seg, map.containerPointToLatLng(h.at)); }
  }
  map.on('contextmenu', function (e) {
    if (e.originalEvent) e.originalEvent.preventDefault();
    if (Date.now() - lastLong < 1200) return;
    longPress(e.containerPoint);
  });
  (function () {
    var t = 0, start = null, mc = map.getContainer();
    mc.addEventListener('touchstart', function (e) {
      clearTimeout(t);
      if (e.touches.length !== 1) { start = null; return; }
      var r = mc.getBoundingClientRect(), x = e.touches[0].clientX - r.left, y = e.touches[0].clientY - r.top;
      start = { x: x, y: y };
      t = setTimeout(function () { if (start) longPress(L.point(start.x, start.y)); start = null; }, S.longMs);
    }, { passive: true });
    mc.addEventListener('touchmove', function (e) {
      if (!start) return;
      var r = mc.getBoundingClientRect(), dx = e.touches[0].clientX - r.left - start.x, dy = e.touches[0].clientY - r.top - start.y;
      if (dx * dx + dy * dy > 100) { clearTimeout(t); start = null; }
    }, { passive: true });
    ['touchend', 'touchcancel'].forEach(function (ev) { mc.addEventListener(ev, function () { clearTimeout(t); start = null; }, { passive: true }); });
    mc.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  })();

  // ================================================================== карточки (сведения)

  function kvRow(k, v) { return v === '' || v == null ? '' : '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>'; }
  function showCard(id) { view = { k: 'card', id: id }; renderView(); }

  function renderView() {
    if (!view) return;
    if (view.k === 'card') renderCard(view.id);
    else if (view.k === 'pt') renderPoint(view.id, view.i);
    else if (view.k === 'line') renderLineMenu(view.id, view.seg, view.at);
    else if (view.k === 'nodemenu') renderNodeMenu(view.id);
    else if (view.k === 'tool') renderTool();
  }

  function btnRow(btns) {
    return '<div class="row">' + btns.map(function (b) {
      return '<button type="button" class="b' + (b[2] ? ' ' + b[2] : '') + '" data-a="' + b[0] + '">' + b[1] + '</button>';
    }).join('') + '</div>';
  }
  function bind(root, map2) {
    root.querySelectorAll('[data-a]').forEach(function (b) { var f = map2[b.getAttribute('data-a')]; if (f) b.onclick = f; });
  }

  function renderCard(id) {
    var o = get(id);
    if (!o) { closeSheet(); return; }
    var f = o.f, html = '', body;
    if (o.type === 'node') {
      html += '<div><span class="muted">' + esc(f.kind || 'узел') + '</span> <span class="badge" style="background:' + (STATES[f.state] || '#455a64') + '">' + esc(f.state || '') + '</span></div>' +
        '<table class="kv">' + kvRow('Адрес', esc(f.addr || '')) + kvRow('Примечание', esc(f.note || '')) +
        kvRow('Координаты', (+f.lat).toFixed(6) + ', ' + (+f.lng).toFixed(6)) + kvRow('СК-42', sk(f.lat, f.lng)) + '</table>';
      var ls = linesAt(o.id);
      if (ls.length) html += '<div class="sec">Линии</div>' + ls.map(function (l) {
        return '<div class="item" data-go="' + esc(l.id) + '">' + (l.type === 'radio' ? I.radio : I.fiber).replace('<svg', '<svg width="20" height="20"') +
          '<div class="tx"><div><b>' + esc(l.f.name || '') + '</b></div><div class="muted">' + TYPE_NAME[l.type] + ' · ' + len(lenOf(ptsOf(l))) + '</div></div></div>';
      }).join('');
      if (mode === 'edit') html += btnRow([['edit', 'Изменить'], ['fiber', 'ВОЛС отсюда', 't'], ['radio', 'Радиолиния отсюда', 't'], ['del', 'Удалить', 'd']]) +
        '<p class="muted">Узел можно перетащить. Долгое нажатие на узел — меню.</p>';
      body = openSheet(f.name || 'Узел', view);
      body.innerHTML = html;
      bind(body, {
        edit: function () { editNode(o.id); },
        fiber: function () { startLine('fiber', o.id); },
        radio: function () { startLine('radio', o.id); },
        del: function () { askDelete(o.id); }
      });
    } else {
      var pts = ptsOf(o), L2 = lens(o), total = L2.air + L2.ground, a = pts[0], b = pts[pts.length - 1];
      var kinds = {};
      pts.forEach(function (p) { if (!p.nid) kinds[p.kind] = (kinds[p.kind] || 0) + 1; });
      html += '<div class="muted">' + TYPE_NAME[o.type] + '</div><table class="kv">' +
        kvRow('Протяжённость', '<b>' + len(total) + '</b>') +
        (o.type === 'fiber' ? kvRow('По опорам', L2.air ? len(L2.air) : '—') + kvRow('В земле', L2.ground ? len(L2.ground) : '—') : '') +
        kvRow('Откуда', a && a.nid ? esc(nodeName(a.nid)) : '') + kvRow('Куда', b && b.nid ? esc(nodeName(b.nid)) : '') +
        (o.type === 'fiber' ? kvRow('Точки', pts.length + (Object.keys(kinds).length ? ' (' + Object.keys(kinds).map(function (k) { return esc(k) + ' ' + kinds[k]; }).join(', ') + ')' : '')) : '') +
        (o.type === 'fiber' ? kvRow('Кабель', esc([f.cable, f.fibers ? f.fibers + ' вол.' : ''].filter(Boolean).join(', '))) : '') +
        kvRow('Примечание', esc(f.note || '')) + kvRow('Изменено', esc(o.by || '') + ', ' + when(o.t)) + '</table>';
      if (o.type === 'fiber') {
        var seenJ = {}, js = [];
        pts.forEach(function (p, i) { if (!p.nid) joined(o.id, i).forEach(function (j) { if (!seenJ[j.id]) { seenJ[j.id] = 1; js.push({ l: get(j.id), at: i, p: p }); } }); });
        if (js.length) html += '<div class="sec">Соединения с другими линиями</div>' + js.map(function (j) {
          return '<div class="item" data-go="' + esc(j.l.id) + '">' + ptSvg(j.p.kind, 18) + '<div class="tx"><div><b>' + esc(j.l.f.name || '') + '</b></div><div class="muted">' +
            esc(j.p.kind || 'точка') + (j.p.name ? ' ' + esc(j.p.name) : '') + ', точка ' + (j.at + 1) + '</div></div></div>';
        }).join('');
      }
      if (o.type === 'fiber') html += '<div class="muted" style="display:flex;gap:16px;margin-top:8px;align-items:center"><span><span class="lg" style="border-color:' + LAY.air.color + '"></span> по опорам</span>' +
        '<span><span class="lg" style="border-top-style:dashed;border-color:' + LAY.ground.color + '"></span> в земле</span></div>';
      if (mode === 'edit') html += btnRow((o.type === 'fiber' ? [['cont', 'Продолжить линию']] : []).concat([['name', 'Название…', 't'], ['del', 'Удалить', 'd']])) +
        '<p class="muted">' + (o.type === 'fiber' ? 'Тяните точки, «+» между точками — новая точка. Нажатие на точку или долгое нажатие на линию — меню.' : 'Концы радиолинии можно перетащить.') + '</p>';
      html += '<div class="sec">Все точки</div>' + pts.map(function (p, i) {
        var nm = p.nid ? nodeName(p.nid) : (p.name || '');
        var segTxt = i < pts.length - 1 && o.type === 'fiber' ? ' <span class="muted">→ ' + (LAY[layOf(o)[i]] || LAY.air).name + '</span>' : '';
        return '<div class="item" data-pt="' + i + '"><div class="ap-h" style="background:' + (PT_COLOR[p.nid ? 'узел' : p.kind] || '#78909c') + ';flex:0 0 22px">' + (i + 1) + '</div>' +
          '<div class="tx"><div><b>' + esc(p.nid ? 'узел' : (o.type === 'radio' ? (i ? 'B' : 'A') : p.kind || 'точка')) + '</b> ' + esc(nm) + segTxt + '</div><div class="muted">' + coord(p.lat, p.lng) + '</div></div></div>';
      }).join('');
      body = openSheet(f.name || TYPE_NAME[o.type], view);
      body.innerHTML = html;
      bind(body, {
        cont: function () { startLine(o.type, null, o.id); },
        name: function () { editLine(o.id); },
        del: function () { askDelete(o.id); }
      });
      body.querySelectorAll('[data-pt]').forEach(function (it) {
        it.onclick = function () {
          var i = +it.getAttribute('data-pt'), p = pts[i];
          centerAt(L.latLng(p.lat, p.lng), Math.max(map.getZoom(), 16));
          if (mode === 'edit') showPoint(o.id, i);
        };
      });
    }
    body.querySelectorAll('[data-go]').forEach(function (it) { it.onclick = function () { focusObj(it.getAttribute('data-go')); }; });
  }

  function askDelete(id) {
    var o = get(id);
    if (!o) return;
    var extra = o.type === 'node' && linesAt(id).length ? 'Линии к узлу останутся, их концы будут без узла.' : '';
    confirmDlg('Удалить ' + TYPE_NAME[o.type] + ' «' + (o.f.name || '') + '»?', 'Удалить', function () {
      removeObj(id); select(null); closeSheet(); toast('Удалено');
    }, extra);
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
      var o = put(null, 'node', { name: v.name, kind: v.kind, state: v.state, addr: v.addr, note: v.note, lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) });
      sel = { type: 'node', id: o.id }; refresh(); showCard(o.id);
      toast('Узел «' + v.name + '» добавлен');
    });
  }
  function editNode(id) {
    var o = get(id);
    if (!o) return;
    form('Узел', nodeFields(o.f), 'Сохранить', function (v) {
      put(id, 'node', { name: v.name, kind: v.kind, state: v.state, addr: v.addr, note: v.note });
      follow(id);   // имя узла на концах линий
    });
  }
  function showNodeMenu(id) { view = { k: 'nodemenu', id: id }; renderView(); }
  function renderNodeMenu(id) {
    var o = get(id);
    if (!o) { closeSheet(); return; }
    var body = openSheet(o.f.name || 'Узел', view);
    body.innerHTML = [
      ['edit', I.edit, 'Изменить сведения'], ['fiber', I.fiber, 'Линия ВОЛС отсюда'], ['radio', I.radio, 'Радиолиния отсюда'],
      ['move', I.move, 'Переместить'], ['del', I.trash, 'Удалить узел', 'd']
    ].map(function (m) { return '<button type="button" class="mi' + (m[3] ? ' d' : '') + '" data-a="' + m[0] + '">' + m[1] + m[2] + '</button>'; }).join('');
    bind(body, {
      edit: function () { editNode(id); },
      fiber: function () { startLine('fiber', id); },
      radio: function () { startLine('radio', id); },
      move: function () { sel = { type: 'node', id: id }; refresh(); showCard(id); toast('Перетащите узел пальцем на новое место'); },
      del: function () { askDelete(id); }
    });
  }

  // ================================================================== линии: точки, участки, свойства

  function lineFields(o) {
    var pts = ptsOf(o);
    return { pts: copy(pts), lay: o.type === 'fiber' ? layOf(o) : null };
  }
  function saveLine(o, pts, lay, what) {
    var fields = { dist: lenOf(pts), from: (pts[0] && pts[0].nid) || '', to: (pts[pts.length - 1] && pts[pts.length - 1].nid) || '' };
    if (o.type === 'radio') fields.points = pts; else { fields.fnodes = pts; fields.lay = lay; }
    if (o.f.autoName !== false) { fields.name = autoName(o.type, pts, o); fields.autoName = true; }
    return put(o.id, o.type, fields, what);
  }
  function movePoint(id, i, ll) {
    var o = get(id);
    if (!o) return;
    var d = lineFields(o), p = d.pts[i], c = map.latLngToContainerPoint(ll);
    var J = o.type === 'fiber' && !p.nid ? joined(id, i) : [];           // точки других линий в этом же месте едут следом
    var n = S.snap ? nearNode(c, 24) : null, q = !n && S.snap && o.type === 'fiber' ? nearPt(c, 18, id, J, true) : null;
    if (n) { p.lat = +n.f.lat; p.lng = +n.f.lng; p.nid = n.id; p.name = n.f.name || ''; if (o.type === 'fiber') p.kind = 'узел'; }
    else {
      if (q) { p.lat = q.p.lat; p.lng = q.p.lng; }                         // встала на точку другой линии — соединение
      else { p.lat = +ll.lat.toFixed(6); p.lng = +ll.lng.toFixed(6); }
      if (p.nid) { delete p.nid; if (p.kind === 'узел') p.kind = 'точка'; p.name = ''; }
      if (q && o.type === 'fiber' && (p.kind === 'точка' || !p.kind)) { p.kind = q.p.kind; if (!p.name) p.name = q.p.name || ''; }
    }
    saveLine(o, d.pts, d.lay, 'трасса изменена');
    J.forEach(function (j) {
      var l = get(j.id);
      if (!l) return;
      var dd = lineFields(l), pp = dd.pts[j.i];
      pp.lat = p.lat; pp.lng = p.lng;
      if (p.nid) { pp.nid = p.nid; pp.name = p.name; pp.kind = 'узел'; }
      saveLine(l, dd.pts, dd.lay, 'соединение перенесено');
    });
    if (q) toast('Точка соединена с линией «' + (get(q.id).f.name || '') + '»');
    else if (J.length) toast('Перенесено вместе с соединением: линий ' + (J.length + 1));
  }
  /* муфта в середине участка чужой линии — место ответвления; возвращает номер новой точки */
  function insertJoint(id, seg, ll) {
    var o = get(id), d = lineFields(o);
    d.pts.splice(seg + 1, 0, { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), kind: 'муфта', name: '' });
    d.lay.splice(seg, 0, d.lay[seg] || 'air');
    saveLine(o, d.pts, d.lay, 'муфта для ответвления');
    return seg + 1;
  }
  /* ответвление от точки линии (или от места на линии): новая линия начинается в этой точке */
  function startBranch(id, i, seg, at) {
    var o = get(id);
    if (!o || o.type !== 'fiber') return;
    if (i == null) i = insertJoint(id, seg, at);
    else {
      var d = lineFields(o), k = d.pts[i].kind;
      if (!d.pts[i].nid && k !== 'муфта' && k !== 'кросс') { d.pts[i].kind = 'муфта'; saveLine(o, d.pts, d.lay, 'точка стала муфтой'); toast('Точка стала муфтой: от неё идёт ответвление'); }
    }
    o = get(id);
    var p = ptsOf(o)[i], lay = layOf(o);
    if (p.nid) { startLine('fiber', p.nid); return; }
    startLine('fiber', null, null, { lat: p.lat, lng: p.lng, kind: p.kind === 'кросс' ? 'кросс' : 'муфта', name: p.name || '' }, lay[Math.min(i, lay.length - 1)]);
  }
  function insertPoint(id, seg, ll) {
    var o = get(id);
    if (!o) return;
    var d = lineFields(o), lay = d.lay ? d.lay[seg] : null;
    var n = S.snap ? nearNode(map.latLngToContainerPoint(ll), 24) : null;
    var p = n ? { lat: +n.f.lat, lng: +n.f.lng, kind: 'узел', name: n.f.name || '', nid: n.id }
      : { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), kind: lay === 'ground' ? 'колодец' : 'опора', name: '' };
    if (o.type === 'radio') { delete p.kind; p.height = 15; }
    d.pts.splice(seg + 1, 0, p);
    if (d.lay) d.lay.splice(seg, 0, lay || 'air');
    saveLine(o, d.pts, d.lay, 'трасса изменена');
    toast('Точка добавлена');
  }
  function deletePoint(id, i) {
    var o = get(id);
    if (!o) return;
    var d = lineFields(o);
    if (d.pts.length <= 2) { askDelete(id); return; }
    d.pts.splice(i, 1);
    if (d.lay) { if (i === 0) d.lay.shift(); else d.lay.splice(i - 1, 1); }
    saveLine(o, d.pts, d.lay, 'трасса изменена');
    view = { k: 'card', id: id };
    renderView();
    toast('Точка удалена');
  }

  function showPoint(id, i) { sel = { type: 'line', id: id }; view = { k: 'pt', id: id, i: i }; refresh(); }
  function cap(t) { t = String(t || ''); return t ? t[0].toUpperCase() + t.slice(1) : t; }
  function renderPoint(id, i) {
    var o = get(id);
    if (!o) { closeSheet(); return; }
    var pts = ptsOf(o), p = pts[i];
    if (!p) { view = { k: 'card', id: id }; renderCard(id); return; }
    var lay = layOf(o), edit = mode === 'edit', fib = o.type === 'fiber', J = fib && !p.nid ? joined(id, i) : [];
    var title = p.nid ? 'Узел «' + nodeName(p.nid) + '»' : fib ? cap(p.kind || 'точка') + (p.name ? ' ' + p.name : '') : 'Точка ' + (i ? 'B' : 'A');
    var body = openSheet(title, view), html = '';
    html += '<div class="item" data-go="' + esc(o.id) + '">' + (fib ? I.fiber : I.radio).replace('<svg', '<svg width="20" height="20"') +
      '<div class="tx"><div><b>' + esc(o.f.name || '') + '</b></div><div class="muted">точка ' + (i + 1) + ' из ' + pts.length + ' · ' + TYPE_NAME[o.type] + '</div></div></div>';
    if (p.nid && edit) html += '<p class="muted">Точка стоит на узле. Перетащите её, чтобы отвязать от узла.</p>';
    if (edit && fib && !p.nid) {
      html += '<div class="chips tight scroll">' + PT_KINDS.map(function (k) {
        return '<button type="button" class="chip' + (p.kind === k ? ' on' : '') + '" data-k="' + k + '">' + ptSvg(k, 16) + k + '</button>';
      }).join('') + '</div>';
      html += '<div style="display:flex;gap:8px;margin-top:8px"><input id="apPtName" value="' + esc(p.name || '') + '" placeholder="номер или имя, например: оп. 12, М-3">' +
        '<button type="button" class="b t" id="apPtSave" style="flex:0 0 auto">Сохранить</button></div>';
    }
    // участки по обе стороны точки — одной строкой каждый
    function layRow(txt, cur, w) {
      return '<div class="lrow"><span class="muted">' + txt + '</span>' + (edit ? layChips(cur, w).replace('class="chips"', 'class="chips tight"') : '<b>' + (LAY[cur] || LAY.air).name + '</b>') + '</div>';
    }
    if (fib && i > 0) html += layRow('← от ' + i, lay[i - 1], 'segp');
    if (fib && i < pts.length - 1) html += layRow('→ до ' + (i + 2), lay[i], 'seg');
    if (J.length) html += '<div class="sec">В этой точке также</div>' + J.map(function (j) {
      var l = get(j.id), n = ptsOf(l).length;
      return '<div class="item" data-go="' + esc(l.id) + '">' + I.fiber.replace('<svg', '<svg width="20" height="20"') + '<div class="tx"><div><b>' + esc(l.f.name || '') + '</b></div><div class="muted">' +
        (j.i === 0 ? 'начало линии' : j.i === n - 1 ? 'конец линии' : 'проходит через точку') + ' · ' + len(lenOf(ptsOf(l))) + '</div></div></div>';
    }).join('');
    html += '<div class="muted" style="margin-top:8px">' + coord(p.lat, p.lng) + '</div>';
    if (edit) html += '<div class="row tool">' + (fib ? '<button type="button" class="b" data-a="branch" style="flex:1">Ответвление отсюда</button>' : '') +
      '<button type="button" class="b d" data-a="del">Удалить точку</button></div>';
    body.innerHTML = html;
    body.querySelectorAll('[data-k]').forEach(function (b) {
      b.onclick = function () { var d = lineFields(o); d.pts[i].kind = b.getAttribute('data-k'); saveLine(o, d.pts, d.lay, 'точка изменена'); };
    });
    function saveName() { var d = lineFields(o); d.pts[i].name = $('apPtName').value.trim(); saveLine(o, d.pts, d.lay, 'точка изменена'); toast('Сохранено'); }
    if ($('apPtSave')) { $('apPtSave').onclick = saveName; $('apPtName').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveName(); }); }
    body.querySelectorAll('[data-lay]').forEach(function (b) {
      b.onclick = function () {
        var d = lineFields(o), idx = b.getAttribute('data-w') === 'segp' ? i - 1 : i;
        d.lay[idx] = b.getAttribute('data-lay');
        saveLine(o, d.pts, d.lay, 'прокладка изменена');
      };
    });
    body.querySelectorAll('[data-go]').forEach(function (it) { it.onclick = function () { var g = it.getAttribute('data-go'); sel = { type: 'line', id: g }; showCard(g); refresh(); }; });
    bind(body, { del: function () { deletePoint(id, i); }, branch: function () { startBranch(id, i); } });
  }
  function layChips(cur, w) {
    return '<div class="chips">' + ['air', 'ground'].map(function (k) {
      return '<button type="button" class="chip' + (cur === k ? ' on' : '') + '" data-lay="' + k + '" data-w="' + w + '"><span class="ln" style="border-color:' + LAY[k].color +
        (LAY[k].dash ? ';border-top-style:dashed' : '') + '"></span>' + LAY[k].name + '</button>';
    }).join('') + '</div>';
  }

  function showLineMenu(id, seg, at) { view = { k: 'line', id: id, seg: seg, at: at }; renderView(); }
  function renderLineMenu(id, seg, at) {
    var o = get(id);
    if (!o) { closeSheet(); return; }
    var body = openSheet(o.f.name || TYPE_NAME[o.type], view), lay = layOf(o), html = '';
    if (o.type === 'fiber') html += '<button type="button" class="mi" data-a="ins">' + I.ins + 'Вставить точку здесь</button>' +
      '<button type="button" class="mi" data-a="branch">' + I.branch + 'Ответвление отсюда (муфта)</button>';
    if (o.type === 'fiber') html += '<div class="sec">Этот участок (' + (seg + 1) + '–' + (seg + 2) + ')</div>' + layChips(lay[seg], 'seg');
    html += '<button type="button" class="mi" data-a="cont">' + I.cont + 'Продолжить линию</button>' +
      '<button type="button" class="mi" data-a="name">' + I.edit + 'Название и примечание</button>' +
      '<button type="button" class="mi" data-a="info">' + I.list + 'Сведения и все точки</button>' +
      '<button type="button" class="mi d" data-a="del">' + I.trash + 'Удалить линию</button>';
    body.innerHTML = html;
    body.querySelectorAll('[data-lay]').forEach(function (b) {
      b.onclick = function () { var d = lineFields(o); d.lay[seg] = b.getAttribute('data-lay'); saveLine(o, d.pts, d.lay, 'прокладка изменена'); toast('Участок: ' + LAY[d.lay[seg]].name); };
    });
    bind(body, {
      ins: function () { insertPoint(id, seg, at); showCard(id); },
      branch: function () { startBranch(id, null, seg, at); },
      cont: function () { startLine(o.type, null, id); },
      name: function () { editLine(id); },
      info: function () { showCard(id); },
      del: function () { askDelete(id); }
    });
  }
  function editLine(id) {
    var o = get(id);
    if (!o) return;
    var fib = o.type === 'fiber';
    form(cap(TYPE_NAME[o.type]), [
      { key: 'name', label: 'Название', value: o.f.name, required: true }
    ].concat(fib ? [
      { key: 'fibers', label: 'Число волокон', value: o.f.fibers, placeholder: 'например: 16' },
      { key: 'cable', label: 'Марка кабеля', value: o.f.cable, placeholder: 'например: ОКСН-16' }
    ] : []).concat([
      { key: 'note', label: 'Примечание', type: 'textarea', value: o.f.note }
    ]).concat(whoField()), 'Сохранить', function (v) {
      var f = { name: v.name, note: v.note };
      if (fib) { f.fibers = v.fibers; f.cable = v.cable; }
      if (v.name !== o.f.name) f.autoName = false;
      put(id, o.type, f);
    });
  }

  // ================================================================== нанесение: перекрестие

  function crossPoint() {
    var r = map.getContainer().getBoundingClientRect(), left = Math.max(0, panelW() - r.left);
    return L.point(left + (r.width - left) / 2, (r.height - sheetH()) / 2);
  }
  function crossLatLng() { return map.containerPointToLatLng(crossPoint()); }
  var snap = null;         // к чему прилипло перекрестие: {node} | {pt: {id, i, p}} | {seg: {id, seg, at}}
  function snapLL() {
    if (!snap) return crossLatLng();
    if (snap.node) return L.latLng(snap.node.f.lat, snap.node.f.lng);
    if (snap.pt) return L.latLng(snap.pt.p.lat, snap.pt.p.lng);
    return map.containerPointToLatLng(snap.seg.at);
  }
  function placeCross() {
    if (!tool || tool.kind === 'pick') { cross.classList.remove('show'); return; }
    var r = map.getContainer().getBoundingClientRect(), p = crossPoint(), label = '', btn = 'Поставить точку';
    cross.style.left = (r.left + p.x) + 'px';
    cross.style.top = (r.top + p.y) + 'px';
    cross.classList.add('show');
    snap = null;
    if (tool.kind === 'line' && S.snap) {
      var n = nearNode(p, 28), q, sg;
      if (n) snap = { node: n };
      else if (tool.type === 'fiber') {
        if ((q = nearPt(p, 22, tool.id, null, true))) snap = { pt: q };
        else if ((sg = nearSeg(p, 12, tool.id, true))) snap = { seg: sg };
      }
    }
    if (snap && snap.node) {
      label = 'узел «' + (snap.node.f.name || '') + '»';
      btn = tool.pts.length ? 'Завершить на «' + (snap.node.f.name || 'узле') + '»' : 'Начать от «' + (snap.node.f.name || 'узла') + '»';
    } else if (snap && snap.pt) {
      label = (snap.pt.p.kind || 'точка') + (snap.pt.p.name ? ' ' + snap.pt.p.name : '') + ' · ' + (get(snap.pt.id).f.name || 'линия');
      btn = 'Поставить на ' + (snap.pt.p.kind === 'муфта' ? 'муфту' : snap.pt.p.kind === 'опора' ? 'опору' : (snap.pt.p.kind || 'точку')) + ' этой линии';
    } else if (snap && snap.seg) {
      label = 'линия «' + (get(snap.seg.id).f.name || '') + '»';
      btn = tool.pts.length ? 'Присоединить к линии (муфта)' : 'Начать от линии (муфта)';
    }
    cross.classList.toggle('snap', !!snap);
    cross.querySelector('span').textContent = label;
    drawRubber();
    var add = $('apAddPt');
    if (add && tool.kind === 'line') add.textContent = btn;
  }
  map.on('move', placeCross);

  var rubber = null;
  function drawRubber() {
    if (!tool || tool.kind !== 'line' || !tool.pts.length) { if (rubber) { toolLayer.removeLayer(rubber); rubber = null; } return; }
    var last = tool.pts[tool.pts.length - 1], c = snapLL();
    var style = tool.type === 'radio' ? { color: '#1565c0', dashArray: '6 6' } : { color: LAY[tool.nextLay].color, dashArray: '4 6' };
    if (!rubber) rubber = L.polyline([[last.lat, last.lng], c], L.extend({ weight: 3, opacity: .8, interactive: false }, style)).addTo(toolLayer);
    else { rubber.setLatLngs([[last.lat, last.lng], c]); rubber.setStyle(style); }
  }
  function drawTool() {
    toolLayer.clearLayers();
    rubber = null;
    if (!tool || tool.kind !== 'line') return;
    if (tool.pts.length === 1) {
      var p = tool.pts[0];
      L.marker([p.lat, p.lng], { icon: handleIcon(p, tool.type), interactive: false }).addTo(toolLayer);
    }
    drawRubber();
  }

  function startTool(t) {
    if (tool) finishTool();
    tool = t;
    map.doubleClickZoom.disable();
    document.body.classList.add('ap-tool');
    sel = t.id ? { type: 'line', id: t.id } : null;
    view = { k: 'tool' };
    refresh();
    placeCross();
  }
  function startNode() { startTool({ kind: 'node' }); }
  /* новая линия (от узла fromId, если задан) или продолжение линии contId */
  function startLine(type, fromId, contId, fromPt, lay) {
    var t = { kind: 'line', type: type, id: null, pts: [], lay: [], nextLay: lay === 'ground' ? 'ground' : 'air', nextKind: lay === 'ground' ? 'колодец' : 'опора' };
    if (contId) {
      var o = get(contId);
      if (!o) return;
      t.id = o.id; t.type = o.type; t.pts = copy(ptsOf(o)); t.lay = o.type === 'fiber' ? layOf(o) : [];
      if (t.lay.length) { t.nextLay = t.lay[t.lay.length - 1]; t.nextKind = t.nextLay === 'ground' ? 'колодец' : 'опора'; }
      var last = t.pts[t.pts.length - 1];
      if (last) centerAt(L.latLng(last.lat, last.lng));
    }
    if (fromId) {
      var n = get(fromId);
      if (n) { t.pts.push(nodePt(n, type)); centerAt(L.latLng(n.f.lat, n.f.lng)); }
    }
    if (fromPt) { t.pts.push(copy(fromPt)); centerAt(L.latLng(fromPt.lat, fromPt.lng)); }
    startTool(t);
  }
  function nodePt(n, type) {
    var p = { lat: +n.f.lat, lng: +n.f.lng, kind: 'узел', name: n.f.name || '', nid: n.id };
    if (type === 'radio') { delete p.kind; p.height = 15; }
    return p;
  }
  function finishTool() {
    var t = tool;
    if (!t) return;
    tool = null;
    map.doubleClickZoom.enable();
    document.body.classList.remove('ap-tool');
    cross.classList.remove('show');
    toolLayer.clearLayers();
    rubber = null;
    if (t.kind === 'line') {
      if (t.id && t.pts.length < 2) { removeObj(t.id); toast('Линия из одной точки не сохранена'); }
      if (t.id && get(t.id)) { sel = { type: 'line', id: t.id }; view = { k: 'card', id: t.id }; refresh(); fitPts(ptsOf(get(t.id))); return; }
    }
    sel = null; view = null;
    sheet.classList.remove('show');
    sizeChanged();
    refresh();
  }

  var lastTap = 0, lastTapPt = null;
  function toolTap(ll, h) {
    if (!S.tap) { toast('Двигайте карту и нажмите кнопку — нажатия по карте выключены в настройках'); return; }
    var tp = map.latLngToContainerPoint(ll);
    if (Date.now() - lastTap < 350 && lastTapPt && tp.distanceTo(lastTapPt) < 30) return;      // двойное касание — одна точка
    lastTap = Date.now(); lastTapPt = tp;
    if (tool.kind === 'node') { var t = ll; finishTool(); newNode(t); return; }
    if (tool.kind === 'line') {
      var hn = h && h.type === 'node' ? get(h.id) : null, ho = h && h.type === 'pt' ? get(h.id) : null;
      if (hn) addPoint(L.latLng(hn.f.lat, hn.f.lng), hn);
      else if (ho && ho.id !== tool.id && ho.type === 'fiber' && tool.type === 'fiber' && !ptsOf(ho)[h.i].nid) addPoint(ll, null, { pt: { id: ho.id, i: h.i, p: ptsOf(ho)[h.i] } });
      else addPoint(ll, null);
    }
  }
  /* join — точка встаёт на точку другой линии ({pt}) или на саму линию ({seg}: там появится муфта) */
  function addPoint(ll, node, join) {
    var t = tool;
    if (!t || t.kind !== 'line') return;
    if (!node && !join && S.snap) node = nearNode(map.latLngToContainerPoint(ll), 24);
    var p, jl = null, end = false;
    if (node) p = nodePt(node, t.type);
    else if (join && t.type === 'fiber') {
      var jp = join.pt;
      if (join.seg) {
        var ni = insertJoint(join.seg.id, join.seg.seg, map.containerPointToLatLng(join.seg.at));
        jp = { id: join.seg.id, i: ni, p: ptsOf(get(join.seg.id))[ni] };
      }
      jl = get(jp.id);
      p = { lat: jp.p.lat, lng: jp.p.lng, kind: jp.p.kind || 'муфта', name: jp.p.name || '' };
      end = p.kind === 'муфта' || p.kind === 'кросс';
    } else p = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), kind: t.nextKind, name: '' };
    if (t.type === 'radio' && !node) { delete p.kind; p.height = 15; }
    var last = t.pts[t.pts.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-7 && Math.abs(last.lng - p.lng) < 1e-7) { toast('Точка уже стоит здесь — сдвиньте карту'); return; }
    if (t.pts.length) t.lay.push(t.nextLay);
    t.pts.push(p);
    persistTool();
    if (t.type === 'radio' && t.pts.length >= 2) { toast('Радиолиния: ' + len(lenOf(t.pts))); finishTool(); return; }
    if (node && t.pts.length >= 2) { toast('Линия доведена до узла «' + (node.f.name || '') + '»'); finishTool(); return; }
    if (jl && end && t.pts.length >= 2) { toast('Линия присоединена к «' + (jl.f.name || '') + '»'); finishTool(); return; }
    if (jl) toast(end ? 'Начало — от линии «' + (jl.f.name || '') + '»' : 'Общая точка с линией «' + (jl.f.name || '') + '»');
    renderView();
  }
  function persistTool() {
    var t = tool;
    if (t.pts.length < 2) { drawTool(); return; }
    var o = t.id ? get(t.id) : null;
    if (!o) {
      var f = { name: autoName(t.type, t.pts), autoName: true, dist: lenOf(t.pts), from: t.pts[0].nid || '', to: t.pts[t.pts.length - 1].nid || '' };
      if (t.type === 'radio') f.points = copy(t.pts); else { f.fnodes = copy(t.pts); f.lay = t.lay.slice(); }
      o = put(null, t.type, f);
      t.id = o.id;
      sel = { type: 'line', id: o.id };
      refresh();
    } else saveLine(o, copy(t.pts), t.type === 'fiber' ? t.lay.slice() : null, 'трасса изменена');
  }
  function undoPoint() {
    var t = tool;
    if (!t || !t.pts.length) return;
    t.pts.pop();
    if (t.lay.length >= t.pts.length && t.lay.length) t.lay.pop();
    if (t.id && t.pts.length >= 2) persistTool();
    else if (t.id && t.pts.length < 2) { removeObj(t.id); t.id = null; sel = null; refresh(); }
    else drawTool();
    renderView();
  }

  function renderTool() {
    var t = tool;
    if (!t) return;
    var body, html = '';
    if (t.kind === 'node') {
      body = openSheet('Новый узел', view);
      html = '<p class="muted">Двигайте карту, чтобы перекрестие встало на место узла, или просто нажмите на это место.</p>' +
        btnRow([['place', 'Поставить узел здесь', 'big']]) + btnRow([['cancel', 'Отмена', 't']]);
      body.innerHTML = html;
      bind(body, { place: function () { var ll = crossLatLng(); finishTool(); newNode(ll); }, cancel: finishTool });
      return;
    }
    var o = t.id ? get(t.id) : null, name = o ? o.f.name : (t.type === 'radio' ? 'Новая радиолиния' : 'Новая линия ВОЛС');
    body = openSheet(name, view);
    html = '<div class="muted">Точек: <b>' + t.pts.length + '</b> · ' + len(lenOf(t.pts)) +
      (t.pts.length ? '' : ' · двигайте карту — точка встаёт в перекрестие, или нажмите на место') + '</div>';
    if (t.type === 'fiber') {
      html += '<div class="chips tight">' + layChips(t.nextLay, 'next').replace(/^<div class="chips">|<\/div>$/g, '') + '</div>' +
        '<div class="chips tight scroll">' + PT_KINDS.map(function (k) {
          return '<button type="button" class="chip' + (t.nextKind === k ? ' on' : '') + '" data-k="' + k + '">' + ptSvg(k, 16) + k + '</button>';
        }).join('') + '</div>';
    }
    html += '<div class="row tool"><button type="button" class="b t" data-a="undo" title="Убрать последнюю точку">' + I.undo.replace('<svg', '<svg width="20" height="20"') + '</button>' +
      '<button type="button" class="b" id="apAddPt" style="flex:1">Поставить точку</button>' +
      '<button type="button" class="b t" data-a="done">Готово</button></div>';
    body.innerHTML = html;
    $('apAddPt').onclick = function () { var sn = snap; addPoint(snapLL(), sn && sn.node, sn && !sn.node ? sn : null); };
    body.querySelector('[data-a=undo]').disabled = !t.pts.length;
    bind(body, { undo: undoPoint, done: finishTool });
    body.querySelectorAll('[data-lay]').forEach(function (b) {
      b.onclick = function () { t.nextLay = b.getAttribute('data-lay'); t.nextKind = t.nextLay === 'ground' ? 'колодец' : 'опора'; renderTool(); drawRubber(); };
    });
    body.querySelectorAll('[data-k]').forEach(function (b) { b.onclick = function () { t.nextKind = b.getAttribute('data-k'); renderTool(); }; });
    placeCross();
  }

  // ================================================================== «+» — добавить

  function showAdd() {
    view = { k: 'add' };
    var body = openSheet('Добавить', view);
    body.innerHTML = '<button type="button" class="mi" data-a="node">' + I.node + 'Узел</button>' +
      '<button type="button" class="mi" data-a="fiber">' + I.fiber + 'Линия ВОЛС</button>' +
      '<button type="button" class="mi" data-a="radio">' + I.radio + 'Радиолиния</button>' +
      '<p class="muted">Линию удобно начинать от узла: нажмите на узел → «ВОЛС отсюда».</p>';
    bind(body, { node: startNode, fiber: function () { startLine('fiber'); }, radio: function () { startLine('radio'); } });
  }

  // ================================================================== поиск и список

  var query = '', filter = 'all';
  function showSearch() {
    view = { k: 'search' };
    var body = openSheet('Поиск', view);
    var c = counts(db);
    body.innerHTML = '<input id="apQ" type="search" placeholder="Название, адрес, примечание" value="' + esc(query) + '">' +
      '<div class="chips">' + [['all', 'Всё'], ['node', 'Узлы ' + c.node], ['fiber', 'ВОЛС ' + c.fiber], ['radio', 'Радио ' + c.radio], ['авария', 'Аварии'], ['работы', 'Работы']].map(function (x) {
        return '<button type="button" class="chip' + (filter === x[0] ? ' on' : '') + '" data-f="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div><div id="apList"></div>';
    $('apQ').addEventListener('input', function () { query = this.value.trim().toLowerCase(); renderList(); });
    body.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { filter = b.getAttribute('data-f'); showSearch(); }; });
    renderList();
    if (pc) $('apQ').focus();
  }
  function renderList() {
    var list = alive().filter(function (o) {
      if (filter === 'node' || filter === 'fiber' || filter === 'radio') { if (o.type !== filter) return false; }
      else if (filter !== 'all' && (o.type !== 'node' || o.f.state !== filter)) return false;
      return !query || [o.f.name, o.f.addr, o.f.note, o.f.kind].join(' ').toLowerCase().indexOf(query) >= 0;
    }).sort(function (a, b) {
      var ord = { node: 0, fiber: 1, radio: 2 };
      return ord[a.type] - ord[b.type] || String(a.f.name || '').localeCompare(String(b.f.name || ''), 'ru', { numeric: true });
    });
    var box = $('apList');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<p class="muted">' + (alive().length ? 'Ничего не найдено.' : 'Сеть пуста. Включите «Редактирование» и нажмите «+».') + '</p>';
      return;
    }
    box.innerHTML = list.slice(0, 400).map(function (o) {
      var ico, sub;
      if (o.type === 'node') { ico = shapeSvg(o.f.kind, STATES[o.f.state] || '#455a64', 20); sub = esc(o.f.kind || '') + ' · ' + esc(o.f.state || '') + (o.f.addr ? ' · ' + esc(o.f.addr) : ''); }
      else { ico = (o.type === 'radio' ? I.radio : I.fiber).replace('<svg', '<svg width="20" height="20"'); sub = TYPE_NAME[o.type] + ' · ' + len(lenOf(ptsOf(o))); }
      return '<div class="item" data-go="' + esc(o.id) + '">' + ico + '<div class="tx"><div><b>' + esc(o.f.name || 'без названия') + '</b></div><div class="muted">' + sub + '</div></div></div>';
    }).join('');
    box.querySelectorAll('[data-go]').forEach(function (it) { it.onclick = function () { focusObj(it.getAttribute('data-go')); }; });
  }
  $('apFind').onclick = function () { if (view && view.k === 'search') closeSheet(); else showSearch(); };

  function focusObj(id) {
    var o = get(id);
    if (!o) return;
    sel = { type: o.type === 'node' ? 'node' : 'line', id: id };
    showCard(id);
    refresh();
    if (o.type === 'node') centerAt(L.latLng(o.f.lat, o.f.lng), Math.max(map.getZoom(), 15));
    else fitPts(ptsOf(o));
  }

  // ================================================================== карта: центр с учётом карточки, вся сеть

  function pads() {
    var tl = [40, 40], br = [40, 40], r = map.getContainer().getBoundingClientRect();
    if (panelW()) tl[0] = panelW() - r.left + 30;
    if (sheetH()) br[1] = Math.min(sheetH() + 30, r.height * 0.7);
    return { paddingTopLeft: tl, paddingBottomRight: br };
  }
  function centerAt(ll, z) {
    if (z != null) map.setView(ll, z, { animate: false });
    var p = map.latLngToContainerPoint(ll), c = crossPoint();
    map.panBy([p.x - c.x, p.y - c.y], { animate: false });
  }
  function fitPts(pts) {
    if (!pts.length) return;
    if (pts.length === 1) { centerAt(L.latLng(pts[0].lat, pts[0].lng), 16); return; }
    map.fitBounds(pts.map(function (p) { return [p.lat, p.lng]; }), L.extend({ maxZoom: 17 }, pads()));
  }
  function fitAll() {
    var b = L.latLngBounds([]);
    alive().forEach(function (o) {
      if (o.type === 'node') b.extend([o.f.lat, o.f.lng]);
      else ptsOf(o).forEach(function (p) { b.extend([p.lat, p.lng]); });
    });
    if (!b.isValid()) { toast('Сеть пока пуста'); return; }
    map.fitBounds(b, L.extend({ maxZoom: 16 }, pads()));
  }

  // ================================================================== «Где я»

  var me = null, meCircle = null;
  function showMe(lat, lng, acc) {
    var ll = L.latLng(lat, lng);
    if (!me) {
      me = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="ap-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1200 }).addTo(map);
      meCircle = L.circle(ll, { radius: acc || 0, color: '#1e88e5', weight: 1, fillOpacity: .1, interactive: false }).addTo(map);
    } else { me.setLatLng(ll); meCircle.setLatLng(ll).setRadius(acc || 0); }
    centerAt(ll, Math.max(map.getZoom(), 16));
    toast('Вы здесь' + (acc ? ' (точность ±' + Math.round(acc) + ' м)' : '') + (tool ? '. Перекрестие — на вашем месте' : ''));
  }
  window.__kartaGeo = function (lat, lng, acc, err) { if (err) toast('Место не определено: ' + err); else showMe(lat, lng, acc); };
  function locate() {
    toast('Определяю местоположение…');
    if (android && android.locate) { android.locate(); return; }
    if (!navigator.geolocation) { toast('Это устройство не сообщает местоположение'); return; }
    navigator.geolocation.getCurrentPosition(function (p) { showMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy); },
      function (e) { toast('Место не определено: ' + (e.code === 1 ? 'нет разрешения' : e.code === 3 ? 'не успели' : 'нет данных')); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }

  // ================================================================== настройки (меню «⋮»)

  function sw(on) { return '<span class="sw' + (on ? ' on' : '') + '"></span>'; }
  function renderMenu() {
    var online = $('online') && $('online').checked, dark = document.body.classList.contains('dark'), who = localStorage.getItem(WHO) || '';
    menu.innerHTML =
      '<button type="button" class="mi" data-m="file">' + I.file + 'Обмен данными (файл)</button>' +
      '<button type="button" class="mi" data-m="journal">' + I.list + 'Журнал изменений</button>' +
      '<button type="button" class="mi" data-m="offline">' + I.map + 'Карта без интернета</button>' +
      '<button type="button" class="mi" data-m="legend">' + I.node + 'Обозначения</button>' +
      '<button type="button" class="mi" data-m="help">' + I.help + 'Инструкция</button>' +
      '<hr><button type="button" class="mi" data-m="online">' + I.web + 'Карта из интернета' + sw(online) + '</button>' +
      '<button type="button" class="mi" data-m="theme">' + I.moon + 'Тёмная тема' + sw(dark) + '</button>' +
      '<hr><button type="button" class="mi" data-m="set">' + I.gear + 'Настройки</button>';
  }
  function closeMenu() { menu.classList.remove('show'); }
  $('apMenuBtn').onclick = function (e) {
    e.stopPropagation();
    if (menu.classList.contains('show')) { closeMenu(); return; }
    renderMenu(); menu.classList.add('show');
  };
  document.addEventListener('click', function (e) { if (e.target.isConnected && !menu.contains(e.target) && !e.target.closest('#apMenuBtn')) closeMenu(); });
  menu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-m]');
    if (!b) return;
    var m = b.getAttribute('data-m');
    if (m === 'file') { closeMenu(); showExchange(); }
    else if (m === 'journal') { closeMenu(); showJournal(); }
    else if (m === 'offline') { closeMenu(); showOffline(); }
    else if (m === 'online') { toggleOnline(); renderMenu(); menu.classList.add('show'); }
    else if (m === 'theme') { setS('theme', document.body.classList.contains('dark') ? 'light' : 'dark'); renderMenu(); menu.classList.add('show'); }
    else if (m === 'legend') { closeMenu(); showLegend(); }
    else if (m === 'help') { closeMenu(); showHelp(); }
    else if (m === 'set') { closeMenu(); showSettings(); }
    else if (m === 'who') {
      closeMenu();
      askWho();
    }
  });
  /* Кто работает: фамилия или мобильный расчёт. Спрашивается при первом запуске (тогда окно нельзя
   * закрыть, не ответив), подписывает изменения и входит в имя файла обмена. */
  function askWho(then, first) {
    var cur = localStorage.getItem(WHO) || '';
    openDlg('<h3>' + (first ? 'Кто работает с картой?' : 'Подпись изменений') + '</h3>' +
      '<p class="muted">Фамилия или мобильный расчёт. Так подписываются ваши изменения и называется файл, которым вы делитесь.</p>' +
      '<label for="apWho">Имя</label><input id="apWho" value="' + esc(cur) + '" placeholder="например: Карабанов" autocomplete="off">' +
      '<div class="sec">Или мобильный расчёт</div><div class="chips">' + [1, 2, 3, 4, 5, 6].map(function (n) {
        return '<button type="button" class="chip" data-mr="' + n + '">№ ' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="row"><button type="button" class="b" id="apOk">' + (first ? 'Продолжить' : 'Сохранить') + '</button>' +
      (first ? '' : '<button type="button" class="b t" id="apNo">Отмена</button>') + '</div>');
    dlgLock = !!first;
    dlg.classList.toggle('lock', dlgLock);
    var inp = $('apWho');
    function ok() {
      var v = inp.value.trim();
      if (!v) { inp.style.borderColor = 'var(--danger)'; inp.focus(); return; }
      localStorage.setItem(WHO, v);
      dlgLock = false;
      closeDlg();
      toast('Подпись: ' + v);
      if (then) then();
    }
    dlgBox.querySelectorAll('[data-mr]').forEach(function (b) { b.onclick = function () { inp.value = 'Моб.Расчет№' + b.getAttribute('data-mr'); inp.style.borderColor = ''; }; });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); });
    $('apOk').onclick = ok;
    if ($('apNo')) $('apNo').onclick = closeDlg;
    if (pc) inp.focus();
  }
  function toggleOnline() {
    $('online').click();
    toast($('online').checked ? 'Карта из интернета включена' : 'Интернет для карты выключен: офлайн-карта районов и то, что уже открывали');
  }

  function showJournal() {
    var list = db.journal.slice(0, 300);
    openDlg('<h3>Журнал изменений</h3>' + (list.length ? list.map(function (j) {
      return '<div style="border-bottom:1px solid var(--line);padding:8px 0"><b>' + esc(j.name || 'без названия') + '</b> — ' + esc(TYPE_NAME[j.type] || '') + ' ' + esc(j.what) +
        '<br><span class="muted">' + when(j.t) + ' · ' + esc(j.by || '') + '</span></div>';
    }).join('') : '<p class="muted">Пока пусто.</p>') + '<div class="row"><button type="button" class="b t" id="apNo">Закрыть</button></div>');
    $('apNo').onclick = closeDlg;
  }


  // ================================================================== карта без интернета

  var REGIONS = [{ slug: 'kherson', name: 'Херсонская область', mb: 102 }, { slug: 'zaporozhye', name: 'Запорожская область', mb: 104 },
    { slug: 'crimea', name: 'Крым', mb: 77 }];
  var MAPS_URL = 'https://github.com/Almazny26/apk_map/releases/download/maps/';
  var mapJob = null, mapPoll = 0;      // телефон: ход скачивания {state, slug, done, total, error}
  function mb(n) { return Math.round((n || 0) / 1048576) + ' МБ'; }
  function offlineOpen() { return dlg.classList.contains('show') && dlgBox.getAttribute('data-offline'); }
  function showOffline() {
    if (pc) fetch('/api/map').then(function (r) { return r.json(); }).then(function (st) { renderOffline(st.files || [], st.job); }, function () { renderOffline([], null); });
    else renderOffline(window.KartaMap ? window.KartaMap.info().files : [], mapJob);
  }
  function renderOffline(files, job) {
    var by = {}, KM = window.KartaMap, run = job && job.state === 'running' ? job : null, top = offlineOpen() ? dlgBox.scrollTop : 0;
    files.forEach(function (f) { by[f.slug] = f; });
    var html = '<h3>Карта без интернета</h3><p class="muted">Скачайте район — и схема в нём рисуется сразу, без интернета, на любом масштабе до отдельных домов.</p>';
    if (KM && !KM.info().gl) html += '<p style="color:var(--danger)">Это устройство не умеет быстро рисовать карту (нет WebGL) — офлайн-карта показана не будет.</p>';
    function row(slug, name, f, size) {
      var r = '<div class="srow"><span>' + esc(name) + '<small>' + (f ? 'загружена, ' + mb(f.size) : size ? 'около ' + size + ' МБ' : '') + '</small></span>';
      if (run && run.slug === slug) {
        var pct = run.total ? Math.floor(run.done * 100 / run.total) : 0;
        r += '<button type="button" class="b t" data-a="cancel">Отмена</button><div style="flex:1 1 100%"><div style="height:8px;border-radius:4px;background:var(--line);overflow:hidden">' +
          '<div style="height:100%;width:' + pct + '%;background:var(--accent)"></div></div><small>' + (run.total ? mb(run.done) + ' из ' + mb(run.total) + ' (' + pct + '%)' : esc(run.stage || 'подключаюсь…')) + '</small></div>';
      } else if (f) r += '<button type="button" class="b d" data-del="' + esc(slug) + '">Удалить</button>';
      else r += '<button type="button" class="b" data-dl="' + esc(slug) + '"' + (run ? ' disabled' : '') + '>Скачать</button>';
      return r + '</div>';
    }
    html += '<div class="sec">Районы — из интернета</div>' + REGIONS.map(function (g) { return row(g.slug, g.name, by[g.slug], g.mb); }).join('');
    var other = files.filter(function (f) { return !REGIONS.some(function (g) { return g.slug === f.slug; }); });
    if (other.length) html += '<div class="sec">Другие файлы карт</div>' + other.map(function (f) { return row(f.slug, f.name && f.name !== f.slug ? f.name : f.slug, f); }).join('');
    if (job && job.state === 'error') html += '<p style="color:var(--danger)">Не скачалось: ' + esc(job.error || '') + '</p>';
    html += '<div class="sec">Файл карты — с этого устройства</div><p class="muted">Файл района (.pmtiles), присланный с другого телефона или компьютера.</p>' +
      btnRow([['pick', 'Выбрать файл…', 't']]) +
      '<div class="row"><button type="button" class="b t" id="apNo">Закрыть</button></div>';
    openDlg(html);
    dlgBox.setAttribute('data-offline', '1');
    dlgBox.scrollTop = top;
    $('apNo').onclick = function () { closeDlg(); };
    function reload() { if (KM) KM.reload(function () { if (offlineOpen()) showOffline(); }); }
    function post(body) { return fetch('/api/map', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    dlgBox.querySelectorAll('[data-dl]').forEach(function (b) {
      b.onclick = function () {
        var slug = b.getAttribute('data-dl');
        if (pc) post({ download: slug }).then(function () { pollMap(); });
        else if (android && android.mapDownload) {
          if (android.mapDownload(slug, MAPS_URL + slug + '.pmtiles')) { mapJob = { state: 'running', slug: slug, done: 0, total: 0 }; showOffline(); }
          else toast('Подождите: уже идёт другая загрузка');
        } else toast('Скачивание работает в приложении на телефоне и в программе на компьютере');
      };
    });
    dlgBox.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        var slug = b.getAttribute('data-del');
        confirmDlg('Удалить эту офлайн-карту?', 'Удалить', function () {
          if (pc) post({ delete: slug }).then(reload).then(function () { showOffline(); });
          else { if (android && android.mapDelete) android.mapDelete(slug); if (KM) KM.reload(function () { showOffline(); }); }
          toast('Офлайн-карта удалена');
        });
      };
    });
    bind(dlgBox, {
      cancel: function () { if (pc) post({ cancel: true }); else if (android && android.mapCancel) android.mapCancel(); toast('Отменяю…'); },
      pick: function () { if (android && android.openFile) android.openFile(); else if (pc) mapPicker.click(); }
    });
    clearTimeout(mapPoll);
    if (pc && run) mapPoll = setTimeout(pollMap, 1200);
  }
  var wasRunning = false;
  function pollMap() {
    fetch('/api/map').then(function (r) { return r.json(); }).then(function (st) {
      var running = st.job && st.job.state === 'running';
      if (wasRunning && !running) {
        if (window.KartaMap) window.KartaMap.reload();
        if (st.job.state === 'done') toast('Офлайн-карта скачана: ' + (st.job.name || ''));
      }
      wasRunning = running;
      if (offlineOpen()) renderOffline(st.files || [], st.job);
      else if (running) mapPoll = setTimeout(pollMap, 3000);
    });
  }
  // компьютер: файл карты с диска уходит в программу
  var mapPicker = el('input');
  mapPicker.type = 'file'; mapPicker.accept = '.pmtiles'; mapPicker.style.display = 'none';
  document.body.appendChild(mapPicker);
  mapPicker.addEventListener('change', function () {
    var f = mapPicker.files && mapPicker.files[0];
    mapPicker.value = '';
    if (!f) return;
    toast('Копирую файл карты (' + mb(f.size) + ')…');
    fetch('/api/mapupload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.error) { toast('Карта не загружена: ' + r.error); return; }
      if (window.KartaMap) window.KartaMap.reload(function () { toast('Офлайн-карта загружена'); if (offlineOpen()) showOffline(); });
    }, function () { toast('Карта не загружена'); });
  });
  // телефон: ход и итог скачивания или копирования файла карты
  window.__kartaMapProgress = function (slug, done, total) {
    mapJob = { state: 'running', slug: slug, done: done, total: total };
    if (offlineOpen()) showOffline(); else if (!total) toast('Копирую карту: ' + mb(done) + '…');
  };
  window.__kartaMap = function (ok, msg) {
    mapJob = ok || msg === 'отменено' ? null : { state: 'error', error: msg };
    if (window.KartaMap) window.KartaMap.reload(function () { if (offlineOpen()) showOffline(); });
    toast(ok ? 'Офлайн-карта загружена' : msg === 'отменено' ? 'Загрузка отменена' : 'Карта не загружена: ' + msg);
  };

  // ================================================================== обмен файлами

  /* Имя файла: кто и когда — «Карабанов_13.11.26_19.44.json», «Моб.Расчет№2_13.11.26_19.44.json».
   * Время через точку: двоеточие в именах файлов Windows и Android не допускают. */
  function fileName() {
    var d = new Date(), who = author().replace(/[\\\/:*?"<>|\r\n]+/g, '').trim().replace(/\s+/g, '_') || 'Карта';
    return who + '_' + two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2) + '_' + two(d.getHours()) + '.' + two(d.getMinutes()) + '.json';
  }
  function pack() {
    return { format: FORMAT, kind: 'fresnel', version: 3, app: 'Карта сети', created: Date.now(), by: author(),
      source: android ? 'Телефон' : pc ? 'Компьютер' : 'Браузер', data: { net: copy(db) } };
  }
  function check(p) {
    if (!p || p.format !== FORMAT) return 'Это не файл программы «Карта сети».';
    if (!p.data || typeof p.data !== 'object') return 'Файл повреждён.';
    if (!valid(p.data.net)) return 'В этом файле нет карты сети (он от старой версии программы).';
    return null;
  }
  var FIELD = { name: 'название', kind: 'вид', state: 'состояние', addr: 'адрес', note: 'примечание', lat: 'место', lng: 'место',
    fnodes: 'трасса', points: 'трасса', lay: 'прокладка', fibers: 'волокна', cable: 'кабель' };
  /* что изменится, если моя карта станет как в файле */
  function diff(inc) {
    var mine = {}, theirs = {}, res = { add: [], del: [], ch: [] };
    alive().forEach(function (o) { mine[o.id] = o; });
    Object.keys(inc.objs).forEach(function (k) { var o = inc.objs[k]; if (o && o.f && !o.f.deleted) theirs[k] = o; });
    Object.keys(theirs).forEach(function (k) {
      var t = theirs[k], m = mine[k];
      if (!m) { res.add.push(t); return; }
      var fs = {};
      Object.keys(FIELD).forEach(function (f) { if (!same(m.f[f], t.f[f]) && (m.f[f] != null || t.f[f] != null)) fs[FIELD[f]] = 1; });
      if (Object.keys(fs).length) res.ch.push({ o: t, fields: Object.keys(fs) });
    });
    Object.keys(mine).forEach(function (k) { if (!theirs[k]) res.del.push(mine[k]); });
    return res;
  }
  /* «Добавить новое»: чего у меня нет — добавляется; что есть у обоих — берётся более поздняя правка
   * каждого поля; моё не удаляется. dry — только посчитать. */
  function merge(inc, dry) {
    var res = { add: [], ch: [] };
    Object.keys(inc.objs).forEach(function (k) {
      var t = inc.objs[k], m = db.objs[k];
      if (!t || !t.f || t.f.deleted) return;
      if (!m || (m.f.deleted && (t.t || 0) > (m.t || 0))) { res.add.push(t); if (!dry) db.objs[k] = copy(t); return; }
      if (m.f.deleted) return;
      var fs = {}, tf = t.ft || {};
      Object.keys(t.f).forEach(function (f) {
        if (f === 'deleted' || same(m.f[f], t.f[f]) || (tf[f] || 0) <= ((m.ft || {})[f] || 0)) return;
        fs[FIELD[f] || f] = 1;
        if (!dry) { m.f[f] = copy(t.f[f]); if (!m.ft) m.ft = {}; m.ft[f] = tf[f]; }
      });
      if (Object.keys(fs).length) { res.ch.push({ o: t, fields: Object.keys(fs) }); if (!dry) { m.t = Math.max(m.t || 0, t.t || 0); m.by = t.by || m.by; } }
    });
    return res;
  }
  function objLine(o, extra) {
    return '<div style="padding:4px 0">' + esc(TYPE_NAME[o.type]) + ' <b>' + esc(o.f.name || 'без названия') + '</b>' + (extra ? ' <span class="muted">— ' + esc(extra) + '</span>' : '') + '</div>';
  }

  var picker = el('input');
  picker.type = 'file'; picker.accept = '.json,application/json'; picker.style.display = 'none';
  document.body.appendChild(picker);
  picker.addEventListener('change', function () {
    var f = picker.files && picker.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { received(f.name, String(r.result)); };
    r.readAsText(f, 'utf-8');
    picker.value = '';
  });

  var exNote = '';
  function showExchange() {
    var c = counts(db), prev = localStorage.getItem(PREV);
    openDlg('<h3>Обмен данными</h3><p class="muted">Ваша карта: узлов ' + c.node + ', линий ВОЛС ' + c.fiber + ', радиолиний ' + c.radio + '.</p>' +
      '<div class="sec">Отправить свою карту</div>' +
      (android ? btnRow([['share', 'Поделиться файлом'], ['save', 'Сохранить в файл', 't']]) : btnRow([['save', 'Сохранить в файл']])) +
      '<div class="sec">Загрузить карту из файла</div><p class="muted">Покажу, что изменится, и спрошу: добавить новое к вашей карте или заменить её целиком.</p>' +
      btnRow([['open', 'Открыть файл…', 't']]) +
      (prev ? '<div class="sec">Ошиблись?</div>' + btnRow([['undo', 'Вернуть карту, какой она была до загрузки', 'd']]) : '') +
      (exNote ? '<p class="muted" style="color:var(--text)">' + exNote + '</p>' : '') +
      '<div class="row"><button type="button" class="b t" id="apNo">Закрыть</button></div>');
    exNote = '';
    $('apNo').onclick = closeDlg;
    bind(dlgBox, {
      share: function () { exNote = android.shareText(fileName(), JSON.stringify(pack())) ? 'Выберите, куда отправить файл.' : 'Не удалось подготовить файл.'; showExchange(); },
      save: function () {
        var text = JSON.stringify(pack());
        if (android) android.saveText(fileName(), text);
        else {
          var a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = fileName();
          document.body.appendChild(a); a.click(); a.remove();
          exNote = 'Файл сохранён в папку «Загрузки».'; showExchange();
        }
      },
      open: function () { if (android) android.openFile(); else picker.click(); },
      undo: function () {
        confirmDlg('Вернуть карту, какой она была до загрузки файла?', 'Вернуть', function () {
          var p = localStorage.getItem(PREV);
          if (!p) return;
          try { var d = JSON.parse(p); if (valid(d.net)) { db = d.net; save(); localStorage.removeItem(PREV); select(null); closeSheet(); refresh(); toast('Карта возвращена'); } } catch (e) { toast('Не удалось вернуть'); }
        });
      }
    });
  }
  function received(name, text) {
    var p = null;
    try { p = JSON.parse(text); } catch (e) { p = null; }
    var problem = check(p);
    if (problem) { exNote = esc(problem); showExchange(); return; }
    var d = diff(p.data.net), mg = merge(p.data.net, true), c = counts(p.data.net), html = '<h3>Загрузить карту из файла?</h3>' +
      '<p class="muted">' + esc(name || 'файл') + (p.created ? ' · ' + when(p.created) : '') + (p.by ? ' · ' + esc(p.by) : '') +
      '<br>В файле: узлов ' + c.node + ', линий ВОЛС ' + c.fiber + ', радиолиний ' + c.radio + '.</p>';
    if (!d.add.length && !d.del.length && !d.ch.length) html += '<p><b>Ваша карта уже такая же, как в файле.</b></p>';
    else {
      html += '<div class="srow"><span><b>Добавить новое</b><small>добавится ' + mg.add.length + ', обновится ' + mg.ch.length + ' (где в файле правка новее); ваше не удаляется</small></span>' +
        '<button type="button" class="b" data-a="merge">Добавить</button></div>' +
        '<div class="srow"><span><b>Заменить всю карту</b><small>станет точно как в файле: добавится ' + d.add.length + ', изменится ' + d.ch.length + ', удалится ' + d.del.length + '</small></span>' +
        '<button type="button" class="b d" data-a="replace">Заменить</button></div>';
      html += '<div class="sec">Отличия файла от вашей карты</div>';
      if (d.add.length) html += '<p style="margin:6px 0 2px;color:var(--ok)"><b>Нет у вас: ' + d.add.length + '</b></p>' + d.add.slice(0, 60).map(function (o) { return objLine(o); }).join('');
      if (d.ch.length) html += '<p style="margin:10px 0 2px;color:var(--accent)"><b>Отличается: ' + d.ch.length + '</b></p>' + d.ch.slice(0, 60).map(function (x) { return objLine(x.o, x.fields.join(', ')); }).join('');
      if (d.del.length) html += '<p style="margin:10px 0 2px;color:var(--danger)"><b>Нет в файле (удалится только при замене): ' + d.del.length + '</b></p>' + d.del.slice(0, 60).map(function (o) { return objLine(o); }).join('');
    }
    html += '<div class="row"><button type="button" class="b t" id="apNo">Отмена</button></div>' +
      '<p class="muted">Ваша нынешняя карта сохранится — её можно вернуть в «Обмен данными».</p>';
    openDlg(html);
    $('apNo').onclick = closeDlg;
    function journal(inc, what) {
      var seen = {}, all = [];
      db.journal.concat(inc.journal || []).forEach(function (j) {
        if (!j || typeof j !== 'object') return;
        var k = j.t + '|' + j.by + '|' + j.id + '|' + j.what;
        if (!seen[k]) { seen[k] = 1; all.push(j); }
      });
      all.unshift({ t: Date.now(), by: author(), id: '', type: '', name: name || 'файл', what: what });
      all.sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
      return all.slice(0, JOURNAL_MAX);
    }
    function done(text) { save(); closeDlg(); select(null); if (view) closeSheet(); refresh(); setTimeout(fitAll, 60); toast(text); }
    bind(dlgBox, {
      merge: function () {
        localStorage.setItem(PREV, JSON.stringify({ saved: Date.now(), net: db }));
        var r = merge(p.data.net, false);
        db.journal = journal(p.data.net, 'добавлено новое из файла');
        done('Добавлено: ' + r.add.length + ', обновлено: ' + r.ch.length);
      },
      replace: function () {
        localStorage.setItem(PREV, JSON.stringify({ saved: Date.now(), net: db }));
        var inc = copy(p.data.net);
        inc.journal = journal(inc, 'карта заменена картой из файла');
        if (!inc.objs) inc.objs = {};
        db = inc;
        done('Карта заменена: +' + d.add.length + ', изменено ' + d.ch.length + ', удалено ' + d.del.length);
      }
    });
  }
  window.__kartaSaved = function (ok) { exNote = ok ? 'Файл сохранён.' : 'Файл не сохранён.'; showExchange(); };
  window.__kartaOpened = function () {
    var err = android.takeOpenedError(), name = android.takeOpenedName(), text = android.takeOpenedText();
    if (err || text == null) { exNote = 'Не удалось открыть файл' + (err ? ': ' + esc(err) : '') + '.'; showExchange(); return; }
    received(name, text);
  };

  // для проверок и совместимости
  window.KartaNet = { data: function () { return copy(db); }, counts: counts, valid: valid };
  window.KartaApp = { setMode: setMode, refresh: refresh, fitAll: fitAll, startLine: startLine, startNode: startNode, finishTool: finishTool,
    addCross: function () { if ($('apAddPt')) $('apAddPt').click(); }, state: function () { return { mode: mode, tool: tool, sel: sel, view: view }; } };

  // ================================================================== настройки (окно)

  var SETTINGS = [
    { sec: 'Вид' },
    { k: 'theme', t: 'Тема', o: [['light', 'Светлая'], ['dark', 'Тёмная'], ['auto', 'Как в системе']] },
    { k: 'ui', t: 'Размер кнопок и текста', o: [[0.9, 'Мелкий'], [1, 'Обычный'], [1.15, 'Крупный'], [1.3, 'Очень крупный']] },
    { k: 'mapDim', t: 'Приглушать карту в тёмной теме' },
    { sec: 'Карта' },
    { k: 'nodeLbl', t: 'Подписи узлов', o: [['always', 'Всегда'], ['zoom', 'Вблизи'], ['never', 'Нет']] },
    { k: 'lineLbl', t: 'Подписи линий', o: [['always', 'Всегда'], ['zoom', 'Вблизи'], ['never', 'Нет']] },
    { k: 'nodeSize', t: 'Значки узлов', o: [[0.8, 'Мелкие'], [1, 'Обычные'], [1.3, 'Крупные']] },
    { k: 'lineW', t: 'Толщина линий', o: [[0.75, 'Тонкие'], [1, 'Обычные'], [1.4, 'Толстые']] },
    { k: 'lineLen', t: 'Длина в подписи линии' },
    { k: 'linePts', t: 'Точки линий (опоры, колодцы, муфты)', o: [['always', 'Всегда'], ['near', 'Вблизи'], ['never', 'Нет']] },
    { k: 'ptSize', t: 'Значки точек линий', o: [[0.8, 'Мелкие'], [1, 'Обычные'], [1.3, 'Крупные']] },
    { k: 'ptLbl', t: 'Номера и имена точек', o: [['always', 'Всегда'], ['near', 'Вблизи'], ['never', 'Нет']] },
    { k: 'scale', t: 'Масштабная линейка' },
    { k: 'zoomBtns', t: 'Кнопки масштаба «+ −»', phone: true },
    { k: '_online', t: 'Карта из интернета', h: 'выключите — только офлайн-карта районов и то, что уже открывали' },
    { k: 'schema', t: 'Схема там, где есть офлайн-карта', o: [['auto', 'Офлайн-карта'], ['online', 'Из интернета']], h: 'офлайн-карта рисуется сразу и не тратит интернет' },
    { sec: 'Работа' },
    { k: 'start', t: 'При запуске открывать', o: [['view', 'Просмотр'], ['edit', 'Правку'], ['last', 'Как в прошлый раз']] },
    { k: 'tap', t: 'Ставить точки нажатием на карту', h: 'выключите, чтобы точки ставились только в перекрестие' },
    { k: 'snap', t: 'Прилипание к узлам, точкам и линиям', h: 'перекрестие и перетаскиваемая точка встают точно на соседний объект' },
    { k: 'keep', t: 'Не гасить экран', phone: true },
    { k: 'longMs', t: 'Долгое нажатие', o: [[400, 'Быстрое'], [550, 'Обычное'], [800, 'Медленное']] },
    { k: 'vibro', t: 'Вибрация при долгом нажатии', phone: true },
    { k: 'coords', t: 'Координаты точек', o: [['sk42', 'СК-42'], ['wgs', 'Градусы'], ['both', 'Оба']] },
    { sec: 'Компьютер', pc: true },
    { k: 'pcPanel', t: 'Ширина панели слева', o: [[320, 'Узкая'], [380, 'Обычная'], [460, 'Широкая']], pc: true },
    { k: 'pcCoords', t: 'Координаты под курсором', pc: true }
  ];
  var sysDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applySettings() {
    var b = document.body, dark = S.theme === 'dark' || (S.theme === 'auto' && !!sysDark && sysDark.matches), was = b.classList.contains('dark');
    b.classList.toggle('dark', dark);
    try { localStorage.setItem('wf_theme', dark ? 'dark' : 'light'); } catch (e) { /* не важно */ }
    if (was !== dark && window.KartaMap && window.KartaMap.retheme) window.KartaMap.retheme();
    b.classList.toggle('ap-dim', !!S.mapDim);
    b.classList.toggle('ap-nozoom', !S.zoomBtns);
    b.classList.toggle('ap-nocoords', !S.pcCoords);
    if (window.KartaMap && window.KartaMap.setSchema) window.KartaMap.setSchema(S.schema);
    if (android && android.keepScreen) try { android.keepScreen(!!S.keep); } catch (e) { /* старая оболочка */ }
    var t = cssText(S.ui);
    if (css.textContent !== t) css.textContent = t;
    document.documentElement.style.setProperty('--pw', Math.round(S.pcPanel * S.ui) + 'px');
    if (S.scale) scaleCtl.addTo(map); else scaleCtl.remove();
    zoomCls();
    refresh();
    sizeChanged();
    setTimeout(function () { map.invalidateSize(); sizeChanged(); }, 60);
  }
  function setS(k, v) {
    S[k] = v;
    try { localStorage.setItem(SET, JSON.stringify(S)); } catch (e) { /* не важно */ }
    applySettings();
  }
  if (sysDark) { var onSys = function () { if (S.theme === 'auto') applySettings(); }; if (sysDark.addEventListener) sysDark.addEventListener('change', onSys); else if (sysDark.addListener) sysDark.addListener(onSys); }
  function showSettings() {
    var top = dlgBox.getAttribute('data-set') ? dlgBox.scrollTop : 0, html = '<h3>Настройки</h3>';
    SETTINGS.forEach(function (r) {
      if ((r.pc && !pc) || (r.phone && pc)) return;
      if (r.sec) { html += '<div class="sec">' + r.sec + '</div>'; return; }
      var val = r.k === '_online' ? !!($('online') && $('online').checked) : S[r.k];
      html += '<div class="srow"><span>' + esc(r.t) + (r.h ? '<small>' + esc(r.h) + '</small>' : '') + '</span>' +
        (r.o ? '<div class="chips">' + r.o.map(function (o, i) {
          return '<button type="button" class="chip' + (o[0] === val ? ' on' : '') + '" data-sk="' + r.k + '" data-si="' + i + '">' + o[1] + '</button>';
        }).join('') + '</div>' : '<button type="button" class="sw' + (val ? ' on' : '') + '" data-sk="' + r.k + '" aria-label="' + esc(r.t) + '"></button>') + '</div>';
    });
    html += '<div class="sec">Прочее</div><div class="srow"><span>Подпись изменений<small>' + esc(localStorage.getItem(WHO) || 'не задана') + '</small></span>' +
      '<button type="button" class="b t" data-a="who">Изменить</button></div>' +
      '<div class="row"><button type="button" class="b d" data-a="reset">Сбросить настройки</button><button type="button" class="b" id="apNo">Готово</button></div>' +
      '<p class="muted">Карта сети 3.2. Настройки хранятся на этом устройстве и в файл обмена не попадают.<br>' + esc((window.KartaMap && window.KartaMap.credits) || '') + '</p>';
    openDlg(html);
    dlgBox.setAttribute('data-set', '1');
    dlgBox.scrollTop = top;
    $('apNo').onclick = closeDlg;
    dlgBox.querySelectorAll('[data-sk]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-sk'), r = SETTINGS.filter(function (x) { return x.k === k; })[0];
        if (k === '_online') toggleOnline();
        else setS(k, r.o ? r.o[+b.getAttribute('data-si')][0] : !S[k]);
        showSettings();
      };
    });
    bind(dlgBox, {
      who: function () { askWho(showSettings); },
      reset: function () { Object.keys(DEF).forEach(function (k) { S[k] = DEF[k]; }); S.theme = 'light'; setS('ui', 1); showSettings(); toast('Настройки сброшены'); }
    });
  }

  // ================================================================== инструкция

  function showHelp() {
    var hold = pc ? 'правая кнопка мыши' : 'долгое нажатие', H = [
      ['Два режима', 'Вверху — «Просмотр» и «' + (pc ? 'Редактирование' : 'Правка') + '». В просмотре ничего нельзя сдвинуть: нажмите на узел, линию или точку — увидите сведения. Всё, что меняет карту, делается в правке.'],
      ['Добавить узел или линию', 'В правке нажмите «+» справа внизу и выберите: узел, линия ВОЛС, радиолиния. Двигайте карту, чтобы перекрестие встало на нужное место, и нажмите «Поставить точку» — или просто нажмите на место на карте. «Назад» (↶) убирает последнюю точку, «Готово» заканчивает линию.'],
      ['Линия от узла до узла', 'Нажмите на узел → «+ ВОЛС» (или «+ Радио»). Ведите линию; когда перекрестие встанет на другой узел, оно позеленеет — нажмите «Завершить на…».'],
      ['По опорам или в земле', 'Пока ведёте линию, выберите прокладку следующего участка: «по опорам» (сплошная линия) или «в земле» (пунктир), и вид точки: опора, колодец, муфта, кросс. Одна линия может идти сначала по опорам, потом в земле. Прокладку готового участка меняет ' + hold + ' на линию.'],
      ['Точки на линии', 'У каждого вида точки свой значок: опора — кружок, колодец — квадрат, муфта — ромб, кросс — квадрат с крестом. Нажмите на значок — откроются сведения о точке: вид, номер, прокладка соседних участков.'],
      ['Ответвление (муфта)', 'Нажмите на точку линии → «Ответвление отсюда»: точка станет муфтой, от неё пойдёт новая линия. Если точки в нужном месте нет: ' + hold + ' на линию → «Ответвление отсюда». Можно и довести новую линию до чужой: перекрестие на линии или на её точке позеленеет.'],
      ['Общая опора или колодец', 'Если две линии идут по одним опорам, ставьте точку второй линии прямо на значок точки первой. Такие точки связаны: перенесёте одну — переедут обе.'],
      ['Изменить линию', 'Нажмите на линию — появятся её точки. Тяните точку, чтобы перенести; «+» между точками добавляет новую. ' + cap(hold) + ' на линию — вставить точку, сменить прокладку, продолжить, переименовать, удалить. В «Название…» можно указать число волокон и марку кабеля.'],
      ['Изменить узел', 'Нажмите на узел → «Изменить». Выделенный узел можно перетащить — концы линий поедут за ним. ' + cap(hold) + ' на узел — меню.'],
      ['Отменить', 'Кнопка ↶ над кнопками карты' + (pc ? ' или Ctrl+Z' : '') + ' отменяет последнее изменение, до 30 шагов.'],
      ['Карточка сведений', pc ? 'Сведения открываются в панели слева. Esc закрывает её.' : 'Сведения открываются внизу свёрнутыми. Нажмите на них, чтобы развернуть; смахните вниз, чтобы свернуть или убрать — выделение при этом остаётся.'],
      ['Поделиться картой', '«⋮» → «Обмен данными» → «' + (pc ? 'Сохранить в файл' : 'Поделиться файлом') + '». Файл называется вашим именем с датой и временем.'],
      ['Загрузить чужую карту', '«⋮» → «Обмен данными» → «Открыть файл…»' + (pc ? '' : ' (или нажмите на файл в мессенджере → «Открыть с помощью» → «Карта сети»)') + '. Программа покажет отличия и спросит: «Добавить новое» — к вашей карте добавится то, чего у вас нет, ничего не удалится; «Заменить всю карту» — станет точно как в файле. Прежнюю карту можно вернуть там же.'],
      ['Карта без интернета', '«⋮» → «Карта без интернета»: скачайте нужный район (Херсонская, Запорожская области, Крым) или выберите файл карты с устройства. Внутри района схема рисуется сразу и без связи. Снимки со спутника без интернета видны только там, где их уже открывали.'],
      ['Настройки', '«⋮» → «Настройки»: тема, размер кнопок и текста, подписи, значки, толщина линий, перекрестие и нажатия, координаты и другое.']
    ];
    openDlg('<h3>Инструкция</h3>' + H.map(function (h) {
      return '<details class="hlp"><summary>' + esc(h[0]) + '</summary><p>' + esc(h[1]) + '</p></details>';
    }).join('') + '<div class="row"><button type="button" class="b t" id="apNo">Закрыть</button></div>');
    $('apNo').onclick = closeDlg;
  }

  // ================================================================== обозначения

  function showLegend() {
    openDlg('<h3>Обозначения</h3><div class="sec">Узлы — форма по виду</div><div class="lgd">' + NODE_KINDS.map(function (k) {
      return '<div>' + shapeSvg(k, '#455a64', 22) + esc(k) + '</div>';
    }).join('') + '</div><div class="sec">Цвет — состояние</div><div class="lgd">' + Object.keys(STATES).map(function (k) {
      return '<div><i style="width:14px;height:14px;border-radius:50%;background:' + STATES[k] + '"></i>' + esc(k) + '</div>';
    }).join('') + '</div><div class="sec">Линии</div><div class="lgd">' +
      '<div><span class="lg" style="border-color:' + LAY.air.color + '"></span>ВОЛС по опорам</div>' +
      '<div><span class="lg" style="border-top-style:dashed;border-color:' + LAY.ground.color + '"></span>ВОЛС в земле</div>' +
      '<div><span class="lg" style="border-top-style:dashed;border-color:#1565c0"></span>радиолиния</div></div>' +
      '<div class="sec">Точки линии</div><div class="lgd">' + PT_KINDS.map(function (k) {
        return '<div>' + ptSvg(k, 20) + esc(k) + '</div>';
      }).join('') + '</div><div class="row"><button type="button" class="b t" id="apNo">Закрыть</button></div>');
    $('apNo').onclick = closeDlg;
  }

  // ================================================================== подсказка на пустой карте, кнопка «назад»

  var hint = el('div');
  hint.id = 'apHint';
  document.body.appendChild(hint);
  function updHint() {
    var show = !alive().length && !tool && !view;
    hint.style.display = show ? 'block' : 'none';
    if (show) hint.innerHTML = mode === 'edit' ? '<b>Сеть пока пуста</b>Нажмите «+» справа внизу: узел, линия ВОЛС или радиолиния.'
      : '<b>Сеть пока пуста</b>Включите «' + (window.innerWidth <= 420 ? 'Правка' : 'Редактирование') + '» вверху и нажмите «+» — или загрузите карту из файла: «⋮» → «Обмен данными».';
  }
  /* кнопка «назад» на телефоне: закрыть то, что открыто; false — закрывать нечего */
  window.__kartaBack = function () {
    if (dlg.classList.contains('show')) { if (!dlgLock) closeDlg(); return true; }
    if (menu.classList.contains('show')) { closeMenu(); return true; }
    if (tool) { finishTool(); return true; }
    if (view || sel) { select(null); if (view) closeSheet(); return true; }
    return false;
  };

  // ================================================================== компьютер: координаты, Esc

  if (pc) {
    var co = el('div');
    co.id = 'apCoords';
    document.body.appendChild(co);
    map.on('mousemove', function (e) { co.textContent = e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + '  ·  СК-42 ' + sk(e.latlng.lat, e.latlng.lng) + '  ·  масштаб ' + map.getZoom(); });
  }
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'я') && !/INPUT|TEXTAREA/.test((e.target || {}).tagName || '')) { undo(); return; }
    if (e.key !== 'Escape') return;
    if (dlg.classList.contains('show')) { if (!dlgLock) closeDlg(); }
    else if (menu.classList.contains('show')) closeMenu();
    else if (tool) finishTool();
    else if (view) { select(null); closeSheet(); }
  });

  // ================================================================== запуск

  if (window.KartaMap) window.KartaMap.note = toast;
  applySettings();
  setMode(S.start === 'edit' || (S.start === 'last' && localStorage.getItem('karta_mode') === 'edit') ? 'edit' : 'view');
  toastEl.classList.remove('show');
  // карта открывается там, где её оставили; в первый раз — вся сеть
  (function () {
    var v = null;
    try { v = JSON.parse(localStorage.getItem('karta_view')); } catch (e) { v = null; }
    if (v && isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2])) map.setView([v[0], v[1]], v[2], { animate: false });
    else if (alive().length) setTimeout(fitAll, 80);
    var t = 0;
    map.on('moveend', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var c = map.getCenter();
        try { localStorage.setItem('karta_view', JSON.stringify([+c.lat.toFixed(5), +c.lng.toFixed(5), map.getZoom()])); } catch (e) { /* не важно */ }
      }, 1200);
    });
  })();
  refresh();
  if (!localStorage.getItem(WHO)) askWho(null, true);
  if (android && android.ready) android.ready();
})();
