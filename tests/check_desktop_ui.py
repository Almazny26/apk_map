"""Desktop dialogs, control layout, CRUD/persistence and detailed coverage in a clean profile."""
import json, os, sys, tempfile, threading
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'.audit/deps'),str(ROOT)]
os.environ['KARTA_MAP_DIR']=str(ROOT/'map')
import run
from shared import Shared
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as folder:
    app=run.App(folder,lambda *a:None)
    app.state.save({'karta_author':'Проверка длинного имени участника','karta_view':'[46.64,32.62,18]','karta_set':json.dumps({'ui':1.3,'pcPanel':460})})
    app.shared=Shared(app.state,folder);app.allow_local_admin=True;app.local_name='Проверка длинного имени участника'
    server=run.Server(('127.0.0.1',0),run.make_handler(app));threading.Thread(target=server.serve_forever,daemon=True).start()
    base='http://127.0.0.1:%s'%server.server_address[1]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
            context=browser.new_context(viewport=dict(width=1366,height=768));outbound=[];errors=[];problems=[]
            context.add_init_script('localStorage.setItem("karta_set",JSON.stringify({ui:1.3,pcPanel:460}));localStorage.setItem("karta_view","[46.64,32.62,18]")')
            def route(r):
                if r.request.url.startswith((base,'data:')):r.continue_()
                else:outbound.append(r.request.url);r.abort()
            context.route('**/*',route)
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base);page.wait_for_function('window.KartaApp && window.KartaMap && KartaMap.glMap()')
            def settle():
                page.wait_for_function('KartaMap.glMap().isStyleLoaded() && KartaMap.glMap().areTilesLoaded()')
                page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            settle()
            def menu(key):
                page.locator('#apMenuBtn').click();page.locator('[data-m="'+key+'"]').click()
            def overflow(label,selector):
                for item in page.locator(selector).evaluate_all('''xs=>xs.filter(x=>x.getClientRects().length).map(x=>({id:x.id,cls:x.className,sw:x.scrollWidth,cw:x.clientWidth,left:x.getBoundingClientRect().left,right:x.getBoundingClientRect().right,bottom:x.getBoundingClientRect().bottom}))'''):
                    if item['sw']>item['cw']+2 or item['left'] < -1 or item['right']>page.viewport_size['width']+1:
                        problems.append((label,item))
            for width,height in [(1920,1080),(1366,768),(1024,768),(900,600),(768,600)]:
                page.set_viewport_size(dict(width=width,height=height))
                overflow(str(width)+' bar','#apBar')
                rects=page.locator('#apBar>button,#apBar>.ap-seg,#apBar>.ap-logo').evaluate_all('xs=>xs.filter(x=>x.getClientRects().length).map(x=>({id:x.id,x:x.getBoundingClientRect().x,right:x.getBoundingClientRect().right,width:x.getBoundingClientRect().width}))')
                if any(x['width']<30 for x in rects):problems.append(('compressed controls',width,rects))
                page.locator('#apMenuBtn').click();assert page.locator('[data-m=offline]').count()==0
                page.keyboard.press('Escape')
                for key in ['set','help','legend','file','journal']:
                    menu(key);overflow(str(width)+' '+key,'#apDlgBox,#apDlgBox .srow,#apDlgBox .row')
                    if key=='help':assert 'Карта без интернета' not in page.locator('#apDlgBox').inner_text()
                    page.locator('.ap-dx').click()
                page.locator('[data-c=measure]').click()
                overflow(str(width)+' ruler','#apSheet,.measure-actions')
                page.locator('[data-a=measure-add]').click();page.locator('[data-a=measure-undo]').click()
                page.locator('#apSheet .ap-x').click()
                page.locator('#apAccess').click();page.locator('#apAccessDialog').wait_for()
                overflow(str(width)+' access','#apAccessDialog');page.locator('#apAccessDialog').get_by_role('button',name='Закрыть',exact=True).click()
                page.locator('#apUsers').click();overflow(str(width)+' users','#apUsersDialog');page.keyboard.press('Escape')
            page.set_viewport_size(dict(width=1366,height=768))
            page.evaluate('KartaApp.setMode("edit");KartaApp.startNode();map.fire("click",{latlng:L.latLng(46.64,32.62),containerPoint:map.latLngToContainerPoint([46.64,32.62])})')
            page.locator('#apSheet [data-a=edit]').click()   # 3.5: узел ставится сразу, название — правкой
            page.locator('#apf0').fill('Тестовый узел');page.locator('#apOk').click()
            oid=page.evaluate('Object.keys(KartaNet.data().objs)[0]')
            page.reload();page.wait_for_function('(id)=>window.KartaNet && KartaNet.data().objs[id]',arg=oid)
            assert page.evaluate('(id)=>KartaNet.data().objs[id].f.name',oid)=='Тестовый узел'
            page.evaluate('KartaApp.setMode("view")')
            menu('set');page.locator('[data-sk=theme][data-si="1"]').click();page.locator('.ap-dx').click();settle()
            assert page.evaluate('document.body.classList.contains("dark")')
            page.screenshot(path=str(ROOT/'.audit/desktop-audit-dark.png'))
            menu('set');page.locator('[data-sk=theme][data-si="0"]').click();page.locator('.ap-dx').click();settle()
            page.screenshot(path=str(ROOT/'.audit/desktop-audit-light.png'))
            assert page.evaluate('KartaMap.glMap().getLayer("coverage-mask") && !map.hasLayer(offlineTiles)')
            page.evaluate('map.setView([46.64,32.62],19,{animate:false})');settle()
            address=page.evaluate("()=>{let f=KartaMap.glMap().querySourceFeatures('p',{sourceLayer:'buildings'}).find(f=>f.properties.kind==='address' && f.properties.addr_housenumber);return {point:f.geometry.coordinates,label:f.properties.addr_housenumber};}")
            page.evaluate('(p)=>map.setView([p[1],p[0]],19,{animate:false})',address['point']);settle()
            page.wait_for_function('(label)=>KartaMap.glMap().queryRenderedFeatures({layers:["address-close"]}).some(f=>f.properties.addr_housenumber===label)',arg=address['label'])
            page.screenshot(path=str(ROOT/'.audit/address-close.png'))
            for lat,lng in [(46.11229,33.69176),(44.95,34.10)]:
                page.evaluate('(p)=>map.setView(p,16,{animate:false})',[lat,lng]);settle()
                assert not page.evaluate('map.hasLayer(offlineTiles)')
                assert page.locator('#mapCoverageNotice').is_visible()
                page.screenshot(path=str(ROOT/('.audit/excluded-'+str(lat)+'.png')))
            page.locator('#mapCoverageNotice').click();settle()
            assert page.evaluate('map.getZoom()<12')
            (ROOT/'.audit/desktop-ui-report.json').write_text(json.dumps(dict(problems=problems,errors=errors,outbound=outbound),ensure_ascii=False,indent=2),encoding='utf-8')
            assert not problems,problems
            assert not errors,errors
            assert not outbound,outbound
            browser.close()
        print('Desktop UI passed: five sizes, enlarged controls, dialogs, ruler, save/reload, themes and coverage')
    finally:server.shutdown();server.server_close();app.close()
