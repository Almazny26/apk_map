"""Render the real bundled maps at all supported zooms without outbound traffic."""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'.audit/deps'),str(ROOT)]
os.environ['KARTA_MAP_DIR']=str(ROOT/'map')
import run
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as folder:
    app=run.App(folder,lambda *a:None)
    app.state.save({'karta_author':'Проверка','wf_online':'1','karta_map':'sat','karta_set':json.dumps({'schema':'online'}),'karta_view':'[46.64,32.62,14]'})
    assert [f['slug'] for f in app.offline.status()['files']]==['karta-offline']
    server=run.Server(('127.0.0.1',0),run.make_handler(app))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base='http://127.0.0.1:%s'%server.server_address[1]
    outbound=[];errors=[]
    try:
        with patch('urllib.request.urlopen',side_effect=AssertionError('Outbound server traffic is forbidden')) as blocked:
            with sync_playwright() as p:
                browser=p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
                context=browser.new_context(viewport=dict(width=1366,height=900))
                def route(r):
                    if r.request.url.startswith((base,'data:')):r.continue_()
                    else:outbound.append(r.request.url);r.abort()
                context.route('**/*',route)
                page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(base);page.wait_for_function('window.KartaMap && KartaMap.glMap()')
                assert page.evaluate('KartaOfflineOnly && !online && localStorage.getItem("wf_online")==="0"')
                for name,lat,lng in [('kherson',46.64,32.62),('zaporozhye',47.84,35.14)]:
                    for kind in ['off']:
                        page.evaluate('(kind)=>useMap(kind)',kind)
                        for zoom in range(3,20):
                            page.evaluate('(v)=>map.setView([v[0],v[1]],v[2],{animate:false})',[lat,lng,zoom])
                            page.wait_for_function('KartaMap.glMap().isStyleLoaded() && KartaMap.glMap().areTilesLoaded()')
                            assert page.evaluate('!map.hasLayer(sat) && !map.hasLayer(hybrid) && Object.values(map._layers).every(l=>!l._url || !/\\/tc\\/(osm|sat|skl)\\//.test(l._url))')
                            if kind=='off':
                                assert page.evaluate('KartaMap.glMap().queryRenderedFeatures().length>0'),(name,kind,zoom)
                        print(name,kind,'zooms 3-19 rendered',flush=True)
                        if kind=='off':
                            page.evaluate('(v)=>map.setView(v,14,{animate:false})',[lat,lng])
                            page.wait_for_function('KartaMap.glMap().areTilesLoaded()')
                            page.screenshot(path=str(ROOT/('.audit/offline-'+name+'-schema.png')))
                for old_mode in ['sat','hyb']:
                    page.evaluate('(mode)=>useMap(mode)',old_mode)
                    assert page.evaluate('localStorage.getItem("karta_map")==="off" && !map.hasLayer(sat) && !map.hasLayer(hybrid)')
                assert page.locator('#mapKinds').is_hidden()
                assert not outbound,outbound
                assert not errors,errors
                browser.close()
            assert blocked.call_count==0,blocked.call_args_list
        print('Desktop schema passed: two regions at every zoom 3-19, old satellite selection reset, zero external requests')
    finally:
        server.shutdown();server.server_close();app.close()
