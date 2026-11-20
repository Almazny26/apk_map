"""3.5.2: старый Chromium (Edge 92 на рабочем ПК, 2021 год) — полная подробная схема MapLibre, не упрощённая.
Нужен сам старый браузер: KARTA_CHROME92=путь к chrome (Chromium 92, сборка 885264); без него — SKIP."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'.audit/deps'), str(ROOT)]
import run
from playwright.sync_api import sync_playwright

EXE = os.environ.get('KARTA_CHROME92')
if not EXE or not os.path.isfile(EXE):
    print('SKIP: нет KARTA_CHROME92 (старый Chromium 92)'); sys.exit(0)
SHOTS = os.environ.get('KARTA_SHOTS')
with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as prof:
    json.dump({'karta_author': 'Проверка'}, open(os.path.join(folder, 'state.json'), 'w'))
    app = run.App(folder, lambda *a: None)
    server = run.Server(('127.0.0.1', 0), run.make_handler(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%s' % server.server_address[1]
    port = 9300 + os.getpid() % 500
    chrome = subprocess.Popen([EXE, '--headless', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=%d' % port,
                               '--window-size=1366,800', '--user-data-dir=' + prof, 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(3)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp('http://127.0.0.1:%d' % port)
            page = browser.contexts[0].pages[0]; errors = []
            page.on('pageerror', lambda e: errors.append(str(e)[:200]))
            page.goto(base); page.wait_for_function('window.KartaMap', timeout=30000)
            assert '/92.' in page.evaluate('navigator.userAgent')
            if not page.evaluate('KartaMap.info().files.length'):
                print('SKIP: нет файла схемы в map/'); sys.exit(0)
            page.evaluate("map.setView([46.84,35.37],14)")
            page.wait_for_function('KartaMap.info().tiles > 3', timeout=40000)
            time.sleep(3)
            info = page.evaluate('KartaMap.info()')
            assert info['gl'] and not info['raster'], page.evaluate('KartaMap.diag()')
            gm = page.evaluate("(()=>{var m=KartaMap.glMap();return {order:m.style._order.length,miss:m.style._order.filter(i=>!m.style._layers[i]).length}})()")
            full = page.evaluate("KartaStylePC.light.layers.length + (window.KartaCoverage ? 1 : 0)")
            assert gm['miss'] == 0 and gm['order'] == full, (gm, full)
            if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'after_edge92_light.png'))
            page.evaluate("KartaApp.setTheme(document.body.classList.contains('dark') ? 'light' : 'dark')"); time.sleep(3)
            gm = page.evaluate("(()=>{var m=KartaMap.glMap();return m.style._order.filter(i=>!m.style._layers[i]).length})()")
            assert gm == 0 and not page.evaluate('KartaMap.info().raster')
            if SHOTS: page.evaluate("document.querySelector('#apMenu') && document.body.click()"); time.sleep(.5); page.screenshot(path=os.path.join(SHOTS, 'after_edge92_dark.png'))
            text = page.evaluate('KartaMap.diag()')
            assert 'Ошибки' not in text and 'не создались' not in text, text
            assert not errors, errors
            browser.close()
    finally:
        chrome.kill(); server.shutdown()
print('Old Chromium 92 passed: full detailed MapLibre schema (all layers), dark theme, no errors')
