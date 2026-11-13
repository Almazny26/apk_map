/* Карта сети — оформление для компьютера.
 *
 * Подключается программой run.py в конце страницы (после кода приложения и exchange.js), только на
 * компьютере. Страница приложения не меняется: её панели переносятся в окна поверх карты.
 *   - карта на всё окно программы;
 *   - окна «Радиолиния» / «ВОЛС», «Профиль», «История», «Обмен данными», «Текст» можно перетаскивать
 *     за заголовок, растягивать за края и углы, сворачивать, разворачивать двойным щелчком;
 *   - положение и размер окон запоминаются (karta_pc_layout в data\state.json);
 *   - профиль рисуется по размеру своего окна и перерисовывается при растягивании;
 *   - строка состояния внизу: сообщения программы, координаты под курсором (WGS-84 и СК-42), масштаб;
 *   - Esc отменяет постановку точки или закрывает верхнее окно;
 *   - «Отправить» и «Текст паспорта» открывают окно с текстом: скопировать, сохранить, письмо.
 */
(function () {
  'use strict';
  if (!window.KartaPC || !window.L || typeof map === 'undefined') return;

  var HEADER = 48, STATUS = 26, LAYOUT = 'karta_pc_layout';
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------ стили

  var css = document.createElement('style');
  css.textContent = [
    'body.pc{overflow:hidden}',
    'body.pc button{cursor:pointer}',
    'body.pc button:hover{filter:brightness(1.1)}',
    'body.pc button:active{filter:brightness(.92)}',
    'body.pc input:focus,body.pc select:focus{outline:2px solid var(--accent);outline-offset:-1px}',
    'body.pc header{user-select:none}',
    'body.pc header>span:last-child{display:flex;gap:6px;align-items:center}',
    'body.pc header button{padding:6px 12px;font-size:13px;font-weight:600}',
    'body.pc #map{bottom:' + STATUS + 'px}',
    'body.pc #toggle,body.pc #modal{display:none!important}',
    'body.pc #mapKinds{top:' + (HEADER + 10) + 'px;right:10px}',
    'body.pc #mapKinds button{padding:7px 12px;font-size:13px}',
    'body:has(#addA.active) #map,body:has(#addB.active) #map,body:has(#addMore.active) #map,body:has(#nodeArm.active) #map{cursor:crosshair}',
    'body:has(#addA.active) #map .leaflet-interactive,body:has(#addB.active) #map .leaflet-interactive{cursor:crosshair}',

    // окна
    '.pcw{position:fixed;display:flex;flex-direction:column;background:var(--panel);color:var(--text);' +
      'border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.28),0 1px 4px rgba(0,0,0,.2);' +
      'min-width:220px;min-height:34px;overflow:hidden}',
    '.pcw.pcw-hide{display:none!important}',
    '.pcw.pcw-front{box-shadow:0 12px 36px rgba(0,0,0,.36),0 1px 4px rgba(0,0,0,.2)}',
    '.pcw-title{flex:0 0 34px;display:flex;align-items:center;gap:4px;padding:0 4px 0 12px;background:var(--accent);color:#fff;' +
      'font-size:13px;font-weight:700;cursor:move;user-select:none;touch-action:none}',
    'body.dark .pcw-title{background:#23415f}',
    '.pcw:not(.pcw-front) .pcw-title{filter:saturate(.55)}',
    '.pcw-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pcw-title button{width:28px;height:26px;padding:0;border:0;border-radius:5px;background:transparent;color:#fff;font-size:15px;line-height:26px}',
    '.pcw-title button:hover{background:rgba(255,255,255,.2);filter:none}',
    '.pcw-title button.pcw-x:hover{background:#c62828}',
    '.pcw-body{flex:1;min-height:0;overflow:auto;position:relative}',
    '.pcw.pcw-min{height:auto!important;min-height:0}',
    '.pcw.pcw-min .pcw-body,.pcw.pcw-min .pcw-h{display:none}',
    '.pcw-h{position:absolute;z-index:2}',
    '.pcw-h.n{top:-3px;left:8px;right:8px;height:7px;cursor:ns-resize}',
    '.pcw-h.s{bottom:-3px;left:8px;right:8px;height:7px;cursor:ns-resize}',
    '.pcw-h.e{right:-3px;top:8px;bottom:8px;width:7px;cursor:ew-resize}',
    '.pcw-h.w{left:-3px;top:8px;bottom:8px;width:7px;cursor:ew-resize}',
    '.pcw-h.ne{right:-3px;top:-3px;width:12px;height:12px;cursor:nesw-resize}',
    '.pcw-h.sw{left:-3px;bottom:-3px;width:12px;height:12px;cursor:nesw-resize}',
    '.pcw-h.nw{left:-3px;top:-3px;width:12px;height:12px;cursor:nwse-resize}',
    '.pcw-h.se{right:-3px;bottom:-3px;width:14px;height:14px;cursor:nwse-resize}',
    '.pcw-h.se::after{content:"";position:absolute;right:5px;bottom:5px;width:7px;height:7px;' +
      'border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);opacity:.6}',
    'body.pcw-busy,body.pcw-busy *{user-select:none!important}',

    // панели приложения внутри окна
    '#pcTool .panel{position:static;max-height:none;overflow:visible;border:0;transform:none;transition:none;padding:10px 12px}',
    '#pcTool .panel.off{display:none}',
    '#pcTool .pt{overflow:hidden}',
    '#pcTool #status:empty{display:none}',
    '#pcTool #status{background:var(--card);border-radius:6px;padding:6px 8px;margin:6px 0}',

    // профиль
    '#pcProfile .pcw-body{overflow:hidden;background:#fff}',
    'body.dark #pcProfile .pcw-body{background:#101418}',
    '#pcProfile canvas{display:block;width:100%;height:100%;margin:0;border:0;border-radius:0;cursor:zoom-in}',
    '#pcProfile.pcw-max canvas{cursor:zoom-out}',
    '#pcProfileEmpty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;padding:20px;text-align:center}',

    // диалоги приложения (история, обмен данными) — окна без затемнения экрана
    '#hist.pcw,#kartaEx.pcw{inset:auto;background:var(--panel);align-items:stretch;justify-content:flex-start}',
    '#hist.pcw:not(.show),#kartaEx.pcw:not(.show){display:none}',
    '#hist.pcw.show,#kartaEx.pcw.show{display:flex}',
    '#hist.pcw .x,#kartaEx.pcw>.pcw-body>.x{display:none}',
    '#hist.pcw #histBox,#kartaEx.pcw #kartaExBox{width:auto;max-width:none;max-height:none;overflow:visible;border-radius:0;padding:10px 14px}',
    '#hist.pcw #histBox>b:first-child{display:none}',
    '#hist.pcw .hist-item button{margin-top:4px}',

    // окно с текстом
    '#pcText .pcw-body{display:flex;flex-direction:column;gap:8px;padding:10px 12px}',
    '#pcText textarea{flex:1;min-height:80px;resize:none;font:13px/1.45 Consolas,"Courier New",monospace;padding:8px;' +
      'border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text)}',
    '#pcText .row{margin:0}',
    '#pcText .pc-note{font-size:12px;color:var(--muted)}',

    // строка состояния
    '#pcBar{position:fixed;left:0;right:0;bottom:0;height:' + STATUS + 'px;display:flex;align-items:center;gap:14px;padding:0 10px;' +
      'background:var(--panel);color:var(--muted);border-top:1px solid var(--line);font-size:12px;z-index:100000;user-select:none}',
    '#pcBarMsg{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}',
    '#pcBarPos{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '#pcBar a{color:var(--accent);cursor:pointer;white-space:nowrap}',
    '#pcBar a:hover{text-decoration:underline}',
    'body.pc .leaflet-bottom{bottom:4px}'
  ].join('\n');
  document.head.appendChild(css);
  document.body.classList.add('pc');

  // ------------------------------------------------------------------ раскладка окон

  var layout = {};
  try { layout = JSON.parse(localStorage.getItem(LAYOUT) || '{}') || {}; } catch (e) { layout = {}; }
  function saveLayout() {
    var all = {};
    wins.forEach(function (w) {
      all[w.key] = { x: w.g.x, y: w.g.y, w: w.g.w, h: w.g.h, min: w.min, max: w.max, prev: w.prev || null };
    });
    layout = all;
    try { localStorage.setItem(LAYOUT, JSON.stringify(all)); } catch (e) { /* не важно */ }
  }

  function area() {
    return { x: 0, y: HEADER, w: window.innerWidth, h: window.innerHeight - HEADER - STATUS };
  }

  var wins = [], zTop = 1200;

  /* Делает окно из элемента el (или нового элемента, если el не передан).
   * opt: key, title, def() → {x,y,w,h}, minW, minH, close (функция или null), noMax */
  function makeWin(el, opt) {
    var frame = el || document.createElement('div');
    frame.classList.add('pcw');
    var body = document.createElement('div');
    body.className = 'pcw-body';
    while (frame.firstChild) body.appendChild(frame.firstChild);

    var title = document.createElement('div');
    title.className = 'pcw-title';
    title.innerHTML = '<span class="pcw-name"></span>' +
      '<button type="button" class="pcw-m" title="Свернуть">&#8211;</button>' +
      (opt.noMax ? '' : '<button type="button" class="pcw-f" title="Развернуть">&#9633;</button>') +
      (opt.close ? '<button type="button" class="pcw-x" title="Закрыть (Esc)">&#10005;</button>' : '');
    frame.appendChild(title);
    frame.appendChild(body);
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (d) {
      var h = document.createElement('div');
      h.className = 'pcw-h ' + d;
      h.dataset.dir = d;
      frame.appendChild(h);
    });
    if (!el) document.body.appendChild(frame);

    var saved = layout[opt.key] || {};
    var w = {
      key: opt.key, el: frame, body: body, title: title, opt: opt,
      g: saved.w ? { x: saved.x, y: saved.y, w: saved.w, h: saved.h } : opt.def(),
      min: !!saved.min, max: !!saved.max, prev: saved.prev || null
    };
    w.setTitle = function (t) { title.querySelector('.pcw-name').textContent = t; };
    w.setTitle(opt.title);
    wins.push(w);

    title.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      front(w);
      if (w.max) return;
      drag(e, w, 'move');
    });
    title.addEventListener('dblclick', function (e) {
      if (e.target.closest('button') || opt.noMax) return;
      toggleMax(w);
    });
    frame.addEventListener('pointerdown', function (e) {
      var dir = e.target.dataset && e.target.dataset.dir;
      front(w);
      if (dir && e.button === 0 && !w.max) drag(e, w, dir);
    }, true);
    title.querySelector('.pcw-m').onclick = function () { setMin(w, !w.min); };
    if (!opt.noMax) title.querySelector('.pcw-f').onclick = function () { toggleMax(w); };
    if (opt.close) title.querySelector('.pcw-x').onclick = function () { opt.close(w); };

    fit(w);
    return w;
  }

  function clamp(w) {
    var a = area(), g = w.g;
    g.w = Math.max(w.opt.minW || 260, Math.min(g.w, a.w));
    g.h = Math.max(w.opt.minH || 140, Math.min(g.h, a.h));
    g.x = Math.max(a.x - g.w + 90, Math.min(g.x, a.x + a.w - 90));
    g.y = Math.max(a.y, Math.min(g.y, a.y + a.h - 34));
  }

  function apply(w) {
    var s = w.el.style, g = w.g;
    if (w.max) {
      var a = area();
      s.left = a.x + 'px'; s.top = a.y + 'px'; s.width = a.w + 'px'; s.height = a.h + 'px';
    } else {
      clamp(w);
      s.left = g.x + 'px'; s.top = g.y + 'px'; s.width = g.w + 'px'; s.height = g.h + 'px';
    }
    w.el.classList.toggle('pcw-min', w.min);
    w.el.classList.toggle('pcw-max', w.max);
    var m = w.title.querySelector('.pcw-m');
    m.innerHTML = w.min ? '&#9634;' : '&#8211;';
    m.title = w.min ? 'Развернуть окно' : 'Свернуть';
    var f = w.title.querySelector('.pcw-f');
    if (f) { f.innerHTML = w.max ? '&#10064;' : '&#9633;'; f.title = w.max ? 'Вернуть размер' : 'Развернуть на весь экран'; }
    if (w.opt.onResize) w.opt.onResize(w);
  }

  function front(w) {
    if (w.el.style.zIndex == zTop) return;
    w.el.style.zIndex = ++zTop;
    wins.forEach(function (o) { o.el.classList.toggle('pcw-front', o === w); });
  }

  function setMin(w, on) { w.min = on; if (on) w.max = false; apply(w); saveLayout(); }
  function toggleMax(w) {
    w.max = !w.max;
    if (w.max) w.min = false;
    apply(w); saveLayout();
  }

  function shown(w) {
    return !w.el.classList.contains('pcw-hide') && getComputedStyle(w.el).display !== 'none';
  }
  function showWin(w) {
    w.el.classList.remove('pcw-hide');
    if (w.min) w.min = false;
    apply(w);
    front(w);
  }
  function hideWin(w) { w.el.classList.add('pcw-hide'); }

  function drag(e, w, dir) {
    e.preventDefault();
    var sx = e.clientX, sy = e.clientY, g0 = { x: w.g.x, y: w.g.y, w: w.g.w, h: w.g.h };
    var minW = w.opt.minW || 260, minH = w.opt.minH || 140, src = e.target;
    try { src.setPointerCapture(e.pointerId); } catch (er) { /* старый движок */ }
    document.body.classList.add('pcw-busy');
    function move(ev) {
      var dx = ev.clientX - sx, dy = ev.clientY - sy, g = w.g;
      if (dir === 'move') { g.x = g0.x + dx; g.y = g0.y + dy; }
      else {
        if (dir.indexOf('e') >= 0) g.w = Math.max(minW, g0.w + dx);
        if (dir.indexOf('s') >= 0) g.h = Math.max(minH, g0.h + dy);
        if (dir.indexOf('w') >= 0) { g.w = Math.max(minW, g0.w - dx); g.x = g0.x + g0.w - g.w; }
        if (dir.indexOf('n') >= 0) {
          g.h = Math.max(minH, g0.h - dy); g.y = g0.y + g0.h - g.h;
          if (g.y < HEADER) { g.h -= HEADER - g.y; g.y = HEADER; }
        }
      }
      apply(w);
    }
    function up() {
      src.removeEventListener('pointermove', move);
      src.removeEventListener('pointerup', up);
      src.removeEventListener('pointercancel', up);
      document.body.classList.remove('pcw-busy');
      saveLayout();
    }
    src.addEventListener('pointermove', move);
    src.addEventListener('pointerup', up);
    src.addEventListener('pointercancel', up);
  }

  function fit(w) {
    var a = area(), g = w.g;
    if (g.y + g.h > a.y + a.h) g.y = Math.max(a.y, a.y + a.h - g.h);
    if (g.y + g.h > a.y + a.h) g.h = a.y + a.h - g.y;
    if (g.x + g.w > a.x + a.w) g.x = Math.max(a.x, a.x + a.w - g.w);
    if (g.x < a.x) g.x = a.x;
    apply(w);
  }
  window.addEventListener('resize', function () {
    wins.forEach(function (w) { fit(w); });
  });

  // ------------------------------------------------------------------ окно инструментов (Радио / ВОЛС)

  var tool = makeWin(null, {
    key: 'tool', title: 'Радиолиния', minW: 330, minH: 160,
    def: function () { var a = area(); return { x: 10, y: a.y + 10, w: 440, h: a.h - 20 }; }
  });
  tool.el.id = 'pcTool';
  tool.body.appendChild($('panel'));
  tool.body.appendChild($('panelFiber'));
  function toolTitle() {
    tool.setTitle($('panel').classList.contains('off') ? 'ВОЛС — паспорт линии и расчёт кабеля' : 'Радиолиния — профиль и оборудование');
  }
  toolTitle();
  new MutationObserver(toolTitle).observe($('panel'), { attributes: true, attributeFilter: ['class'] });
  ['tabRadio', 'tabFiber'].forEach(function (id) {
    $(id).addEventListener('click', function () { showWin(tool); });
  });
  front(tool);

  // ------------------------------------------------------------------ окно профиля

  var canvas = $('profile');
  var profile = makeWin(null, {
    key: 'profile', title: 'Профиль радиолинии', minW: 360, minH: 200,
    def: function () {
      var a = area(), x = 460, w = Math.max(420, Math.min(980, a.w - x - 70)), h = Math.min(400, Math.round(a.h * 0.45));
      return { x: x, y: a.y + a.h - h - 10, w: w, h: h };
    },
    close: function (w) { hideWin(w); saveLayout(); },
    onResize: function () { redrawSoon(); }
  });
  profile.el.id = 'pcProfile';
  profile.body.appendChild(canvas);
  var empty = document.createElement('div');
  empty.id = 'pcProfileEmpty';
  empty.textContent = 'Поставьте точки A и B и нажмите «Рассчитать профиль».';
  profile.body.appendChild(empty);
  hideWin(profile);

  function hasProfile() { return typeof lastProfile !== 'undefined' && !!lastProfile; }
  function syncEmpty() { empty.style.display = hasProfile() ? 'none' : 'flex'; }

  // профиль рисуется по размеру окна
  var setupOrig = window.setupCanvas;
  window.setupCanvas = function (c, modal) {
    if (c !== canvas) return setupOrig(c, modal);
    // dpr 1 и крупные подписи (режим «modal» приложения): окно профиля большое, текст должен читаться
    var r = profile.body.getBoundingClientRect(), dpr = 1;
    var cssW = Math.max(300, Math.round(r.width) || 640), cssH = Math.max(160, Math.round(r.height) || 300);
    c.width = Math.floor(cssW * dpr);
    c.height = Math.floor(cssH * dpr);
    c.style.width = '100%';
    c.style.height = '100%';
    return { w: c.width, h: c.height, dpr: dpr };
  };
  var drawOrig = window.draw;
  window.draw = function (p, target) {
    if (!target || target === canvas) {
      if (!shown(profile)) showWin(profile);
      empty.style.display = 'none';
      return drawOrig(p, canvas);
    }
    return drawOrig(p, target);
  };
  var pending = 0;
  function redrawSoon() {
    if (pending) return;
    pending = requestAnimationFrame(function () {
      pending = 0;
      if (hasProfile() && shown(profile) && !profile.min) drawOrig(lastProfile, canvas);
    });
  }
  if (window.ResizeObserver) new ResizeObserver(redrawSoon).observe(profile.body);
  canvas.onclick = function () { if (hasProfile()) toggleMax(profile); };
  canvas.title = 'Щелчок — на весь экран и обратно';
  $('clear').addEventListener('click', function () { setTimeout(syncEmpty, 0); });
  syncEmpty();

  // кнопка «Профиль» в окне радиолинии, чтобы вернуть закрытое окно
  var showBtn = document.createElement('button');
  showBtn.type = 'button';
  showBtn.className = 'secondary';
  showBtn.textContent = 'Окно профиля';
  showBtn.onclick = function () { showWin(profile); syncEmpty(); redrawSoon(); };
  $('share').parentNode.appendChild(showBtn);

  // ------------------------------------------------------------------ история и обмен данными

  function dialogWin(el, key, title, closeBtn, size) {
    var w = makeWin(el, {
      key: key, title: title, minW: 320, minH: 200, noMax: false,
      def: function () {
        var a = area(), ww = Math.min(size[0], a.w - 40), hh = Math.min(size[1], a.h - 40);
        return { x: Math.round((a.w - ww) / 2), y: a.y + Math.round((a.h - hh) / 3), w: ww, h: hh };
      },
      close: function () { closeBtn().click(); }
    });
    new MutationObserver(function () {
      if (el.classList.contains('show')) { if (w.min) { w.min = false; } apply(w); front(w); }
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
    return w;
  }
  var histWin = dialogWin($('hist'), 'hist', 'История профилей', function () { return $('histClose'); }, [560, 620]);
  var fileWin = $('kartaEx') ? dialogWin($('kartaEx'), 'file', 'Обмен данными', function () {
    return $('kartaEx').querySelector('[data-kx=close]');
  }, [540, 560]) : null;

  // ------------------------------------------------------------------ окно с текстом (вместо письма)

  var textWin = makeWin(null, {
    key: 'text', title: 'Текст', minW: 360, minH: 220,
    def: function () {
      var a = area(), ww = Math.min(620, a.w - 40), hh = Math.min(420, a.h - 40);
      return { x: Math.round((a.w - ww) / 2), y: a.y + Math.round((a.h - hh) / 3), w: ww, h: hh };
    },
    close: function (w) { hideWin(w); }
  });
  textWin.el.id = 'pcText';
  textWin.body.innerHTML =
    '<textarea id="pcTextArea" readonly spellcheck="false"></textarea>' +
    '<div class="row"><button type="button" id="pcCopy">Копировать</button>' +
    '<button type="button" class="secondary" id="pcSaveTxt">Сохранить в файл</button>' +
    '<button type="button" class="secondary" id="pcMail">Открыть в почте</button>' +
    '<span class="pc-note" id="pcTextNote"></span></div>';
  hideWin(textWin);
  var textSubject = '', textFile = 'text';
  function openText(subject, text, fileBase) {
    textSubject = subject; textFile = fileBase;
    textWin.setTitle(subject);
    $('pcTextArea').value = text;
    $('pcTextNote').textContent = '';
    showWin(textWin);
    $('pcTextArea').focus();
    $('pcTextArea').select();
  }
  $('pcCopy').onclick = function () {
    var t = $('pcTextArea').value, note = $('pcTextNote');
    function done() { note.textContent = 'Скопировано'; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, function () { $('pcTextArea').select(); document.execCommand('copy'); done(); });
    } else { $('pcTextArea').select(); document.execCommand('copy'); done(); }
  };
  $('pcSaveTxt').onclick = function () {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = textFile + '-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.txt';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + $('pcTextArea').value.replace(/\n/g, '\r\n')], { type: 'text/plain' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    $('pcTextNote').textContent = 'Сохранено в «Загрузки»: ' + name;
  };
  $('pcMail').onclick = function () {
    window.location.href = 'mailto:?subject=' + encodeURIComponent(textSubject) + '&body=' + encodeURIComponent($('pcTextArea').value);
  };

  // те же тексты, что приложение отправляет письмом на телефоне
  $('share').onclick = function () {
    if (points.length < 2) { status('Сначала поставьте точки A и B'); return; }
    var lines = points.map(function (p, i) {
      var sk = toSK42(p.lat, p.lng);
      return letter(i) + ': ' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + ' h=' + p.height + 'м SK-42 X=' + sk.x + ' Y=' + sk.y;
    });
    var text = 'Профиль радиолинка\n' + lines.join('\n') + '\nЧастота: ' + $('freq').value + ' МГц\nМодель: ' + $('device').selectedOptions[0].text;
    openText('Профиль радиолинка', text, 'radiolinia');
  };
  $('nodeShare').onclick = function () {
    if (!nodes.length) { status('Паспорт пуст: поставьте точки линии'); return; }
    var lines = nodes.map(function (p, i) {
      var sk = toSK42(p.lat, p.lng);
      return (i + 1) + '. ' + p.kind + ' ' + (p.name || '') + ' SK-42 X=' + sk.x + ' Y=' + sk.y;
    });
    openText('Паспорт линии', lines.join('\n'), 'pasport-linii');
  };

  // ------------------------------------------------------------------ строка состояния

  var bar = document.createElement('div');
  bar.id = 'pcBar';
  bar.innerHTML = '<span id="pcBarMsg"></span><span id="pcBarPos"></span><a id="pcBarReset" title="Вернуть окна на места по умолчанию">Окна по умолчанию</a>';
  document.body.appendChild(bar);
  var st = $('status');
  function mirror() { $('pcBarMsg').textContent = st.textContent; }
  new MutationObserver(mirror).observe(st, { childList: true, characterData: true, subtree: true });
  mirror();

  var posFrame = 0, lastPos = null;
  function showPos() {
    posFrame = 0;
    var el = $('pcBarPos'), z = 'масштаб ' + map.getZoom();
    if (!lastPos) { el.textContent = z; return; }
    var sk = toSK42(lastPos.lat, lastPos.lng);
    el.textContent = lastPos.lat.toFixed(5) + ', ' + lastPos.lng.toFixed(5) + '   СК-42 X=' + sk.x + ' Y=' + sk.y + '   ' + z;
  }
  map.on('mousemove', function (e) { lastPos = e.latlng; if (!posFrame) posFrame = requestAnimationFrame(showPos); });
  map.on('mouseout', function () { lastPos = null; showPos(); });
  map.on('zoomend', showPos);
  showPos();

  $('pcBarReset').onclick = function () {
    wins.forEach(function (w) { w.g = w.opt.def(); w.min = false; w.max = false; apply(w); });
    saveLayout();
  };

  // ------------------------------------------------------------------ карта и клавиатура

  map.zoomControl.setPosition('bottomright');
  L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
  setTimeout(function () { map.invalidateSize(); }, 50);

  function cancelPlacing() {
    var any = false;
    ['addA', 'addB', 'addMore', 'nodeArm'].forEach(function (id) {
      if ($(id).classList.contains('active')) { $(id).classList.remove('active'); any = true; }
    });
    if (typeof mode !== 'undefined' && mode) { mode = null; any = true; }
    if (typeof armNode !== 'undefined' && armNode) { armNode = false; any = true; }
    if (any) status('Постановка точки отменена');
    return any;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (cancelPlacing()) return;
    var top = null;
    wins.forEach(function (w) {
      if (w.opt.close && shown(w) && (!top || (+w.el.style.zIndex || 0) > (+top.el.style.zIndex || 0))) top = w;
    });
    if (top) top.opt.close(top);
  });
  // щелчок по карте поднимает окно инструментов над остальными не нужен — карта остаётся под окнами
})();
