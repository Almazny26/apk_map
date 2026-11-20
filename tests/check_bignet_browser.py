"""3.5: большая сеть (5 000 узлов + 5 000 линий, ~5 МБ — больше лимита localStorage).
ПК: правка доходит до data/state.json и переживает перезапуск программы. Телефон (заглушка оболочки):
сеть пишется в файл через KartaFiles.netSave и читается обратно после перезагрузки страницы."""
import json, os, random, shutil, socket, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe'


def big_net(n=6000):
    random.seed(7)
    objs, cols = {}, int(n ** .5) + 1
    for i in range(n):
        r, c = divmod(i, cols)
        objs['n%d' % i] = {'id': 'n%d' % i, 'type': 'node', 'f': {'name': 'УД-%d' % i, 'kind': 'узел доступа', 'state': 'работает',
                           'lat': round(46.55 + r * .004, 6), 'lng': round(33.3 + c * .006, 6)}, 'ft': {}, 't': 1795000000000, 'by': 'gen'}
    for i in range(n - 1):
        a, b = objs['n%d' % i]['f'], objs['n%d' % (i + 1)]['f']
        pts = [{'lat': a['lat'], 'lng': a['lng'], 'kind': 'узел', 'nid': 'n%d' % i}] + \
              [{'lat': round(a['lat'] + (b['lat'] - a['lat']) * k / 9, 6), 'lng': round(a['lng'] + (b['lng'] - a['lng']) * k / 9, 6), 'kind': 'опора'} for k in range(1, 9)] + \
              [{'lat': b['lat'], 'lng': b['lng'], 'kind': 'узел', 'nid': 'n%d' % (i + 1)}]
        objs['l%d' % i] = {'id': 'l%d' % i, 'type': 'fiber', 'f': {'name': 'ВОЛС %d' % i, 'fnodes': pts, 'lay': ['air'] * 9, 'fibers': '16', 'cable': 'ОКА-М16'}, 'ft': {}, 't': 1795000000000, 'by': 'gen'}
    return json.dumps({'v': 1, 'objs': objs, 'journal': []}, ensure_ascii=False, separators=(',', ':'))


def free():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def block_outside(route):
    u = route.request.url
    route.continue_() if u.startswith(('http://127.0.0.1', 'data:', 'blob:')) else route.abort()


ADD = """async () => {
  KartaApp.setMode('edit'); map.setView([46.6, 33.4], 15, {animate: false});
  KartaApp.startNode(); document.querySelector('[data-a="place"]').click(); KartaApp.finishTool();
  return Object.keys(KartaNet.data().objs).length;
}"""

NET = big_net()
assert len(NET) > 5_000_000, len(NET)
TOTAL = len(json.loads(NET)['objs'])
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    # ---- ПК
    folder = tempfile.mkdtemp()
    json.dump({'karta_net': NET, 'karta_author': 'Тест'}, open(os.path.join(folder, 'state.json'), 'w'), ensure_ascii=False)
    def start():
        port = free()
        proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'run.py'), '--no-window', '--port', str(port), '--data', folder],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.5); return port, proc
    port, proc = start()
    try:
        ctx = browser.new_context(); ctx.route('**/*', block_outside); page = ctx.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:%d/' % port); page.wait_for_function('window.KartaApp && window.KartaPC', timeout=120000)
        count = page.evaluate(ADD)
        assert count == TOTAL + 1, count
        # холст линий не должен закрывать карту (общее правило canvas{background} у страницы товарища)
        bg = page.evaluate("getComputedStyle(document.querySelector('.leaflet-overlay-pane canvas')).backgroundColor")
        assert bg in ('rgba(0, 0, 0, 0)', 'transparent'), bg
        page.wait_for_function('!window.KartaPCSaving()', timeout=30000)
        disk = json.loads(json.load(open(os.path.join(folder, 'state.json'), encoding='utf-8'))['karta_net'])
        assert len(disk['objs']) == TOTAL + 1, len(disk['objs'])
        assert not errors, errors
        ctx.close()
    finally:
        proc.kill(); proc.wait()
    port, proc = start()      # «компьютер выключили и включили»
    try:
        ctx = browser.new_context(); ctx.route('**/*', block_outside); page = ctx.new_page()
        page.goto('http://127.0.0.1:%d/' % port); page.wait_for_function('window.KartaApp && window.KartaPC', timeout=120000)
        assert page.evaluate('Object.keys(KartaNet.data().objs).length') == TOTAL + 1
        ctx.close()
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(folder, ignore_errors=True)
    # ---- телефон: страница из web/ и заглушка оболочки Android с файлом сети
    port = free()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=os.path.join(ROOT, 'web'),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        ctx = browser.new_context(viewport={'width': 393, 'height': 851}, is_mobile=True, has_touch=True); ctx.route('**/*', block_outside)
        ctx.route('**/__net.json', lambda r: r.fulfill(body=NET, content_type='application/json'))
        ctx.add_init_script("""var F = JSON.parse(sessionStorage.getItem('__files') || '{}');
          window.KartaFiles = {ready(){}, shareText(){return true}, saveText(){}, openFile(){}, takeOpenedName(){return null}, takeOpenedText(){return null},
            takeOpenedError(){return null}, tileAsync(){}, mapList(){return '[]'}, mapStatus(){return '{}'}, networkUp(){return true}, tick(){},
            netLoad(n){ if (F[n]) return F[n]; if (n !== 'net') return ''; var x = new XMLHttpRequest(); x.open('GET', '/__net.json', false); x.send(); return x.responseText; },
            netSave(n, s){ F[n] = s; window.__lastSave = s.length; return true; }};
          localStorage.setItem('karta_author', 'Тел');""")
        page = ctx.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:%d/index.html' % port); page.wait_for_function('window.KartaApp', timeout=120000)
        assert page.evaluate('Object.keys(KartaNet.data().objs).length') == TOTAL
        assert page.evaluate(ADD) == TOTAL + 1
        saved = page.evaluate('window.__lastSave || 0')
        assert saved > 5_000_000, saved
        small = page.evaluate("(localStorage.getItem('karta_net') || '').length")
        assert small == 0, small          # большой сети в localStorage нет — она в файле приложения
        assert not errors, errors
        ctx.close()
    finally:
        srv.kill()
    browser.close()
print('Big network passed: %d objects' % TOTAL + ' (5 МБ+) — PC disk + restart, phone file storage')
