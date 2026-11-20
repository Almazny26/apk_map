"""Совместная работа «в прямом эфире»: владелец + 4 удалённых пользователя в отдельных окнах браузера.

Проверяет: задержку доставки правок другим окнам, kill -9 сервера сразу после подтверждённых правок
(ничего подтверждённого не теряется, файлы целы), потерю сети у клиента (правки копятся и уходят сами,
переживают перезагрузку страницы), перезапуск сервера при открытых окнах (переподключение без входа).

Запуск: python tests/check_live_browser.py   (браузер: переменная KARTA_CHROME или Chrome по умолчанию)
"""
import asyncio
import http.cookiejar
import json
import os
import socket
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / '.audit/deps')]
from playwright.async_api import async_playwright  # noqa: E402

CHROME = os.environ.get('KARTA_CHROME') or r'C:\Program Files\Google\Chrome\Application\chrome.exe'
ROUNDS = int(os.environ.get('KARTA_ROUNDS', '4'))
KILLS = int(os.environ.get('KARTA_KILLS', '5'))
PASSWORD = 'test-password'
USERS = [('e1', 'editor'), ('e2', 'editor'), ('e3', 'editor'), ('v1', 'viewer')]


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())
    finally:
        s.close()


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Server:
    def __init__(self, folder, port):
        self.folder, self.port, self.proc = folder, port, None

    def start(self):
        self.proc = subprocess.Popen([sys.executable, str(ROOT / 'run.py'), '--shared', '--no-window', '--port', str(self.port), '--data', self.folder],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(200):
            try:
                urllib.request.urlopen('http://127.0.0.1:%d/api/info' % self.port, timeout=1).read()
                return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError('сервер не запустился')

    def kill9(self):
        self.proc.kill()   # SIGKILL; на Windows — TerminateProcess: как выдернутый шнур для программы
        self.proc.wait()


class Http:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        try:
            with self.opener.open(req, timeout=20) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)


def node(id, lat, name):
    return dict(id=id, type='node', f=dict(lat=lat, lng=33.5, name=name, kind='узел доступа', state='работает'))


RECORDER = '''() => {
  window.__recv = [];
  const orig = window.KartaApp.receiveShared;
  window.KartaApp.receiveShared = function (net) {
    const sig = {};
    for (const [id, o] of Object.entries(net.objs)) sig[id] = o.t || 0;
    window.__recv.push({t: Date.now(), sig: sig});
    return orig.apply(this, arguments);
  };
}'''
EDIT = '''(code) => {
  const n = KartaNet.data();
  const info = (new Function('n', code))(n);
  const r = KartaShared.commit(n);
  KartaApp.receiveShared(r);
  const o = r.objs[info];
  return {ok: !KartaShared.hasPending(), t: Date.now(), id: info,
          sig: o ? o.t || 0 : null};
}'''


async def main():
    folder = tempfile.mkdtemp(prefix='karta-live-')
    srv = Server(folder, free_port())
    srv.start()
    try:
        await scenario(folder, srv)
    finally:
        if srv.proc and srv.proc.poll() is None:
            srv.kill9()
        shutil.rmtree(folder, ignore_errors=True)


