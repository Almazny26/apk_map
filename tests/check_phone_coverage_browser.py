"""3.5.3: телефон без растровой карты 7–11 — без связи вшитая схема видна везде (вне левобережья — подсказка),
со связью вне левобережья — схема из интернета, внутри — вшитая."""
import os,sys,tempfile,threading,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; sys.path[:0]=[str(ROOT/'.audit/deps'),str(ROOT)]
import run
from playwright.sync_api import sync_playwright
STUB=open(ROOT/'tests/check_phone_nowebgl_browser.py').read().split("STUB = '''")[1].split("'''")[0]
OUT=os.environ.get('KARTA_SHOTS')
with tempfile.TemporaryDirectory() as f:
    app=run.App(f,lambda *a:None); srv=run.Server(('127.0.0.1',0),run.make_handler(app)); threading.Thread(target=srv.serve_forever,daemon=True).start()
    base='http://127.0.0.1:%s'%srv.server_address[1]
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        for up in (False,True):
            for theme in ('light','dark'):
                c=b.new_context(viewport=dict(width=390,height=844),is_mobile=True,has_touch=True,device_scale_factor=2)
                c.add_init_script(STUB.replace("networkUp(){return false}","networkUp(){return %s}"%('true' if up else 'false')))
                def route(r):
                    u=r.request.url
                    if any(k in u for k in ['/pc.js?','/access.js?','/shared.js?','desktop.css']): r.fulfill(status=200,content_type='text/javascript',body='')
                    elif u.startswith((base,'data:','blob:')): r.continue_()
                    elif 'tile.openstreetmap.org' in u: r.fulfill(status=200,content_type='image/png',body=(ROOT/'web'/'icon.png').read_bytes())
                    else: r.abort()
                c.route('**/*',route)
                pg=c.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
                pg.goto(base+'/index.html'); pg.wait_for_function('window.KartaApp&&window.KartaMap')
                if theme=='dark': pg.evaluate("KartaApp.setTheme('dark')")
                for name,ll,z in [('kyiv',(50.45,30.52),10),('leftbank',(46.84,35.37),13)]:
                    pg.evaluate("void map.setView([%f,%f],%d)"%(ll[0],ll[1],z)); time.sleep(3)
                    st=pg.evaluate("""(()=>({gl:(document.querySelector('.karta-gl')||{style:{}}).style.display!=='none', osm:Object.values(map._layers).some(l=>l._url&&/openstreetmap/.test(l._url)), note:(n=>n&&!n.hidden?n.textContent:'')(document.getElementById('mapCoverageNotice'))}))()""")
                    inside = name == 'leftbank'
                    if up:
                        assert st['gl'] == inside and st['osm'] == (not inside) and not st['note'], (up, name, st)
                    else:   # без связи — везде вшитая схема; вне неё — подсказка, а не пустая карта молча
                        assert st['gl'] and not st['osm'] and (bool(st['note']) != inside), (up, name, st)
                    assert not errs, errs
                    if OUT: pg.screenshot(path='%s/phone_%s_%s_%s.png'%(OUT,'online' if up else 'offline',theme,name))
                c.close()
    srv.shutdown()
print('Phone coverage passed: offline — built-in schema everywhere (+ hint outside), online — internet schema outside the left bank; light/dark')
