"""3.5.1: телефон без WebGL (старый WebView, видеокарта в чёрном списке) — вшитая схема рисуется
упрощённо на холсте из настоящих плиток оболочки (tileAsync), сверху подсказка; светлая и тёмная тема."""
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

# оболочка: плитки вшитой схемы берутся с сервера (тот же файл map/karta-offline.pmtiles), ответ — в фоне, base64
STUB = '''window.__asked=0;window.KartaFiles={ready(){},shareText(){return true},saveText(){},openFile(){},takeOpenedName(){return null},takeOpenedText(){return null},takeOpenedError(){return null},
mapList(){return JSON.stringify([{slug:'karta-offline',kind:'map',size:1,mtime:1,maxzoom:15,builtin:true,bounds:[30.9,45.7,37.34,48.25]}])},
networkUp(){return false},tick(){},netLoad(){return ''},netSave(){return true},locate(){},asset(){return ''},mapTile(){return ''},tileCancel(){},
tileAsync(id,k,z,x,y){window.__asked++;if(k!=='t'){setTimeout(()=>__kartaTile(id,''));return}
 fetch('/omap/'+z+'/'+x+'/'+y+'.mvt').then(r=>r.status==200?r.arrayBuffer():new ArrayBuffer(0)).then(b=>{let s='',u=new Uint8Array(b);for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);__kartaTile(id,u.length?btoa(s):'')})}};
localStorage.setItem('karta_author','Проверка');'''

def painted(page):
    return page.evaluate('''() => [...document.querySelectorAll('.leaflet-tile-pane canvas')].filter(c => {
        try { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const s = new Set();
          for (let i = 0; i < d.length; i += 4000) s.add(d[i] + ',' + d[i+1] + ',' + d[i+2]); return s.size > 3; } catch (e) { return false; } }).length''')

with tempfile.TemporaryDirectory() as folder:
    app = run.App(folder, lambda *a: None)
    server = run.Server(('127.0.0.1', 0), run.make_handler(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%s' % server.server_address[1]
    try:
        if not (ROOT/'map'/'karta-offline.pmtiles').is_file():
            print('SKIP: нет файла схемы в map/'); sys.exit(0)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                                        headless=True, args=['--disable-webgl', '--disable-3d-apis'])
            ctx = browser.new_context(viewport=dict(width=390, height=844), is_mobile=True, has_touch=True, device_scale_factor=2)
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
            page.evaluate("map.setView([46.84,35.37],13)")
            page.wait_for_function('KartaMap.info().raster', timeout=20000)
            assert not page.evaluate('KartaMap.info().gl')
            note = page.locator('#mapGlNotice')
            assert note.is_visible() and 'WebGL' in note.inner_text()
            for _ in range(40):
                if painted(page) >= 2: break
                time.sleep(.5)
            assert painted(page) >= 2, 'упрощённая схема на телефоне не нарисовалась'
            time.sleep(1.5)
            assert page.evaluate('window.__asked') > 0, 'плитки не запрашивались у оболочки'
            if os.path.isdir('/workspace/rv/shots-3.5.1'): page.screenshot(path='/workspace/rv/shots-3.5.1/after_phone_nowebgl_light.png')
            nb = note.bounding_box(); assert nb['x'] >= 0 and nb['x'] + nb['width'] <= 390, nb
            note.click(); time.sleep(.3)
            text = page.locator('#apDlgBox').inner_text()
            assert 'WebView' in text or 'Chrome' in text, text
            page.locator('#apDlg .ap-dx').click(); time.sleep(.2)
            page.evaluate("KartaApp.setTheme(document.body.classList.contains('dark') ? 'light' : 'dark')"); time.sleep(.3)
            for _ in range(40):
                if painted(page) >= 2 and page.evaluate("KartaMap.info().raster"): break
                time.sleep(.5)
            assert painted(page) >= 2, 'тёмная упрощённая схема не нарисовалась'
            page.mouse.click(60, 600); time.sleep(1.5)
            assert page.evaluate("getComputedStyle(document.getElementById('mapGlNotice')).backgroundColor") != 'rgb(255, 244, 229)'
            if os.path.isdir('/workspace/rv/shots-3.5.1'): page.screenshot(path='/workspace/rv/shots-3.5.1/after_phone_nowebgl_dark.png')
            assert not errors, errors
            ctx.close(); browser.close()
    finally:
        server.shutdown()
print('Phone no-WebGL passed: built-in schema drawn on canvas from shell tiles, notice, help, dark theme')
