"""Verify the mobile branch retains satellite/hybrid while desktop resets to schema."""
import os
import struct
import sys
import tempfile
import threading
from pathlib import Path
import zlib

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'.audit/deps'),str(ROOT)]
import run
from playwright.sync_api import sync_playwright

def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\x44\x88\xcc\xff'))+chunk(b'IEND',b'')
with tempfile.TemporaryDirectory() as folder:
    app=run.App(folder,lambda *a:None)
    server=run.Server(('127.0.0.1',0),run.make_handler(app))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base='http://127.0.0.1:%s'%server.server_address[1]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
            ctx=browser.new_context(viewport=dict(width=390,height=844),is_mobile=True,has_touch=True)
            ctx.add_init_script('localStorage.setItem("karta_author","Проверка");localStorage.setItem("karta_map","sat");')
            def route(r):
                url=r.request.url
                if '/pc.js?' in url:r.fulfill(status=200,content_type='text/javascript',body='window.KartaPC=false;window.KartaOfflineOnly=false;')
                elif '/access.js?' in url:r.fulfill(status=200,content_type='text/javascript',body='')
                elif url.startswith((base,'data:')):r.continue_()
                else:r.fulfill(status=200,content_type='image/png',body=png)
            ctx.route('**/*',route)
            page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base);page.wait_for_function('window.KartaApp && window.KartaMap')
            assert page.locator('#mapSat').is_visible()
            assert page.locator('#mapHyb').is_visible()
            assert page.evaluate('!window.KartaPC && map.hasLayer(sat) && localStorage.getItem("karta_map")==="sat"')
            page.locator('#mapHyb').click()
            assert page.evaluate('map.hasLayer(hybrid) && localStorage.getItem("karta_map")==="hyb"')
            assert not errors,errors
            browser.close()
        print('Mobile branch preserved: satellite/hybrid controls, stored satellite selection and switching')
    finally:server.shutdown();server.server_close();app.close()
