"""Create a single transferable archive of the installed and verified offline maps."""
import json
import os
import zipfile
from pathlib import Path
from verify_offline import verify

ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'apk/offline-materials'
def source(name):return (ROOT/'map' if name.startswith('karta-offline') else ASSETS)/name
names=['karta-offline.pmtiles','kherson-sat.pmtiles','zaporozhye-sat.pmtiles']
report=[verify(source(name)) for name in names]
(ASSETS/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
target=ASSETS/'Офлайн-карты_Херсон_Запорожье.zip'
temp=Path(str(target)+'.tmp')
with zipfile.ZipFile(temp,'w',compression=zipfile.ZIP_STORED,allowZip64=True) as archive:
    for name in names+['verification.json']:
        archive.write(source(name),'map/'+name)
    for path in [source(name+'.json') for name in names]:
        archive.write(path,'map/'+path.name)
    archive.write(ASSETS/'sat-fill.json','map/sat-fill.json')
    for path in sorted((ASSETS/'sat-fill').rglob('*.tile')):
        archive.write(path,'map/'+path.relative_to(ASSETS).as_posix())
    archive.write(ASSETS/'Офлайн-карты — инструкция.txt','Офлайн-карты — инструкция.txt')
with zipfile.ZipFile(temp) as archive:
    assert archive.testzip() is None
os.replace(temp,target)
print(target.name,target.stat().st_size,'bytes, verified',flush=True)
