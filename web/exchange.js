/* Карта сети — экспорт и импорт данных (добавка к приложению «WiFi Френель»).
 *
 * Код приложения товарища не меняется: этот файл подключается в конце страницы, добавляет в шапку
 * кнопку «Файл» и работает с тем же хранилищем, что и приложение:
 *   wf_session — точки радиолинии, частота, высота по умолчанию, лес/застройка, модель;
 *   wf_nodes   — паспорт линии ВОЛС (опора, муфта, узел, кросс);
 *   wf_hist    — история профилей.
 * Настройки вида (тема, онлайн-режим, выбранная вкладка) в файл не попадают.
 *
 * Файл — JSON: {format: "karta-seti", kind: "fresnel", version: 1, created, source, data: {...}}.
 * При импорте точки радиолинии и паспорт линии заменяются данными из файла, история дополняется.
 * Предыдущее состояние сохраняется, его можно вернуть кнопкой «Вернуть как было».
 */
(function () {
  'use strict';

  var FORMAT = 'karta-seti', KIND = 'fresnel', HIST_MAX = 25;
  var KEYS = ['wf_session', 'wf_nodes', 'wf_hist', 'karta_net', 'karta_cur'];
  var NET = window.KartaNet || null;   // постоянная карта сети (net.js)
  var PREV = 'karta_prev';
  var android = window.KartaFiles || null;
  var pc = !!window.KartaPC;

  // ------------------------------------------------------------------ данные

  function read(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }

  function current() {
    var d = { session: read('wf_session', null), nodes: read('wf_nodes', []), hist: read('wf_hist', []) };
    if (NET) d.net = NET.data();
    return d;
  }

  function pack() {
    return {
      format: FORMAT, kind: KIND, version: 2, app: 'Карта сети',
      created: Date.now(), source: android ? 'Телефон' : pc ? 'Компьютер' : 'Браузер',
      data: current()
    };
  }

  function check(p) {
    if (!p || p.format !== FORMAT) return 'Это не файл программы «Карта сети».';
    if (p.kind !== KIND || !p.data || typeof p.data !== 'object') {
      return 'Этот файл сделан другой версией «Карты сети» и сюда не подходит.';
    }
    var d = p.data;
    if (d.session != null && (typeof d.session !== 'object' || !Array.isArray(d.session.points))) return 'Файл повреждён: неверные точки радиолинии.';
    if (d.nodes != null && !Array.isArray(d.nodes)) return 'Файл повреждён: неверный паспорт линии.';
    if (d.hist != null && !Array.isArray(d.hist)) return 'Файл повреждён: неверная история.';
    if (d.net != null && (typeof d.net !== 'object' || typeof d.net.objs !== 'object')) return 'Файл повреждён: неверные данные сети.';
    return null;
  }

  function mergeHist(mine, theirs) {
    var seen = {}, out = [];
    mine.concat(theirs).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var key = it.t + '|' + JSON.stringify(it.points || []);
      if (seen[key]) return;
      seen[key] = true;
      out.push(it);
    });
    out.sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    return out.slice(0, HIST_MAX);
  }

  function hasWork(d) { return !!((d.session && d.session.points && d.session.points.length) || (d.nodes && d.nodes.length)); }
  function netCount(d) { if (!NET || !d.net) return 0; var c = NET.counts(d.net); return c.node + c.radio + c.fiber; }

  function apply(p, withWork) {
    var before = {};
    KEYS.forEach(function (k) { before[k] = localStorage.getItem(k); });
    localStorage.setItem(PREV, JSON.stringify({ saved: Date.now(), keys: before }));
    var d = p.data;
    if (withWork) {
      if (d.session) localStorage.setItem('wf_session', JSON.stringify(d.session));
      else localStorage.removeItem('wf_session');
      localStorage.setItem('wf_nodes', JSON.stringify(d.nodes || []));
      localStorage.removeItem('karta_cur');   // открытая линия больше не соответствует точкам
    }
    if (NET && d.net) NET.merge(d.net);
    localStorage.setItem('wf_hist', JSON.stringify(mergeHist(read('wf_hist', []), d.hist || [])));
    location.reload();   // приложение само восстановит точки, паспорт и историю из хранилища
  }

  function undo() {
    var prev = read(PREV, null);
    if (!prev) return;
    KEYS.forEach(function (k) {
      var v = prev.keys[k];
      if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    });
    localStorage.removeItem(PREV);
    location.reload();
  }

  // ------------------------------------------------------------------ описание данных

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function when(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes());
  }

  function netRow(d) {
    if (!NET || !d.net) return '';
    var c = NET.counts(d.net);
    return '<tr><td>Сеть</td><td>узлов ' + c.node + ', радиолиний ' + c.radio + ', ВОЛС ' + c.fiber + '</td></tr>';
  }

  function describe(d) {
    var s = d.session, pts = s && s.points ? s.points.length : 0, nodes = (d.nodes || []).length, hist = (d.hist || []).length;
    var radio = pts ? pts + ' ' + (pts === 1 ? 'точка' : pts < 5 ? 'точки' : 'точек') + (s.freq ? ', ' + esc(s.freq) + ' МГц' : '') : 'нет точек';
    var kinds = {};
    (d.nodes || []).forEach(function (n) { kinds[n.kind] = (kinds[n.kind] || 0) + 1; });
    var fiber = nodes ? nodes + ' (' + Object.keys(kinds).map(function (k) { return esc(k) + ' ' + kinds[k]; }).join(', ') + ')' : 'пусто';
    return '<table class="kx-t"><tr><td>Радиолиния</td><td>' + radio + '</td></tr>' +
      '<tr><td>Паспорт линии</td><td>' + fiber + '</td></tr>' +
      '<tr><td>История профилей</td><td>' + (hist || 'пусто') + '</td></tr>' + netRow(d) + '</table>';
  }

  // ------------------------------------------------------------------ окно

  var css = document.createElement('style');
  css.textContent =
    '#kartaEx{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:2100;align-items:center;justify-content:center}' +
    '#kartaEx.show{display:flex}' +
    '#kartaExBox{background:var(--panel);color:var(--text);width:92vw;max-width:520px;max-height:86vh;overflow:auto;border-radius:10px;padding:14px;font-size:14px;line-height:1.4}' +
    '#kartaExBox h3{font-size:15px;margin:12px 0 6px}' +
    '#kartaExBox p{margin:6px 0}' +
    '#kartaExBox .kx-row{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}' +
    '#kartaExBox button{border:0;border-radius:6px;padding:9px 12px;font-size:14px;font-weight:600;background:var(--accent);color:#fff}' +
    '#kartaExBox button.kx-2{background:transparent;color:var(--accent);border:1px solid var(--accent)}' +
    '#kartaExBox .kx-muted{color:var(--muted);font-size:13px}' +
    '#kartaExBox .kx-msg{background:var(--card);border-radius:8px;padding:8px 10px;margin:8px 0}' +
    '#kartaExBox .kx-chk{display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:14px;color:var(--text)}' +
    '#kartaExBox .kx-chk input{margin-top:3px}' +
    '#kartaExBox .kx-warn{background:var(--warnbg);border-radius:8px;padding:8px 10px;margin:8px 0}' +
    '.kx-t{border-collapse:collapse;width:100%;margin:4px 0}.kx-t td{padding:4px 6px 4px 0;border-bottom:1px solid var(--line);vertical-align:top}' +
    '.kx-t td:first-child{color:var(--muted);width:42%}' +
    '#kartaEx>.x{display:none}';
  document.head.appendChild(css);

  var wrap = document.createElement('div');
  wrap.id = 'kartaEx';
  wrap.innerHTML = '<button class="x" type="button" data-kx="close">&times;</button><div id="kartaExBox"></div>';
  document.body.appendChild(wrap);
  var box = wrap.querySelector('#kartaExBox');

  var picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.json,application/json';
  picker.style.display = 'none';
  document.body.appendChild(picker);

  var pending = null;   // файл, ожидающий подтверждения импорта
  var note = '';        // сообщение после действия

  function render() {
    var html = '<div class="kx-head"><b>Обмен данными</b><button type="button" class="kx-close" data-kx="close" title="Закрыть">&#10005;</button></div>';
    if (note) html += '<div class="kx-msg">' + note + '</div>';
    if (pending) {
      html += '<h3>Загрузить данные из файла?</h3>' +
        '<p class="kx-muted">' + esc(pending.name || 'файл') + ' · ' + esc(pending.pkg.source || '') + ', ' + when(pending.pkg.created) + '</p>' +
        describe(pending.pkg.data) + importNote(pending.pkg.data) +
        '<div class="kx-row"><button type="button" data-kx="apply">Загрузить</button>' +
        '<button type="button" class="kx-2" data-kx="cancel">Отмена</button></div>';
      box.innerHTML = html;
      return;
    }
    html += '<h3>Сейчас в приложении</h3>' + describe(current());
    html += '<h3>Экспорт</h3><p class="kx-muted">Сохранить сеть (узлы и линии), текущую работу и историю в файл — чтобы переслать ' +
      'или открыть на другом телефоне или компьютере.</p><div class="kx-row">' +
      (android ? '<button type="button" data-kx="share">Поделиться файлом</button>' : '') +
      '<button type="button"' + (android ? ' class="kx-2"' : '') + ' data-kx="save">Сохранить в файл</button></div>';
    html += '<h3>Импорт</h3><div class="kx-row"><button type="button" data-kx="open">Открыть файл</button></div>';
    if (android) html += '<p class="kx-muted">Или в мессенджере нажмите на файл → «Открыть с помощью» → «Карта сети».</p>';
    var prev = read(PREV, null);
    if (prev) {
      html += '<h3>Отмена импорта</h3><p class="kx-muted">Вернуть данные, которые были до загрузки файла (' + when(prev.saved) + ').</p>' +
        '<div class="kx-row"><button type="button" class="kx-2" data-kx="undo">Вернуть как было</button></div>';
    }
    box.innerHTML = html;
  }

  function importNote(d) {
    var html = '', net = netCount(d);
    if (NET && d.net) {
      var r = NET.preview(d.net);
      html += '<div class="kx-msg">Сеть объединится с вашей: новых объектов ' + r.added + ', изменённых ' + r.changed +
        (r.deleted ? ', удалённых ' + r.deleted : '') + '. Ваши правки, сделанные позже, сохранятся.</div>';
    }
    if (hasWork(d)) {
      html += '<label class="kx-chk"><input type="checkbox" id="kxWork"' + (net ? '' : ' checked') + '> ' +
        'Загрузить и текущую работу из файла: точки радиолинии и паспорт линии заменят открытые сейчас</label>';
    }
    return html + '<div class="kx-warn">История профилей дополнится. Если что-то не так, всё можно вернуть кнопкой «Вернуть как было».</div>';
  }

  function show() { wrap.classList.add('show'); render(); }
  function hide() { wrap.classList.remove('show'); pending = null; note = ''; }

  function fileName() { return 'karta-seti-' + stamp() + '.json'; }

  function download(name, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function received(name, text) {
    var p = null;
    try { p = JSON.parse(text); } catch (e) { p = null; }
    var problem = check(p);
    wrap.classList.add('show');
    if (problem) { pending = null; note = esc(problem); render(); return; }
    note = '';
    pending = { name: name, pkg: p };
    render();
  }

  wrap.addEventListener('click', function (e) {
    var b = e.target.closest('[data-kx]');
    if (!b) { if (e.target === wrap) hide(); return; }
    var act = b.getAttribute('data-kx'), text;
    if (act === 'close') hide();
    else if (act === 'share') {
      text = JSON.stringify(pack());
      note = android.shareText(fileName(), text) ? 'Выберите, куда отправить файл.' : 'Не удалось подготовить файл.';
      render();
    } else if (act === 'save') {
      text = JSON.stringify(pack());
      if (android) android.saveText(fileName(), text);
      else { download(fileName(), text); note = 'Файл сохранён в папку «Загрузки».'; render(); }
    } else if (act === 'open') {
      if (android) android.openFile(); else picker.click();
    } else if (act === 'apply') {
      if (pending) { var w = box.querySelector('#kxWork'); apply(pending.pkg, w ? w.checked : false); }
    } else if (act === 'cancel') {
      pending = null; render();
    } else if (act === 'undo') {
      undo();
    }
  });

  picker.addEventListener('change', function () {
    var f = picker.files && picker.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { received(f.name, String(r.result)); };
    r.readAsText(f, 'utf-8');
    picker.value = '';
  });

  // ответы оболочки Android
  window.__kartaSaved = function (ok) { note = ok ? 'Файл сохранён.' : 'Файл не сохранён.'; render(); };
  window.__kartaOpened = function () {
    var err = android.takeOpenedError(), name = android.takeOpenedName(), text = android.takeOpenedText();
    if (err || text == null) { wrap.classList.add('show'); pending = null; note = 'Не удалось открыть файл' + (err ? ': ' + esc(err) : '') + '.'; render(); return; }
    received(name, text);
  };

  // кнопка в шапке, рядом с «История»
  var hist = document.getElementById('btnHist');
  var btn = document.createElement('button');
  btn.id = 'btnFile';
  btn.type = 'button';
  btn.textContent = 'Файл';
  btn.onclick = show;
  if (hist && hist.parentNode) {
    hist.parentNode.insertBefore(btn, hist.nextSibling);
    hist.parentNode.insertBefore(document.createTextNode(' '), btn);   // как между остальными кнопками
  }
  else document.body.appendChild(btn);

  if (android && android.ready) android.ready();
})();
