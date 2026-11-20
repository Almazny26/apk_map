"""Install verified satellite archives for the bundled offline map."""
import hashlib
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import run

ASSETS = [
    ('kherson-sat.pmtiles', 147880888, '2f322d70be9c327f48429f10a57025c040474578a6b3468d8105219829d2633a'),
    ('zaporozhye-sat.pmtiles', 129501655, '42f67743678bc08cdf9b81cab379d1549fd7ce7a71366d2bd27dc395aee4d286'),
]


def digest(path):
    h = hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):
            h.update(chunk)
    return h.hexdigest()


def download(url, part, size):
    offset = part.stat().st_size if part.exists() else 0
    if offset > size:
        raise IOError('Partial file is larger than the source')
    ranges = [(start,min(start+8*1024*1024,size)-1) for start in range(offset,size,8*1024*1024)]
    def segment(bounds):
        start,end = bounds
        dest = Path(str(part)+'.%d-%d' % bounds)
        for attempt in range(4):
            done = dest.stat().st_size if dest.exists() else 0
            if done == end-start+1: return dest
            try:
                headers = {'User-Agent':'KartaSeti offline package','Range':'bytes=%d-%d' % (start+done,end)}
                with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=35) as r:
                    expected = 'bytes %d-%d/%d' % (start+done,end,size)
                    if r.status != 206 or r.headers.get('Content-Range') != expected:
                        raise IOError('Server returned an unexpected byte range')
                    with open(dest,'ab') as out:
                        for chunk in iter(lambda:r.read(256*1024),b''): out.write(chunk)
                if dest.stat().st_size != end-start+1: raise IOError('Incomplete range')
                print(part.name, 'range %d-%d MB ready' % (start//1000000,end//1000000),flush=True)
                return dest
            except Exception:
                if attempt == 3: raise
        raise IOError('Download failed')
    with ThreadPoolExecutor(4) as pool:
        # Ordered consumption permits resuming from the already assembled prefix.
        with open(part,'ab') as out:
            for segment_path in pool.map(segment,ranges):
                with open(segment_path,'rb') as src:
                    for chunk in iter(lambda:src.read(1024*1024),b''): out.write(chunk)
                out.flush()
                segment_path.unlink()


def main():
    folder = ROOT/'apk/offline-materials'
    folder.mkdir(exist_ok=True)
    for name,size,sha in ASSETS:
        target = folder/name
        if target.exists() and target.stat().st_size == size and digest(target) == sha:
            print(name, 'already verified', flush=True)
            continue
        part = folder/(name+'.download')
        url = 'https://github.com/Almazny26/apk_map/releases/download/maps/'+name
        download(url,part,size)
        if part.stat().st_size != size or digest(part) != sha:
            raise IOError('Checksum/size mismatch: '+name)
        pm = run.PmFile(str(part)); pm.close()
        os.replace(part,target)
        print(name,'verified',size,flush=True)
        region = name.split('-')[0]
        (folder/(name+'.json')).write_text(json.dumps(dict(regions=[run.OfflineMap.REGIONS[region][0]],source='Sentinel-2 cloudless 2016/2017, EOX',maxzoom=14,sha256=sha),ensure_ascii=False,indent=2),encoding='utf-8')


if __name__ == '__main__': main()
