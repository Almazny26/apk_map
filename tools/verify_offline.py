"""Validate installed archives, every vector blob and native zoom coverage."""
import gzip
import hashlib
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import run

CITIES=[('Херсон',46.64,32.62),('Запорожье',47.84,35.14),('Мелитополь',46.85,35.36),('Бердянск',46.77,36.79),('Геническ',46.17,34.80),('Новая Каховка',46.75,33.37)]


def verify(path):
    import math
    pm=run.PmFile(str(path))
    entries=[];filled={}
    def walk(directory):
        for tid,count,offset,length in directory:
            if count:
                assert 0<=pm.data_off+offset<pm.size and pm.data_off+offset+length<=pm.size,(path,tid)
                entries.append((tid,count,offset,length))
            else:
                walk(pm._dir(pm.leaf_off+offset,length))
    try:
        walk(pm.root)
        zooms={}
        for z in range(pm.minzoom,pm.maxzoom+1):
            lo=((1<<(2*z))-1)//3;hi=((1<<(2*z+2))-1)//3
            zooms[z]=sum(max(0,min(tid+count,hi)-max(tid,lo)) for tid,count,_,_ in entries)
            assert zooms[z]>0,(path,z)
            if pm.kind=='sat':
                w,s,e,n=pm.bounds
                tx=lambda lng:int((lng+180)/360*(1<<z))
                ty=lambda lat:int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*(1<<z))
                expected=(tx(e)-tx(w)+1)*(ty(s)-ty(n)+1)
                filled[z]=0
                for x in range(tx(w),tx(e)+1):
                    for y in range(ty(n),ty(s)+1):
                        if not pm.tile(z,x,y):
                            overlay=path.parent/'sat-fill'/str(z)/str(x)/(str(y)+'.tile')
                            assert overlay.exists(),(path,z,x,y,'missing source tile')
                            assert overlay.read_bytes().startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8'))
                            filled[z]+=1
                assert zooms[z]+filled[z]==expected,(path,z,'incomplete coverage')
        if pm.kind=='map':
            for offset,length in {(e[2],e[3]) for e in entries}:
                data=pm._read(pm.data_off+offset,length)
                if pm.tile_comp==2: gzip.decompress(data)
        sample=[]
        for name,lat,lng in CITIES:
            w,s,e,n=pm.bounds
            if not(w<=lng<=e and s<=lat<=n): continue
            for z in range(pm.minzoom,pm.maxzoom+1):
                x=int((lng+180)/360*(1<<z));y=int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*(1<<z))
                data=pm.tile(z,x,y)
                if not data and pm.kind=='sat':data=(path.parent/'sat-fill'/str(z)/str(x)/(str(y)+'.tile')).read_bytes()
                assert data,(path,name,z)
                if pm.kind=='sat': assert data.startswith((b'\xff\xd8',b'\x89PNG')),(path,name,z)
            sample.append(name)
        h=hashlib.sha256()
        with path.open('rb') as f:
            for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
        result=dict(file=path.name,bytes=pm.size,kind=pm.kind,minzoom=pm.minzoom,maxzoom=pm.maxzoom,tilesByZoom=zooms,restoredTilesByZoom=filled,bounds=pm.bounds,sampledCities=sample,sha256=h.hexdigest())
        print(path.name,pm.kind,pm.size,'zoom',pm.minzoom,pm.maxzoom,'verified',flush=True)
        return result
    finally: pm.close()


if __name__=='__main__':
    paths=[ROOT/'map/karta-offline.pmtiles']
    report=[verify(path) for path in paths]
    (ROOT/'map/verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