async def scenario(folder, srv):
    port = srv.port
    local = 'http://127.0.0.1:%d' % port
    remote = 'http://%s:%d' % (lan_ip(), port)
    owner_http = Http(local)
    for login, role in USERS:
        assert owner_http.call('POST', '/api/users', dict(login=login, name=login.upper(), role=role, password=PASSWORD, create=True))[0] == 200
    report = REPORT
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, headless=True)
        ctxs, pages = {}, {}

        async def open_page(who):
            ctx = await browser.new_context(viewport=dict(width=1280, height=800))
            await ctx.route('**/*', lambda r: asyncio.ensure_future(
                r.continue_() if r.request.url.startswith((local, remote, 'data:', 'blob:')) else r.abort()))
            page = await ctx.new_page()
            page.on('pageerror', lambda e: errors.append('%s: %s' % (who, e)))
            page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
            if who == 'owner':
                await page.goto(local + '/')
            else:
                await page.goto(remote + '/login')
                await page.fill('[name=login]', who)
                await page.fill('[name=password]', PASSWORD)
                await page.click('button')
            await page.wait_for_function('window.KartaApp && window.KartaShared', timeout=20000)
            await page.evaluate(RECORDER)
            ctxs[who], pages[who] = ctx, page

        await asyncio.gather(*[open_page(w) for w in ['owner'] + [u for u, _ in USERS]])
        names = list(pages)

        async def edit(who, code):
            return await pages[who].evaluate(EDIT, code)

        async def seen_by_all(who, res, timeout=15):
            """Задержка (мс) от подтверждения правки до её появления в каждом другом окне."""
            out = {}
            deadline = time.time() + timeout
            for other in names:
                if other == who:
                    continue
                while True:
                    t = await pages[other].evaluate('([id, sig, t0]) => { const r = window.__recv.find(x => x.t >= t0 - 1000 && x.sig[id] >= sig); return r ? r.t : null; }',
                                                    [res['id'], res['sig'], res['t']])
                    if t is not None:
                        out[other] = max(0, t - res['t'])
                        break
                    if time.time() > deadline:
                        out[other] = None
                        break
                    await asyncio.sleep(0.02)
            return out

        latencies, missing, slow = [], 0, []
        for r in range(ROUNDS):
            ids = ['n%d_%s' % (r, w) for w in ('e1', 'e2', 'e3')]
            # одновременно: три редактора добавляют по узлу
            adds = await asyncio.gather(*[edit(w, "n.objs['%s']=%s; return '%s';" % (i, json.dumps(node(i, 46.5 + r * 0.01 + k * 0.001, 'Узел ' + i)), i))
                                          for k, (w, i) in enumerate(zip(('e1', 'e2', 'e3'), ids))])
            steps = [(w, a) for w, a in zip(('e1', 'e2', 'e3'), adds)]
            await asyncio.sleep(0.3)
            # передвинуть узел (e2), линия ВОЛС с промежуточной точкой (e3), переименование (владелец), удаление (e1)
            seq = [
                ('e2', "n.objs['%s'].f.lat += 0.002; return '%s';" % (ids[0], ids[0])),
                ('e3', ("const a=n.objs['%s'].f,b=n.objs['%s'].f; n.objs['l%d']={id:'l%d',type:'fiber',f:{name:'ВОЛС %d',"
                        "fnodes:[{lat:a.lat,lng:a.lng,nid:'%s',kind:'узел'},{lat:(a.lat+b.lat)/2,lng:33.52,kind:'опора'},{lat:b.lat,lng:b.lng,nid:'%s',kind:'узел'}],"
                        "lay:['air','ground']}}; return 'l%d';") % (ids[1], ids[2], r, r, r, ids[1], ids[2], r)),
                ('owner', "n.objs['%s'].f.name='Переименован владельцем %d'; return '%s';" % (ids[1], r, ids[1])),
                ('e1', "n.objs['%s'].f.deleted=true; return '%s';" % (ids[2], ids[2])),
            ]
            for w, code in seq:
                need = [i for i in ids if "'%s'" % i in code]
                await pages[w].wait_for_function('(ids) => { const o = KartaNet.data().objs; return ids.every(i => o[i]); }', arg=need, timeout=20000)
                res = await edit(w, code)
                assert res['ok'], (w, res)
                steps.append((w, res))
                await asyncio.sleep(0.15)
            for w, res in steps:
                assert res['ok'], (w, res)
                for other, ms in (await seen_by_all(w, res)).items():
                    if ms is None:
                        missing += 1
                    else:
                        latencies.append(ms)
                        if ms > 300:
                            slow.append((r, w, res['id'], other, ms))
        report['latency_ms'] = dict(samples=len(latencies), missing=missing, median=statistics.median(latencies),
                                    p90=sorted(latencies)[int(len(latencies) * 0.9) - 1], max=max(latencies), slow=slow[:10])
        assert missing == 0, report

        # Сервер «обесточен» (kill -9) сразу после подтверждённых правок — из окна и по HTTP.
        kill_results = []
        e1 = Http(remote)
        assert e1.call('POST', '/api/login', dict(login='e1', password=PASSWORD))[0] == 200
        for k in range(KILLS):
            acked = []
            for i in range(15):
                id = 'k%d_%d' % (k, i)
                status, data = e1.call('POST', '/api/shared', dict(ops=[dict(id=id, before=None, after=node(id, 46.0 + i * 0.001, id))]))
                assert status == 200, data
                acked.append(id)
            res = await edit('e2', "n.objs['kb%d']=%s; return 'kb%d';" % (k, json.dumps(node('kb%d' % k, 46.3, 'из окна %d' % k)), k))
            assert res['ok']
            acked.append('kb%d' % k)
            srv.kill9()
            with open(os.path.join(folder, 'state.json'), encoding='utf-8') as f:
                objs = json.loads(json.load(f)['karta_net'])['objs']   # файл читается и разбирается целиком
            lost = [i for i in acked if i not in objs]
            tmp_left = [n for n in os.listdir(folder) if n.endswith('.tmp')]
            srv.start()
            kill_results.append(dict(acked=len(acked), lost=len(lost), tmp_left=len(tmp_left)))
            assert not lost, lost
        report['kill9'] = kill_results

        # После перезапуска окна подключаются сами, без повторного входа, и снова видят чужие правки.
        await asyncio.sleep(0.5)
        res = await edit('e3', "n.objs['after']=%s; return 'after';" % json.dumps(node('after', 46.4, 'после перезапуска')))
        assert res['ok'], res
        seen = await seen_by_all('e3', res, timeout=20)
        report['after_restart_ms'] = seen
        assert all(v is not None for v in seen.values()), seen
        for w in names:
            assert '/login' not in pages[w].url, w

        # Кто в сети: каждое окно видит владельца и всех четверых.
        await asyncio.sleep(1)
        report['online_seen'] = {w: await pages[w].evaluate('KartaShared.user() && document.querySelector("#apUsers").title') for w in names}
        for w, title in report['online_seen'].items():
            assert 'в сети 5' in title, (w, title)

        # Пока человек рисует (инструмент включён), чужая правка откладывается и появляется сразу после.
        await pages['owner'].evaluate('KartaApp.setMode("edit"); KartaApp.startNode()')
        d = await edit('e1', "n.objs['defer']=%s; return 'defer';" % json.dumps(node('defer', 46.44, 'пока рисуют')))
        await asyncio.sleep(1)
        assert not await pages['owner'].evaluate('!!KartaNet.data().objs.defer'), 'правка применилась посреди рисования'
        await pages['owner'].evaluate('KartaApp.finishTool()')
        t0 = time.time()
        await pages['owner'].wait_for_function('!!KartaNet.data().objs.defer', timeout=5000)
        report['deferred_shown_after_tool_ms'] = int((time.time() - t0) * 1000)

        # Сервер выключен, пока пользователь правит: правка ждёт и уходит сама после запуска сервера.
        srv.kill9()
        down = await edit('e3', "n.objs['down1']=%s; return 'down1';" % json.dumps(node('down1', 46.45, 'сервер выключен')))
        assert not down['ok']
        await asyncio.sleep(2)
        srv.start()
        t0 = time.time()
        await pages['v1'].wait_for_function('!!KartaNet.data().objs.down1', timeout=20000)
        report['server_down_edit_delivered_ms'] = int((time.time() - t0) * 1000)

        # Клиент без сети: правки копятся, видны как несохранённые, уходят сами после восстановления связи.
        await ctxs['e2'].set_offline(True)
        off1 = await edit('e2', "n.objs['off1']=%s; return 'off1';" % json.dumps(node('off1', 46.41, 'без сети 1')))
        off2 = await edit('e2', "n.objs['off2']=%s; return 'off2';" % json.dumps(node('off2', 46.42, 'без сети 2')))
        status_text = await pages['e2'].inner_text('#apUsers')
        stored = await pages['e2'].evaluate("Object.keys(localStorage).filter(k => k.startsWith('shared_pending'))")
        assert not off1['ok'] and not off2['ok'] and 'не сохранены' in status_text and stored, (off1, status_text, stored)
        await asyncio.sleep(3)
        t_back = time.time() * 1000
        await ctxs['e2'].set_offline(False)
        await pages['owner'].wait_for_function("() => window.__recv.some(x => x.sig.off1 && x.sig.off2)", timeout=20000)
        report['offline_delivered_ms'] = int(time.time() * 1000 - t_back)
        assert not await pages['e2'].evaluate('KartaShared.hasPending()')

        # Несохранённая правка переживает перезагрузку страницы (сервер пока недоступен для записи).
        blocker = lambda r: asyncio.ensure_future(r.abort() if r.request.method == 'POST' and '/api/shared' in r.request.url else r.fallback())
        await pages['e1'].route('**/api/shared*', blocker)
        rl = await edit('e1', "n.objs['reload1']=%s; return 'reload1';" % json.dumps(node('reload1', 46.43, 'до перезагрузки')))
        assert not rl['ok']
        await pages['e1'].reload()
        await pages['e1'].wait_for_function('window.KartaApp && window.KartaShared')
        assert await pages['e1'].evaluate("KartaShared.hasPending() && !!KartaNet.data().objs.reload1"), 'правка пропала после перезагрузки'
        await pages['e1'].unroute('**/api/shared*', blocker)
        await pages['owner'].wait_for_function("() => window.__recv.some(x => x.sig.reload1)", timeout=20000)
        report['reload_pending_delivered'] = True

        # Окончательная проверка: всё, что подтверждено, есть на сервере после ещё одного kill -9.
        srv.kill9()
        with open(os.path.join(folder, 'state.json'), encoding='utf-8') as f:
            objs = json.loads(json.load(f)['karta_net'])['objs']
        for need in ['after', 'off1', 'off2', 'reload1', 'defer', 'down1']:
            assert need in objs, need
        await browser.close()
    report['page_errors'] = errors
    print(json.dumps(report, ensure_ascii=False, indent=1))
    assert not errors, errors
    print('OK')


REPORT = {}
try:
    asyncio.run(main())
finally:
    if REPORT:
        print('Промежуточные результаты:', json.dumps(REPORT, ensure_ascii=False))
