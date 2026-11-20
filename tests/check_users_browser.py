"""Users dialog: authors, permissions, account edits and responsive layouts."""
import os
import json
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'.audit/deps'),str(ROOT)]
import run
from shared import Shared
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as folder:
    app=run.App(folder,lambda *a:None)
    objects={}
    for id,author in [('legacy1','Телефон'),('legacy2','Компьютер'),('named','Иванов')]:
        objects[id]=dict(id=id,type='node',f=dict(name=id,lat=46.64,lng=32.62),ft={},by=author,t=1000)
    app.state.save({'karta_net':json.dumps(dict(v=1,objs=objects,journal=[]))})
    app.shared=Shared(app.state,folder)
    app.shared.set_user(dict(login='owner',name='Иванов',role='admin',password='test-password'))
    app.shared.set_user(dict(login='watch',name='Наблюдатель',role='viewer',password='test-password'))
    app.shared.local_presence=(dict(login='@server',name='Компьютер',role='admin'),time.time())
    server=run.Server(('127.0.0.1',0),run.make_handler(app))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base='http://127.0.0.1:%s'%server.server_address[1]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
            context=browser.new_context(viewport=dict(width=1366,height=900))
            context.route('**/*',lambda r:r.continue_() if r.request.url.startswith((base,'data:')) else r.abort())
            assert context.request.post(base+'/api/login',data=dict(login='owner',password='test-password')).ok
            page=context.new_page(); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base);page.wait_for_function('window.KartaApp && window.KartaShared')
            page.locator('#apUsers').click()
            dialog=page.locator('#apUsersDialog')
            text=dialog.inner_text()
            assert 'Телефон' not in text and 'Компьютер' not in text and '@server' not in text,text
            assert dialog.locator('summary').count()==2
            # 3.5.1: окно не меняет размер при смене вкладок, крестик — круг со значком SVG
            boxes=[]
            for tab in ['Доступ','Копии','Участники']:
                dialog.get_by_role('tab',name=tab,exact=True).click(); page.wait_for_timeout(150)
                bb=dialog.bounding_box(); boxes.append((round(bb['width']),round(bb['height'])))
            assert len(set(boxes))==1,boxes
            x=dialog.locator('.us-close').bounding_box()
            assert abs(x['width']-x['height'])<1 and dialog.locator('.us-close svg').count()==1,x
            dialog.get_by_role('tab',name='Доступ',exact=True).click()
            assert dialog.locator('form').count()==0
            dialog.get_by_role('button',name='Добавить пользователя',exact=True).click()
            assert dialog.get_by_label('Права',exact=True).input_value()=='editor'
            for width in [320,390,768,1366]:
                page.set_viewport_size(dict(width=width,height=900))
                assert dialog.evaluate('(d)=>d.scrollWidth<=d.clientWidth'),width
                assert dialog.locator('.us-actions').evaluate('(d)=>d.scrollWidth<=d.clientWidth'),width
                assert dialog.locator('input,select').evaluate_all('(xs)=>xs.every(x=>x.getBoundingClientRect().right<=x.closest("dialog").getBoundingClientRect().right)'),width
            page.set_viewport_size(dict(width=1366,height=900))
            dialog.locator('[name=name]').fill('Расчёт 7')
            dialog.locator('[name=login]').fill('crew7')
            dialog.locator('[name=password]').fill('new-password')
            dialog.get_by_role('button',name='Показать пароль').click()
            assert dialog.locator('[name=password]').get_attribute('type')=='text'
            dialog.get_by_role('button',name='Показать пароль').click()
            page.screenshot(path=str(ROOT/'.audit/users-editor.png'))
            dialog.get_by_role('button',name='Сохранить',exact=True).click()
            assert app.shared.users['crew7']['role']=='editor'
            dialog.get_by_role('button',name='Изменить доступ: Расчёт 7',exact=True).click()
            assert dialog.locator('[name=login]').get_attribute('readonly') is not None
            dialog.locator('[name=name]').fill('Расчёт 8')
            dialog.get_by_label('Права',exact=True).select_option('viewer')
            dialog.get_by_role('button',name='Сохранить',exact=True).click()
            assert app.shared.users['crew7']['role']=='viewer'
            assert app.shared.login(dict(login='crew7',password='new-password'),'test')
            page.screenshot(path=str(ROOT/'.audit/users-access.png'))
            dialog.get_by_role('tab',name='Участники',exact=True).click()
            page.evaluate('document.body.classList.add("dark")')
            page.screenshot(path=str(ROOT/'.audit/users-dark.png'))
            dialog.locator('summary').filter(has_text='Иванов').click()
            dialog.get_by_role('button',name='named',exact=True).click()
            assert not dialog.count()
            assert page.locator('#apSheet').is_visible()
            page.locator('#apUsers').click()
            dialog=page.locator('#apUsersDialog')
            dialog.get_by_role('tab',name='Доступ',exact=True).click()
            dialog.get_by_role('button',name='Изменить доступ: Расчёт 8',exact=True).click()
            page.on('dialog',lambda d:d.accept())
            dialog.get_by_role('button',name='Отключить доступ',exact=True).click()
            assert 'crew7' not in app.shared.users
            assert not errors,errors
            browser.close()
        print('Users dialog checks passed: responsive layouts, account lifecycle, roles, hidden device labels, author navigation, dark theme')
    finally:
        server.shutdown();server.server_close();app.close()
