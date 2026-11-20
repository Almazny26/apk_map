"""3.5.1: браузер без WebGL (Firefox с выключенным WebGL, видеокарта в чёрном списке) — схема рисуется
запасным путём на холсте, сверху объяснение, как включить WebGL; ПК и телефон."""
import json
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

with tempfile.TemporaryDirectory() as folder:
    json.dump({'karta_author': 'Проверка'}, open(os.path.join(folder, 'state.json'), 'w'))
    app = run.App(folder, lambda *a: None)
    server = run.Server(('127.0.0.1', 0), run.make_handler(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%s' % server.server_address[1]
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                                        headless=True, args=['--disable-webgl', '--disable-3d-apis'])
            ctx = browser.new_context(viewport=dict(width=1366, height=800))
            ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith((base, 'data:', 'blob:')) else r.abort())
            page = ctx.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(base); page.wait_for_function('window.KartaApp && window.KartaMap')
            if not page.evaluate('KartaMap.info().files.length'):
                print('SKIP: нет файла схемы в map/'); sys.exit(0)
            page.wait_for_function('KartaMap.info().raster', timeout=20000)
            assert not page.evaluate('KartaMap.info().gl')
            note = page.locator('#mapGlNotice')
            assert note.is_visible() and 'WebGL' in note.inner_text()
            assert page.locator('#mapCoverageNotice').is_hidden()
            page.evaluate("map.setView([46.84,35.37],13)")
            page.wait_for_function("document.querySelectorAll('.leaflet-tile-pane canvas').length > 0", timeout=20000)
            time.sleep(2)
            painted = page.evaluate('''() => [...document.querySelectorAll('.leaflet-tile-pane canvas')].some(c => {
                try { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const s = new Set();
                  for (let i = 0; i < d.length; i += 4000) s.add(d[i] + ',' + d[i+1] + ',' + d[i+2]); return s.size > 3; } catch (e) { return false; } })''')
            assert painted, 'схема без WebGL не нарисовалась'
            note.click(); time.sleep(.3)
            text = page.locator('#apDlgBox').inner_text()
            assert 'about:config' in text and 'webgl.disabled' in text and 'Chrome' in text, text
            assert not errors, errors
            ctx.close()
            browser.close()
    finally:
        server.shutdown()
print('No-WebGL passed: canvas fallback schema, notice and how-to dialog')
