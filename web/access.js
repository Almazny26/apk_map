/* Desktop connection controls, visible in both local and shared modes. */
(function () {
  'use strict';
  function el(tag, text, parent) {
    var e = document.createElement(tag); if (text) e.textContent = text;
    if (tag === 'p') e.style.cssText = 'margin:10px 0;line-height:1.45';
    if (tag === 'h2') e.style.margin = '0 0 12px';
    if (tag === 'h3') e.style.margin = '18px 0 8px';
    if (parent) parent.appendChild(e); return e;
  }
  async function call(method, data) {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 4000);
    try {
      var r = await fetch('/api/access', {method:method, cache:'no-store', signal:controller.signal, headers:{'Content-Type':'application/json'}, body:data ? JSON.stringify(data) : undefined});
      var result = await r.json(); if (!r.ok) throw Error(result.error || 'Нет связи с программой'); return result;
    } finally { clearTimeout(timer); }
  }
  async function open() {
    var d = el('dialog', '', document.body);
    d.id = 'apAccessDialog';
    d.style.cssText = 'box-sizing:border-box;margin:auto;width:min(520px,92vw);max-height:85vh;overflow:auto;border:0;border-radius:16px;padding:24px;background:var(--panel,#fff);color:var(--text,#111);font:16px system-ui';
    el('h2', 'Удалённый доступ', d);
    var content = el('div', 'Загрузка…', d), foot = el('div', '', d);
    foot.style.marginTop = '18px';
    var close = el('button', 'Закрыть', foot); close.onclick = function () { d.close(); };
    close.style.cssText = 'border:0;border-radius:9px;padding:10px 16px;background:var(--tonal,#eee);color:var(--text,#111);font:inherit;cursor:pointer';
    function button(text, parent) {
      var b = el('button', text, parent); b.style.cssText = 'display:block;width:100%;margin:12px 0;padding:12px;border:0;border-radius:9px;background:#007aff;color:white;font:inherit;cursor:pointer'; return b;
    }
    d.onclose = function () { d.remove(); }; d.showModal();
    try {
      var state = await call('GET'); content.textContent = '';
      el('p', state.enabled ? 'Доступ по сети включён.' : 'Сейчас программа доступна только на этом компьютере.', content);
      el('p', 'Для подключения участникам нужны логин и пароль.', content);
      if (state.enabled) {
        el('h3', 'Адреса для подключения', content);
        state.addresses.forEach(function (address) { var p = el('p', address, content); p.style.cssText = 'user-select:text;overflow-wrap:anywhere;font-weight:600'; });
        if (!state.addresses.length) el('p', 'Подключите компьютер к локальной сети, чтобы получить IP-адрес.', content);
        el('p', 'Разрешите входящие подключения к этому порту в брандмауэре Windows. Адрес 127.0.0.1 предназначен только для этого компьютера.', content);
        button('Пользователи и пароли', content).onclick = function () { d.close(); window.KartaShared.showUsers(); };
      }
      if (window.KartaShared && !window.KartaShared.isOwner()) {
        el('p', 'Включать и выключать удалённый доступ можно только на серверном компьютере: иначе отключившийся по ошибке администратор не сможет вернуть доступ удалённо.', content).style.color = 'var(--muted,#666)';
        return;
      }
      var action = button(state.enabled ? 'Выключить удалённый доступ' : 'Включить удалённый доступ', content);
      if (state.enabled) action.style.background = '#b42318';
      action.onclick = async function () {
        if (window.KartaShared && window.KartaShared.hasPending()) { alert('Сначала сохраните ожидающие правки красной кнопкой пользователя.'); return; }
        if (window.KartaApp.state().tool || document.querySelector('#apDlg.show')) { alert('Сначала завершите ввод или нанесение линии.'); return; }
        if (state.enabled && !confirm('Отключить доступ по сети? Удалённые пользователи потеряют соединение.')) return;
        action.disabled = true;
        try {
          window.KartaPCSwitching = true;
          await call('POST', {enabled:!state.enabled});
          window.stop();
          content.textContent = 'Перезапуск программы…'; close.disabled = true;
          var deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            await new Promise(function (done) { setTimeout(done, 500); });
            try { var next = await call('GET'); if (next.enabled !== state.enabled) { location.replace('/'); return; } } catch (e) { /* сервер переключается */ }
          }
          content.textContent = 'Программа переключается дольше обычного. Обновите страницу через несколько секунд.';
          close.disabled = false;
        } catch (error) { window.KartaPCSwitching = false; el('p', error.message, content); action.disabled = false; }
      };
    } catch (error) { content.textContent = error.message; }
  }
  document.addEventListener('DOMContentLoaded', function () {
    // подписи режимов для узких экранов, где видны только значки
    document.querySelectorAll('#apBar .ap-seg button').forEach(function (s) { s.title = s.textContent.replace('РедактированиеПравка', 'Редактирование'); s.setAttribute('aria-label', s.title); });
    if (!window.KartaApp || (window.KartaShared && window.KartaShared.user().role !== 'admin')) return;
    var b = el('button', '', document.getElementById('apBar'));
    b.id = 'apAccess'; b.title = 'Удалённый доступ: подключение других пользователей';
    b.setAttribute('aria-label', 'Удалённый доступ');
    b.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
    el('span', 'Удалённый доступ', b).className = 'ac-label';
    b.style.cssText = 'min-width:0;max-width:25vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:8px;padding:8px 10px;background:var(--tonal,#eee);color:var(--accent,#007aff);font:inherit;cursor:pointer';
    document.querySelector('#apBar .ap-sp').before(b);
    b.onclick = open;
  });
})();
