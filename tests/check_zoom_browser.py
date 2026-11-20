import sys,os,json,tempfile,threading,time
import os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
(ROOT/'.audit').mkdir(exist_ok=True)
sys.path[:0]=[str(ROOT/'.audit/deps'),str(ROOT)]
import run
from playwright.sync_api import sync_playwright
with tempfile.TemporaryDirectory(dir=ROOT/'.audit') as tmp:
 os.environ['KARTA_MAP_DIR']=str(ROOT/'map')
 app=run.App(tmp,lambda *a:None)
 app.tilecache.get=lambda *a:None
 objs={}
 for i in range(20):
  lat=46.5+(i%5)*.002; lng=33.5+(i//5)*.003
  objs[str(i)]={'id':str(i),'type':'fiber','f':{'name':'Линия '+str(i),'fnodes':[{'lat':lat,'lng':lng,'kind':'муфта'},{'lat':lat+.002,'lng':lng+.002,'kind':'опора'}],'lay':['air']},'ft':{}}
 app.state.save({'karta_author':'Аудит','karta_view':'[46.505,33.505,13]','karta_net':json.dumps({'v':1,'objs':objs,'journal':[]})})
 server=run.Server(('127.0.0.1',0),run.make_handler(app));threading.Thread(target=server.serve_forever,daemon=True).start()
 base='http://127.0.0.1:%d'%server.server_address[1]
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True,args=['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
   ctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=2)
   ctx.route('**/*',lambda r:r.continue_() if r.request.url.startswith(base) or r.request.url.startswith('data:') else r.abort())
   page=ctx.new_page(); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(base);page.wait_for_function('window.KartaMap && KartaMap.glMap()');page.wait_for_timeout(1500)
   page.evaluate("window.stats={zooms:[],ends:0,removed:0}; map.on('zoom',()=>stats.zooms.push(map.getZoom()));map.on('zoomend',()=>stats.ends++);map.on('layerremove',e=>{if(e.layer instanceof L.Marker || e.layer instanceof L.Polyline)stats.removed++})")
   cdp=ctx.new_cdp_session(page)
   def touch(kind,d):
    cdp.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[] if kind=='touchEnd' else [{'x':195-d,'y':420,'id':1},{'x':195+d,'y':420,'id':2}]})
   touch('touchStart',45)
   for i in range(1,21):touch('touchMove',45+i*3);page.wait_for_timeout(25)
   during=page.evaluate('stats')
   touch('touchEnd',0);page.wait_for_timeout(700)
   after=page.evaluate('({stats,zoom:map.getZoom(),glZoom:KartaMap.glMap().getZoom(),bearing:map.getBearing()})')
   checks=[]
   for angle in (35,0):
    page.evaluate('(a)=>map.setBearing(a)',angle)
    page.evaluate('stats.ends=0;stats.removed=0;stats.zooms=[]')
    touch('touchStart',100)
    for i in range(1,16):
     touch('touchMove',100-i*3);page.wait_for_timeout(25)
    mid=page.evaluate('({ends:stats.ends,removed:stats.removed,gap:Math.abs(map.getZoom()-1-KartaMap.glMap().getZoom())})')
    touch('touchEnd',0);page.wait_for_timeout(600)
    checks.append({'bearing':angle,'during':mid,'ends':page.evaluate('stats.ends'),'gap':page.evaluate('Math.abs(map.getZoom()-1-KartaMap.glMap().getZoom())')})
   page.evaluate('map.zoomIn()');page.wait_for_timeout(600)
   button_gap=page.evaluate('Math.abs(map.getZoom()-1-KartaMap.glMap().getZoom())')
   if True:
    assert during['ends']==0 and during['removed']==0, during
    assert after['stats']['ends']==1 and abs(after['zoom']-1-after['glZoom'])<1e-6,after
    assert all(c['during']['ends']==0 and c['during']['removed']==0 and c['gap']<1e-6 and c['ends']==1 for c in checks),checks
    assert button_gap<1e-6 and not errors,errors
   print(json.dumps({'during':during,'after':after,'zoom_out_checks':checks,'button_gap':button_gap,'errors':errors},ensure_ascii=False))
   page.screenshot(path=str(ROOT/('.audit/zoom-'+('after' if '--after' in sys.argv else 'before')+'.png')))
   browser.close()
 finally:
  server.shutdown();server.server_close()
  if app.tiles.zip:app.tiles.zip.close()
  for f in app.offline.files.values():f.close()

