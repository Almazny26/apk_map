/* Карта сети — ядро клиента: хранение, обращения к серверу, синхронизация.
 *
 * Принцип работы без связи:
 *   base  — объекты в том виде, в каком их последний раз прислал сервер;
 *   queue — правки, сделанные на этом устройстве и ещё не подтверждённые сервером;
 *   view  — то, что видит пользователь: base с наложенными поверх правками из queue.
 * Правка сразу попадает в queue и на экран, а на сервер уходит, когда есть связь.
 * У каждой правки свой op_id, поэтому повторная отправка после обрыва ничего не ломает.
 */
var NM = {};

(function () {
  'use strict';

  NM.native = window.NetMapNative || null;
  NM.CLIENT_VERSION = '1.0';

  // ------------------------------------------------------------------ мелочи

  var listeners = {};
  NM.on = function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); };
  NM.emit = function (name, arg) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(arg); } catch (e) { console.error(e); }
    });
  };

  NM.uuid = function () {
    // crypto.randomUUID доступен только на HTTPS, поэтому собираем идентификатор сами
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
      h.slice(8, 10).join('') + '-' + h.slice(10).join('');
  };

  NM.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  NM.fmtTime = function (ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000), now = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return 'сегодня ' + hm;
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + hm;
  };

  NM.distance = function (a, b) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  };

  NM.fmtDist = function (m) {
    if (m < 1000) return Math.round(m) + ' м';
    return (m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',') + ' км';
  };

  NM.debounce = function (fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };

  // ------------------------------------------------------------------ локальное хранилище
  // В приложении данные лежат в файлах приложения (надёжно и без ограничения размера),
  // в браузере — в localStorage.

  NM.kv = {
    get: function (key) {
      try {
        var raw = NM.native ? NM.native.load(key) : localStorage.getItem('nm_' + key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    set: function (key, value) {
      try {
        var raw = value == null ? null : JSON.stringify(value);
        if (NM.native) return NM.native.save(key, raw);
        if (raw == null) localStorage.removeItem('nm_' + key); else localStorage.setItem('nm_' + key, raw);
        return true;
      } catch (e) { return false; }
    }
  };

  // ------------------------------------------------------------------ настройки вида по умолчанию

  NM.DEFAULT_SETTINGS = {
    rev: 0,
    node_types: [
      { id: 'access', name: 'Узел доступа' }, { id: 'aggregation', name: 'Узел агрегации' },
      { id: 'core', name: 'Опорный узел' }, { id: 'bs', name: 'Базовая станция' }, { id: 'other', name: 'Прочее' }
    ],
    link_types: [
      { id: 'fiber', name: 'ВОЛС', color: '#1d4ed8', dash: '' },
      { id: 'radio', name: 'Радиоканал (БШПД)', color: '#7c3aed', dash: '8 8' },
      { id: 'rrl', name: 'РРЛ', color: '#0e7490', dash: '2 8' },
      { id: 'copper', name: 'Медь', color: '#92400e', dash: '' },
      { id: 'leased', name: 'Арендованный канал', color: '#475569', dash: '12 6 2 6' }
    ],
    statuses: [
      { id: 'ok', name: 'В работе', color: '#16a34a' }, { id: 'work', name: 'Идут работы', color: '#f59e0b' },
      { id: 'fail', name: 'Авария', color: '#dc2626' }, { id: 'plan', name: 'Планируется', color: '#64748b' }
    ]
  };

  NM.lookup = function (list, id) {
    var arr = NM.data.settings[list] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  };
  NM.nameOf = function (list, id) { var x = NM.lookup(list, id); return x ? x.name : (id ? id : '—'); };

  // ------------------------------------------------------------------ сессия и запросы

  NM.session = { server: '', token: '', user: null };

  NM.servedByServer = /^https?:$/.test(location.protocol);

  NM.normalizeServer = function (s) {
    s = (s || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s;
  };

  NM.canEdit = function () {
    var u = NM.session.user;
    return !!u && (u.role === 'admin' || u.role === 'editor');
  };
  NM.isAdmin = function () { return !!NM.session.user && NM.session.user.role === 'admin'; };

  function ApiError(status, code, message) {
    this.status = status; this.code = code; this.message = message;
  }
  NM.ApiError = ApiError;

  NM.api = function (method, path, body, server) {
    var opts = { method: method, headers: {} };
    if (NM.session.token) opts.headers.Authorization = 'Bearer ' + NM.session.token;
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = null;
    if (ctrl) { opts.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, 25000); }
    return fetch((server || NM.session.server) + path, opts).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = null; }
        if (!r.ok) {
          var err = new ApiError(r.status, (j && j.code) || 'http', (j && j.error) || ('Ошибка сервера ' + r.status));
          if (r.status === 401 && path !== '/api/login') NM.data.authLost();
          throw err;
        }
        if (j === null) throw new ApiError(0, 'bad_response', 'Сервер ответил не так, как ожидалось');
        return j;
      });
    }, function () {
      clearTimeout(timer);
      throw new ApiError(0, 'network', 'Нет связи с сервером');
    });
  };

  // ------------------------------------------------------------------ данные и синхронизация

  var D = NM.data = {
    base: new Map(),
    view: new Map(),
    queue: [],
    rev: 0,
    settings: JSON.parse(JSON.stringify(NM.DEFAULT_SETTINGS)),
    online: [],
    connected: false,     // открыт ли поток событий
    lastSync: 0,
    es: null,
    flushing: false,
    retryTimer: null
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Пересчитывает видимое состояние объекта: серверная версия плюс неотправленные правки. */
  function recompute(id) {
    var obj = D.base.has(id) ? clone(D.base.get(id)) : null;
    for (var i = 0; i < D.queue.length; i++) {
      var op = D.queue[i];
      if (op.id !== id) continue;
      if (op.action === 'put') {
        if (!obj) obj = { id: id, kind: op.kind, rev: 0, deleted: false, data: {}, updated_at: op.ts, updated_by: '' };
        for (var k in op.patch) obj.data[k] = op.patch[k];
        obj.pending = true;
      } else if (obj) {
        obj.deleted = true;
      }
    }
    if (obj && !obj.deleted) D.view.set(id, obj); else D.view.delete(id);
  }

  var saveState = NM.debounce(function () {
    var objs = [];
    D.base.forEach(function (o) { objs.push(o); });
    NM.kv.set('state', { server: NM.session.server, rev: D.rev, objects: objs, settings: D.settings, saved: Date.now() });
  }, 1500);

  function saveQueue() { NM.kv.set('queue', { server: NM.session.server, ops: D.queue }); }

  D.saveSession = function () { NM.kv.set('session', NM.session); };

  /** Загружает сохранённые на устройстве данные. Возвращает true, если есть сохранённый вход. */
  D.load = function () {
    var s = NM.kv.get('session');
    if (s && s.server) { NM.session.server = s.server; NM.session.token = s.token || ''; NM.session.user = s.user || null; }
    if (NM.servedByServer) NM.session.server = location.origin;
    var st = NM.kv.get('state');
    if (st && st.server === NM.session.server) {
      D.rev = st.rev || 0;
      (st.objects || []).forEach(function (o) { D.base.set(o.id, o); });
      if (st.settings) D.settings = st.settings;
      D.lastSync = st.saved || 0;
    }
    var q = NM.kv.get('queue');
    if (q && q.server === NM.session.server) D.queue = q.ops || [];
    D.base.forEach(function (_, id) { recompute(id); });
    D.queue.forEach(function (op) { recompute(op.id); });
    return !!NM.session.token;
  };

  /** Полностью забывает данные сервера на этом устройстве (при смене сервера). */
  D.reset = function () {
    D.base.clear(); D.view.clear(); D.queue = []; D.rev = 0;
    D.settings = clone(NM.DEFAULT_SETTINGS);
    NM.kv.set('state', null); NM.kv.set('queue', null);
    NM.emit('reset');
  };

  function applyServer(objs, rev) {
    var ids = [];
    (objs || []).forEach(function (o) {
      var cur = D.base.get(o.id);
      if (cur && cur.rev > o.rev) return;
      if (o.deleted) D.base.delete(o.id); else D.base.set(o.id, o);
      recompute(o.id);
      ids.push(o.id);
    });
    if (rev && rev > D.rev) D.rev = rev;
    if (ids.length) { saveState(); NM.emit('objects', ids); }
  }

  function applySettings(s) {
    if (!s) return;
    if (JSON.stringify(s) !== JSON.stringify(D.settings)) {
      D.settings = s; saveState(); NM.emit('settings');
    }
  }

  function applyUser(u) {
    if (!u) return;
    var before = JSON.stringify(NM.session.user);
    NM.session.user = u;
    if (JSON.stringify(u) !== before) { D.saveSession(); NM.emit('user'); }
  }

  D.status = function () {
    if (!NM.session.token) return 'out';
    if (!D.connected) return 'offline';
    return D.queue.length ? 'syncing' : 'online';
  };

  /** Локальная правка: сразу видна на карте, на сервер уйдёт при первой возможности. */
  D.edit = function (kind, id, action, patch) {
    var ids = [id];
    if (action === 'delete' && kind === 'node') {
      // линии удаляемого узла убираем сразу, не дожидаясь сервера
      D.view.forEach(function (o) {
        if (o.kind === 'link' && (o.data.a === id || o.data.b === id)) {
          D.queue.push({ op_id: NM.uuid(), kind: 'link', id: o.id, action: 'delete', ts: Date.now() / 1000 });
          ids.push(o.id);
        }
      });
    }
    D.queue.push({ op_id: NM.uuid(), kind: kind, id: id, action: action, patch: patch || undefined, ts: Date.now() / 1000 });
    saveQueue();
    ids.forEach(recompute);
    NM.emit('objects', ids);
    NM.emit('status');
    D.flush();
  };

  D.flush = function () {
    if (D.flushing || !D.queue.length || !NM.session.token) return;
    D.flushing = true;
    var batch = D.queue.slice(0, 100);
    NM.api('POST', '/api/ops', { ops: batch }).then(function (res) {
      D.flushing = false;
      var done = {}, rejected = [];
      (res.results || []).forEach(function (r) {
        done[r.op_id] = true;
        if (!r.ok) rejected.push(r);
      });
      D.queue = D.queue.filter(function (op) { return !done[op.op_id]; });
      saveQueue();
      var objs = [], touched = [];
      (res.results || []).forEach(function (r) { if (r.object) objs.push(r.object); touched.push(r.id); });
      applyServer(objs, 0);
      touched.forEach(recompute);
      NM.emit('objects', touched);
      D.lastSync = Date.now();
      NM.emit('status');
      if (rejected.length) NM.emit('rejected', rejected);
      if (D.queue.length) D.flush();
    }, function (err) {
      D.flushing = false;
      if (err.status === 403) {
        NM.emit('toast', 'Сервер не принял правки: у вас доступ только на просмотр');
      } else if (err.status === 0) {
        scheduleRetry();
      } else if (err.status !== 401) {
        NM.emit('toast', 'Не удалось отправить правки: ' + err.message);
        scheduleRetry();
      }
      NM.emit('status');
    });
  };

  /** Отказаться от неотправленных правок (например, если права забрали). */
  D.dropQueue = function () {
    var ids = D.queue.map(function (op) { return op.id; });
    D.queue = []; saveQueue();
    ids.forEach(recompute);
    NM.emit('objects', ids); NM.emit('status');
  };

  function scheduleRetry() {
    clearTimeout(D.retryTimer);
    D.retryTimer = setTimeout(function () {
      if (!NM.session.token) return;
      if (!D.es || D.es.readyState === 2) D.connect(); else D.flush();
    }, 8000);
  }

  /** Догоняет изменения, сделанные другими, пока устройство было без связи. */
  D.pull = function (full) {
    var path = (full || !D.rev) ? '/api/snapshot' : '/api/changes?since=' + D.rev;
    return NM.api('GET', path).then(function (res) {
      if (path === '/api/snapshot') {
        var keep = {};
        res.objects.forEach(function (o) { keep[o.id] = true; });
        var gone = [];
        D.base.forEach(function (_, id) { if (!keep[id]) gone.push(id); });
        gone.forEach(function (id) { D.base.delete(id); recompute(id); });
        D.rev = 0;
        D.base.forEach(function (o) { o.rev = -1; });   // серверная версия точно новее
        applyServer(res.objects, res.rev);
        D.rev = res.rev;
        if (gone.length) NM.emit('objects', gone);
        saveState();
      } else {
        applyServer(res.objects, res.rev);
      }
      applySettings(res.settings);
      applyUser(res.user);
      D.online = res.online || [];
      D.lastSync = Date.now();
      NM.emit('presence'); NM.emit('status');
    });
  };

  D.connect = function () {
    if (!NM.session.token || !NM.session.server) return;
    D.disconnect();
    var es;
    try {
      es = new EventSource(NM.session.server + '/api/events?token=' + encodeURIComponent(NM.session.token));
    } catch (e) { scheduleRetry(); return; }
    D.es = es;
    es.addEventListener('hello', function (e) {
      var h = JSON.parse(e.data);
      D.connected = true;
      NM.emit('status');
      // ревизия сервера меньше нашей — базу на сервере заменили; берём всё заново
      D.pull(h.rev < D.rev).then(function () { D.flush(); }, function () {});
    });
    es.addEventListener('change', function (e) {
      var p = JSON.parse(e.data);
      applyServer(p.objects, p.rev);
    });
    es.addEventListener('settings', function (e) { applySettings(JSON.parse(e.data)); });
    es.addEventListener('presence', function (e) {
      D.online = JSON.parse(e.data).online || [];
      NM.emit('presence');
    });
    es.onerror = function () {
      if (D.es !== es) return;
      var wasConnected = D.connected;
      D.connected = false;
      if (wasConnected) NM.emit('status');
      if (es.readyState === 2) {
        // браузер сам переподключаться не будет: либо сервер отказал (вышел срок входа), либо он недоступен
        NM.api('GET', '/api/me').then(function () { scheduleRetry(); }, function (err) {
          if (err.status !== 401) scheduleRetry();
        });
      }
    };
  };

  D.disconnect = function () {
    if (D.es) { try { D.es.close(); } catch (e) { /* уже закрыт */ } }
    D.es = null;
    if (D.connected) { D.connected = false; NM.emit('status'); }
  };

  /** Сервер больше не принимает наш вход: показываем форму входа, данные на устройстве остаются. */
  D.authLost = function () {
    if (!NM.session.token) return;
    NM.session.token = '';
    D.saveSession();
    D.disconnect();
    NM.emit('auth');
  };

  D.login = function (server, login, password) {
    server = NM.servedByServer ? location.origin : NM.normalizeServer(server);
    return NM.api('POST', '/api/login', {
      login: login, password: password,
      device: (NM.native ? 'Android ' + NM.native.versionName() : 'Браузер') + '; ' + navigator.userAgent.slice(0, 120)
    }, server).then(function (res) {
      if (server !== NM.session.server) D.reset();
      NM.session.server = server; NM.session.token = res.token; NM.session.user = res.user;
      D.saveSession();
      NM.emit('auth');
      D.connect();
      return res.user;
    });
  };

  D.logout = function () {
    var p = NM.api('POST', '/api/logout').catch(function () {});
    D.disconnect();
    NM.session.token = ''; NM.session.user = null;
    D.saveSession();
    NM.emit('auth');
    return p;
  };

  // связь появилась или приложение вернули на экран — сразу пробуем синхронизироваться
  window.addEventListener('online', function () { if (NM.session.token) D.connect(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && NM.session.token) {
      if (!D.es || D.es.readyState === 2 || !D.connected) D.connect(); else D.flush();
    }
  });
  setInterval(function () { if (NM.session.token && D.queue.length && D.connected) D.flush(); }, 20000);

  // ------------------------------------------------------------------ выборки

  D.nodes = function () {
    var out = [];
    D.view.forEach(function (o) { if (o.kind === 'node') out.push(o); });
    return out;
  };
  D.links = function () {
    var out = [];
    D.view.forEach(function (o) { if (o.kind === 'link') out.push(o); });
    return out;
  };
  D.linksOf = function (nodeId) {
    return D.links().filter(function (l) { return l.data.a === nodeId || l.data.b === nodeId; });
  };
  D.linkPoints = function (link) {
    var a = D.view.get(link.data.a), b = D.view.get(link.data.b);
    if (!a || !b) return null;
    return [[a.data.lat, a.data.lng]].concat(link.data.path || [], [[b.data.lat, b.data.lng]]);
  };
  D.linkLength = function (link) {
    var pts = D.linkPoints(link);
    if (!pts) return 0;
    var sum = 0;
    for (var i = 1; i < pts.length; i++) sum += NM.distance(pts[i - 1], pts[i]);
    return sum;
  };
  D.linkTitle = function (link) {
    if (link.data.name) return link.data.name;
    var a = D.view.get(link.data.a), b = D.view.get(link.data.b);
    return (a ? a.data.name : '?') + ' — ' + (b ? b.data.name : '?');
  };
})();
