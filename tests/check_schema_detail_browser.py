"""Compare old/new cartography on the same real vector tiles with networking disabled."""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'.audit/deps'),str(ROOT)]
os.environ['KARTA_MAP_DIR']=str(ROOT/'map')
import run
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as folder:
    app=run.App(folder,lambda *a:None)
    net=dict(v=1,objs={'n':dict(id='n',type='node',f=dict(name='Проверочная метка',lat=46.11229,lng=33.69176),ft={},t=1000,by='Проверка')},journal=[])
    app.state.save({'karta_author':'Проверка','karta_view':'[46.11229,33.69176,16]','karta_net':json.dumps(net)})
    server=run.Server(('127.0.0.1',0),run.make_handler(app));threading.Thread(target=server.serve_forever,daemon=True).start()
    base='http://127.0.0.1:%s'%server.server_address[1]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
            context=browser.new_context(viewport=dict(width=1366,height=900));outbound=[]
            def route(r):
                if r.request.url.startswith((base,'data:')):r.continue_()
                else:outbound.append(r.request.url);r.abort()
            context.route('**/*',route)
            page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base);page.wait_for_function('window.KartaMap && KartaMap.glMap()')
            page.evaluate('window.styleErrors=[];KartaMap.glMap().on("error",e=>styleErrors.push(e.error.message))')
            original=page.evaluate('JSON.stringify(KartaNet.data())')
            report=[]
            def counts():
                return page.evaluate('''()=>{let r={};KartaMap.glMap().queryRenderedFeatures().forEach(f=>r[f.layer.id]=(r[f.layer.id]||0)+1);return r;}''')
            def settle():
                page.wait_for_function('KartaMap.glMap().isStyleLoaded() && KartaMap.glMap().areTilesLoaded()')
                page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            for name,lat,lng in [('melitopol',46.85,35.36),('kherson',46.64,32.62),('zaporozhye',47.84,35.14)]:
                page.evaluate('(p)=>map.setView(p,16,{animate:false})',[lat,lng]);settle()
                page.evaluate('''()=>{let g=KartaMap.glMap();window.detailed=JSON.parse(JSON.stringify(g.getStyle()));let base=JSON.parse(JSON.stringify(KartaStyle.light));base.sources=detailed.sources;base.glyphs=detailed.glyphs;g.setStyle(base,{diff:false});}''')
                settle();before=counts()
                page.screenshot(path=str(ROOT/('.audit/schema-old-'+name+'.png')))
                page.evaluate('KartaMap.glMap().setStyle(detailed,{diff:false})');settle();after=counts()
                assert before.get('address',0)==0
                assert after.get('address',0)>20,(name,after)
                assert sum(after.get(id,0) for id in ['poi-primary-label','poi-secondary-label','poi-transit-label'])>10,(name,after)
                assert after.get('road_label',0)>=before.get('road_label',0)*.8,(name,before,after)
                assert after.get('buildings',0)>=before.get('buildings',0)*.95
                page.screenshot(path=str(ROOT/('.audit/schema-detail-'+name+'.png')))
                report.append(dict(name=name,before=before,after=after))
                print(name,'old/new addresses',before.get('address',0),after['address'],'streets',before.get('road_label',0),after.get('road_label',0),flush=True)
            page.evaluate('document.body.classList.add("dark");KartaMap.retheme()');settle()
            dark=counts();assert dark.get('address',0)>20 and dark.get('poi-primary-point',0)>0
            page.screenshot(path=str(ROOT/'.audit/schema-detail-dark.png'))
            assert page.evaluate('JSON.stringify(KartaNet.data())')==original
            assert not page.evaluate('styleErrors'),page.evaluate('styleErrors')
            assert not errors,errors
            assert not outbound,outbound
            (ROOT/'.audit/schema-detail-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            browser.close()
        print('Detailed schema passed: real addresses/POIs, street priority, light/dark themes, unchanged user marks, no external requests')
    finally:server.shutdown();server.server_close();app.close()
