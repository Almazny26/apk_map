/* Карта сети — нижняя шторка вместо половины экрана (телефон).
 *
 * Подключается в конце страницы. Панели «Сеть», «Радио», «ВОЛС» собираются в одну шторку поверх
 * карты, как в приложениях карт: карта всегда на весь экран, шторку тянут за ручку.
 *   - три положения: свёрнута (видно заголовок и последнее сообщение), половина, почти весь экран;
 *   - тянуть пальцем за ручку и заголовок; смахнуть вниз, когда список прокручен к началу;
 *     быстрый взмах переводит в следующее положение; нажатие на ручку — свернуть или раскрыть;
 *   - пока ставится точка («Точка A», «Поставить», «Добавить узел»), шторка уходит вниз, после
 *     постановки возвращается;
 *   - после расчёта профиля и при переходе по вкладкам шторка раскрывается;
 *   - кнопки карты и подпись источника поднимаются над шторкой.
 * На компьютере не используется: там панели — окна (pc-ui.js).
 */
(function () {
  'use strict';
  if (window.KartaPC || !window.L || typeof map === 'undefined') return;

  var HEADER = 48, PEEK = 76, STATE = 'karta_sheet';
  var $ = function (id) { return document.getElementById(id); };

  var css = document.createElement('style');
  css.textContent = [
    '#toggle{display:none!important}',
    '#sheet{position:fixed;left:0;right:0;bottom:0;z-index:1050;display:flex;flex-direction:column;background:var(--panel);color:var(--text);' +
      'border-radius:16px 16px 0 0;box-shadow:0 -4px 22px rgba(0,0,0,.25);will-change:transform;touch-action:none}',
    '#sheet.anim{transition:transform .28s cubic-bezier(.2,.8,.2,1)}',
    '#sheetHead{flex:0 0 auto;padding:6px 16px 8px;cursor:grab;user-select:none;-webkit-user-select:none}',
    '#sheetGrip{width:40px;height:5px;border-radius:3px;background:var(--line);margin:0 auto 8px}',
    'body.dark #sheetGrip{background:#4a525c}',
    '#sheetTitle{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px}',
    '#sheetTitle span{flex:1}',
    '#sheetTitle button{background:transparent;color:var(--accent);border:1px solid var(--line);border-radius:14px;padding:3px 10px;font-size:13px}',
    '#sheetMsg{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;min-height:17px}',
    '#sheetBody{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y}',
    '#sheet .panel{position:static;max-height:none;overflow:visible;border:0;transform:none;transition:none;padding:0 14px 14px;background:transparent}',
    '#sheet .panel.off{display:none}',
    '#sheet .panel>b:first-child{display:none}',
    '#sheet .panel button{padding:8px 11px;font-size:14px}',
    '#sheet .panel input,#sheet .panel select{padding:7px 8px;font-size:14px}',
    '#sheet #status:empty{display:none}',
    '#sheet #status{background:var(--card);border-radius:8px;padding:6px 8px}',
    '.leaflet-bottom{transition:bottom .28s cubic-bezier(.2,.8,.2,1);bottom:var(--sheet-h,0px)}',
    '@media (min-width:760px){#sheet{right:auto;width:440px;left:8px;border-radius:16px 16px 0 0}.leaflet-bottom.leaflet-right{bottom:0}}'
  ].join('\n');
  document.head.appendChild(css);

  // ---------------------------------------------------------------- шторка

  var sheet = document.createElement('div');
  sheet.id = 'sheet';
  sheet.innerHTML = '<div id="sheetHead"><div id="sheetGrip"></div><div id="sheetTitle"><span></span><button type="button" id="sheetBtn"></button></div>' +
    '<div id="sheetMsg"></div></div><div id="sheetBody"></div>';
  document.body.appendChild(sheet);
  var head = $('sheetHead'), body = $('sheetBody');
  ['panelNet', 'panel', 'panelFiber'].forEach(function (id) { if ($(id)) { $(id).classList.remove('hidden'); body.appendChild($(id)); } });

  var pos = localStorage.getItem(STATE) || 'half';   // peek | half | full
  var offset = 0;                                     // текущий сдвиг вниз, px

  function full() { return window.innerHeight - HEADER - 10; }
  function stops() {
    var h = full();
    return { full: 0, half: Math.round(h - Math.max(260, (window.innerHeight - HEADER) * 0.48)), peek: h - PEEK };
  }
  function setOffset(y, anim) {
    var h = full();
    offset = Math.max(0, Math.min(h - PEEK, y));
    sheet.classList.toggle('anim', !!anim);
    sheet.style.height = h + 'px';
    sheet.style.transform = 'translateY(' + offset + 'px)';
    document.body.style.setProperty('--sheet-h', (h - offset) + 'px');
    // карточки на карте не прячутся под шторку
    L.Popup.prototype.options.autoPanPaddingBottomRight = L.point(10, h - offset + 12);
    L.Popup.prototype.options.autoPanPaddingTopLeft = L.point(10, 12);
  }
  function go(name, noSave) {
    pos = name;
    setOffset(stops()[name], true);
    if (!noSave) try { localStorage.setItem(STATE, name); } catch (e) { /* не важно */ }
    $('sheetBtn').textContent = name === 'peek' ? 'Открыть' : 'Свернуть';
  }
  window.addEventListener('resize', function () { go(pos, true); });
  $('sheetBtn').onclick = function (e) { e.stopPropagation(); go(pos === 'peek' ? 'half' : 'peek'); };

  // ---------------------------------------------------------------- перетаскивание

  var drag = null;
  function start(y, fromBody) {
    drag = { y0: y, off0: offset, last: y, t: Date.now(), v: 0, fromBody: fromBody, moved: false };
  }
  function move(y) {
    if (!drag) return;
    var now = Date.now(), dt = Math.max(1, now - drag.t);
    drag.v = (y - drag.last) / dt;
    drag.last = y; drag.t = now;
    if (Math.abs(y - drag.y0) > 4) drag.moved = true;
    setOffset(drag.off0 + (y - drag.y0), false);
  }
  function end() {
    if (!drag) return;
    var s = stops(), v = drag.v, order = ['full', 'half', 'peek'], target;
    if (Math.abs(v) > 0.45) {
      // быстрый взмах — к соседнему положению по направлению
      var i = order.indexOf(nearest(s)), cur = order.indexOf(pos);
      if (v > 0) target = order[Math.min(2, Math.max(i, cur) + (offset > s[order[Math.max(i, cur)]] ? 1 : 0))];
      else target = order[Math.max(0, Math.min(i, cur) - (offset < s[order[Math.min(i, cur)]] ? 1 : 0))];
    } else target = nearest(s);
    drag = null;
    go(target);
  }
  function nearest(s) {
    var best = 'half', bd = Infinity;
    Object.keys(s).forEach(function (k) { var d = Math.abs(s[k] - offset); if (d < bd) { bd = d; best = k; } });
    return best;
  }

  head.addEventListener('touchstart', function (e) {
    if (e.target.closest('button')) return;
    start(e.touches[0].clientY, false);
  }, { passive: true });
  head.addEventListener('touchmove', function (e) { e.preventDefault(); move(e.touches[0].clientY); }, { passive: false });
  head.addEventListener('touchend', function (e) {
    if (!drag) return;
    e.preventDefault();   // без этого после касания придут ещё и события мыши
    if (drag && !drag.moved) { drag = null; go(pos === 'peek' ? 'half' : pos === 'half' ? 'full' : 'half'); return; }
    end();
  });
  // мышь (планшет с мышью, проверка в браузере)
  head.addEventListener('mousedown', function (e) {
    if (e.target.closest('button')) return;
    start(e.clientY, false);
    function mm(ev) { move(ev.clientY); }
    function mu() {
      document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
      if (drag && !drag.moved) { drag = null; go(pos === 'peek' ? 'half' : pos === 'half' ? 'full' : 'half'); return; }
      end();
    }
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
  });

  // смахивание вниз по содержимому, когда оно прокручено к началу; вверх из «половины» — раскрыть
  var bodyTouch = null;
  body.addEventListener('touchstart', function (e) {
    bodyTouch = { y: e.touches[0].clientY, top: body.scrollTop, active: false };
  }, { passive: true });
  body.addEventListener('touchmove', function (e) {
    if (!bodyTouch) return;
    var y = e.touches[0].clientY, dy = y - bodyTouch.y;
    if (!bodyTouch.active) {
      var down = dy > 8 && body.scrollTop <= 0 && bodyTouch.top <= 0;
      var up = dy < -8 && pos !== 'full' && body.scrollTop <= 0;
      if (down || up) { bodyTouch.active = true; start(y, true); }
    }
    if (bodyTouch.active) { e.preventDefault(); move(y); }
  }, { passive: false });
  body.addEventListener('touchend', function () {
    if (bodyTouch && bodyTouch.active) end();
    bodyTouch = null;
  });

  // ---------------------------------------------------------------- заголовок и сообщение

  function title() {
    var net = $('panelNet') && !$('panelNet').classList.contains('off');
    var fiber = $('panel').classList.contains('off') && !net;
    $('sheetTitle').querySelector('span').textContent = net ? 'Сеть' : fiber ? 'ВОЛС — паспорт линии' : 'Радиолиния';
  }
  title();
  ['panel', 'panelNet', 'panelFiber'].forEach(function (id) {
    if ($(id)) new MutationObserver(title).observe($(id), { attributes: true, attributeFilter: ['class'] });
  });
  var st = $('status');
  function mirror() { $('sheetMsg').textContent = st.textContent; }
  new MutationObserver(mirror).observe(st, { childList: true, characterData: true, subtree: true });
  mirror();

  // вкладки раскрывают шторку
  ['tabNet', 'tabRadio', 'tabFiber'].forEach(function (id) {
    if ($(id)) $(id).addEventListener('click', function () { if (pos === 'peek') go('half'); body.scrollTop = 0; });
  });

  // ---------------------------------------------------------------- постановка точки: шторка вниз

  var placing = false, before = null;
  var armIds = ['addA', 'addB', 'addMore', 'nodeArm', 'netAdd', 'nmBar'];
  function watchPlacing() {
    var now = armIds.some(function (id) { return $(id) && $(id).classList.contains('active'); });
    if (now === placing) return;
    placing = now;
    if (now) { before = pos; if (pos !== 'peek') go('peek', true); }
    else if (before && before !== 'peek') { var b = before; before = null; setTimeout(function () { if (!placing) go(b, true); }, 250); }
  }
  armIds.forEach(function (id) {
    if ($(id)) new MutationObserver(watchPlacing).observe($(id), { attributes: true, attributeFilter: ['class'] });
  });

  // после расчёта профиля — показать результат
  if (typeof draw === 'function') {
    var drawOrig = window.draw;
    window.draw = function (p, target) {
      var r = drawOrig.apply(this, arguments);
      if (!target && pos === 'peek') go('half');
      return r;
    };
  }
  // открыли окно-диалог сети или обмена — шторка не мешает (они поверх), ничего не делаем

  go(pos === 'peek' || pos === 'full' ? pos : 'half', true);
  requestAnimationFrame(function () { map.invalidateSize(); });
})();
