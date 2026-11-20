"""3.5.1: телефон — нет «Карты без интернета», меню и окна открываются без ошибок, крестики одинаковые,
сообщение не ложится на открытое окно, цели нажатия не меньше 40 px."""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'.audit/deps'), str(ROOT)]
import run
from playwright.sync_api import sync_playwright

STUB = '''window.KartaFiles={ready(){},shareText(){return true},saveText(){},openFile(){},takeOpenedName(){return null},takeOpenedText(){return null},takeOpenedError(){return null},
mapList(){return '[]'},networkUp(){return true},tick(){},netLoad(){return ''},netSave(){return true},locate(){},tileAsync(id){setTimeout(function(){__kartaTile(id,'')})},tileCancel(){}};
localStorage.setItem('karta_author','Проверка');'''
with tempfile.TemporaryDirectory() as folder:
    app = run.App(folder, lambda *a: None)
    server = run.Server(('127.0.0.1', 0), run.make_handler(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%s' % server.server_address[1]
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True)
            for w, h in [(360, 800), (844, 390)]:
                ctx = browser.new_context(viewport=dict(width=w, height=h), is_mobile=True, has_touch=True)
                ctx.add_init_script(STUB)
                def route(r):
                    url = r.request.url
                    if '/pc.js?' in url or '/access.js?' in url or '/shared.js?' in url or 'desktop.css' in url:
                        r.fulfill(status=200, content_type='text/javascript', body='')
                    elif url.startswith((base, 'data:', 'blob:')):
                        r.continue_()
                    else:
                        r.abort()
                ctx.route('**/*', route)
                page = ctx.new_page(); errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base + '/index.html'); page.wait_for_function('window.KartaApp && window.KartaMap')
                assert not page.evaluate('!!window.KartaPC')
                page.locator('#apMenuBtn').click()
                items = page.locator('#apMenu [data-m]').evaluate_all('l => l.map(e => e.dataset.m)')
                assert 'offline' not in items and 'Карта без интернета' not in page.locator('#apMenu').inner_text(), items
                for m in ['file', 'journal', 'legend', 'help', 'set']:
                    if not page.locator('#apMenu').is_visible():
                        page.locator('#apMenuBtn').click()
                    page.locator('#apMenu [data-m=%s]' % m).click(); time.sleep(.2)
                    x = page.locator('#apDlg .ap-dx').bounding_box()
                    assert x and round(x['width']) == round(x['height']) == 34, (m, x)
                    assert page.locator('#apDlg .ap-dx svg').count() == 1
                    text = page.locator('#apDlgBox').inner_text()
                    assert 'Скачайте' not in text and 'Sentinel' not in text, (m, text[:200])
                    if m == 'set':
                        small = page.evaluate('''() => [...document.querySelectorAll('#apDlgBox button')].filter(b => b.offsetParent && !b.classList.contains('sw') && Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height) < 34).map(b => b.textContent)''')
                        assert not small, small
                        page.evaluate("(t=>{t.textContent='Сохранено: изменения записаны в файл';t.classList.add('show')})(document.getElementById('apToast'))"); time.sleep(.35)
                        t = page.locator('#apToast').bounding_box(); d = page.locator('#apDlgBox').bounding_box()
                        assert t['y'] + t['height'] <= d['y'] + 1 or t['y'] >= d['y'] + 60, ('сообщение на заголовке окна', t, d)
                        page.evaluate("document.getElementById('apToast').classList.remove('show')")
                    page.locator('#apDlg .ap-dx').click(); time.sleep(.15)
                page.evaluate("KartaApp.setMode('edit'); KartaApp.startLine('fiber')"); time.sleep(.3)
                fib = page.locator('#apSheet [data-fib]').first.bounding_box()
                assert fib['width'] >= 44 and fib['height'] >= 40, fib
                sx = page.locator('#apSheet .ap-x').bounding_box()
                assert round(sx['width']) == round(sx['height']) == 34, sx
                kinds = page.locator('#mapKinds button').first.bounding_box()
                assert kinds['height'] >= 40, kinds
                assert not errors, errors
                ctx.close()
            browser.close()
    finally:
        server.shutdown()
print('Phone UI checks passed: no offline-download screen, dialogs, close buttons, tap targets')
