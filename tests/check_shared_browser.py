import time
"""End-to-end shared map checks in independent authenticated browser contexts."""
import copy
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ['KARTA_MAP_DIR'] = str(ROOT / 'map')
sys.path[:0] = [str(ROOT / '.audit/deps'), str(ROOT)]
import run
from shared import Shared
from playwright.sync_api import sync_playwright


with tempfile.TemporaryDirectory() as folder:
    app = run.App(folder, lambda *args: None)
    app.shared = Shared(app.state, folder)
    for login, role in [('admin','admin'), ('ivan','editor'), ('petr','editor'), ('watch','viewer')]:
        app.shared.set_user(dict(login=login, name=login, role=role, password='test-password'))
    server = run.Server(('127.0.0.1', 0), run.make_handler(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%s' % server.server_address[1]
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True,
                args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
            pages = {}
            for login in ['admin','ivan','petr','watch']:
                context = browser.new_context(viewport=dict(width=1366,height=900))
                context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(base) or r.request.url.startswith('data:') else r.abort())
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base)
                page.locator('[name=login]').fill(login)
                page.locator('[name=password]').fill('test-password')
                page.locator('button').click()
                page.wait_for_function('window.KartaApp && window.KartaShared')
                pages[login] = page
            a, b, viewer, admin = [pages[k] for k in ['ivan','petr','watch','admin']]

            def add(page, name, lat):
                page.evaluate('KartaApp.setMode("edit"); KartaApp.startNode()')
                page.evaluate('(lat)=>map.fire("click",{latlng:L.latLng(lat,33.51),containerPoint:map.latLngToContainerPoint([lat,33.51])})', lat)
                page.locator('#apSheet [data-a=edit]').click()   # 3.5: узел ставится сразу, название — правкой
                page.locator('#apf0').fill(name)
                page.locator('#apOk').click()
                return page.evaluate('(name)=>Object.values(KartaNet.data().objs).find(o=>o.f.name===name).id', name)

            id_a = add(a, 'Узел Ивана', 46.51)
            id_b = add(b, 'Узел Петра', 46.52)
            # Polling returns all accepted changes, including independent simultaneous edits.
            viewer.wait_for_function('Object.keys(KartaNet.data().objs).length===2')
            a.wait_for_function('Object.keys(KartaNet.data().objs).length===2')
            assert viewer.locator('[data-mode=edit]').is_hidden()
            viewer.evaluate('KartaApp.setMode("edit")')
            assert viewer.evaluate('KartaApp.state().mode') == 'view'
            # Undo Ivan's operation must keep Petr's unrelated node.
            # 3.5: узел ставится одним нажатием, название — отдельная правка: две отмены
            a.keyboard.press('Control+z')
            a.wait_for_function('(id)=>KartaNet.data().objs[id].f.name!=="Узел Ивана"', arg=id_a)
            for _ in range(100):
                if app.shared.net()['objs'][id_a]['f']['name'] != 'Узел Ивана': break
                time.sleep(.1)
            a.keyboard.press('Control+z')
            a.wait_for_function('(id)=>KartaNet.data().objs[id].f.deleted', arg=id_a)
            time.sleep(1)
            assert app.shared.net()['objs'][id_a]['f']['deleted']
            assert not app.shared.net()['objs'][id_b]['f'].get('deleted')

            a.wait_for_function('(id)=>KartaNet.data().objs[id]', arg=id_b)
            for page in [a,b]:
                page.evaluate('(id)=>KartaApp.showObject(id)', id_b)
                page.locator('#apSheet [data-a=edit]').click()
            a.locator('#apf0').fill('Правка Ивана')
            b.locator('#apf0').fill('Правка Петра')
            a.locator('#apOk').click()
            dialogs = []
            b.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            b.locator('#apOk').click()
            assert dialogs and 'Другой пользователь' in dialogs[0], dialogs   # 3.4.6: первый вопрос — оставить чужую версию
            assert app.shared.net()['objs'][id_b]['f']['name'] == 'Правка Ивана'
            # Cancelled conflict must not create an undo entry that restores somebody else's version.
            assert b.evaluate('(id)=>KartaNet.data().objs[id].f.name', id_b) == 'Правка Ивана'

            # Transient save error keeps the draft; button explicitly retries.
            a.evaluate('(id)=>KartaApp.showObject(id)', id_b)
            a.locator('#apSheet [data-a=edit]').click()
            a.locator('#apf0').fill('После обрыва')
            a.on('dialog', lambda dialog: dialog.dismiss())
            a.route('**/api/shared', lambda route: route.abort() if route.request.method=='POST' else route.continue_())
            a.locator('#apOk').click()
            assert a.evaluate('KartaShared.hasPending()')
            a.wait_for_timeout(2500)
            assert a.evaluate('(id)=>KartaNet.data().objs[id].f.name', id_b) == 'После обрыва'
            a.unroute('**/api/shared')
            a.locator('#apUsers').click()
            assert not a.evaluate('KartaShared.hasPending()')
            assert app.shared.net()['objs'][id_b]['f']['name'] == 'После обрыва'

            admin.locator('#apUsers').click()
            admin.get_by_role('tab',name='Доступ',exact=True).click()
            admin.get_by_role('button',name='Добавить пользователя',exact=True).click()
            admin.locator('dialog [name=login]').fill('newuser')
            admin.locator('dialog [name=name]').fill('Расчёт 7')
            admin.locator('dialog [name=password]').fill('new-password')
            assert admin.get_by_label('Права',exact=True).input_value() == 'editor'
            admin.get_by_role('button',name='Сохранить',exact=True).click()
            assert app.shared.users['newuser']['name'] == 'Расчёт 7'
            admin.get_by_role('button',name='Закрыть',exact=True).click()
            admin.wait_for_function('(id)=>KartaNet.data().objs[id].f.name==="После обрыва"', arg=id_b)
            admin.evaluate('(id)=>KartaApp.showObject(id)', id_b)
            assert 'Добавил' in admin.locator('#apSheet').inner_text()
            # Authenticated clients must also receive the actual map assets.
            assert admin.request.get(base + '/omap/8/151/90.mvt').status == 200   # офлайн-схема; растровых tiles/ на ПК нет
            admin.evaluate('map.setView([46.64,32.62],14,{animate:false})')
            admin.wait_for_function('window.KartaMap && KartaMap.glMap() && KartaMap.glMap().queryRenderedFeatures().length>0')
            (ROOT / '.audit').mkdir(exist_ok=True)
            admin.screenshot(path=str(ROOT / '.audit/shared-desktop.png'))
            assert not errors, errors
            browser.close()
            print('Shared browser checks passed: login, roles, polling, distinct edits, safe undo, conflicts, recovery, accounts, attribution')
    finally:
        server.shutdown()
        server.server_close()
        app.close()
