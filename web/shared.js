/* Shared desktop map: optimistic object transactions, live updates (long polling) and presence. */
(function () {
  'use strict';
  function saveCopy(net, label) {
    // Копия правки в «Загрузки»: если сервер её не принял, работа не пропадёт.
    try {
      var link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify({format:'karta-seti', version:3, data:{net:net}})], {type:'application/json'}));
      link.download = (label || 'Несохранённая_правка') + '_' + Date.now() + '.json';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 30000);
    } catch (e) { /* не удалось — правка остаётся в окне */ }
  }
  function toLogin(unsaved) {
    if (unsaved) {
      saveCopy(unsaved);
      alert('Сеанс входа закончился. Ваши несохранённые правки сохранены файлом в «Загрузки» — после входа откройте его через «Обмен данными».');
    }
    location.replace('/login');
  }
  function request(method, path, body, unsaved) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, false);
    if (body) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(body ? JSON.stringify(body) : null);
    if (xhr.status === 401) { toLogin(unsaved); throw Error('Требуется вход'); }
    var data;
    try { data = JSON.parse(xhr.responseText); } catch (e) { throw Error(xhr.status ? 'Сервер ответил ошибкой ' + xhr.status : 'Нет связи с сервером'); }
    if (xhr.status !== 409 && xhr.status !== 200) throw Error(data.error || 'Сервер не ответил');
    return data;
  }
  var initial = request('GET', '/api/shared'), base = initial.net, revision = initial.revision;
  var user = initial.user, online = initial.online, busy = false, panel, status, pending = null, accepted = false, polling = false;
  var copy = function (v) { return JSON.parse(JSON.stringify(v)); };
  /* Правки, которые сервер ещё не подтвердил, лежат и в браузере: переживают перезагрузку страницы и
     уходят сами, когда связь вернётся. Ключ не начинается с karta_/wf_ — pc.js не пишет его в state.json. */
  var pendingBase = null, PKEY = 'shared_pending_' + user.login;
  function storePending() {
    try {
      if (pending) localStorage.setItem(PKEY, JSON.stringify({base: pendingBase, net: pending, t: Date.now()}));
      else localStorage.removeItem(PKEY);
    } catch (e) { /* память браузера заполнена — правка остаётся в окне */ }
  }
  var J = function (v) { return v === undefined ? '' : JSON.stringify(v); };
  var FIELD = {name:'название', kind:'вид', state:'состояние', addr:'адрес', note:'примечание', lat:'положение', lng:'положение',
    fnodes:'трасса', points:'точки', lay:'прокладка', fibers:'число жил', cable:'кабель', deleted:'удаление'};
  /* Слияние по полям: base — с чего начинали, mine — наша правка, srv — то, что уже на сервере.
     Поля, которые менял только один из двоих, объединяются; совпадающая правка — не конфликт. */
  function mergeObj(b, mine, srv) {
    if (J(mine) === J(srv)) return {same: true};
    if (!b || !mine || !srv || mine.type !== srv.type) return {clash: [!mine ? 'удаление' : !srv ? 'объект удалён' : 'объект']};
    if (srv.f.deleted && !mine.f.deleted) return {clash: ['объект удалён другим пользователем']};
    var keys = {}, f = {}, clash = [];
    [b.f, mine.f, srv.f].forEach(function (o) { Object.keys(o || {}).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var m = J(mine.f[k]), o = J(b.f[k]), x = J(srv.f[k]);
      var v = m !== o ? mine.f[k] : srv.f[k];
      if (m !== o && x !== o && x !== m) { var label = FIELD[k] || k; if (clash.indexOf(label) < 0) clash.push(label); }
      if (v !== undefined) f[k] = copy(v);
    });
    var merged = copy(srv); merged.f = f;
    return {obj: merged, clash: clash};
  }
  function info() {
    if (status) {
      var name = generic(user.name) ? 'Владелец' : user.name;
      status.replaceChildren();
      if (pending) status.textContent = 'Правки не сохранены — повторить';
      else {
        var n = document.createElement('span'); n.className = 'us-name'; n.textContent = name;
        var c = document.createElement('span'); c.className = 'us-count';
        var cl = document.createElement('span'); cl.className = 'us-long'; cl.textContent = ' · в сети ';
        var cs = document.createElement('span'); cs.className = 'us-short'; cs.textContent = ' · ';
        c.append(cl, cs, String(online.length));
        status.append(n, c);
      }
      status.title = pending ? 'Правки ещё не на сервере. Они хранятся в этом браузере и отправятся сами, когда появится связь. Нажмите, чтобы повторить сейчас.' :
        name + ' · ' + ({admin:'Администратор',editor:'Редактор',viewer:'Просмотр'})[user.role] + ' · в сети ' + online.length + ' · все правки сохранены на сервере';
      status.style.color = pending ? 'var(--danger,#b42318)' : 'var(--accent,#145db0)';
    }
  }
  function adopt(data) {
    if (data.net) { base = copy(data.net); revision = data.revision; }
    user = data.user; online = data.online;
    info();
  }
  window.KartaShared = {
    user: function () { return user; },
    isOwner: function () { return user.login === '@server'; },
    initial: base,
    hasPending: function () { return !!pending; },
    wasAccepted: function () { return accepted; },
    showUsers: function () { participants('access'); },
    commit: function (net, opts) {
      accepted = false;
      opts = opts || {};
      // Правки считаются от той версии карты, с которой их начинали (пока они не приняты, она не меняется).
      var from = opts.base || (pending && pendingBase) || base;
      var ids = new Set(Object.keys(from.objs).concat(Object.keys(net.objs))), ops = [];
      ids.forEach(function (id) {
        var before = from.objs[id] || null, after = net.objs[id] || null;
        if (JSON.stringify(before) !== JSON.stringify(after)) ops.push({id: id, before: before, after: after});
      });
      if (!ops.length) { pending = null; pendingBase = null; storePending(); info(); return copy(base); }
      if (user.role === 'viewer') { alert('У вашей учётной записи доступен только просмотр'); return copy(base); }
      busy = true;
      try {
        var data = request('POST', '/api/shared', {ops: ops}, net);
        accepted = !data.conflicts;
        if (data.conflicts) {
          var srvObjs = data.net.objs, clashes = [], next = [];
          ops.forEach(function (op) {
            var srv = srvObjs[op.id] || null;
            if (data.conflicts.indexOf(op.id) < 0) { next.push({id: op.id, before: srv, after: op.after}); return; }
            var m = mergeObj(op.before, op.after, srv);
            if (m.same) return;
            if (m.clash.length) { clashes.push({op: op, srv: srv, fields: m.clash}); return; }
            next.push({id: op.id, before: srv, after: m.obj});
          });
          if (clashes.length) {
            saveCopy(net);
            var names = clashes.map(function (c) { var o = c.op.after || c.op.before || c.srv; return '«' + ((o && o.f.name) || c.op.id) + '» (' + c.fields.join(', ') + ')'; }).join('; ');
            var keepTheirs = confirm('Другой пользователь одновременно изменил те же данные: ' + names + '.\n\n' +
              'OK — оставить его версию этих объектов (рекомендуется). Остальные ваши правки сохранятся. Ваша полная версия сохранена файлом в «Загрузки».\n' +
              'Отмена — выбрать другое действие.');
            if (!keepTheirs && confirm('Заменить изменения другого пользователя вашей версией? Его правки в этих объектах будут потеряны.')) {
              clashes.forEach(function (c) { next.push({id: c.op.id, before: c.srv, after: c.op.after}); });
            }
          }
          if (next.length) {
            data = request('POST', '/api/shared', {ops: next}, net);
            accepted = !data.conflicts;
            if (data.conflicts) alert('Объекты снова изменились, пока вы выбирали. Показана версия сервера. Ваша копия сохранена в файле.');
          } else accepted = true;
          if (!clashes.length && next.length && !data.conflicts) {
            var note = document.createElement('div'); note.setAttribute('role', 'status');
            note.style.cssText = 'position:fixed;z-index:3100;bottom:20px;left:50%;transform:translateX(-50%);max-width:90%;padding:10px 14px;background:#323232;color:#fff;border-radius:10px;font:14px system-ui';
            note.textContent = 'Ваши правки объединены с одновременными изменениями другого пользователя';
            document.body.appendChild(note); setTimeout(function () { note.remove(); }, 4000);
          }
        }
        adopt(data);
        pending = null; pendingBase = null; storePending(); info();
        return copy(base);
      } catch (error) {
        var firstFailure = !pending;
        pending = copy(net); pendingBase = copy(from); storePending(); info();
        if (firstFailure && !opts.silent && error.message !== 'Требуется вход') alert('Изменения пока не сохранены на сервере: ' + error.message + '. Они хранятся в этом браузере и отправятся сами, когда связь восстановится (кнопка пользователя вверху станет синей).');
        return copy(net);
      } finally { busy = false; }
    }
  };
  window.addEventListener('beforeunload', function (e) { if (pending) { e.preventDefault(); e.returnValue = ''; } });
  function element(tag, text, parent) {
    var el = document.createElement(tag);
    if (text) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  function button(text, parent, cls, click) {
    var b = element('button', text, parent); b.type = 'button';
    if (cls) b.className = cls;
    if (click) b.onclick = click;
    return b;
  }
  function generic(name) { return !name || /^(телефон|компьютер|браузер|серверный компьютер|без подписи)$/i.test(name.trim()); }
  var roleNames = {admin:'Администратор', editor:'Редактирование', viewer:'Просмотр'};
  function participants(startTab) {
    if (panel) panel.remove();
    var currentPanel = panel = element('dialog', '', document.body);
    panel.id = 'apUsersDialog';
    var head = element('div', '', panel); head.className = 'us-head';
    element('h2', 'Пользователи', head);
    var closeBtn = button('', head, 'us-close', function () { currentPanel.close(); }); closeBtn.setAttribute('aria-label','Закрыть'); closeBtn.title = 'Закрыть';
    closeBtn.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    var tabs = element('div', '', panel); tabs.className = 'us-tabs'; tabs.setAttribute('role','tablist');
    var content = element('div', '', panel); content.className = 'us-content';
    var members = button('Участники', tabs, '', function () { show('members'); }); members.setAttribute('role','tab');
    var access = null;
    var copiesTab = null;
    if (user.role === 'admin') { access = button('Доступ', tabs, '', function () { show('access'); }); access.setAttribute('role','tab'); }
    if (user.role === 'admin') { copiesTab = button('Копии', tabs, '', function () { show('backups'); }); copiesTab.setAttribute('role','tab'); }
    function message(text, error) { var p = element('p',text,content); p.className = error ? 'us-error' : 'us-success'; p.setAttribute('role','status'); }
    function show(tab, notice) {
      members.setAttribute('aria-selected',tab !== 'access' && tab !== 'backups');
      if (access) access.setAttribute('aria-selected',tab === 'access');
      if (copiesTab) copiesTab.setAttribute('aria-selected',tab === 'backups');
      content.replaceChildren();
      if (tab === 'access' && access) accounts(notice);
      else if (tab === 'backups' && copiesTab) backups(notice);
      else marks();
    }
    function marks() {
      element('h3', 'В сети', content);
      var list = element('div','',content); list.className = 'us-online';
      online.forEach(function (u) { var item = element('span',generic(u.name) ? 'Владелец' : u.name,list); item.className = 'us-person'; });
      if (!online.length) { var empty = element('p','Нет активных участников',list); empty.className = 'us-muted'; }
      element('h3','Отметки',content);
      var authors = new Map(), accountsById = new Map();
      online.forEach(function (u) { accountsById.set(u.login,u.name); });
      Object.values(window.KartaNet.data().objs).forEach(function (o) {
        if (o.f.deleted) return;
        var rawName = o.createdBy || o.by || '', id = o.createdById || '';
        var name = generic(rawName) ? 'Без автора' : accountsById.get(id) || rawName;
        var key = generic(rawName) ? 'unassigned' : id || name;
        if (!authors.has(key)) authors.set(key,{name:name, objects:[]});
        authors.get(key).objects.push(o);
      });
      if (!authors.size) { var empty = element('p','На карте пока нет отметок',content); empty.className = 'us-muted'; }
      Array.from(authors.values()).sort(function (a,b) { return a.name.localeCompare(b.name,'ru'); }).forEach(function (group) {
        var details = element('details','',content);
        element('summary',group.name + ' · ' + group.objects.length,details);
        var rendered = false;
        details.ontoggle = function () {
          if (!details.open || rendered) return;
          rendered = true;
          group.objects.forEach(function (o) {
            button(o.f.name || ({node:'Узел',fiber:'Линия ВОЛС',radio:'Радиолиния'})[o.type], details,'us-object',function () { currentPanel.close(); window.KartaApp.showObject(o.id); });
          });
        };
      });
      if (user.login !== '@server') button('Выйти',content,'us-danger',function () { request('POST','/api/logout',{}); location.replace('/login'); });
    }
    function accounts(notice) {
      try {
        var users = request('GET','/api/users').users;
        var toolbar = element('div','',content); toolbar.className = 'us-toolbar';
        element('strong','Доступ по сети',toolbar);
        button('Добавить пользователя',toolbar,'us-primary',function () { editor(null); });
        if (notice) message(notice,false);
        if (!users.length) { var empty = element('p','Добавьте тех, кому нужен доступ к карте.',content); empty.className = 'us-muted'; }
        users.sort(function (a,b) { return a.name.localeCompare(b.name,'ru'); }).forEach(function (u) {
          var row = element('div','',content); row.className = 'us-account';
          var caption = element('div','',row); element('strong',u.name,caption); element('small',u.login + ' · ' + roleNames[u.role],caption);
          button('Изменить',row,'',function () { editor(u); }).setAttribute('aria-label','Изменить доступ: ' + u.name);
        });
      } catch (e) { message(e.message,true); }
    }
    function backups(notice) {
      element('h3','Резервные копии карты',content);
      var hint = element('p','Копии делаются каждый час (если карта менялась) и автоматически перед массовыми правками: заменой карты из файла, удалением многих объектов, восстановлением. Восстановление тоже сначала сохраняет текущую карту.',content);
      hint.className = 'us-muted';
      if (notice) message(notice,false);
      try {
        var list = request('GET','/api/backups').backups;
        if (!list.length) { var empty = element('p','Копий пока нет.',content); empty.className = 'us-muted'; }
        list.forEach(function (b) {
          var row = element('div','',content); row.className = 'us-account';
          var caption = element('div','',row);
          var d = new Date(b.mtime), two = function (n) { return (n < 10 ? '0' : '') + n; };
          element('strong', two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()), caption);
          element('small', b.kind + ' · ' + Math.max(1, Math.round(b.size / 1024)) + ' КБ', caption);
          button('Восстановить',row,'',function () {
            if (!confirm('Вернуть общую карту к состоянию на ' + caption.firstChild.textContent + '? Это увидят все участники. Текущая карта будет сохранена отдельной копией.')) return;
            try {
              var data = request('POST','/api/backups',{restore:b.name});
              adopt(data); if (data.net && window.KartaApp) window.KartaApp.receiveShared(copy(base));
              show('backups','Карта восстановлена');
            } catch (e) { message(e.message,true); }
          }).setAttribute('aria-label','Восстановить копию ' + b.name);
        });
      } catch (e) { message(e.message,true); }
    }
    function editor(u) {
      content.replaceChildren();
      element('h3',u ? u.name : 'Новый пользователь',content);
      var form = element('form','',content), grid = element('div','',form); grid.className = 'us-grid';
      var fields = {};
      [['name','Имя'],['login','Логин'],['password','Пароль']].forEach(function (row) {
        var field = element('div','',grid), label = element('label',row[1],field);
        label.htmlFor = 'us-' + row[0];
        var wrap = row[0] === 'password' ? element('div','',field) : field;
        if (wrap !== field) wrap.className = 'us-password';
        var input = element('input','',wrap); input.name = row[0];
        input.id = label.htmlFor;
        input.value = u && row[0] !== 'password' ? u[row[0]] : '';
        input.required = row[0] !== 'password' || !u;
        input.maxLength = row[0] === 'login' ? 40 : row[0] === 'name' ? 80 : 256;
        input.autocomplete = row[0] === 'password' ? 'new-password' : 'off';
        if (row[0] === 'login' && u) input.readOnly = true;
        if (row[0] === 'password') {
          input.type = 'password'; input.minLength = 8;
          input.placeholder = u ? 'Не менять' : 'Не менее 8 символов';
          button('Показать',wrap,'',function () { var show = input.type === 'password'; input.type = show ? 'text' : 'password'; this.textContent = show ? 'Скрыть' : 'Показать'; this.setAttribute('aria-pressed',show); }).setAttribute('aria-label','Показать пароль');
        }
        fields[row[0]] = input;
      });
      var field = element('div','',grid), label = element('label','Права',field), roles = element('select','',field);
      roles.id = 'us-role'; label.htmlFor = roles.id;
      ['editor','viewer','admin'].forEach(function (role) { element('option',roleNames[role],roles).value = role; });
      roles.value = u ? u.role : 'editor';
      var result = element('p','',form); result.className = 'us-error'; result.setAttribute('role','alert');
      if (u) button('Отключить доступ',form,'us-danger',function () {
        if (!confirm('Отключить доступ для «' + u.name + '»?')) return;
        try { request('POST','/api/users',{login:u.login,name:u.name,role:u.role,disable:true}); show('access','Доступ отключён'); }
        catch (e) { result.textContent = e.message; }
      });
      var actions = element('div','',form); actions.className = 'us-actions';
      button('Отмена',actions,'',function () { show('access'); });
      var save = button('Сохранить',actions,'us-primary'); save.type = 'submit';
      form.onsubmit = function (event) {
        event.preventDefault(); save.disabled = true;
        try {
          request('POST','/api/users',{login:fields.login.value.trim(),name:fields.name.value.trim(),password:fields.password.value,role:roles.value,create:!u});
          show('access',u ? 'Изменения сохранены' : 'Пользователь добавлен');
        } catch (e) { result.textContent = e.message; save.disabled = false; }
      };
      fields.name.focus();
    }
    currentPanel.addEventListener('close',function () { currentPanel.remove(); if (panel === currentPanel) panel = null; });
    show(startTab === 'access' && access ? 'access' : 'members');
    currentPanel.showModal();
  }
  /* Прямой эфир: окно ждёт на сервере следующую правку (длинный опрос, до 10 с на запрос) и получает её
     сразу после записи на диск. Если сервер ответил мгновенно без изменений (старая версия без ожидания) —
     обычный опрос раз в секунду. Пока человек рисует линию или заполняет форму, чужие правки
     откладываются (deferred) и показываются сразу после этого. */
  var deferred = null, failures = 0;
  var wake = null;
  function sleep(ms) {
    return new Promise(function (r) {
      var t = setTimeout(function () { wake = null; r(); }, ms);
      wake = function () { clearTimeout(t); wake = null; r(); };
    });
  }
  var current = null;
  window.addEventListener('online', function () {   // сеть вернулась — отправить отложенное и переподключиться сразу
    if (!window.KartaApp) return;
    retryPending();
    if (current) current.abort();
    if (wake) wake();
  });
  function editing() {
    var c = window.KartaApp.state(), a = document.activeElement;
    return c.tool || (c.view && c.view.k === 'pt') || document.querySelector('#apDlg.show') || (a && a.matches && a.matches('input,textarea,select') && a.closest('#apSheet,#apDlg,dialog'));
  }
  function retryPending() {
    if (!pending || busy || editing()) return;
    var net = window.KartaShared.commit(pending, {silent: true});
    window.KartaApp.receiveShared(net);
  }
  function flush() {
    if (!deferred || !window.KartaApp) return;
    var d = deferred;
    if (busy || d.revision < revision) { if (!busy) deferred = null; return; }
    if (pending || editing()) return;
    deferred = null;
    adopt(d);
    window.KartaApp.receiveShared(copy(base));
  }
  function restorePending() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(PKEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved.net || !saved.base || !window.KartaApp) return;
    var net = window.KartaShared.commit(saved.net, {base: saved.base, silent: true});
    window.KartaApp.receiveShared(net);
  }
  async function loop() {
    var restored = false;
    for (;;) {
      if (busy || window.KartaPCSwitching || !window.KartaApp) { await sleep(300); continue; }
      if (!restored) { restored = true; restorePending(); }
      var started = Date.now(), timer = null;
      try {
        var ctl = current = window.AbortController ? new AbortController() : null;
        if (ctl) timer = setTimeout(function () { ctl.abort(); }, 25000);
        var known = deferred ? deferred.revision : revision;
        var response = await fetch('/api/shared?revision=' + known + '&wait=10', {cache: 'no-store', signal: ctl ? ctl.signal : undefined});
        if (response.status === 401) { toLogin(pending); return; }
        if (!response.ok) throw Error('Нет связи');
        var data = await response.json();
        failures = 0;
        retryPending();
        if (data.net) deferred = data;
        else if (!busy) { user = data.user; online = data.online; info(); }
        flush();
        if (!data.net && Date.now() - started < 150) await sleep(1000);
      } catch (e) {
        failures++;
        if (status) status.textContent = pending ? 'Правки не сохранены — повторить' : 'Нет связи с сервером · повторное подключение';
        await sleep(Math.min(3000, 400 * failures));
      } finally { if (timer) clearTimeout(timer); current = null; }
    }
  }
  var usersCSS = document.createElement('link'); usersCSS.rel = 'stylesheet'; usersCSS.href = 'users.css'; document.head.appendChild(usersCSS);
  document.addEventListener('DOMContentLoaded', function () {
    status = element('button', '', document.getElementById('apBar'));
    status.id = 'apUsers';
    status.style.cssText = 'min-width:0;max-width:28vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;padding:7px 10px;border:0;border-radius:8px;background:var(--panel,#fff);color:var(--accent,#145db0);cursor:pointer;font:inherit';
    document.querySelector('#apBar .ap-sp').before(status);
    if (user.role === 'viewer') document.querySelector('[data-mode="edit"]').style.display = 'none';
    status.onclick = function () {
      if (pending) { var net = window.KartaShared.commit(pending); if (!pending) window.KartaApp.receiveShared(net); }
      else participants();
    }; info();
    setInterval(flush, 250);
    loop();
  });
})();
