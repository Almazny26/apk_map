"""Transferable desktop schema only; imagery stays available separately for Android."""
import hashlib
import json
import os
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
path=ROOT/'map/karta-offline.pmtiles'
record=next(x for x in json.loads((ROOT/'map/verification.json').read_text(encoding='utf-8')) if x['file']==path.name)
h=hashlib.sha256()
with path.open('rb') as f:
    for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
assert path.stat().st_size==record['bytes'] and h.hexdigest()==record['sha256']
(ROOT/'map/schema-verification.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
target=ROOT/'Офлайн-схема_Херсон_Запорожье.zip';temp=Path(str(target)+'.tmp')
with zipfile.ZipFile(temp,'w',compression=zipfile.ZIP_STORED) as out:
    for name in ['karta-offline.pmtiles','karta-offline.pmtiles.json','schema-verification.json']:
        out.write(ROOT/'map'/name,'map/'+name)
    out.write(ROOT/'web/vendor/coverage-pc.js','web/vendor/coverage-pc.js')
    out.write(ROOT/'Офлайн-схема — инструкция.txt','Офлайн-схема — инструкция.txt')
with zipfile.ZipFile(temp) as archive:assert archive.testzip() is None
os.replace(temp,target)
print(target.name,target.stat().st_size,'bytes, verified')
