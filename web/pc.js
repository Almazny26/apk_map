/* Карта сети — заменитель оболочки Android для программы на компьютере.
 *
 * Программа run.py отдаёт ту же страницу, что и приложение на телефоне, и подключает этот файл сразу
 * после Leaflet, до кода приложения. Код приложения при этом не меняется:
 *   - данные приложения (localStorage) хранятся в файле data\state.json на компьютере: при запуске
 *     они загружаются оттуда, при каждом изменении — записываются обратно;
 *   - офлайн-карта https://local.tiles/... берётся у программы на компьютере;
 *   - без галочки «Онлайн» карты из интернета не загружаются (как на телефоне);
 *   - AndroidBridge: рельеф считает программа на компьютере по тому же файлу dem.bin,
 *     PNG профиля сохраняется в «Загрузки».
 */
(function () {
  'use strict';

  window.KartaPC = true;
  var OWN = /^(wf_|karta_)/;

  function request(method, url, body) {
    var x = new XMLHttpRequest();
    x.open(method, url, false);   // синхронно: приложение ждёт ответа так же, как от оболочки Android
    if (body != null) x.setRequestHeader('Content-Type', 'application/json');
    x.send(body == null ? null : body);
    return x;
  }

  // ---------------------------------------------------------------- хранилище в файле на компьютере

  var proto = Storage.prototype, setItem = proto.setItem, removeItem = proto.removeItem;
  try {
    var r = request('GET', '/api/state');
    if (r.status === 200 && r.getResponseHeader('X-State') !== 'none') {
      var saved = JSON.parse(r.responseText), drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (OWN.test(k) && !(k in saved)) drop.push(k);
      }
      drop.forEach(function (k) { removeItem.call(localStorage, k); });
      Object.keys(saved).forEach(function (k) { setItem.call(localStorage, k, saved[k]); });
    }
  } catch (e) { /* программа не ответила — работаем с тем, что есть в браузере */ }

  function persist() {
    var all = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (OWN.test(k)) all[k] = localStorage.getItem(k);
    }
    try { request('POST', '/api/state', JSON.stringify(all)); } catch (e) { /* сохраним при следующем изменении */ }
  }
  proto.setItem = function (k, v) {
    setItem.call(this, k, v);
    if (this === localStorage && OWN.test(k)) persist();
  };
  proto.removeItem = function (k) {
    removeItem.call(this, k);
    if (this === localStorage && OWN.test(k)) persist();
  };

  // ---------------------------------------------------------------- карты

  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  if (window.L && L.tileLayer) {
    var tileLayer = L.tileLayer;
    L.tileLayer = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('https://local.tiles/') === 0) url = '/' + url.slice('https://local.tiles/'.length);
      return tileLayer.call(this, url, opts);
    };
    var getTileUrl = L.TileLayer.prototype.getTileUrl;
    L.TileLayer.prototype.getTileUrl = function (coords) {
      var u = getTileUrl.call(this, coords);
      // как на телефоне: без галочки «Онлайн» в интернет не ходим
      if (/^https?:/.test(u) && localStorage.getItem('wf_online') !== '1') return BLANK;
      return u;
    };
  }

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
