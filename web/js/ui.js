/* Карта сети — интерфейс: карточки, формы, списки, режимы работы с картой, вход. */
(function () {
  'use strict';

  var D = NM.data, M = NM.map, esc = NM.esc;
  var $ = function (id) { return document.getElementById(id); };
  var U = NM.ui = {};

  var hist = [];        // открытые друг за другом панели: [{view, arg}]
  var mode = null;      // текущий режим работы с картой или null
  var apkInfo = null;   // сведения о свежем APK на сервере

  var FIELD_NAMES = {
    name: 'название', type: 'вид', status: 'состояние', address: 'адрес', note: 'примечание',
    lat: 'широта', lng: 'долгота', a: 'узел А', b: 'узел Б', path: 'трасса'
  };
  var ROLE_NAMES = { admin: 'Администратор', editor: 'Редактор', viewer: 'Только просмотр' };

  // ------------------------------------------------------------------ общие элементы

  var toastTimer = null;
  U.toast = function (text, ms) {
    var t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  };
  NM.on('toast', U.toast);

  /** Окно подтверждения в стиле приложения. Возвращает Promise<boolean>. */
  var dialogDone = null;
  U.confirm = function (text, okLabel, danger) {
    return new Promise(function (resolve) {
      if (dialogDone) dialogDone(false);
      $('dialogtext').textContent = text;
      var ok = $('dialogok');
      ok.textContent = okLabel || 'Да';
      ok.className = 'btn ' + (danger ? 'dangerfill' : 'primary');
      $('dialog').hidden = false;
      dialogDone = function (value) { dialogDone = null; $('dialog').hidden = true; resolve(value); };
    });
  };

  function isWide() { return window.innerWidth >= 820; }

  U.mapPadding = function () {
    var sheet = $('sheet');
    if (sheet.hidden) return { paddingTopLeft: [30, 80], paddingBottomRight: [30, 40] };
    if (isWide()) return { paddingTopLeft: [30, 80], paddingBottomRight: [sheet.offsetWidth + 30, 40] };
    return { paddingTopLeft: [30, 80], paddingBottomRight: [30, sheet.offsetHeight + 30] };
  };

  function options(list, current, allowEmpty) {
    var arr = (D.settings[list] || []).slice(), found = false, html = '';
    if (allowEmpty) html += '<option value="">—</option>';
    arr.forEach(function (x) {
      if (x.id === current) found = true;
      html += '<option value="' + esc(x.id) + '"' + (x.id === current ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    });
    if (current && !found) html += '<option value="' + esc(current) + '" selected>' + esc(current) + '</option>';
    return html;
  }

  function shapeSvg(typeId, color) {
    var s = M.shapeOf(typeId), body;
    if (s === 'square') body = '<rect x="4" y="4" width="14" height="14"/>';
    else if (s === 'diamond') body = '<path d="M11 2 20 11 11 20 2 11Z"/>';
    else if (s === 'triangle') body = '<path d="M11 2 20 18H2Z"/>';
    else if (s === 'hex') body = '<path d="M20 11 15.5 18.8h-9L2 11l4.5-7.8h9Z"/>';
    else body = '<circle cx="11" cy="11" r="8"/>';
    return '<svg class="shape" viewBox="0 0 22 22" style="fill:' + esc(color || '#94a3b8') + ';stroke:#0f172a;stroke-width:1.5">' + body + '</svg>';
  }

  function statusColor(id) { var s = NM.lookup('statuses', id); return s ? s.color : '#94a3b8'; }

  function lineSvg(typeId) {
    var t = NM.lookup('link_types', typeId) || { color: '#475569', dash: '' };
    return '<svg class="linesw" viewBox="0 0 34 10"><path d="M2 5h30" stroke="' + esc(t.color) + '" stroke-width="4" ' +
      (t.dash ? 'stroke-dasharray="' + esc(t.dash.split(' ').map(function (n) { return n / 2; }).join(' ')) + '"' : 'stroke-linecap="round"') + '/></svg>';
  }

  function statusButtons(o) {
    if (!NM.canEdit()) {
      return '<div class="status-ro"><i style="background:' + esc(statusColor(o.data.status)) + '"></i>' +
        esc(NM.nameOf('statuses', o.data.status)) + '</div>';
    }
    return '<div class="statusrow" role="group" aria-label="Состояние">' + (D.settings.statuses || []).map(function (s) {
      var on = s.id === o.data.status;
      return '<button data-act="set-status" data-id="' + esc(o.id) + '" data-status="' + esc(s.id) + '" class="' + (on ? 'on' : '') +
        '" style="--c:' + esc(s.color) + '"><i></i>' + esc(s.name) + '</button>';
    }).join('') + '</div>';
  }

  function metaLine(o) {
    var s = '';
    if (o.pending) s += '<span class="pending">Изменения ещё не отправлены на сервер</span>';
    if (o.updated_at) s += '<span>Изменено ' + esc(NM.fmtTime(o.updated_at)) + (o.updated_by ? ', ' + esc(o.updated_by) : '') + '</span>';
    return '<div class="meta">' + s + '</div>';
  }

  // ------------------------------------------------------------------ панель (нижняя на телефоне, боковая на ПК)

  var views = {};

  U.show = function (view, arg, replace) {
    if (mode) cancelMode(true);
    closeDrawer(); closeFab();
    if (replace && hist.length) hist.pop();
    hist.push({ view: view, arg: arg || {} });
    if (hist.length > 12) hist.shift();
    render();
  };

  function render() {
    var cur = hist[hist.length - 1];
    if (!cur) { closeSheet(); return; }
    var out = views[cur.view](cur.arg);
    if (!out) { hist.pop(); render(); return; }
    var body = $('sheetbody'), keepScroll = body.dataset.view === cur.view ? body.scrollTop : 0;
    $('sheettitle').textContent = out.title;
    body.innerHTML = out.html;
    body.dataset.view = cur.view;
    body.scrollTop = keepScroll;
    $('sheetback').hidden = hist.length < 2;
    $('sheet').hidden = false;
    $('sheet').className = out.tall ? 'tall' : '';
    document.body.classList.add('sheet-open');
    if (out.after) out.after(body);
    M.map.invalidateSize({ pan: false });
  }

  function closeSheet() {
    hist = [];
    $('sheet').hidden = true;
    $('sheetbody').dataset.view = '';
    document.body.classList.remove('sheet-open');
    M.select(null);
    if ($('search').value) $('search').value = '';
    M.map.invalidateSize({ pan: false });
  }

  function back() {
    hist.pop();
    if (hist.length) render(); else closeSheet();
  }

  function currentIs(view) { return hist.length && hist[hist.length - 1].view === view; }

  /** Данные изменились — перерисовываем открытую панель, если она не форма (чтобы не стереть ввод). */
  function rerenderIfPassive() {
    var cur = hist[hist.length - 1];
    if (!cur || mode) return;
    if (['node', 'link', 'list', 'sync'].indexOf(cur.view) >= 0) render();
  }

  // ------------------------------------------------------------------ карточки

  views.node = function (arg) {
    var o = D.view.get(arg.id);
    if (!o || o.kind !== 'node') return null;
    var links = D.linksOf(o.id), edit = NM.canEdit();
    var html = '<div class="cardhead">' + shapeSvg(o.data.type, statusColor(o.data.status)) +
      '<div><div class="sub">' + esc(NM.nameOf('node_types', o.data.type)) + '</div>' +
      (o.data.address ? '<div class="addr">' + esc(o.data.address) + '</div>' : '') + '</div></div>';
    html += statusButtons(o);
    if (o.data.note) html += '<div class="note">' + esc(o.data.note) + '</div>';
    html += '<div class="coords"><span>' + o.data.lat.toFixed(6) + ', ' + o.data.lng.toFixed(6) + '</span>' +
      '<button class="link" data-act="route" data-id="' + esc(o.id) + '">Проложить маршрут</button></div>';
    html += '<h3>Линии' + (links.length ? ' (' + links.length + ')' : '') + '</h3>';
    if (links.length) {
      html += '<div class="rows">' + links.map(function (l) {
        var other = D.view.get(l.data.a === o.id ? l.data.b : l.data.a);
        return '<button class="row" data-act="open" data-id="' + esc(l.id) + '">' + lineSvg(l.data.type) +
          '<span class="grow">' + esc(other ? other.data.name : '?') + '<small>' + esc(NM.nameOf('link_types', l.data.type)) +
          ' · ' + NM.fmtDist(D.linkLength(l)) + '</small></span><i class="dot" style="background:' + esc(statusColor(l.data.status)) + '"></i></button>';
      }).join('') + '</div>';
    } else {
      html += '<p class="muted">К этому узлу пока не подведено ни одной линии.</p>';
    }
    html += metaLine(o);
    html += '<div class="actions">';
    if (edit) {
      html += '<button class="btn primary" data-act="edit-node" data-id="' + esc(o.id) + '">Изменить</button>' +
        '<button class="btn" data-act="link-from" data-id="' + esc(o.id) + '">Линия отсюда</button>' +
        '<button class="btn" data-act="move-node" data-id="' + esc(o.id) + '">Переместить</button>';
    }
    html += '<button class="btn" data-act="history" data-id="' + esc(o.id) + '">История</button>';
    if (edit) html += '<button class="btn danger" data-act="delete" data-id="' + esc(o.id) + '">Удалить</button>';
    html += '</div>';
    return { title: o.data.name, html: html };
  };

  views.link = function (arg) {
    var o = D.view.get(arg.id);
    if (!o || o.kind !== 'link') return null;
    var a = D.view.get(o.data.a), b = D.view.get(o.data.b), edit = NM.canEdit();
    var html = '<div class="cardhead">' + lineSvg(o.data.type) + '<div><div class="sub">' +
      esc(NM.nameOf('link_types', o.data.type)) + ' · ' + NM.fmtDist(D.linkLength(o)) +
      ((o.data.path || []).length ? ' · трасса из ' + ((o.data.path || []).length + 1) + ' отрезков' : '') + '</div></div></div>';
    html += statusButtons(o);
    if (o.data.note) html += '<div class="note">' + esc(o.data.note) + '</div>';
    html += '<h3>Соединяет</h3><div class="rows">' + [a, b].map(function (n) {
      if (!n) return '';
      return '<button class="row" data-act="open" data-id="' + esc(n.id) + '">' + shapeSvg(n.data.type, statusColor(n.data.status)) +
        '<span class="grow">' + esc(n.data.name) + '<small>' + esc(NM.nameOf('node_types', n.data.type)) + '</small></span></button>';
    }).join('') + '</div>';
    html += metaLine(o);
    html += '<div class="actions">';
    if (edit) {
      html += '<button class="btn primary" data-act="edit-link" data-id="' + esc(o.id) + '">Изменить</button>' +
        '<button class="btn" data-act="edit-path" data-id="' + esc(o.id) + '">Трасса</button>';
    }
    html += '<button class="btn" data-act="history" data-id="' + esc(o.id) + '">История</button>';
    if (edit) html += '<button class="btn danger" data-act="delete" data-id="' + esc(o.id) + '">Удалить</button>';
    html += '</div>';
    return { title: D.linkTitle(o), html: html };
  };

  // ------------------------------------------------------------------ формы

  views.nodeForm = function (arg) {
    var o = arg.id ? D.view.get(arg.id) : null;
    if (arg.id && !o) return null;
    var d = o ? o.data : { name: '', type: (D.settings.node_types[0] || {}).id, status: (D.settings.statuses[0] || {}).id,
      address: '', note: '', lat: arg.lat, lng: arg.lng };
    var html = '<form data-form="node" data-id="' + esc(arg.id || '') + '">' +
      '<label>Название<input id="fName" required maxlength="200" value="' + esc(d.name) + '" autocomplete="off"></label>' +
      '<div class="two"><label>Вид<select id="fType">' + options('node_types', d.type) + '</select></label>' +
      '<label>Состояние<select id="fStatus">' + options('statuses', d.status) + '</select></label></div>' +
      '<label>Адрес<input id="fAddress" maxlength="500" value="' + esc(d.address) + '" autocomplete="off"></label>' +
      '<label>Примечание<textarea id="fNote" rows="3" maxlength="4000">' + esc(d.note) + '</textarea></label>' +
      '<div class="two"><label>Широта<input id="fLat" inputmode="decimal" required value="' + esc(d.lat) + '"></label>' +
      '<label>Долгота<input id="fLng" inputmode="decimal" required value="' + esc(d.lng) + '"></label></div>' +
      '<div class="error" id="fError" hidden></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Сохранить</button>' +
      '<button class="btn" type="button" data-act="back">Отмена</button></div></form>';
    return { title: o ? 'Изменить узел' : 'Новый узел', html: html, tall: true,
      after: function (body) { if (!o && isWide()) body.querySelector('#fName').focus(); } };
  };

  views.linkForm = function (arg) {
    var o = arg.id ? D.view.get(arg.id) : null;
    if (arg.id && !o) return null;
    var d = o ? o.data : { name: '', type: (D.settings.link_types[0] || {}).id, status: (D.settings.statuses[0] || {}).id, note: '', a: arg.a, b: arg.b };
    var a = D.view.get(d.a), b = D.view.get(d.b);
    if (!a || !b) return null;
    var path = o ? (o.data.path || []) : (arg.path || []);
    var pts = [[a.data.lat, a.data.lng]].concat(path, [[b.data.lat, b.data.lng]]), len = 0;
    for (var i = 1; i < pts.length; i++) len += NM.distance(pts[i - 1], pts[i]);
    var html = '<form data-form="link" data-id="' + esc(arg.id || '') + '" data-a="' + esc(d.a) + '" data-b="' + esc(d.b) +
      '" data-path="' + esc(JSON.stringify(path)) + '">' +
      '<p class="pair">' + esc(a.data.name) + ' — ' + esc(b.data.name) +
      ' <span class="muted">(' + NM.fmtDist(len) + (path.length ? ', точек изгиба: ' + path.length : ' по прямой') + ')</span></p>' +
      '<div class="two"><label>Вид линии<select id="fType">' + options('link_types', d.type) + '</select></label>' +
      '<label>Состояние<select id="fStatus">' + options('statuses', d.status) + '</select></label></div>' +
      '<label>Название (необязательно)<input id="fName" maxlength="200" value="' + esc(d.name) + '" autocomplete="off"></label>' +
      '<label>Примечание<textarea id="fNote" rows="3" maxlength="4000">' + esc(d.note) + '</textarea></label>' +
      '<div class="actions"><button class="btn primary" type="submit">Сохранить</button>' +
      '<button class="btn" type="button" data-act="back">Отмена</button></div></form>';
    return { title: o ? 'Изменить линию' : 'Новая линия', html: html, tall: true };
  };

  function parseCoord(s) {
    var v = parseFloat(String(s).replace(',', '.').trim());
    return isFinite(v) ? v : null;
  }

  function submitNode(form) {
    var id = form.dataset.id, lat = parseCoord($('fLat').value), lng = parseCoord($('fLng').value), err = $('fError');
    var patch = {
      name: $('fName').value.trim(), type: $('fType').value, status: $('fStatus').value,
      address: $('fAddress').value.trim(), note: $('fNote').value.trim(), lat: lat, lng: lng
    };
    if (!patch.name) { err.textContent = 'Укажите название узла'; err.hidden = false; return; }
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      err.textContent = 'Координаты указаны неверно: широта от −90 до 90, долгота от −180 до 180'; err.hidden = false; return;
    }
    if (id) {
      var cur = D.view.get(id), diff = {};
      for (var k in patch) if (cur.data[k] !== patch[k]) diff[k] = patch[k];
      if (Object.keys(diff).length) D.edit('node', id, 'put', diff);
      hist.pop(); render();
    } else {
      id = NM.uuid();
      D.edit('node', id, 'put', patch);
      hist = [];
      U.open(id);
    }
  }

  function submitLink(form) {
    var id = form.dataset.id;
    var patch = { type: $('fType').value, status: $('fStatus').value, name: $('fName').value.trim(), note: $('fNote').value.trim() };
    if (id) {
      var cur = D.view.get(id), diff = {};
      for (var k in patch) if (cur.data[k] !== patch[k]) diff[k] = patch[k];
      if (Object.keys(diff).length) D.edit('link', id, 'put', diff);
      hist.pop(); render();
    } else {
      id = NM.uuid();
      patch.a = form.dataset.a; patch.b = form.dataset.b; patch.path = JSON.parse(form.dataset.path || '[]');
      D.edit('link', id, 'put', patch);
      hist = [];
      U.open(id);
    }
  }

  // ------------------------------------------------------------------ список и поиск

  views.list = function (arg) {
    var q = (arg.q || '').trim().toLowerCase(), tab = arg.tab || 'nodes';
    var nodes = D.nodes(), links = D.links();
    var html = '';
    if (!q) {
      html += '<div class="tabs"><button data-act="tab" data-tab="nodes" class="' + (tab === 'nodes' ? 'on' : '') + '">Узлы (' + nodes.length +
        ')</button><button data-act="tab" data-tab="links" class="' + (tab === 'links' ? 'on' : '') + '">Линии (' + links.length + ')</button></div>';
    }
    var rows = '';
    if (q || tab === 'nodes') {
      var found = nodes.filter(function (n) {
        return !q || n.data.name.toLowerCase().indexOf(q) >= 0 || (n.data.address || '').toLowerCase().indexOf(q) >= 0;
      }).sort(function (x, y) { return x.data.name.localeCompare(y.data.name, 'ru', { numeric: true }); });
      rows = found.slice(0, 300).map(function (n) {
        return '<button class="row" data-act="open" data-id="' + esc(n.id) + '">' + shapeSvg(n.data.type, statusColor(n.data.status)) +
          '<span class="grow">' + esc(n.data.name) + '<small>' + esc(NM.nameOf('node_types', n.data.type)) +
          (n.data.address ? ' · ' + esc(n.data.address) : '') + '</small></span></button>';
      }).join('');
      if (!found.length) rows = '<p class="muted">' + (q ? 'Ничего не найдено.' : 'Узлов пока нет. Нажмите «+», чтобы поставить первый узел на карту.') + '</p>';
      else if (found.length > 300) rows += '<p class="muted">Показаны первые 300 из ' + found.length + '. Уточните поиск.</p>';
    } else {
      links.sort(function (x, y) { return D.linkTitle(x).localeCompare(D.linkTitle(y), 'ru', { numeric: true }); });
      rows = links.slice(0, 300).map(function (l) {
        return '<button class="row" data-act="open" data-id="' + esc(l.id) + '">' + lineSvg(l.data.type) +
          '<span class="grow">' + esc(D.linkTitle(l)) + '<small>' + esc(NM.nameOf('link_types', l.data.type)) + ' · ' +
          NM.fmtDist(D.linkLength(l)) + '</small></span><i class="dot" style="background:' + esc(statusColor(l.data.status)) + '"></i></button>';
      }).join('') || '<p class="muted">Линий пока нет.</p>';
    }
    return { title: q ? 'Поиск' : 'Узлы и линии', html: html + '<div class="rows">' + rows + '</div>', tall: true };
  };

  // ------------------------------------------------------------------ обозначения и фильтр

  views.filters = function () {
    var h = M.prefs.hidden;
    function group(title, list, key, icon) {
      return '<h3>' + title + '</h3><div class="checks">' + (D.settings[list] || []).map(function (x) {
        return '<label class="check"><input type="checkbox" data-filter="' + key + '" value="' + esc(x.id) + '"' +
          (h[key][x.id] ? '' : ' checked') + '>' + icon(x) + '<span>' + esc(x.name) + '</span></label>';
      }).join('') + '</div>';
    }
    var html = '<p class="muted">Снимите отметку, чтобы скрыть объекты с карты. Фильтр действует только на этом устройстве.</p>' +
      group('Виды узлов (форма значка)', 'node_types', 'node_types', function (x) { return shapeSvg(x.id, '#cbd5e1'); }) +
      group('Состояния (цвет значка, подсветка линии)', 'statuses', 'statuses', function (x) {
        return '<i class="dot big" style="background:' + esc(x.color) + '"></i>';
      }) +
      group('Виды линий', 'link_types', 'link_types', function (x) { return lineSvg(x.id); }) +
      '<h3>Подписи</h3><label class="check"><input type="checkbox" id="fltLabels"' + (M.prefs.labels ? ' checked' : '') +
      '><span>Показывать названия узлов при приближении</span></label>';
    return { title: 'Обозначения и фильтр', html: html, tall: true };
  };

  // ------------------------------------------------------------------ журнал

  function describeChange(e) {
    var kind = e.kind === 'node' ? 'узел' : 'линию';
    var label = '«' + esc(e.label || '?') + '»';
    if (e.action === 'create') return 'добавил ' + kind + ' ' + label;
    if (e.action === 'delete') return 'удалил ' + kind + ' ' + label;
    var parts = [];
    for (var k in (e.changes || {})) {
      var c = e.changes[k];
      if (k === 'lat' || k === 'lng') { if (parts.indexOf('положение на карте') < 0) parts.push('положение на карте'); continue; }
      if (k === 'path') { parts.push('трассу'); continue; }
      var show = function (v) {
        if (k === 'status') return NM.nameOf('statuses', v);
        if (k === 'type') return NM.nameOf(e.kind === 'node' ? 'node_types' : 'link_types', v);
        return v === '' || v == null ? 'пусто' : String(v).length > 60 ? String(v).slice(0, 60) + '…' : v;
      };
      parts.push(FIELD_NAMES[k] + ': ' + esc(show(c[0])) + ' → <b>' + esc(show(c[1])) + '</b>');
    }
    return 'изменил ' + kind + ' ' + label + (parts.length ? ' — ' + parts.join('; ') : '');
  }

  views.journal = function (arg) {
    var html = '<div id="journal"><p class="muted">Загрузка…</p></div>';
    return {
      title: arg.obj ? 'История изменений' : 'Журнал изменений', html: html, tall: true,
      after: function (body) {
        var box = body.querySelector('#journal');
        function load(before) {
          NM.api('GET', '/api/journal?limit=80' + (arg.obj ? '&obj=' + encodeURIComponent(arg.obj) : '') + (before ? '&before=' + before : ''))
            .then(function (res) {
              if (!before) box.innerHTML = '';
              var more = box.querySelector('.more'); if (more) more.remove();
              if (!res.entries.length && !before) { box.innerHTML = '<p class="muted">Изменений пока не было.</p>'; return; }
              box.insertAdjacentHTML('beforeend', res.entries.map(function (e) {
                var exists = D.view.has(e.obj_id);
                return '<div class="jrow"' + (exists ? ' data-act="open" data-id="' + esc(e.obj_id) + '"' : '') + '><time>' +
                  esc(NM.fmtTime(e.ts)) + '</time><div><b>' + esc(e.user || '?') + '</b> ' + describeChange(e) + '</div></div>';
              }).join(''));
              if (res.entries.length === 80) {
                var last = res.entries[res.entries.length - 1].rev;
                box.insertAdjacentHTML('beforeend', '<button class="btn more">Показать более ранние</button>');
                box.querySelector('.more').onclick = function () { load(last); };
              }
            }, function (err) {
              if (!before) box.innerHTML = '<p class="muted">Журнал хранится на сервере и доступен только при наличии связи. ' + esc(err.message) + '.</p>';
            });
        }
        load(0);
      }
    };
  };

  // ------------------------------------------------------------------ связь и синхронизация

  views.sync = function () {
    var st = D.status(), html = '';
    var text = { online: 'Связь с сервером есть, все правки отправлены.', syncing: 'Связь есть, правки отправляются…',
      offline: 'Связи с сервером нет. Карта и правки сохраняются на устройстве и отправятся, когда связь появится.', out: 'Вход не выполнен.' }[st];
    html += '<p class="state ' + st + '">' + text + '</p>';
    html += '<dl class="kv"><dt>Неотправленных правок</dt><dd>' + D.queue.length + '</dd>' +
      '<dt>Последний обмен с сервером</dt><dd>' + (D.lastSync ? esc(NM.fmtTime(D.lastSync / 1000)) : 'ещё не было') + '</dd>' +
      '<dt>Объектов на карте</dt><dd>' + D.nodes().length + ' узл., ' + D.links().length + ' лин.</dd>' +
      '<dt>Сервер</dt><dd>' + esc(NM.session.server) + '</dd></dl>';
    if (st !== 'offline' && D.online.length) {
      html += '<h3>Сейчас в сети (' + D.online.length + ')</h3><p>' + D.online.map(function (u) { return esc(u.name); }).join(', ') + '</p>';
    }
    html += '<div class="actions"><button class="btn primary" data-act="sync-now">Обновить сейчас</button>';
    if (D.queue.length) html += '<button class="btn danger" data-act="drop-queue">Отменить неотправленные правки</button>';
    html += '</div>';
    return { title: 'Связь с сервером', html: html };
  };

  // ------------------------------------------------------------------ настройки и учётная запись

  views.settings = function () {
    var u = NM.session.user || {}, html = '';
    html += '<dl class="kv"><dt>Пользователь</dt><dd>' + esc(u.name) + ' (' + esc(u.login) + ')</dd><dt>Права</dt><dd>' +
      esc(ROLE_NAMES[u.role] || u.role) + '</dd><dt>Сервер</dt><dd>' + esc(NM.session.server) + '</dd><dt>Версия</dt><dd>' +
      (NM.native ? 'приложение ' + esc(NM.native.versionName()) : 'браузер, клиент ' + NM.CLIENT_VERSION) + '</dd></dl>';
    if (NM.native && apkInfo && apkInfo.versionCode > NM.native.versionCode()) {
      html += '<div class="banner">Доступна новая версия приложения: ' + esc(apkInfo.versionName) +
        '. <button class="link" data-act="update">Скачать обновление</button></div>';
    }
    html += '<h3>Сменить пароль</h3><form data-form="password">' +
      '<label>Текущий пароль<input id="pwOld" type="password" autocomplete="current-password" required></label>' +
      '<label>Новый пароль (не короче 6 символов)<input id="pwNew" type="password" autocomplete="new-password" required minlength="6"></label>' +
      '<div class="error" id="pwError" hidden></div><div class="actions"><button class="btn" type="submit">Сменить пароль</button></div></form>';
    html += '<h3>Выход</h3><p class="muted">После выхода карта на этом устройстве останется сохранённой, но открыть её можно будет только после входа.</p>' +
      '<div class="actions"><button class="btn danger" data-act="logout">Выйти</button></div>';
    return { title: 'Настройки', html: html, tall: true };
  };

  // ------------------------------------------------------------------ карта без интернета (только приложение)

  var dl = null;  // идущее скачивание области

  views.offline = function () {
    var html = '<p>Карта, которую вы уже просматривали, сохраняется на телефоне сама и открывается без интернета. ' +
      'Здесь можно заранее сохранить область целиком — например, район, куда едет бригада.</p>';
    if (NM.native) {
      html += '<dl class="kv"><dt>Сохранено на телефоне</dt><dd id="offSize">' + cacheSizeText() + '</dd></dl>';
      html += '<h3>Сохранить область, которая сейчас на экране</h3>' +
        '<p class="muted">Подвиньте карту так, чтобы нужный район был виден целиком, и выберите подробность. ' +
        'Сохраняется тот вид карты, который сейчас включён (схема или спутник).</p>' +
        '<div class="actions" id="offBtns"><button class="btn" data-act="offline-save" data-z="15">До улиц</button>' +
        '<button class="btn" data-act="offline-save" data-z="17">До домов</button></div>' +
        '<div id="offProgress" hidden><progress id="offBar" max="100" value="0"></progress><span id="offText"></span>' +
        '<button class="btn" data-act="offline-cancel">Остановить</button></div>' +
        '<h3>Очистка</h3><div class="actions"><button class="btn danger" data-act="offline-clear">Удалить сохранённую карту</button></div>';
    } else {
      html += '<p class="muted">Эта возможность есть только в приложении для Android.</p>';
    }
    return { title: 'Карта без интернета', html: html, tall: true, after: function () { if (dl) showDl(); } };
  };

  function cacheSizeText() {
    var b = NM.native.tileCacheBytes(), n = NM.native.tileCacheCount();
    return (b / 1048576).toFixed(1).replace('.', ',') + ' МБ (' + n + ' фрагментов)';
  }

  function showDl() {
    var p = $('offProgress');
    if (!p) return;
    p.hidden = !dl; $('offBtns').hidden = !!dl;
    if (dl) {
      $('offBar').value = Math.round(dl.done / dl.total * 100);
      $('offText').textContent = dl.done + ' из ' + dl.total + (dl.failed ? ', не удалось: ' + dl.failed : '');
    } else if ($('offSize')) {
      $('offSize').textContent = cacheSizeText();
    }
  }

  function startDownload(maxZoom) {
    var urls = M.tilesForView(maxZoom);
    if (urls.length > 6000) {
      U.toast('Область слишком большая (' + urls.length + ' фрагментов). Приблизьте карту или выберите меньшую подробность.', 6000);
      return;
    }
    dl = { total: urls.length, done: 0, failed: 0, stop: false };
    var i = 0;
    function next() {
      if (!dl) return;
      if (dl.stop || i >= urls.length) {
        if (--dl.active === 0) {
          var msg = dl.stop ? 'Сохранение остановлено' : 'Область сохранена' + (dl.failed ? ', не удалось загрузить фрагментов: ' + dl.failed : '');
          dl = null; showDl(); U.toast(msg);
        }
        return;
      }
      var img = new Image();
      img.onload = function () { dl.done++; showDl(); next(); };
      img.onerror = function () { dl.done++; dl.failed++; showDl(); next(); };
      img.src = urls[i++];
    }
    dl.active = 4;
    for (var k = 0; k < 4; k++) next();
    showDl();
  }

  // ------------------------------------------------------------------ пользователи (администратор)

  views.users = function () {
    return {
      title: 'Пользователи', tall: true,
      html: '<div id="users"><p class="muted">Загрузка…</p></div><div class="actions"><button class="btn primary" data-act="show" data-view="userForm">Добавить пользователя</button></div>',
      after: function (body) {
        var box = body.querySelector('#users');
        NM.api('GET', '/api/users').then(function (res) {
          box.innerHTML = '<div class="rows">' + res.users.map(function (u) {
            return '<button class="row' + (u.active ? '' : ' off') + '" data-act="user" data-user="' + esc(JSON.stringify(u)) + '">' +
              '<i class="dot big" style="background:' + (u.online ? '#16a34a' : '#cbd5e1') + '"></i><span class="grow">' + esc(u.name) +
              '<small>' + esc(u.login) + ' · ' + esc(ROLE_NAMES[u.role]) + (u.active ? '' : ' · отключён') +
              (u.online ? ' · в сети' : u.last_seen ? ' · был ' + esc(NM.fmtTime(u.last_seen)) : ' · ещё не входил') + '</small></span></button>';
          }).join('') + '</div>';
        }, function (err) { box.innerHTML = '<p class="muted">Список пользователей доступен только при наличии связи. ' + esc(err.message) + '.</p>'; });
      }
    };
  };

  views.userForm = function (arg) {
    var u = arg.user, html;
    function roles(cur) {
      return ['editor', 'viewer', 'admin'].map(function (r) {
        return '<option value="' + r + '"' + (r === cur ? ' selected' : '') + '>' + ROLE_NAMES[r] + '</option>';
      }).join('');
    }
    if (u) {
      html = '<form data-form="user" data-id="' + u.id + '">' +
        '<label>Имя (так человек виден остальным)<input id="uName" required maxlength="80" value="' + esc(u.name) + '"></label>' +
        '<label>Права<select id="uRole">' + roles(u.role) + '</select></label>' +
        '<label>Новый пароль (оставьте пустым, чтобы не менять)<input id="uPass" type="text" autocomplete="off" minlength="6"></label>' +
        '<label class="check"><input type="checkbox" id="uActive"' + (u.active ? ' checked' : '') + '><span>Учётная запись действует</span></label>' +
        '<p class="muted">Если снять отметку или сменить пароль, человек сразу потеряет доступ на всех своих устройствах.</p>';
    } else {
      html = '<form data-form="user" data-id="">' +
        '<label>Логин (латиница и цифры)<input id="uLogin" required maxlength="40" autocapitalize="off" autocomplete="off" pattern="[A-Za-z0-9._\\-]+"></label>' +
        '<label>Имя (так человек виден остальным)<input id="uName" required maxlength="80" autocomplete="off"></label>' +
        '<label>Права<select id="uRole">' + roles('editor') + '</select></label>' +
        '<label>Пароль (не короче 6 символов)<input id="uPass" type="text" required minlength="6" autocomplete="off"></label>';
    }
    html += '<div class="error" id="uError" hidden></div><div class="actions"><button class="btn primary" type="submit">Сохранить</button>' +
      '<button class="btn" type="button" data-act="back">Отмена</button></div></form>';
    return { title: u ? u.login : 'Новый пользователь', html: html, tall: true };
  };

  function submitUser(form) {
    var id = form.dataset.id, err = $('uError'), req;
    if (id) {
      var body = { name: $('uName').value.trim(), role: $('uRole').value, active: $('uActive').checked };
      if ($('uPass').value) body.password = $('uPass').value;
      req = NM.api('PATCH', '/api/users/' + id, body);
    } else {
      req = NM.api('POST', '/api/users', { login: $('uLogin').value.trim(), name: $('uName').value.trim(), role: $('uRole').value, password: $('uPass').value });
    }
    req.then(function () { U.toast('Сохранено'); hist.pop(); render(); },
      function (e) { err.textContent = e.message; err.hidden = false; });
  }

  // ------------------------------------------------------------------ справочники (администратор)

  var LISTS = [
    { key: 'node_types', title: 'Виды узлов', color: false, hint: 'Форма значка на карте задаётся порядком в списке.' },
    { key: 'link_types', title: 'Виды линий', color: true, hint: '' },
    { key: 'statuses', title: 'Состояния', color: true, hint: 'Первое состояние считается обычным: линии в нём не подсвечиваются.' }
  ];

  views.types = function () {
    var html = '<form data-form="types"><p class="muted">Изменения увидят все пользователи. Если убрать вид, который уже назначен объектам, у них останется прежнее значение без названия.</p>';
    LISTS.forEach(function (l) {
      html += '<h3>' + l.title + '</h3>' + (l.hint ? '<p class="muted">' + l.hint + '</p>' : '') + '<div class="tlist" data-list="' + l.key + '">' +
        (D.settings[l.key] || []).map(function (x) { return typeRow(l, x); }).join('') +
        '</div><button class="btn" type="button" data-act="type-add" data-list="' + l.key + '">Добавить</button>';
    });
    html += '<div class="error" id="tError" hidden></div><div class="actions"><button class="btn primary" type="submit">Сохранить</button>' +
      '<button class="btn" type="button" data-act="back">Отмена</button></div></form>';
    return { title: 'Виды и состояния', html: html, tall: true };
  };

  function typeRow(l, x) {
    return '<div class="trow" data-id="' + esc(x.id) + '" data-dash="' + esc(x.dash || '') + '">' +
      (l.color ? '<input type="color" value="' + esc(x.color || '#475569') + '" aria-label="Цвет">' : '') +
      '<input type="text" value="' + esc(x.name) + '" maxlength="80" required aria-label="Название">' +
      '<button class="ib flat" type="button" data-act="type-del" aria-label="Убрать"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>';
  }

  function submitTypes() {
    var out = {}, err = $('tError');
    LISTS.forEach(function (l) {
      out[l.key] = [].map.call(document.querySelectorAll('.tlist[data-list="' + l.key + '"] .trow'), function (row) {
        var item = { id: row.dataset.id, name: row.querySelector('input[type=text]').value.trim() };
        if (l.color) item.color = row.querySelector('input[type=color]').value;
        if (l.key === 'link_types') item.dash = row.dataset.dash || '';
        return item;
      });
    });
    NM.api('PUT', '/api/settings', out).then(function (s) {
      D.settings = s; NM.emit('settings'); U.toast('Сохранено'); back();
    }, function (e) { err.textContent = e.message; err.hidden = false; });
  }

  // ------------------------------------------------------------------ импорт и экспорт (в браузере)

  views.exchange = function () {
    var html = '<h3>Экспорт</h3><p class="muted">Выгрузка всей сети в файл.</p><div class="actions">' +
      '<button class="btn" data-act="export" data-fmt="csv">Узлы в CSV (Excel)</button>' +
      '<button class="btn" data-act="export" data-fmt="geojson">Вся сеть в GeoJSON</button></div>' +
      '<h3>Импорт узлов из CSV</h3><p class="muted">Первая строка файла — заголовки столбцов. Обязательны «Название», «Широта», «Долгота»; ' +
      'по желанию «Вид», «Состояние», «Адрес», «Примечание». Разделитель — точка с запятой, запятая или табуляция. ' +
      'Узлы, которые уже есть на карте (то же название и то же место), пропускаются.</p>' +
      '<input type="file" id="impFile" accept=".csv,.txt,text/csv"><div id="impResult"></div>';
    return { title: 'Импорт и экспорт', html: html, tall: true };
  };

  function download(name, text, mime) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function exportData(fmt) {
    var stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'csv') {
      var q = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
      var lines = ['Название;Вид;Состояние;Широта;Долгота;Адрес;Примечание'];
      D.nodes().sort(function (x, y) { return x.data.name.localeCompare(y.data.name, 'ru', { numeric: true }); }).forEach(function (n) {
        lines.push([q(n.data.name), q(NM.nameOf('node_types', n.data.type)), q(NM.nameOf('statuses', n.data.status)),
          String(n.data.lat).replace('.', ','), String(n.data.lng).replace('.', ','), q(n.data.address), q(n.data.note)].join(';'));
      });
      download('karta-seti-uzly-' + stamp + '.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    } else {
      var feats = [];
      D.nodes().forEach(function (n) {
        feats.push({ type: 'Feature', id: n.id, geometry: { type: 'Point', coordinates: [n.data.lng, n.data.lat] },
          properties: { kind: 'node', name: n.data.name, type: NM.nameOf('node_types', n.data.type), status: NM.nameOf('statuses', n.data.status), address: n.data.address, note: n.data.note } });
      });
      D.links().forEach(function (l) {
        var pts = D.linkPoints(l);
        if (!pts) return;
        feats.push({ type: 'Feature', id: l.id, geometry: { type: 'LineString', coordinates: pts.map(function (p) { return [p[1], p[0]]; }) },
          properties: { kind: 'link', name: D.linkTitle(l), type: NM.nameOf('link_types', l.data.type), status: NM.nameOf('statuses', l.data.status),
            note: l.data.note, length_m: Math.round(D.linkLength(l)) } });
      });
      download('karta-seti-' + stamp + '.geojson', JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 1), 'application/geo+json');
    }
  }

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = [';', '\t', ','].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
    var rows = [], row = [], cell = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(function (x) { return x.trim() !== ''; })) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(function (x) { return x.trim() !== ''; })) rows.push(row);
    return rows;
  }

  var pendingImport = null;

  function readImport(file) {
    var box = $('impResult');
    var reader = new FileReader();
    reader.onload = function () {
      var rows = parseCsv(String(reader.result));
      if (rows.length < 2) { box.innerHTML = '<p class="error">В файле нет строк с данными.</p>'; return; }
      var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
      function col(names) { for (var i = 0; i < head.length; i++) if (names.indexOf(head[i]) >= 0) return i; return -1; }
      var c = {
        name: col(['название', 'наименование', 'имя', 'name']), lat: col(['широта', 'lat', 'latitude']),
        lng: col(['долгота', 'lng', 'lon', 'long', 'longitude']), type: col(['вид', 'тип', 'type']),
        status: col(['состояние', 'статус', 'status']), address: col(['адрес', 'address']), note: col(['примечание', 'описание', 'note', 'comment'])
      };
      if (c.name < 0 || c.lat < 0 || c.lng < 0) {
        box.innerHTML = '<p class="error">Не найдены обязательные столбцы «Название», «Широта», «Долгота».</p>'; return;
      }
      function match(list, value) {
        value = (value || '').trim().toLowerCase();
        var arr = D.settings[list] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i].name.toLowerCase() === value || arr[i].id.toLowerCase() === value) return arr[i].id;
        return arr.length ? arr[0].id : '';
      }
      var existing = D.nodes(), items = [], skipped = 0, dup = 0;
      rows.slice(1).forEach(function (r) {
        var name = (r[c.name] || '').trim(), lat = parseCoord(r[c.lat]), lng = parseCoord(r[c.lng]);
        if (!name || lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) { skipped++; return; }
        var same = existing.concat(items.map(function (p) { return { data: p }; })).some(function (n) {
          return n.data.name === name && NM.distance([n.data.lat, n.data.lng], [lat, lng]) < 5;
        });
        if (same) { dup++; return; }
        items.push({ name: name, lat: lat, lng: lng, type: match('node_types', c.type >= 0 ? r[c.type] : ''),
          status: match('statuses', c.status >= 0 ? r[c.status] : ''), address: c.address >= 0 ? (r[c.address] || '').trim() : '',
          note: c.note >= 0 ? (r[c.note] || '').trim() : '' });
      });
      pendingImport = items;
      box.innerHTML = '<p>Найдено новых узлов: <b>' + items.length + '</b>. Уже есть на карте: ' + dup +
        '. Пропущено строк без названия или с неверными координатами: ' + skipped + '.</p>' +
        (items.length ? '<div class="actions"><button class="btn primary" data-act="import-apply">Добавить ' + items.length + ' на карту</button></div>' : '');
    };
    reader.readAsText(file, 'utf-8');
  }

  // ------------------------------------------------------------------ режимы работы с картой

  function modeButtons(buttons) {
    $('modebtns').innerHTML = buttons.map(function (b) {
      return '<button class="btn ' + (b.cls || '') + '" data-act="' + b.act + '"' + (b.off ? ' disabled' : '') + '>' + b.label + '</button>';
    }).join('');
  }

  function modeText(title, hint) {
    $('modetext').innerHTML = (title ? '<b>' + esc(title) + '</b>' : '') + (hint ? '<span>' + esc(hint) + '</span>' : '');
  }

  function setMode(m, title, hint, buttons) {
    mode = m;
    $('sheet').hidden = true;
    document.body.classList.remove('sheet-open');
    document.body.classList.add('mode');
    $('fab').hidden = true; closeFab();
    $('cross').hidden = !(m.type === 'place' || m.type === 'draw');
    modeText(title, hint);
    modeButtons(buttons);
    $('modebar').hidden = false;
    M.map.invalidateSize({ pan: false });
  }

  function endMode() {
    mode = null;
    $('modebar').hidden = true; $('cross').hidden = true;
    document.body.classList.remove('mode');
    M.map.off('move', drawMove);
    M.draft(null);
    M.stopEdit();
    M.select(null);
    updateChrome();
  }

  function cancelMode(silent) {
    endMode();
    if (!silent && hist.length) { render(); var cur = hist[hist.length - 1]; if (cur.arg && cur.arg.id) M.select(cur.arg.id); }
  }

  function startPlace(purpose, id) {
    var o = id ? D.view.get(id) : null;
    setMode({ type: 'place', purpose: purpose, id: id },
      purpose === 'move' ? 'Новое место узла «' + o.data.name + '»' : 'Новый узел',
      'Подвиньте карту так, чтобы перекрестие встало на нужное место.',
      [{ act: 'mode-cancel', label: 'Отмена' }, { act: 'mode-me', label: 'Моё место' }, { act: 'mode-ok', label: 'Здесь', cls: 'primary' }]);
    if (o) M.map.setView([o.data.lat, o.data.lng], Math.max(M.map.getZoom(), 16));
  }

  function startPick() {
    setMode({ type: 'pick' }, 'Новая линия', 'Нажмите на узел, от которого пойдёт линия.',
      [{ act: 'mode-cancel', label: 'Отмена' }]);
    M.select(null);
  }

  // ---- ведение линии по точкам: перекрестие в центре, «Точка» ставит изгиб, на конечном узле — «Завершить»

  function startDraw(a) {
    if (!D.view.get(a)) return;
    setMode({ type: 'draw', a: a, pts: [], snap: null, sig: '' }, '', '', []);
    M.map.on('move', drawMove);
    updateDraw();
  }

  function drawMove() { if (mode && mode.type === 'draw') updateDraw(); }

  function updateDraw() {
    var first = D.view.get(mode.a);
    if (!first) { cancelMode(true); U.toast('Начальный узел удалил другой пользователь'); return; }
    var c = M.center();
    var near = M.nodeNear(L.latLng(c), 30, mode.a), end = c;
    if (near) { var n = D.view.get(near); end = [n.data.lat, n.data.lng]; }
    if (near !== mode.snap) { mode.snap = near; M.select(near); }
    var pts = [[first.data.lat, first.data.lng]].concat(mode.pts, [end]), len = 0;
    for (var i = 1; i < pts.length; i++) len += NM.distance(pts[i - 1], pts[i]);
    M.draft(pts, mode.pts);
    modeText('От «' + first.data.name + '» · ' + NM.fmtDist(len) + (mode.pts.length ? ' · точек: ' + mode.pts.length : ''),
      near ? 'Перекрестие на узле «' + D.view.get(near).data.name + '». Нажмите «Завершить».'
        : 'Наводите перекрестие на повороты и ставьте точки. На конечном узле линия завершится.');
    // кнопки пересоздаём только при смене состояния, иначе нажатие во время движения карты теряется
    var sig = (near ? 'end' : 'pt') + (mode.pts.length ? 1 : 0);
    if (sig !== mode.sig) {
      mode.sig = sig;
      modeButtons([{ act: 'mode-cancel', label: 'Отмена' }, { act: 'draw-undo', label: 'Назад', off: !mode.pts.length },
        near ? { act: 'draw-add', label: 'Завершить', cls: 'primary' } : { act: 'draw-add', label: 'Точка', cls: 'primary' }]);
    }
  }

  function drawAddPoint(p) {
    var first = D.view.get(mode.a);
    var prev = mode.pts.length ? mode.pts[mode.pts.length - 1] : [first.data.lat, first.data.lng];
    if (NM.distance(prev, p) < 0.5) return;   // повторное нажатие в ту же точку
    if (mode.pts.length >= 300) { U.toast('В трассе не может быть больше 300 точек'); return; }
    mode.pts.push([+p[0].toFixed(7), +p[1].toFixed(7)]);
    updateDraw();
  }

  function finishDraw(b) {
    var a = mode.a, path = mode.pts.slice();
    var exists = D.links().some(function (l) {
      return (l.data.a === a && l.data.b === b) || (l.data.a === b && l.data.b === a);
    });
    endMode();
    hist = [];
    U.show('linkForm', { a: a, b: b, path: path });
    if (exists) U.toast('Между этими узлами уже есть линия. Можно добавить ещё одну, если это другая линия.', 5000);
  }

  // ---- правка трассы существующей линии

  function startPath(id) {
    var o = D.view.get(id), a = D.view.get(o.data.a), b = D.view.get(o.data.b);
    setMode({ type: 'path', id: id, path: (o.data.path || []).map(function (p) { return p.slice(); }), undo: [], sig: '' }, '', '', []);
    M.editPath([a.data.lat, a.data.lng], [b.data.lat, b.data.lng], mode.path, function (path) {
      mode.undo.push(mode.path); mode.path = path; updatePathBar();
    });
    updatePathBar();
    var pts = D.linkPoints(o);
    if (pts) M.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 90], paddingBottomRight: [40, 190], maxZoom: 17 });
  }

  function updatePathBar() {
    var o = D.view.get(mode.id), a = D.view.get(o.data.a), b = D.view.get(o.data.b);
    var pts = [[a.data.lat, a.data.lng]].concat(mode.path, [[b.data.lat, b.data.lng]]), len = 0;
    for (var i = 1; i < pts.length; i++) len += NM.distance(pts[i - 1], pts[i]);
    modeText('Трасса · ' + NM.fmtDist(len) + ' · точек: ' + mode.path.length,
      'Тяните точки по улицам. Бледная точка посередине отрезка добавляет изгиб, нажатие на точку убирает её.');
    var sig = (mode.undo.length ? 1 : 0) + '' + (mode.path.length ? 1 : 0);
    if (sig !== mode.sig) {
      mode.sig = sig;
      modeButtons([{ act: 'mode-cancel', label: 'Отмена' }, { act: 'path-undo', label: 'Назад', off: !mode.undo.length },
        { act: 'path-reset', label: 'Спрямить', off: !mode.path.length }, { act: 'mode-ok', label: 'Готово', cls: 'primary' }]);
    }
  }

  function modeOk() {
    if (!mode) return;
    if (mode.type === 'place') {
      var c = M.center(), m = mode;
      endMode();
      if (m.purpose === 'move') {
        D.edit('node', m.id, 'put', { lat: +c[0].toFixed(7), lng: +c[1].toFixed(7) });
        hist = []; U.open(m.id);
      } else {
        hist = [];
        U.show('nodeForm', { lat: +c[0].toFixed(7), lng: +c[1].toFixed(7) });
      }
    } else if (mode.type === 'path') {
      var id = mode.id, path = mode.path, cur = D.view.get(id);
      endMode();
      if (cur && JSON.stringify(cur.data.path || []) !== JSON.stringify(path)) D.edit('link', id, 'put', { path: path });
      hist = []; U.open(id);
    }
  }

  NM.on('tap', function (id) {
    var o = D.view.get(id);
    if (!o) return;
    if (mode) {
      if (o.kind !== 'node') return;
      if (mode.type === 'pick') startDraw(id);
      else if (mode.type === 'draw' && id !== mode.a) finishDraw(id);
      return;
    }
    U.open(id);
  });

  NM.on('maptap', function (latlng) {
    closeFab();
    if (mode) {
      if (mode.type === 'path') M.editInsert(latlng);
      else if (mode.type === 'draw') drawAddPoint([latlng.lat, latlng.lng]);
      return;
    }
    if (currentIs('node') || currentIs('link')) closeSheet();
  });

  /** Открывает карточку объекта и показывает его на карте. */
  U.open = function (id, zoomIn) {
    var o = D.view.get(id);
    if (!o) { U.toast('Этот объект уже удалён'); return; }
    M.select(id);
    U.show(o.kind, { id: id }, currentIs('node') || currentIs('link'));
    M.focus(id, zoomIn);
  };

  // ------------------------------------------------------------------ меню, кнопки, шапка

  function closeDrawer() { $('drawer').hidden = true; $('scrim').hidden = true; }
  function closeFab() { $('fabmenu').hidden = true; $('fab').classList.remove('open'); }

  function updateChrome() {
    var logged = !!NM.session.token, u = NM.session.user || {};
    document.body.classList.toggle('role-admin', u.role === 'admin');
    document.body.classList.toggle('role-edit', NM.canEdit());
    document.body.classList.toggle('is-native', !!NM.native);
    $('fab').hidden = !logged || !NM.canEdit() || !!mode;
    $('drawersub').textContent = logged ? (u.name || '') + ' · ' + (ROLE_NAMES[u.role] || '') : '';
    var st = D.status(), n = D.queue.length;
    $('sync').className = st;
    $('synctext').textContent = st === 'online' ? 'В сети' : st === 'syncing' ? 'Отправка ' + n : st === 'offline' ? (n ? 'Нет связи · ' + n : 'Нет связи') : '';
    $('btnLocate').classList.toggle('on', M.following && M.following());
  }

  NM.on('status', function () { updateChrome(); if (currentIs('sync')) render(); });
  NM.on('user', function () { updateChrome(); rerenderIfPassive(); });
  NM.on('presence', function () { if (currentIs('sync')) render(); });
  NM.on('locate', updateChrome);
  NM.on('objects', function () {
    if (mode && mode.type === 'path' && !D.view.has(mode.id)) { cancelMode(true); U.toast('Линию удалил другой пользователь'); }
    rerenderIfPassive();
  });
  NM.on('settings', rerenderIfPassive);
  NM.on('rejected', function (list) {
    U.toast('Сервер не принял правку: ' + list[0].error + (list.length > 1 ? ' (и ещё ' + (list.length - 1) + ')' : ''), 6000);
  });

  var actions = {
    menu: function () { closeFab(); $('drawer').hidden = false; $('scrim').hidden = false; },
    'menu-close': closeDrawer,
    close: closeSheet,
    back: back,
    show: function (d) { U.show(d.view, {}); },
    sync: function () { U.show('sync', {}); },
    layer: function () { M.setLayer(M.prefs.layer === 'osm' ? 'sat' : 'osm'); },
    locate: function () { M.locate(); },
    fit: function () { M.fitAll(); },
    fab: function () { var m = $('fabmenu'); m.hidden = !m.hidden; $('fab').classList.toggle('open', !m.hidden); },
    'add-node': function () { closeFab(); hist = []; startPlace('new'); },
    'add-link': function () {
      closeFab();
      if (D.nodes().length < 2) { U.toast('Чтобы провести линию, на карте должно быть хотя бы два узла'); return; }
      hist = []; startPick();
    },
    open: function (d) { U.open(d.id, true); },
    tab: function (d) { hist[hist.length - 1].arg.tab = d.tab; render(); },
    'set-status': function (d) {
      var o = D.view.get(d.id);
      if (o && o.data.status !== d.status) D.edit(o.kind, o.id, 'put', { status: d.status });
    },
    'edit-node': function (d) { U.show('nodeForm', { id: d.id }); },
    'edit-link': function (d) { U.show('linkForm', { id: d.id }); },
    'move-node': function (d) { startPlace('move', d.id); },
    'link-from': function (d) { startDraw(d.id); },
    'edit-path': function (d) { startPath(d.id); },
    history: function (d) { U.show('journal', { obj: d.id }); },
    'delete': function (d) {
      var o = D.view.get(d.id);
      if (!o) return;
      var n = o.kind === 'node' ? D.linksOf(o.id).length : 0;
      var text = o.kind === 'node'
        ? 'Удалить узел «' + o.data.name + '»' + (n ? ' и линии, которые к нему подведены (' + n + ')' : '') + '?'
        : 'Удалить линию «' + D.linkTitle(o) + '»?';
      U.confirm(text + ' Удаление увидят все пользователи.', 'Удалить', true).then(function (yes) {
        if (!yes || !D.view.has(o.id)) return;
        D.edit(o.kind, o.id, 'delete');
        closeSheet();
        U.toast(o.kind === 'node' ? 'Узел удалён' : 'Линия удалена');
      });
    },
    route: function (d) {
      var o = D.view.get(d.id);
      if (!o) return;
      if (NM.native) NM.native.openExternal('geo:' + o.data.lat + ',' + o.data.lng + '?q=' + o.data.lat + ',' + o.data.lng + '(' + encodeURIComponent(o.data.name) + ')');
      else window.open('https://yandex.ru/maps/?rtext=~' + o.data.lat + ',' + o.data.lng + '&rtt=auto', '_blank');
    },
    'mode-cancel': function () { cancelMode(false); },
    'mode-ok': modeOk,
    'mode-me': function () {
      if (M.myPos) M.map.setView(M.myPos, Math.max(M.map.getZoom(), 17)); else M.locate();
    },
    'path-reset': function () { mode.undo.push(mode.path); mode.path = []; M.editSet([]); updatePathBar(); },
    'path-undo': function () { if (mode.undo.length) { mode.path = mode.undo.pop(); M.editSet(mode.path); updatePathBar(); } },
    'draw-undo': function () { mode.pts.pop(); updateDraw(); },
    'draw-add': function () { if (mode.snap) finishDraw(mode.snap); else drawAddPoint(M.center()); },
    'dialog-ok': function () { if (dialogDone) dialogDone(true); },
    'dialog-cancel': function () { if (dialogDone) dialogDone(false); },
    'sync-now': function () { D.connect(); U.toast('Обновляю…', 1500); },
    'drop-queue': function () {
      U.confirm('Отменить неотправленные правки (' + D.queue.length + ')? Они будут потеряны.', 'Отменить правки', true)
        .then(function (yes) { if (yes) D.dropQueue(); });
    },
    logout: function () {
      var go = function () { closeSheet(); D.logout(); };
      if (!D.queue.length) { go(); return; }
      U.confirm('Есть неотправленные правки (' + D.queue.length + '). Они отправятся после следующего входа. Выйти?', 'Выйти')
        .then(function (yes) { if (yes) go(); });
    },
    update: function () { NM.native.openExternal(NM.session.server + apkInfo.url); },
    user: function (d) { U.show('userForm', { user: JSON.parse(d.user) }); },
    'type-add': function (d) {
      var l = LISTS.filter(function (x) { return x.key === d.list; })[0];
      document.querySelector('.tlist[data-list="' + d.list + '"]').insertAdjacentHTML('beforeend',
        typeRow(l, { id: 't' + NM.uuid().slice(0, 8), name: '', color: '#475569', dash: '' }));
      var rows = document.querySelectorAll('.tlist[data-list="' + d.list + '"] input[type=text]');
      rows[rows.length - 1].focus();
    },
    'type-del': function (d, el) { el.closest('.trow').remove(); },
    'export': function (d) { exportData(d.fmt); },
    'import-apply': function () {
      (pendingImport || []).forEach(function (p) { D.edit('node', NM.uuid(), 'put', p); });
      U.toast('Добавлено узлов: ' + (pendingImport || []).length);
      pendingImport = null; closeSheet(); M.fitAll();
    },
    'offline-save': function (d) { startDownload(+d.z); },
    'offline-cancel': function () { if (dl) dl.stop = true; },
    'offline-clear': function () {
      U.confirm('Удалить сохранённую на телефоне карту? Узлы и линии не пострадают.', 'Удалить', true)
        .then(function (yes) { if (yes) { NM.native.clearTileCache(); render(); } });
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var fn = actions[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el.dataset, el, e); }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target, kind = form.dataset.form;
    e.preventDefault();
    if (kind === 'node') submitNode(form);
    else if (kind === 'link') submitLink(form);
    else if (kind === 'user') submitUser(form);
    else if (kind === 'types') submitTypes();
    else if (kind === 'password') {
      var err = $('pwError');
      NM.api('POST', '/api/password', { old: $('pwOld').value, 'new': $('pwNew').value }).then(function () {
        U.toast('Пароль изменён'); render();
      }, function (x) { err.textContent = x.message; err.hidden = false; });
    } else if (form.id === 'loginform') doLogin();
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.dataset.filter) {
      var h = M.prefs.hidden[el.dataset.filter];
      if (el.checked) delete h[el.value]; else h[el.value] = true;
      M.savePrefs(); M.rebuild();
    } else if (el.id === 'fltLabels') {
      M.prefs.labels = el.checked; M.savePrefs(); M.updateLabels();
    } else if (el.id === 'impFile' && el.files[0]) {
      readImport(el.files[0]);
    }
  });

  $('search').addEventListener('input', NM.debounce(function () {
    var q = $('search').value;
    if (mode) return;
    if (!q.trim()) { if (currentIs('list')) closeSheet(); return; }
    if (currentIs('list')) { hist[hist.length - 1].arg.q = q; render(); } else { hist = []; U.show('list', { q: q }); $('search').value = q; }
  }, 200));

  $('search').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('search').blur(); });

  // панель на телефоне закрывается смахиванием заголовка вниз
  (function () {
    var head = $('sheethead'), sheet = $('sheet'), y0 = null, dy = 0;
    head.addEventListener('touchstart', function (e) {
      if (isWide() || e.target.closest('button')) return;
      y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none';
    }, { passive: true });
    head.addEventListener('touchmove', function (e) {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      sheet.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    var end = function () {
      if (y0 === null) return;
      y0 = null; sheet.style.transition = ''; sheet.style.transform = '';
      if (dy > 90) closeSheet();
    };
    head.addEventListener('touchend', end);
    head.addEventListener('touchcancel', end);
  })();

  function updateHint() {
    $('hint').hidden = !(NM.session.token && NM.canEdit() && !mode && !hist.length && D.connected && D.view.size === 0);
  }
  NM.on('objects', updateHint); NM.on('status', updateHint); NM.on('auth', updateHint);

  // кнопка «назад» телефона: закрывает то, что открыто поверх карты
  window.__nmBack = function () {
    if (dialogDone) { dialogDone(false); return true; }
    if (!$('login').hidden) return false;
    if (!$('fabmenu').hidden) { closeFab(); return true; }
    if (!$('drawer').hidden) { closeDrawer(); return true; }
    if (mode) { cancelMode(false); return true; }
    if (hist.length) { back(); return true; }
    return false;
  };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.__nmBack(); });
  window.addEventListener('resize', NM.debounce(function () { if (M.map) M.map.invalidateSize(); }, 150));

  // ------------------------------------------------------------------ вход

  function showLogin() {
    closeSheet(); closeDrawer(); if (mode) cancelMode(true);
    $('serverrow').hidden = NM.servedByServer;
    $('lgServer').value = NM.session.server || '';
    $('lgLogin').value = (NM.session.user && NM.session.user.login) || '';
    $('lgPass').value = '';
    $('lgError').hidden = true;
    $('lgVer').textContent = NM.native ? 'Версия приложения ' + NM.native.versionName() : '';
    $('login').hidden = false;
    document.body.classList.add('logged-out');
    if (NM.servedByServer && !NM.native) {
      NM.api('GET', '/api/info').then(function (info) {
        if (info.apk) {
          var a = $('lgApk');
          a.href = info.apk.url; a.hidden = false;
          a.textContent = 'Скачать приложение для Android (версия ' + info.apk.versionName + ')';
        }
      }, function () {});
    }
  }

  function doLogin() {
    var err = $('lgError'), btn = $('lgBtn');
    var server = NM.servedByServer ? location.origin : NM.normalizeServer($('lgServer').value);
    if (!server) { err.textContent = 'Укажите адрес сервера, например http://192.168.1.10:8790'; err.hidden = false; return; }
    var go = function () {
      btn.disabled = true; btn.textContent = 'Вход…'; err.hidden = true;
      D.login(server, $('lgLogin').value, $('lgPass').value).then(function () {
        btn.disabled = false; btn.textContent = 'Войти';
      }, function (e) {
        btn.disabled = false; btn.textContent = 'Войти';
        err.textContent = e.code === 'network'
          ? 'Сервер не отвечает. Проверьте адрес и подключение к интернету.' : e.message;
        err.hidden = false;
      });
    };
    if (server !== NM.session.server && D.queue.length) {
      U.confirm('На устройстве есть неотправленные правки для другого сервера (' + D.queue.length +
        '). При входе на новый сервер они будут потеряны. Продолжить?', 'Продолжить', true).then(function (yes) { if (yes) go(); });
    } else go();
  }

  function checkUpdate() {
    if (!NM.native) return;
    NM.api('GET', '/api/info').then(function (info) {
      apkInfo = info.apk;
      if (apkInfo && apkInfo.versionCode > NM.native.versionCode()) {
        U.toast('Доступна новая версия приложения. Обновить можно в меню «Настройки».', 6000);
      }
    }, function () {});
  }

  NM.on('auth', function () {
    if (NM.session.token) {
      $('login').hidden = true;
      document.body.classList.remove('logged-out');
      updateChrome();
      M.rebuild();
      if (!M.prefs.view) setTimeout(M.fitAll, 600);
      checkUpdate();
    } else {
      showLogin();
    }
    updateChrome();
  });

  // ------------------------------------------------------------------ запуск

  var hadSession = D.load();
  M.init();
  document.body.classList.remove('booting');
  updateChrome();
  if (hadSession) {
    NM.emit('auth');
    D.connect();
  } else {
    showLogin();
  }
})();
