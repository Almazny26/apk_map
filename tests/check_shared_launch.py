"""Start the real command-line LAN server using an isolated data folder."""
import http.cookiejar
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


with tempfile.TemporaryDirectory() as folder:
    port = free_port()
    command = [sys.executable, '-X', 'utf8', '-B', str(ROOT/'run.py'), '--no-window', '--data', folder]
    process = subprocess.Popen(command + ['--port', str(port)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        base = 'http://127.0.0.1:%s' % port
        for attempt in range(100):
            try:
                with urllib.request.urlopen(base+'/api/info', timeout=1) as r:
                    assert r.status == 200
                break
            except OSError:
                if process.poll() is not None:
                    raise AssertionError(process.stderr.read().decode('utf-8'))
                time.sleep(.1)
        else:
            raise AssertionError('Server startup timed out')
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        with client.open(base+'/api/access', timeout=5) as r:
            assert json.load(r)['enabled'] is False
        with client.open(urllib.request.Request(base+'/api/access', data=b'{"enabled":true}', method='POST'), timeout=5) as r:
            assert r.status == 200
        for attempt in range(100):
            time.sleep(.2)
            try:
                with client.open(base+'/api/access', timeout=1) as r:
                    if json.load(r)['enabled']:
                        break
            except OSError:
                pass
        else:
            print((Path(folder)/'program.log').read_text(encoding='utf-8'))
            raise AssertionError('Mode switch timed out')
        with client.open(base+'/', timeout=5) as r:
            assert b'window.KartaSharedMode=true' in r.read()
        with client.open(base+'/api/info', timeout=5) as r:
            assert json.load(r)['version'] == '3.5.3'
        with client.open(base+'/api/shared', timeout=5) as r:
            snapshot = json.load(r)
            assert snapshot['net']['objs'] == {}
            assert snapshot['user']['login'] == '@server'
        assert not (Path(folder)/'Первый вход — сервер.txt').exists()
        remote_headers = {'Host':'192.0.2.1:%s' % port}
        try:
            client.open(urllib.request.Request(base+'/api/shared', headers=remote_headers), timeout=5)
            raise AssertionError('Remote request was allowed without login')
        except urllib.error.HTTPError as e:
            assert e.code == 401
            e.close()
        body = dict(login='crew',name='Расчёт',password='password123',role='editor')
        with client.open(urllib.request.Request(base+'/api/users', data=json.dumps(body).encode(), method='POST'), timeout=5) as r:
            assert r.status == 200
        second = subprocess.run(command + ['--port',str(free_port())], cwd=ROOT, capture_output=True, timeout=10)
        assert second.returncode == 1, second.stderr.decode('utf-8')
        process.terminate()
        process.communicate(timeout=10)
        process = subprocess.Popen(command + ['--port',str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        time.sleep(2)
        with client.open(base+'/api/shared', timeout=5) as r:
            assert json.load(r)['user']['login'] == '@server'
        print('Mode switch/restart, persistence, password-free local access, remote auth and data lock passed')
    except Exception:
        if process.poll() is not None:
            print(process.stdout.read().decode('utf-8'))
            print(process.stderr.read().decode('utf-8'))
        raise
    finally:
        process.terminate()
        process.communicate(timeout=10)
