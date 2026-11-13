/* Карта сети — ядро клиента: хранение данных и обмен.
 *
 * С версии 1.3 два режима:
 *   desk  — программа на компьютере (страница с локального сервера run.py): правки сразу пишутся
 *           в базу на этом компьютере; сюда загружаются файлы изменений от бригад и отсюда
 *           выгружается файл карты для бригад.
 *   phone — приложение на телефоне: работает без сервера и без сети. Карта приходит файлом,
 *           правки копятся на телефоне и уходят диспетчеру файлом изменений.
 *
 * Данные в обоих режимах устроены одинаково:
 *   base  — объекты в том виде, в каком их прислал сервер (desk) или файл карты (phone);
 *   queue — правки, сделанные на этом устройстве и ещё не попавшие в общую карту;
 *   view  — то, что видит пользователь: base с наложенными поверх правками из queue.
 * У каждой правки свой op_id: повторная загрузка того же файла ничего не ломает.
 */
var NM = {};

(function () {
  'use strict';

  NM.native = window.NetMapNative || null;
  NM.CLIENT_VERSION = '1.3';
  NM.FORMAT = 'karta-seti';
  NM.mode = NM.native ? 'phone' : 'desk';

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


  NM.canEdit = function () { return true; };
  NM.isAdmin = function () { return NM.mode === 'desk'; };

  // ------------------------------------------------------------------ запросы к программе на компьютере

  function ApiError(status, code, message) {
    this.status = status; this.code = code; this.message = message;
  }
  NM.ApiError = ApiError;

  /** Запрос к локальному серверу (только в режиме desk). */
  NM.api = function (method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = null; }
        if (!r.ok) throw new ApiError(r.status, (j && j.code) || 'http', (j && j.error) || ('Ошибка программы ' + r.status));
        if (j === null) throw new ApiError(0, 'bad_response', 'Программа ответила не так, как ожидалось');
        return j;
      });
    }, function () {
      throw new ApiError(0, 'network', 'Программа на компьютере не отвечает. Запустите «Карта сети.bat».');
    });
  };

  // ------------------------------------------------------------------ данные

  var D = NM.data = {
    base: new Map(),
    view: new Map(),
    queue: [],
    rev: 0,
    settings: JSON.parse(JSON.stringify(NM.DEFAULT_SETTINGS)),
    // desk
    connected: false, flushing: false, es: null, retryTimer: null, operator: '',
    // phone
    map: null,          // сведения о загруженном файле карты: {map_id, title, created, rev}
    journal: [],        // журнал из файла карты
    profile: { name: '' }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Пересчитывает видимое состояние объекта: основа плюс неотправленные правки. */
  function recompute(id) {
    var obj = D.base.has(id) ? clone(D.base.get(id)) : null;
    for (var i = 0; i < D.queue.length; i++) {
      var op = D.queue[i];
      if (op.id !== id) continue;
      if (op.action === 'put') {
        if (!obj) obj = { id: id, kind: op.kind, rev: 0, deleted: false, data: {}, updated_at: op.ts, updated_by: '' };
        for (var k in op.patch) obj.data[k] = op.patch[k];
        obj.pending = true;
        obj.updated_at = op.ts;
        obj.updated_by = op.author || obj.updated_by;
      } else if (obj) {
        obj.deleted = true;
      }
    }
    if (obj && !obj.deleted) D.view.set(id, obj); else D.view.delete(id);
  }
  function recomputeAll() {
    D.view.clear();
    D.base.forEach(function (_, id) { recompute(id); });
    D.queue.forEach(function (op) { if (!D.view.has(op.id)) recompute(op.id); });
  }

  var saveBase = NM.debounce(function () {
    var objs = [];
    D.base.forEach(function (o) { objs.push(o); });
    NM.kv.set(NM.mode === 'phone' ? 'map' : 'state', {
      map: D.map, rev: D.rev, objects: objs, settings: D.settings, journal: D.journal, saved: Date.now()
    });
  }, 1200);

  function saveQueue() { NM.kv.set('queue', { ops: D.queue }); }

  D.load = function () {
    var st = NM.kv.get(NM.mode === 'phone' ? 'map' : 'state');
    if (NM.mode === 'phone' && !st) {
      // приложение до 1.3 хранило данные сервера под другим ключом — сохраняем их как карту
      st = NM.kv.get('state');
      if (st) st.map = { map_id: null, title: 'Карта из прежней версии', created: (st.saved || Date.now()) / 1000, rev: st.rev || 0 };
    }
    if (st) {
      D.rev = st.rev || 0;
      D.map = st.map || null;
      D.journal = st.journal || [];
      (st.objects || []).forEach(function (o) { D.base.set(o.id, o); });
      if (st.settings) D.settings = st.settings;
    }
    var q = NM.kv.get('queue');
    if (q) D.queue = q.ops || [];
    var p = NM.kv.get('profile');
    if (p) D.profile = p;
    recomputeAll();
  };

  D.status = function () {
    if (NM.mode === 'phone') return D.unsent().length ? 'unsent' : 'sent';
    if (!D.connected) return 'down';
    return D.queue.length ? 'saving' : 'saved';
  };

  /** Правка: сразу видна на карте. На компьютере тут же пишется в базу, на телефоне ждёт отправки. */
  D.edit = function (kind, id, action, patch) {
    var ids = [id], now = Date.now() / 1000;
    var author = NM.mode === 'phone' ? (D.profile.name || '') : D.operator;
    if (action === 'delete' && kind === 'node') {
      // линии удаляемого узла убираем сразу
      D.view.forEach(function (o) {
        if (o.kind === 'link' && (o.data.a === id || o.data.b === id)) {
          D.queue.push({ op_id: NM.uuid(), kind: 'link', id: o.id, action: 'delete', ts: now, author: author });
          ids.push(o.id);
        }
      });
    }
    D.queue.push({ op_id: NM.uuid(), kind: kind, id: id, action: action, patch: patch || undefined, ts: now, author: author });
    saveQueue();
    ids.forEach(recompute);
    NM.emit('objects', ids);
    NM.emit('status');
    if (NM.mode === 'desk') D.flush();
  };

  // ------------------------------------------------------------------ компьютер: база на этом компьютере

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
    if (ids.length) { saveBase(); NM.emit('objects', ids); }
  }

  function applySettings(s) {
    if (!s) return;
    if (JSON.stringify(s) !== JSON.stringify(D.settings)) {
      D.settings = s; saveBase(); NM.emit('settings');
    }
  }
  D.applySettings = applySettings;

  D.flush = function () {
    if (NM.mode !== 'desk' || D.flushing || !D.queue.length) return;
    D.flushing = true;
    var batch = D.queue.slice(0, 200).map(function (op) {
      return { op_id: op.op_id, kind: op.kind, id: op.id, action: op.action, patch: op.patch };
    });
    NM.api('POST', '/api/ops', { ops: batch }).then(function (res) {
      D.flushing = false;
      var done = {}, rejected = [], objs = [], touched = [];
      (res.results || []).forEach(function (r) {
        done[r.op_id] = true;
        if (!r.ok) rejected.push(r);
        if (r.object) objs.push(r.object);
        touched.push(r.id);
      });
      D.queue = D.queue.filter(function (op) { return !done[op.op_id]; });
      saveQueue();
      applyServer(objs, 0);
      touched.forEach(recompute);
      NM.emit('objects', touched);
      NM.emit('status');
      if (rejected.length) NM.emit('rejected', rejected);
      if (D.queue.length) D.flush();
    }, function (err) {
      D.flushing = false;
      D.connected = false;
      NM.emit('status');
      if (err.status !== 0) NM.emit('toast', 'Не удалось сохранить: ' + err.message);
      scheduleRetry();
    });
  };

  function scheduleRetry() {
    clearTimeout(D.retryTimer);
    D.retryTimer = setTimeout(function () { D.connect(); }, 5000);
  }

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
        D.base.forEach(function (o) { o.rev = -1; });
        applyServer(res.objects, res.rev);
        D.rev = res.rev;
        if (gone.length) NM.emit('objects', gone);
        saveBase();
      } else {
        applyServer(res.objects, res.rev);
      }
      applySettings(res.settings);
    });
  };

  /** Подключение к программе на этом компьютере. Поток событий нужен, чтобы окна и вкладки видели правки друг друга. */
  D.connect = function () {
    if (NM.mode !== 'desk') return;
    D.disconnect();
    var es = new EventSource('/api/events');
    D.es = es;
    es.addEventListener('hello', function (e) {
      var h = JSON.parse(e.data);
      D.connected = true;
      D.operator = (h.user && h.user.name) || D.operator;
      NM.emit('status');
      D.pull(h.rev < D.rev).then(function () { D.flush(); }, function () {});
    });
    es.addEventListener('change', function (e) {
      var p = JSON.parse(e.data);
      applyServer(p.objects, p.rev);
    });
    es.addEventListener('settings', function (e) { applySettings(JSON.parse(e.data)); });
    es.onerror = function () {
      if (D.es !== es) return;
      if (D.connected) { D.connected = false; NM.emit('status'); }
      if (es.readyState === 2) scheduleRetry();
    };
  };

  D.disconnect = function () {
    if (D.es) { try { D.es.close(); } catch (e) { /* уже закрыт */ } }
    D.es = null;
  };

  // ------------------------------------------------------------------ телефон: обмен файлами

  D.unsent = function () { return D.queue.filter(function (op) { return !op.exported; }); };

  D.setProfile = function (name) {
    D.profile = { name: String(name || '').trim().slice(0, 80) };
    NM.kv.set('profile', D.profile);
    NM.emit('status');
  };

  /**
   * Файл изменений для диспетчера. В него входят все правки, которые ещё не вернулись в файле карты,
   * в том числе уже отправленные раньше: повторная загрузка на компьютере ничего не испортит,
   * а если прошлый файл потерялся, ничего не пропадёт.
   */
  D.changesPackage = function () {
    return {
      format: NM.FORMAT, version: 1, kind: 'changes',
      map_id: D.map ? D.map.map_id : null,
      author: D.profile.name || 'Бригада',
      created: Date.now() / 1000,
      app: NM.native ? NM.native.versionName() : NM.CLIENT_VERSION,
      ops: D.queue.map(function (op) {
        return { op_id: op.op_id, kind: op.kind, id: op.id, action: op.action, patch: op.patch, ts: op.ts };
      })
    };
  };

  D.markExported = function () {
    var now = Date.now() / 1000;
    D.queue.forEach(function (op) { if (!op.exported) op.exported = now; });
    saveQueue();
    NM.emit('status');
  };

  /** Проверяет файл карты. Возвращает текст ошибки или null. */
  D.checkMap = function (pkg) {
    if (!pkg || pkg.format !== NM.FORMAT) return 'Это не файл программы «Карта сети».';
    if (pkg.kind === 'changes') return 'Это файл изменений бригады. Его загружают в программу на компьютере, а в телефон — файл карты.';
    if (pkg.kind !== 'map' || !Array.isArray(pkg.objects)) return 'Файл повреждён: в нём нет карты.';
    return null;
  };

  /**
   * Загружает файл карты от диспетчера. Свои правки, которые уже вошли в карту, телефон забывает;
   * остальные остаются поверх новой карты и уйдут со следующим файлом изменений.
   * Возвращает {kept, merged}.
   */
  D.loadMap = function (pkg) {
    var applied = {};
    (pkg.applied_ops || []).forEach(function (id) { applied[id] = true; });
    var before = D.queue.length;
    if (D.map && D.map.map_id && pkg.map_id && D.map.map_id !== pkg.map_id) D.queue = [];   // совсем другая карта
    D.queue = D.queue.filter(function (op) { return !applied[op.op_id]; });
    D.base.clear();
    pkg.objects.forEach(function (o) { if (!o.deleted) D.base.set(o.id, o); });
    D.rev = pkg.rev || 0;
    D.map = { map_id: pkg.map_id || null, title: pkg.title || '', created: pkg.created || Date.now() / 1000, rev: pkg.rev || 0 };
    D.journal = Array.isArray(pkg.journal) ? pkg.journal : [];
    if (pkg.settings) D.settings = pkg.settings;
    saveQueue();
    var objs = [];
    D.base.forEach(function (o) { objs.push(o); });
    NM.kv.set('map', { map: D.map, rev: D.rev, objects: objs, settings: D.settings, journal: D.journal, saved: Date.now() });
    recomputeAll();
    NM.emit('settings');
    NM.emit('objects', Array.from(D.view.keys()));
    NM.emit('status');
    return { kept: D.queue.length, merged: before - D.queue.length };
  };

  /** Отказаться от своих неотправленных правок. */
  D.dropQueue = function () {
    var ids = D.queue.map(function (op) { return op.id; });
    D.queue = []; saveQueue();
    ids.forEach(recompute);
    NM.emit('objects', ids); NM.emit('status');
  };

  if (NM.mode === 'desk') {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !D.connected) D.connect();
    });
  }

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
