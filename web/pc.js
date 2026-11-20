/* Карта сети — заменитель оболочки Android для программы на компьютере.
 *
 * Программа run.py отдаёт ту же страницу, что и приложение на телефоне, и подключает этот файл сразу
 * после Leaflet, до кода приложения. Код приложения при этом не меняется:
 *   - данные приложения (localStorage) хранятся в файле data\state.json на компьютере: при запуске
 *     они загружаются оттуда, при каждом изменении — записываются обратно;
 *   - карта — только офлайн-схема из папки map (плитки /omap), в интернет страница не ходит;
 *   - AndroidBridge: рельеф считает программа на компьютере по тому же файлу dem.bin,
 *     PNG профиля сохраняется в «Загрузки».
 */
(function () {
  'use strict';

  window.KartaPC = true;
  window.KartaOfflineOnly = true;
  var EXPECTED = '3.5.3';   // версия run.py, для которой написана эта страница
  window.KartaPCVersion = EXPECTED;
  var OWN = /^(wf_|karta_)/;

  function request(method, url, body) {
    var x = new XMLHttpRequest();
    x.open(method, url, false);   // синхронно: приложение ждёт ответа так же, как от оболочки Android
    if (body != null) x.setRequestHeader('Content-Type', 'application/json');
    x.send(body == null ? null : body);
    return x;
  }

  // ---------------------------------------------------------------- хранилище в файле на компьютере

  var proto = Storage.prototype, setItem = proto.setItem, removeItem = proto.removeItem, getItem = proto.getItem;
  var pendingKey = 'pc_pending_state', warning;
  /* Большая сеть не помещается в память браузера (около 5 млн знаков на сайт). Такие значения
   * держатся в памяти страницы, а на диск их пишет программа (data\state.json), как и остальные. */
  var mem = {}, MEM_KEY = 'pc_mem_keys';
  function memList() { try { return JSON.parse(getItem.call(localStorage, MEM_KEY) || '[]'); } catch (e) { return []; } }
  function memMark() { try { setItem.call(localStorage, MEM_KEY, JSON.stringify(Object.keys(mem))); } catch (e) { /* ничего */ } }
  function store(k, v) {
    if (v.length > 2000000) {     // заведомо не поместится: не тратить время на попытку записи 5 МБ
      if (!(k in mem)) { try { removeItem.call(localStorage, k); } catch (e) { /* ничего */ } }
      var had = k in mem; mem[k] = v; if (!had) memMark();
      return;
    }
    try { setItem.call(localStorage, k, v); if (k in mem) { delete mem[k]; memMark(); } }
    catch (e) { try { removeItem.call(localStorage, k); } catch (e2) { /* ничего */ } mem[k] = v; memMark(); }
  }
  function warnSave(failed) {
    if (!document.body) return;
    if (failed && !warning) {
      warning = document.createElement('div');
      warning.setAttribute('role', 'alert');
      warning.style.cssText = 'position:fixed;z-index:3100;bottom:12px;left:50%;transform:translateX(-50%);max-width:90%;padding:10px 14px;background:#a32018;color:white;border-radius:10px;font:14px system-ui';
      warning.textContent = 'Не удалось записать карту на диск. Изменения пока хранятся в браузере.';
      document.body.appendChild(warning);
    } else if (!failed && warning) { warning.remove(); warning = null; }
  }
  try {
    var r = localStorage.getItem(pendingKey) && !memList().length ? null : request('GET', '/api/state');
    // Shared sessions keep personal preferences in each browser.
    if (!r) {
      var probe = request('GET', '/api/state');
      if (probe.getResponseHeader('X-Karta-Shared') === '1') r = probe;
    }
    window.KartaSharedMode = window.KartaSharedMode || !!(r && r.getResponseHeader('X-Karta-Shared') === '1');
    if (window.KartaSharedMode && r && r.status === 200) {
      removeItem.call(localStorage, pendingKey);
      var sv = JSON.parse(r.responseText);
      ['karta_net', 'karta_author'].forEach(function (k) { store(k, sv[k]); });
      r = null;
    }
    if (r && r.status === 200 && r.getResponseHeader('X-State') !== 'none') {
      var saved = JSON.parse(r.responseText), drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (OWN.test(k) && !(k in saved)) drop.push(k);
      }
      drop.forEach(function (k) { removeItem.call(localStorage, k); });
      Object.keys(saved).forEach(function (k) { store(k, saved[k]); });
    }
  } catch (e) { /* программа не ответила — работаем с тем, что есть в браузере */ }

  setItem.call(localStorage, 'wf_online', '0');

  // ---------------------------------------------------------------- одно окно (обычный режим)
  // Каждое окно держит свою копию сети и записывает на диск всю карту целиком: два окна затёрли бы
  // правки друг друга. Работает одно окно, остальные показывают заставку «открыто в другом окне».
  var WIN_KEY = 'pc_window', winId = Math.random().toString(36).slice(2) + Date.now().toString(36), passive = false, cover = null;
  function readWin() { try { return JSON.parse(localStorage.getItem(WIN_KEY) || 'null'); } catch (e) { return null; } }
  function claim() { setItem.call(localStorage, WIN_KEY, JSON.stringify({ id: winId, t: Date.now() })); }
  function showCover() {
    if (cover || !document.body) return;
    cover = document.createElement('div');
    cover.id = 'pcOtherWindow';
    cover.setAttribute('role', 'alertdialog');
    cover.style.cssText = 'position:fixed;inset:0;z-index:300000;display:grid;place-items:center;background:rgba(20,22,26,.72);font:16px/1.45 system-ui,sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'box-sizing:border-box;width:min(460px,92vw);background:#fff;color:#111;border-radius:16px;padding:24px;box-shadow:0 12px 60px #0006';
    var h = document.createElement('h2'); h.textContent = 'Программа открыта в другом окне'; h.style.margin = '0 0 10px';
    var p = document.createElement('p'); p.style.margin = '0 0 18px';
    p.textContent = 'Работайте в одном окне: два окна записывали бы карту по очереди и затирали правки друг друга. Это окно ничего не сохраняет.';
    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Работать в этом окне';
    b.style.cssText = 'display:block;width:100%;min-height:44px;border:0;border-radius:10px;background:#007aff;color:#fff;font:inherit;cursor:pointer';
    b.onclick = function () { try { sessionStorage.setItem('pc_take', '1'); } catch (e) { /* ничего */ } location.reload(); };
    box.append(h, p, b); cover.appendChild(box); document.body.appendChild(cover);
  }
  function becomePassive() {
    passive = true;
    if (document.body) showCover(); else document.addEventListener('DOMContentLoaded', showCover);
  }
  if (!window.KartaSharedMode) {
    var take = false;
    try { take = sessionStorage.getItem('pc_take') === '1'; sessionStorage.removeItem('pc_take'); } catch (e) { /* ничего */ }
    var other = readWin();
    if (!take && other && other.id !== winId && Date.now() - other.t < 6000) becomePassive();
    else claim();
    setInterval(function () {
      if (passive) return;
      var c = readWin();
      if (c && c.id !== winId && Date.now() - c.t < 6000) becomePassive(); else claim();
    }, 2000);
    window.addEventListener('storage', function (e) {
      if (e.key !== WIN_KEY || passive) return;
      var c = readWin();
      if (c && c.id !== winId) becomePassive();
    });
    window.addEventListener('pagehide', function () {
      var c = readWin();
      if (!passive && c && c.id === winId) removeItem.call(localStorage, WIN_KEY);
    });
  }
  window.KartaPCPassive = function () { return passive; };

  /* Изменился один ключ — на компьютер уходит только он (karta_view после каждого движения карты
   * больше не тянет за собой всю сеть). Не дошло — следующий раз отправляется всё целиком. */
  var fullNext = false, bigBusy = false, bigNext = null;
  /* Большая сеть (несколько МБ) уходит в фоне: синхронная отправка останавливала страницу почти на
   * секунду после каждой точки. Пока запрос в пути, новые правки ждут и уходят одним следующим
   * запросом (последнее состояние). Не дошло — следующая запись отправит всё целиком. */
  function sendBig(k) {
    if (bigBusy) { bigNext = k; return; }
    bigBusy = true;
    try { setItem.call(localStorage, pendingKey, '1'); } catch (e) { /* ничего */ }
    var one = {}, x = new XMLHttpRequest();
    one[k] = mem[k];
    x.open('POST', '/api/state?patch=1', true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.onloadend = function () {
      var ok = x.status === 200;
      bigBusy = false;
      if (!ok) fullNext = true;
      warnSave(!ok);
      if (bigNext != null) { var n = bigNext; bigNext = null; if (ok) sendBig(n); else persist(); }
      else if (!ok) persist();
      else if (!fullNext) try { removeItem.call(localStorage, pendingKey); } catch (e) { /* ничего */ }
    };
    x.send(JSON.stringify(one));
  }
  window.addEventListener('pagehide', function () {   // окно закрывают, а запись ещё в пути
    if (!(bigBusy || bigNext != null) || !navigator.sendBeacon) return;
    var all = {};
    Object.keys(mem).forEach(function (k) { all[k] = mem[k]; });
    try { navigator.sendBeacon('/api/state?patch=1', new Blob([JSON.stringify(all)], { type: 'application/json' })); } catch (e) { /* ничего */ }
  });
  window.KartaPCSaving = function () { return bigBusy || bigNext != null; };
  function persist(k) {
    if (window.KartaSharedMode || window.KartaPCSwitching || passive) return;
    if (k && k in mem && !fullNext) { sendBig(k); return; }
    if (k && !fullNext && (bigBusy || !getItem.call(localStorage, pendingKey))) {
      var one = {}, okOne = false;
      one[k] = k in mem ? mem[k] : getItem.call(localStorage, k);
      try {
        setItem.call(localStorage, pendingKey, '1');
        okOne = request('POST', '/api/state?patch=1', JSON.stringify(one)).status === 200;
        if (okOne && !bigBusy && bigNext == null) removeItem.call(localStorage, pendingKey);
      } catch (e) { okOne = false; }
      if (!okOne) fullNext = true;
      warnSave(!okOne);
      return;
    }
    var all = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (OWN.test(k)) all[k] = localStorage.getItem(k);
    }
    Object.keys(mem).forEach(function (k) { all[k] = mem[k]; });
    if (bigBusy && Object.keys(mem).length) bigNext = Object.keys(mem)[0];   // фоновая запись старее этой — повторить после неё
    var ok = false;
    try {
      setItem.call(localStorage, pendingKey, '1');
      ok = request('POST', '/api/state', JSON.stringify(all)).status === 200;
      if (ok) { removeItem.call(localStorage, pendingKey); fullNext = false; }
    } catch (e) { /* повторим при следующем изменении или запуске */ }
    warnSave(!ok);
  }
  proto.setItem = function (k, v) {
    if (passive && this === localStorage && OWN.test(k)) return;   // неактивное окно не трогает общие данные
    if (this === localStorage && OWN.test(k)) { store(k, String(v)); persist(k); return; }
    setItem.call(this, k, v);
  };
  proto.removeItem = function (k) {
    if (passive && this === localStorage && OWN.test(k)) return;
    removeItem.call(this, k);
    if (this === localStorage && k in mem) { delete mem[k]; memMark(); }
    if (this === localStorage && OWN.test(k)) persist(k);
  };
  proto.getItem = function (k) {
    if (this === localStorage && Object.prototype.hasOwnProperty.call(mem, k)) return mem[k];
    return getItem.call(this, k);
  };
  document.addEventListener('DOMContentLoaded', function () {
    if (localStorage.getItem(pendingKey)) persist();
  });

  // ---------------------------------------------------------------- карты

  // На ПК только офлайн-схема (MapLibre, плитки /omap). Подложки из интернета (остались от телефона:
  // OpenStreetMap, Esri, подписи Яндекса) не запрашиваются вовсе: пустая картинка вместо плитки.
  // 3.5.3: кэш онлайн-плиток /tc, растровая карта /tiles и снимки /osat в программе убраны.
  if (window.L && L.tileLayer) {
    var tileLayer = L.tileLayer;
    var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    L.tileLayer = function (url, opts) {
      var layer = tileLayer.call(this, url, opts);
      if (typeof url === 'string' && /^https?:\/\//.test(url)) layer.getTileUrl = function () { return BLANK; };
      return layer;
    };
  }

  // ---------------------------------------------------------------- версия программы
  // Страница новая, а программа (чёрное окно, может быть свёрнуто) — старая: подсказать перезапуск.
  try {
    var info = JSON.parse(request('GET', '/api/info').responseText);
    if (info.version !== EXPECTED) {
      document.addEventListener('DOMContentLoaded', function () {
        var b = document.createElement('div');
        b.style.cssText = 'position:fixed;left:50%;top:56px;transform:translateX(-50%);z-index:200000;max-width:640px;' +
          'background:#b3261e;color:#fff;border-radius:12px;padding:10px 16px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)';
        b.textContent = 'Работает прежняя версия программы (' + info.version + '). Закройте её чёрное окно (оно может быть ' +
          'свёрнуто на панели задач) и запустите «Карта сети» заново.';
        document.body.appendChild(b);
      });
    }
  } catch (e) { /* не важно */ }

  // ---------------------------------------------------------------- замена оболочки Android

  window.AndroidBridge = {
    fetchElevations: function (locs) {
      var r = request('POST', '/api/elev', JSON.stringify({ locs: locs, online: localStorage.getItem('wf_online') === '1' }));
      return r.status === 200 ? r.responseText : '{"status":"ERROR","error":"offline"}';
    },
    saveImage: function (dataUrl) {
      var name = 'fresnel_' + Date.now() + '.png';
      var a = document.createElement('a');
      a.href = dataUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      return 'OK:' + name;
    },
    setOnline: function () { /* признак хранится в wf_online, программа читает его при запросе рельефа */ }
  };
})();
