"""Restore PNG tiles omitted by the original JPEG-only satellite builder."""
import hashlib
import json
import math
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import run

missing=set()
for name in ['kherson-sat.pmtiles','zaporozhye-sat.pmtiles']:
    pm=run.PmFile(str(ROOT/'apk/offline-materials'/name));w,s,e,n=pm.bounds
    try:
        for z in range(pm.minzoom,pm.maxzoom+1):
            tx=lambda v:int((v+180)/360*(1<<z))
            ty=lambda v:int((1-math.asinh(math.tan(math.radians(v)))/math.pi)/2*(1<<z))
            for x in range(tx(w),tx(e)+1):
                for y in range(ty(n),ty(s)+1):
                    if not pm.tile(z,x,y):missing.add((z,x,y))
    finally:pm.close()
print('Missing source tiles:',len(missing),flush=True)


def fill(tile):
    z,x,y=tile
    dest=ROOT/'apk/offline-materials/sat-fill'/str(z)/str(x)/(str(y)+'.tile')
    if dest.exists():
        data=dest.read_bytes()
    else:
        for attempt in range(4):
            try:
                request=urllib.request.Request(run.OfflineMap.SAT_URL%(z,y,x),headers={'User-Agent':'KartaSeti offline repair'})
                with urllib.request.urlopen(request,timeout=25) as r:data=r.read(4*1024*1024)
                assert data.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8')),'Unexpected raster format'
                dest.parent.mkdir(parents=True,exist_ok=True)
                temp=Path(str(dest)+'.tmp');temp.write_bytes(data);os.replace(temp,dest)
                break
            except Exception:
                if attempt==3:raise
    assert data.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8'))
    return dict(z=z,x=x,y=y,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())


with ThreadPoolExecutor(8) as pool:
    report=[]
    for entry in pool.map(fill,sorted(missing)):
        report.append(entry)
        if len(report)%25==0:print('Restored',len(report),'/',len(missing),flush=True)
(ROOT/'apk/offline-materials/sat-fill.json').write_text(json.dumps(dict(source=run.OfflineMap.SAT_URL,tiles=report),ensure_ascii=False,indent=2),encoding='utf-8')
print('Restored all',len(report),'source tiles',flush=True)
