"""Retain only tiles intersecting the two regions; fill gaps from the same Protomaps build.

Build-time Shapely is used only here. Does not change the installed map until verified.
"""
import gzip, hashlib, json, math, struct, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'.audit/geo-deps')]
import run
from shapely.geometry import shape, box
from shapely.prepared import prep

coverage=json.loads((ROOT/'web/vendor/coverage-pc.js').read_text(encoding='utf-8').split('window.KartaCoverage=')[1].rstrip(';\n'))
area=shape(coverage['area']);prepared=prep(area);w,s,e,n=area.bounds
old=run.PmFile(str(ROOT/'map/karta-offline.pmtiles'))
om=run.OfflineMap(str(ROOT/'.audit/pc-map-build'),lambda *a:None)
path=ROOT/'.audit/karta-regions.pmtiles';tmp=str(path)+'.build'
url=om.BASE+'20261113.pmtiles';remote=None;dirs={}
def lookup(tid):
    global remote
    if remote is None:
        head=om._get(url,0,127)
        assert head[:8]==b'PMTiles\3' and head[97:100]==bytes([2,2,1])
        remote=struct.unpack_from('<8Q',head,8)
    ro,rl,mo,ml,lo,ll,do,dl=remote
    off,length=ro,rl
    for _ in range(4):
        key=(off,length)
        if key not in dirs:dirs[key]=om.read_dir(gzip.decompress(om._get(url,off,length)))
        ent=om.find(dirs[key],tid)
        if not ent:return None
        if ent[1]:return (do+ent[2],ent[3])
        off,length=lo+ent[2],ent[3]
    raise ValueError('Deep directory')
def ty(lat,z):return int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*(1<<z))
def lat(y,z):return math.degrees(math.atan(math.sinh(math.pi*(1-2*y/(1<<z)))))
got={};unique={};missing=[];position=0
try:
    with open(tmp+'.data','wb') as out:
        def write(tid,data):
            global position
            assert data
            gzip.decompress(data)
            key=hashlib.sha256(data).digest()
            if key not in unique:
                unique[key]=(position,len(data));out.write(data);position+=len(data)
            got[tid]=unique[key]
        for z in range(16):
            for x in range(int((w+180)/360*(1<<z)),int((e+180)/360*(1<<z))+1):
                for y in range(ty(n,z),ty(s,z)+1):
                    tile=box(x/(1<<z)*360-180,lat(y+1,z),(x+1)/(1<<z)*360-180,lat(y,z))
                    if not prepared.intersects(tile):continue
                    tid=om.tileid(z,x,y);data=old.tile(z,x,y)
                    if data:write(tid,data)
                    else:missing.append(tid)
            print('zoom',z,'retained',len(got),'missing',len(missing),flush=True)
        wanted={}
        for tid in missing:
            ent=lookup(tid)
            if ent:wanted[tid]=ent
        chunks=[]
        for off,length in sorted(set(wanted.values())):
            if chunks and off-(chunks[-1][0]+chunks[-1][1])<=32768 and off+length-chunks[-1][0]<=4*1024*1024:
                chunks[-1][1]=off+length-chunks[-1][0]
            else:chunks.append([off,length])
        print('fetch chunks',len(chunks),'bytes',sum(x[1] for x in chunks),flush=True)
        fetched={}
        with ThreadPoolExecutor(6) as pool:
            for (off,length),blob in zip(chunks,pool.map(lambda c:om._get(url,c[0],c[1],120),chunks)):
                for ent in set(wanted.values()):
                    if off<=ent[0] and ent[0]+ent[1]<=off+length:fetched[ent]=blob[ent[0]-off:ent[0]-off+ent[1]]
        for tid,ent in wanted.items():write(tid,fetched[ent])
    entries=[]
    for tid,(off,length) in sorted(got.items()):
        if entries and entries[-1][0]+entries[-1][1]==tid and entries[-1][2:]==[off,length]:entries[-1][1]+=1
        else:entries.append([tid,1,off,length])
    meta=old._read(old.meta_off,old.meta_len)
    om._write(tmp,str(path),entries,meta,position,len(unique),[(s,w,n,e)],2,1,15)
    report=dict(tiles=len(got),filled=len(wanted),unavailable=len(missing)-len(wanted),bytes=path.stat().st_size,bounds=list(area.bounds),sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    path.with_suffix('.report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(report,flush=True)
finally:old.close();om.close()
