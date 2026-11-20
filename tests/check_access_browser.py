"""Real UI: enable LAN access, remain signed in locally, require remote credentials."""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'.audit/deps'))
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as folder:
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); port = s.getsockname()[1]
    base = 'http://127.0.0.1:%s' % port
    remote = 'http://127.0.0.2:%s' % port
    process = subprocess.Popen([sys.executable,'-X','utf8','-B',str(ROOT/'run.py'),'--no-window','--data',folder,'--port',str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for attempt in range(60):
            try:
                urllib.request.urlopen(base+'/api/info',timeout=1).close(); break
            except OSError:
                time.sleep(.1)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,
                args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
            def context():
                c = browser.new_context(viewport=dict(width=1366,height=900))
                c.route('**/*',lambda r:r.continue_() if r.request.url.startswith((base,remote,'data:')) and '/tc/' not in r.request.url else r.abort())
                return c
            local = context().new_page(); errors=[]
            local.on('pageerror',lambda e:errors.append(str(e)))
            local.goto(base); local.wait_for_function('window.KartaApp')
            local.locator('#apWho').fill('Владелец'); local.locator('#apOk').click()
            local.locator('#apAccess').click()
            local.get_by_role('button',name='Включить удалённый доступ',exact=True).click()
            try:
                local.wait_for_function('window.KartaShared && KartaShared.user().login==="@server"',timeout=90000)
            except Exception:
                print('UI:', local.locator('body').inner_text()[-1800:])
                print('Errors:', errors)
                print((Path(folder)/'program.log').read_text(encoding='utf-8'))
                raise
            assert local.locator('[name=password]').count()==0
            assert local.locator('#apUsers').is_visible()
            local.locator('#apAccess').click()
            local.get_by_role('button',name='Пользователи и пароли',exact=True).click()
            local.get_by_role('button',name='Добавить пользователя',exact=True).click()
            local.locator('dialog [name=login]').fill('crew')
            local.locator('dialog [name=name]').fill('Расчёт 1')
            local.locator('dialog [name=password]').fill('test-password')
            local.get_by_label('Права',exact=True).select_option('editor')
            local.get_by_role('button',name='Сохранить',exact=True).click()
            local.get_by_role('button',name='Закрыть',exact=True).click()
            guest = context().new_page(); guest.on('pageerror',lambda e:errors.append(str(e)))
            guest.goto(remote)
            guest.locator('[name=login]').fill('crew')
            guest.locator('[name=password]').fill('test-password')
            guest.get_by_role('button',name='Войти',exact=True).click()
            guest.wait_for_function('window.KartaShared && KartaShared.user().login==="crew"')
            assert guest.locator('#apAccess').count()==0
            local.reload(); local.wait_for_function('window.KartaShared && KartaShared.user().login==="@server"')
            assert local.locator('[name=password]').count()==0
            local.locator('#apAccess').click()
            (ROOT/'.audit').mkdir(exist_ok=True)
            local.screenshot(path=str(ROOT/'.audit/access-desktop.png'))
            local.on('dialog',lambda d:d.accept())
            local.get_by_role('button',name='Выключить удалённый доступ',exact=True).click()
            local.wait_for_function('window.KartaApp && !window.KartaSharedMode',timeout=90000)
            assert local.locator('#apAccess').is_visible()
            assert not errors, errors
            browser.close()
        print('Access UI passed: normal launch, enable/reload, local password bypass, account creation, remote login, disable/reload')
    finally:
        process.terminate(); process.communicate(timeout=10)
