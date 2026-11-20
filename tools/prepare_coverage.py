"""Build the desktop coverage mask from a downloaded geoBoundaries ADM1 GeoJSON.

python tools/prepare_coverage.py .audit/ukr-adm1.json
Build-time dependency: Shapely. No runtime dependency or network access.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.audit/geo-deps'))
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union

data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
features = [f for f in data['features'] if f['properties']['shapeISO'] in ('UA-65', 'UA-23')]
assert len(features) == 2
area = unary_union([shape(f['geometry']) for f in features])
assert area.is_valid
mask = box(-180, -85.051128, 180, 85.051128).difference(area)
result = dict(bounds=list(area.bounds), area=mapping(area), mask=mapping(mask))
out = ROOT / 'web/vendor/coverage-pc.js'
out.write_text('/* geoBoundaries UKR ADM1 (2017), OSM / Wambacher, ODbL 1.0.\n'
               ' * https://github.com/wmgeolab/geoBoundaries/tree/9469f09/releaseData/gbOpen/UKR/ADM1\n'
               ' * Desktop display coverage; original geometry retained. */\n'
               'window.KartaCoverage=' + json.dumps(result, separators=(',', ':')) + ';\n', encoding='utf-8')
print(out.name, out.stat().st_size, 'bytes; bounds', area.bounds)
