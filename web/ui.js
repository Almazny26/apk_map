/* Карта сети — современный вид интерфейса (телефон и компьютер).
 *
 * Подключается последним из наших файлов (после sheet.js; на компьютере перед pc-ui.js).
 * Код и разметка приложения товарища не меняются по смыслу — элементы только переставляются и
 * получают новые стили:
 *   - палитра, шрифты, кнопки, поля, карточки, переключатели — в одном стиле, светлом и тёмном;
 *   - шапка: название, вкладки «Сеть · Радио · ВОЛС» переключателем, остальное — в меню «⋮»
 *     (Обмен данными, История профилей, Тёмная тема, Онлайн-карты, Подпись изменений);
 *   - поля ввода: подпись над полем, поля по сетке, ничего не вылезает за край экрана;
 *   - вид точки паспорта — кнопками-«чипами», расчёт кабеля и SFP — сворачиваемым разделом;
 *   - карточки узлов и линий на карте, кнопки карты, окна-диалоги — в том же стиле.
 */
(function () {
  'use strict';
  if (!window.L || typeof map === 'undefined') return;
  var pc = !!window.KartaPC;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ================================================================== стили

  var css = el('style');
  css.textContent = [
    // палитра
    ':root{--bg:#f2f4f7;--panel:#fff;--text:#1b1f24;--muted:#69737d;--line:#e1e5ea;--accent:#1a73e8;--accent2:#1557b0;' +
      '--tonal:#e8f0fe;--card:#f5f8fc;--warnbg:#fff4e0;--danger:#d93025;--ok:#188038;--shadow:0 1px 2px rgba(16,24,40,.06),0 4px 14px rgba(16,24,40,.10);' +
      '--r:12px;--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
    'body.dark{--bg:#0f1216;--panel:#1a1e24;--text:#e8eaed;--muted:#9aa3ad;--line:#2e343c;--accent:#7cacf8;--accent2:#a8c7fa;' +
      '--tonal:#22324a;--card:#20262e;--warnbg:#3b2f18;--danger:#f28b82;--ok:#81c995;--shadow:0 1px 2px rgba(0,0,0,.4),0 6px 18px rgba(0,0,0,.45)}',
    'html,body{font-family:var(--font);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}',
    'body{font-size:14px}',

    // шапка
    'header{height:48px;background:var(--panel)!important;color:var(--text)!important;box-shadow:0 1px 0 var(--line),0 2px 8px rgba(0,0,0,.06);' +
      'padding:0 8px 0 12px!important;gap:10px}',
    '.ui-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;color:var(--text);white-space:nowrap}',
    '.ui-brand svg{flex:0 0 26px}',
    '.ui-seg{display:flex;background:var(--bg);border-radius:11px;padding:3px;gap:2px}',
    '.ui-seg button{background:transparent!important;color:var(--muted)!important;border:0!important;border-radius:8px!important;' +
      'padding:6px 14px!important;font-size:14px!important;font-weight:600!important;box-shadow:none!important;min-height:0}',
    '.ui-seg button.on{background:var(--panel)!important;color:var(--accent)!important;box-shadow:0 1px 3px rgba(0,0,0,.15)!important}',
    '.ui-right{display:flex;align-items:center;gap:4px;margin-left:auto}',
    '.ui-icon{width:38px;height:38px;padding:0!important;border-radius:50%!important;background:transparent!important;color:var(--text)!important;' +
      'display:inline-flex;align-items:center;justify-content:center;font-size:20px!important;line-height:1}',
    '.ui-icon:hover{background:var(--bg)!important}',
    '#btnTheme,#btnHist,#btnFile{display:none!important}',
    '.ui-viewbtn{display:inline-flex;align-items:center;gap:7px;background:var(--tonal)!important;color:var(--accent)!important;' +
      'border-radius:999px!important;padding:7px 14px!important;min-height:36px;font-size:14px!important}',
    '.ui-viewbtn.on{background:var(--accent)!important;color:#fff!important}',
    'body.dark .ui-viewbtn.on{color:#0b1d36!important}',
    '@media (max-width:520px){.ui-viewbtn span{display:none}.ui-viewbtn{padding:7px 9px!important}}',
    'body.view .ui-seg,body.view #pcTool,body.view #pcProfile,body.view #pcText,body.view #sheet,body.view #nmBar,body.view #toggle{display:none!important}',
    'body.view .leaflet-bottom{bottom:0!important}',
    'body.view header::after{content:"Просмотр";font-size:12px;font-weight:700;color:var(--accent);background:var(--tonal);border-radius:999px;padding:3px 10px;order:1}',
    'body.view .ui-right{order:2}',
    '@media (max-width:520px){.ui-brand span{display:none}.ui-seg button{padding:6px 11px!important}header{gap:6px}}',

    // меню «⋮»
    '#uiMenu{position:fixed;top:52px;right:8px;z-index:100001;min-width:250px;background:var(--panel);color:var(--text);border-radius:14px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.22);padding:6px;display:none}',
    '#uiMenu.show{display:block;animation:uiPop .14s ease-out}',
    '@keyframes uiPop{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}',
    '#uiMenu button{display:flex;align-items:center;gap:12px;width:100%;background:transparent!important;color:var(--text)!important;' +
      'border:0;border-radius:10px!important;padding:11px 12px!important;font-size:15px!important;font-weight:500!important;text-align:left}',
    '#uiMenu button:hover{background:var(--bg)!important}',
    '#uiMenu .ui-mi{width:22px;height:22px;flex:0 0 22px;color:var(--muted)}',
    '#uiMenu .ui-mi svg{width:22px;height:22px;display:block}',
    '#uiMenu .ui-sw{margin-left:auto;width:36px;height:20px;border-radius:10px;background:var(--line);position:relative;transition:background .15s}',
    '#uiMenu .ui-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}',
    '#uiMenu .ui-sw.on{background:var(--accent)}',
    '#uiMenu .ui-sw.on::after{left:18px}',
    '#uiMenu hr{border:0;border-top:1px solid var(--line);margin:4px 6px}',
    '#uiMenu .ui-note{font-size:12px;color:var(--muted);padding:2px 12px 8px}',

    // кнопки
    'button{font-family:inherit;border-radius:10px!important;border:0;background:var(--accent);color:#fff;font-weight:600;font-size:14px;' +
      'padding:9px 14px;min-height:38px;cursor:pointer;transition:filter .12s,background .12s,box-shadow .12s;letter-spacing:.1px}',
    'button:active{transform:translateY(1px)}',
    'button.secondary{background:var(--tonal);color:var(--accent)}',
    'body.dark button:not(.secondary):not(.ui-icon){color:#0b1d36}',
    'body.dark .leaflet-tile-pane{filter:brightness(.82) contrast(1.08)}',
    '.nm-pop .nm-sub{color:var(--muted)!important}',
    'body.dark button.secondary{color:var(--accent2)}',
    'button.active{background:var(--danger)!important;color:#fff!important;box-shadow:0 0 0 4px color-mix(in srgb,var(--danger) 25%,transparent)}',
    'button:disabled{opacity:.5}',

    // поля
    'input,select,textarea{font-family:inherit;font-size:15px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);' +
      'padding:9px 11px;min-height:40px;max-width:100%;transition:border-color .12s,box-shadow .12s}',
    'input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}',
    'select{appearance:none;-webkit-appearance:none;padding-right:34px;background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27%3E%3Cpath d=%27M1 1l5 5 5-5%27 fill=%27none%27 stroke=%27%2369737d%27 stroke-width=%272%27/%3E%3C/svg%3E");' +
      'background-repeat:no-repeat;background-position:right 12px center}',
    'input[type=checkbox]{min-height:0;accent-color:var(--accent);width:18px;height:18px}',
    'label{color:var(--muted);font-size:13px}',

    // панели
    '.panel{font-size:14px;line-height:1.45}',
    '.panel .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}',
    '.panel .row.fields{align-items:flex-end;gap:10px}',
    '.fld{display:flex;flex-direction:column;gap:4px;flex:1 1 92px;min-width:0}',
    '.fld>label{font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.fld>input,.fld>select{width:100%!important}',
    '.fld.wide{flex:1 1 220px}',
    '.panel .row>label:not(.chk){font-size:12px}',
    '.chk{display:inline-flex!important;align-items:center;gap:7px;padding:7px 12px;border:1px solid var(--line);border-radius:999px;' +
      'color:var(--text)!important;font-size:13px!important;cursor:pointer;user-select:none;background:var(--panel)}',
    '.chk:has(input:checked){background:var(--tonal);border-color:transparent;color:var(--accent)!important}',
    '.chk input{width:16px;height:16px}',
    '.ui-sec{font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin:16px 0 4px}',
    '.ui-sec:first-child{margin-top:4px}',
    '.panel>b{display:block;font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin:14px 0 4px}',
    '.info{color:var(--text)}',
    '.card{background:var(--card);border-radius:var(--r);padding:10px 12px;border:1px solid var(--line);margin:8px 0}',
    '.card.warn{background:var(--warnbg)}',
    '.pt{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:9px 12px;margin:6px 0;font-size:13px;overflow:hidden}',
    '.pt span[style*="float"]{float:none!important;display:flex;align-items:center;gap:6px;margin-top:6px}',
    '.pt .hpt{width:84px!important}',
    '.pt button[data-del],.pt button[data-nd]{min-height:30px;width:30px;padding:0;border-radius:50%!important;background:var(--bg);color:var(--muted);font-size:15px;margin-left:auto}',
    '.pt button[data-nd]{float:right;margin-top:-2px}',
    'canvas#profile{border-radius:var(--r);border:1px solid var(--line)}',
    '#calc{flex:1 1 100%;min-height:46px;font-size:15px}',
    '#addA,#addB,#addMore{flex:1 1 0;white-space:nowrap;padding-left:6px!important;padding-right:6px!important}',
    '#clear{flex:0 0 auto;padding-left:10px!important;padding-right:10px!important;background:transparent!important;color:var(--danger)!important;border:1px solid var(--line)!important}',
    '#nodeClear{background:var(--tonal)!important;color:var(--accent)!important}',
    '#sheetHead{padding-bottom:4px!important}',
    '#sheetMsg:empty{display:none}',
    '#optCalc{width:100%;min-height:44px;margin-top:6px}',
    'details.ui-det{border:1px solid var(--line);border-radius:var(--r);margin:12px 0;background:var(--panel)}',
    'details.ui-det>summary{list-style:none;cursor:pointer;padding:12px 14px;font-weight:600;display:flex;align-items:center;gap:8px}',
    'details.ui-det>summary::-webkit-details-marker{display:none}',
    'details.ui-det>summary::after{content:"";margin-left:auto;width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg);transition:transform .15s}',
    'details.ui-det[open]>summary::after{transform:rotate(-135deg)}',
    'details.ui-det>.ui-detb{padding:0 14px 12px}',
    '.ui-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}',
    '.ui-chips button{background:var(--panel)!important;color:var(--text)!important;border:1px solid var(--line)!important;border-radius:999px!important;padding:7px 14px;min-height:34px;font-weight:500}',
    '.ui-chips button.on{background:var(--tonal)!important;color:var(--accent)!important;border-color:transparent!important;font-weight:700}',
    '.ui-chips i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:0}',
    '#nodeName{flex:1 1 100%}',
    '#nodeArm{flex:1 1 auto}',
    '.nm-cur{font-size:12px!important;color:var(--muted)}',
    '.ui-hint{font-size:13px;color:var(--muted);background:var(--card);border-radius:var(--r);padding:10px 12px;margin:8px 0}',

    // вкладка «Сеть»
    '#panelNet .nm-item{border-radius:var(--r);padding:10px 12px;transition:border-color .12s,background .12s}',
    '#panelNet .nm-item:hover{border-color:var(--accent)}',
    '#panelNet .nm-txt b{font-size:14px}',
    '#netAdd{flex:1 1 100%;min-height:44px}',
    '#panelNet input[type=search]{flex:1 1 160px}',
    '#netFilter{flex:0 1 140px}',

    // карта: кнопки и подложки
    '.leaflet-bar{border:0!important;border-radius:12px!important;box-shadow:var(--shadow)!important;overflow:hidden}',
    '.leaflet-bar a{width:40px!important;height:40px!important;line-height:40px!important;background:var(--panel)!important;color:var(--text)!important;border-bottom:1px solid var(--line)!important;font-size:20px!important}',
    '.leaflet-bar a:last-child{border-bottom:0!important}',
    '.leaflet-touch .leaflet-bar a{width:44px!important;height:44px!important;line-height:44px!important}',
    '.leaflet-control-scale-line{border-color:var(--muted)!important;background:color-mix(in srgb,var(--panel) 80%,transparent)!important;color:var(--text)!important}',
    '#mapKinds{gap:0!important;background:var(--panel);border-radius:12px;box-shadow:var(--shadow);padding:4px;top:58px!important;right:10px!important}',
    '#mapKinds button{background:transparent!important;color:var(--text)!important;box-shadow:none!important;border-radius:9px!important;padding:7px 12px!important;font-size:13px!important;font-weight:600!important;min-height:34px;text-align:left}',
    '#mapKinds button.on{background:var(--tonal)!important;color:var(--accent)!important}',

    // карточки на карте
    '.leaflet-popup-content-wrapper{border-radius:16px!important;box-shadow:0 8px 28px rgba(0,0,0,.22)!important;background:var(--panel)!important;color:var(--text)!important}',
    '.leaflet-popup-tip{background:var(--panel)!important}',
    '.leaflet-popup-content{margin:14px 16px!important;font-family:var(--font)}',
    '.leaflet-container a.leaflet-popup-close-button{top:8px!important;right:8px!important;width:28px!important;height:28px!important;font-size:20px!important;color:var(--muted)!important}',
    '.nm-pop{font-size:13px!important}',
    '.nm-pop b{font-size:16px!important}',
    '.nm-pop .nm-row{display:grid!important;grid-template-columns:1fr 1fr;gap:6px!important;margin-top:10px!important}',
    '.nm-pop .nm-row button{min-height:38px;padding:7px 8px!important;font-size:13px!important}',
    '.nm-pop .nm-row button:first-child{grid-column:1/-1}',
    '.nm-st{border-radius:999px!important;padding:1px 8px!important}',

    // окна-диалоги на телефоне — снизу, как шторка
    '#netDlgBox,#histBox,#kartaExBox{border-radius:18px!important;box-shadow:0 10px 40px rgba(0,0,0,.3)}',
    '#netDlgBox h3,#kartaExBox h3{font-size:17px}',
    '#netDlgBox label{color:var(--muted);font-weight:600;font-size:12px!important}',
    '#netDlgBox .nm-row button{flex:1 1 auto;min-height:44px}',
    '.kx-head,.ui-dlg-head{display:flex;align-items:center;gap:8px;margin:-2px 0 6px}',
    '.kx-head b,.ui-dlg-head b{font-size:17px;flex:1}',
    '.kx-close,.ui-x{width:34px;height:34px;min-height:0!important;padding:0!important;border-radius:50%!important;background:var(--bg)!important;color:var(--muted)!important;font-size:16px!important}',
    '#hist{background:rgba(0,0,0,.45)!important}',
    '#hist .hist-item{border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;margin:8px 0}',
    '#hist>.x{display:none}',
    pc ? '' : '#netDlg,#kartaEx,#hist{align-items:flex-end!important;background:rgba(0,0,0,.45)!important}',
    pc ? '' : '#netDlgBox,#kartaExBox,#histBox{width:100%!important;max-width:560px!important;max-height:92vh!important;border-radius:20px 20px 0 0!important;' +
      'padding:18px 16px calc(16px + env(safe-area-inset-bottom))!important;animation:uiUp .2s ease-out}',
    '@keyframes uiUp{from{transform:translateY(40px);opacity:.4}to{transform:none;opacity:1}}',

    // полоса проведения линии и шторка
    '#nmBar{border-radius:16px!important;box-shadow:0 10px 30px rgba(0,0,0,.25)!important}',
    '#sheet{border-radius:20px 20px 0 0!important}',
    '#sheetTitle span{font-size:17px}',
    '#sheetBtn{min-height:32px!important;padding:5px 12px!important;background:var(--tonal)!important;color:var(--accent)!important;border:0!important;font-size:13px!important}',
    '#sheetGrip{background:var(--line)!important;width:44px!important}',
    '#sheet .panel{padding:0 16px 18px!important}',

    // компьютер
    pc ? '.pcw{border-radius:14px!important;border-color:var(--line)!important}' : '',
    pc ? '.pcw-title{background:var(--panel)!important;color:var(--text)!important;border-bottom:1px solid var(--line);flex-basis:40px!important}' : '',
    pc ? '.pcw-title button{color:var(--muted)!important;border-radius:8px!important;min-height:0}' : '',
    pc ? '.pcw-title button:hover{background:var(--bg)!important}' : '',
    pc ? '.pcw:not(.pcw-front) .pcw-title{filter:none!important;color:var(--muted)!important}' : '',
    pc ? '#pcBar{background:var(--panel)!important}' : '',
    pc ? '#netDlg.pcw #netDlgBox,#hist.pcw #histBox,#kartaEx.pcw #kartaExBox{box-shadow:none!important;border-radius:0!important}' : '',
    '#netDlg .x{display:none!important}'
  ].join('\n');
  document.head.appendChild(css);

  // ================================================================== шапка

  var header = document.querySelector('header'), spans = header.querySelectorAll(':scope > span');
  var brand = spans[0];
  brand.className = 'ui-brand';
  brand.innerHTML = '<svg width="26" height="26" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#17324D"/>' +
    '<path d="M24 12 L14 31 L34 31 Z" fill="none" stroke="#7FD1FF" stroke-width="2.6" stroke-linejoin="round"/>' +
    '<circle cx="24" cy="12" r="5" fill="#fff"/><circle cx="14" cy="31" r="5" fill="#fff"/><circle cx="34" cy="31" r="5" fill="#FFB547"/></svg><span>Карта сети</span>';
  var seg = el('nav', 'ui-seg');
  ['tabNet', 'tabRadio', 'tabFiber'].forEach(function (id) { if ($(id)) seg.appendChild($(id)); });
  var right = spans[1];
  right.className = 'ui-right';
  header.insertBefore(seg, right);
  // «Просмотр»: только смотреть карту и сведения о линиях и узлах
  var viewBtn = el('button', 'ui-viewbtn');
  viewBtn.type = 'button'; viewBtn.id = 'btnView'; viewBtn.title = 'Режим просмотра: только смотреть карту и сведения';
  var EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  function viewLabel(on) { viewBtn.innerHTML = EYE + '<span>' + (on ? 'Выйти из просмотра' : 'Просмотр') + '</span>'; }
  viewLabel(false);
  right.appendChild(viewBtn);
  window.KartaView = function (on) {
    on = !!on;
    document.body.classList.toggle('view', on);
    viewLabel(on);
    viewBtn.classList.toggle('on', on);
    if (window.KartaNet && KartaNet.setView) KartaNet.setView(on);
    setTimeout(function () { map.invalidateSize(); }, 50);
  };
  viewBtn.onclick = function () { window.KartaView(!document.body.classList.contains('view')); };

  var menuBtn = el('button', 'ui-icon', '&#8942;');
  menuBtn.type = 'button'; menuBtn.id = 'btnMenu'; menuBtn.title = 'Меню';
  right.appendChild(menuBtn);
  // текстовые пробелы между прежними кнопками больше не нужны
  [].slice.call(right.childNodes).forEach(function (n) { if (n.nodeType === 3) right.removeChild(n); });

  var menu = el('div');
  menu.id = 'uiMenu';
  document.body.appendChild(menu);
  function ic(d) { return '<span class="ui-mi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg></span>'; }
  var I = {
    file: ic('<path d="M7 4v13M3 13l4 4 4-4M17 20V7M13 11l4-4 4 4"/>'),
    hist: ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'),
    fit: ic('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    web: ic('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>'),
    moon: ic('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
    pen: ic('<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>')
  };
  function sw(on) { return '<span class="ui-sw' + (on ? ' on' : '') + '"></span>'; }
  function renderMenu() {
    var online = $('online') && $('online').checked, dark = document.body.classList.contains('dark');
    var who = localStorage.getItem('karta_author') || '';
    menu.innerHTML =
      '<button type="button" data-m="file">' + I.file + 'Обмен данными (файл)</button>' +
      '<button type="button" data-m="hist">' + I.hist + 'История профилей</button>' +
      '<button type="button" data-m="fit">' + I.fit + 'Показать всю сеть</button>' +
      '<hr>' +
      '<button type="button" data-m="online">' + I.web + 'Онлайн-карты и высоты' + sw(online) + '</button>' +
      '<div class="ui-note">' + (online ? 'Карта и рельеф загружаются из интернета; открытое сохраняется.' : 'Без интернета: только сохранённое. Координаты никуда не уходят.') + '</div>' +
      '<button type="button" data-m="theme">' + I.moon + 'Тёмная тема' + sw(dark) + '</button>' +
      '<button type="button" data-m="who">' + I.pen + 'Подпись: ' + (who ? who.replace(/</g, '&lt;') : 'не задана') + '</button>';
  }
  function closeMenu() { menu.classList.remove('show'); }
  menuBtn.onclick = function (e) {
    e.stopPropagation();
    if (menu.classList.contains('show')) { closeMenu(); return; }
    renderMenu();
    menu.classList.add('show');
  };
  document.addEventListener('click', function (e) { if (!menu.contains(e.target) && e.target !== menuBtn) closeMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.classList.contains('show')) { closeMenu(); e.stopImmediatePropagation(); } }, true);
  menu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-m]');
    if (!b) return;
    var m = b.getAttribute('data-m');
    if (m === 'file') { closeMenu(); $('btnFile').click(); }
    else if (m === 'hist') { closeMenu(); $('btnHist').click(); }
    else if (m === 'fit') { closeMenu(); var f = $('netFit'); if (f) f.click(); }
    else if (m === 'online') { $('online').click(); renderMenu(); }
    else if (m === 'theme') { $('btnTheme').click(); renderMenu(); }
    else if (m === 'who') { closeMenu(); var w = $('netWhoEdit'); if (w) w.click(); }
  });

  // ================================================================== панели: поля, разделы, чипы

  function sec(text) { return el('div', 'ui-sec', text); }

  // подпись над полем: «label + input» → блок .fld
  function fieldify(row) {
    var kids = [].slice.call(row.children), changed = false;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i], n = kids[i + 1];
      if (k.tagName === 'LABEL' && !k.querySelector('input,select') && n && /^(INPUT|SELECT)$/.test(n.tagName)) {
        var f = el('div', 'fld' + (n.tagName === 'SELECT' ? ' wide' : ''));
        row.insertBefore(f, k); f.appendChild(k); f.appendChild(n);
        n.style.width = '';
        i++; changed = true;
      }
    }
    if (changed) row.classList.add('fields');
  }
  document.querySelectorAll('#panel .row, #panelFiber .row').forEach(fieldify);
  // флажки — переключатели-«чипы»
  document.querySelectorAll('.panel label').forEach(function (l) { if (l.querySelector('input[type=checkbox]')) l.classList.add('chk'); });

  // --- Радиолиния
  var P = $('panel');
  var onlineRow = $('online') && $('online').closest('.row');
  if (onlineRow) onlineRow.style.display = 'none';           // перенесено в меню «⋮»
  P.insertBefore(sec('Точки'), P.firstChild);
  var hRow = $('hDef').closest('.row');
  P.insertBefore(sec('Параметры'), hRow);
  $('freq').closest('.fld').classList.add('freq');
  var calcRow = $('calc').closest('.row');
  P.insertBefore(sec('Расчёт'), calcRow);
  $('addMore').textContent = '+ Точка';
  // «История профилей» — рядом с расчётом
  var histBtn = el('button', 'secondary', 'История');
  histBtn.type = 'button';
  histBtn.onclick = function () { $('btnHist').click(); };
  calcRow.appendChild(histBtn);
  P.insertBefore(sec('Результат'), $('info'));

  // --- ВОЛС
  var F = $('panelFiber');
  var kindSel = $('nodeKind'), kindRow = kindSel.closest('.row');
  var chips = el('div', 'ui-chips');
  var KC = { 'опора': '#6d4c41', 'муфта': '#ef6c00', 'узел': '#1565c0', 'кросс': '#2e7d32' };
  [].slice.call(kindSel.options).forEach(function (o) {
    var b = el('button', o.value === kindSel.value ? 'on' : '', '<i style="background:' + (KC[o.value] || '#555') + '"></i>' + o.textContent);
    b.type = 'button';
    b.onclick = function () {
      kindSel.value = o.value;
      chips.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    };
    chips.appendChild(b);
  });
  kindSel.style.display = 'none';
  kindRow.parentNode.insertBefore(chips, kindRow);
  kindRow.parentNode.insertBefore(sec('Какую точку ставить'), chips);
  $('nodeArm').classList.remove('secondary');
  $('nodeName').placeholder = 'Номер или имя точки (необязательно)';
  // «Расчёт ВОЛС…» — сворачиваемый раздел
  var bs = F.querySelectorAll(':scope > b');
  bs.forEach(function (b) {
    if (/^Паспорт/.test(b.textContent)) { b.remove(); return; }
    if (!/^Расч/.test(b.textContent)) return;
    var det = el('details', 'ui-det', '<summary>Расчёт кабеля, затухания и SFP</summary>');
    var body = el('div', 'ui-detb');
    det.appendChild(body);
    var n = b.nextSibling;
    while (n) { var next = n.nextSibling; body.appendChild(n); n = next; }
    b.replaceWith(det);
  });
  var nodeListSec = sec('Точки линии');
  $('nodeList').parentNode.insertBefore(nodeListSec, $('nodeList'));

  // --- Сеть
  var N = $('panelNet');
  if (N) {
    var leg = N.querySelectorAll('.nm-legend');
    if (leg.length) {
      var det = el('details', 'ui-det', '<summary>Обозначения на карте</summary>');
      var body = el('div', 'ui-detb');
      det.appendChild(body);
      leg[0].parentNode.insertBefore(det, leg[0]);
      leg.forEach(function (l) { body.appendChild(l); });
    }
    var first = N.firstChild;
    if (first && first.tagName === 'B') first.style.display = 'none';
  }

  // окно «История профилей»: заголовок с кнопкой закрытия внутри окна
  var hb = $('histBox');
  if (hb) {
    var hb0 = hb.querySelector(':scope > b');
    var head = el('div', 'ui-dlg-head', '<b>История профилей</b>');
    var x = $('histClose');
    x.className = 'x ui-x'; x.innerHTML = '&#10005;';
    head.appendChild(x);
    if (hb0) hb0.replaceWith(head); else hb.insertBefore(head, hb.firstChild);
  }
  $('hist').addEventListener('click', function (e) { if (e.target === $('hist')) $('hist').classList.remove('show'); });

  setTimeout(function () { map.invalidateSize(); }, 50);
})();
