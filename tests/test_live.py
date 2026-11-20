"""Прямой эфир и сохранность: длинный опрос и «выдернутый шнур» (kill -9) во время непрерывной записи."""
import json
import os
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from test_fixes import Base  # noqa: E402
from test_shared import Client, node  # noqa: E402


class LongPollTest(Base):
    def test_waiting_window_gets_edit_immediately(self):
        status, data = self.clients['watch'].call('GET', '/api/shared')
        rev = data['revision']
        got = {}

        def waiter():
            t = time.monotonic()
            got['status'], got['data'] = self.clients['watch'].call('GET', '/api/shared?revision=%s&wait=8' % rev)
            got['dt'] = time.monotonic() - t
        th = threading.Thread(target=waiter)
        th.start()
        time.sleep(0.4)
        t_edit = time.monotonic()
        self.assertEqual(self.apply('ivan', [dict(id='lp1', before=None, after=node('lp1'))])[0], 200)
        th.join(10)
        self.assertEqual(got['status'], 200)
        self.assertIn('lp1', got['data']['net']['objs'])
        self.assertLess(got['dt'], 2.0)   # ответ пришёл сразу после правки, а не по таймауту

    def test_wait_times_out_without_changes(self):
        rev = self.clients['watch'].call('GET', '/api/shared')[1]['revision']
        t = time.monotonic()
        status, data = self.clients['watch'].call('GET', '/api/shared?revision=%s&wait=0.6' % rev)
        self.assertEqual(status, 200)
        self.assertNotIn('net', data)
        self.assertGreaterEqual(time.monotonic() - t, 0.5)

    def test_old_revision_answers_at_once(self):
        t = time.monotonic()
        status, data = self.clients['watch'].call('GET', '/api/shared?revision=1&wait=8')
        self.assertIn('net', data)
        self.assertLess(time.monotonic() - t, 1.0)

    def test_new_participant_wakes_waiters(self):
        self.app.shared.set_user(dict(login='petr', name='petr', role='editor', password='test-password'))
        rev = self.clients['watch'].call('GET', '/api/shared')[1]['revision']
        got = {}

        def waiter():
            t = time.monotonic()
            got['data'] = self.clients['watch'].call('GET', '/api/shared?revision=%s&wait=8' % rev)[1]
            got['dt'] = time.monotonic() - t
        th = threading.Thread(target=waiter)
        th.start()
        time.sleep(0.3)
        self.login('petr')
        th.join(10)
        self.assertLess(got['dt'], 2.0)
        self.assertIn('petr', [u['login'] for u in got['data']['online']])


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class PowerLossTest(unittest.TestCase):
    """Сервер убивается без предупреждения посреди непрерывной записи. Каждая подтверждённая правка
    должна быть в state.json после перезапуска, файлы — читаться целиком."""

    def start(self):
        self.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'run.py'), '--shared', '--no-window', '--port', str(self.port), '--data', self.tmp.name],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(300):
            try:
                if Client(self.base).call('GET', '/api/info')[0] == 200:
                    return
            except OSError:
                time.sleep(0.05)
        self.fail('сервер не запустился')

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.port = free_port()
        self.base = 'http://127.0.0.1:%d' % self.port
        self.start()
        owner = Client(self.base)
        for login in ('a', 'b', 'c'):
            self.assertEqual(owner.call('POST', '/api/users', dict(login=login, name=login, role='editor', password='test-password', create=True))[0], 200)

    def tearDown(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.tmp.cleanup()

    def test_kill_during_writes_keeps_every_acknowledged_edit(self):
        rounds = int(os.environ.get('KARTA_KILLS', '6'))
        for r in range(rounds):
            acked, lock, stop = [], threading.Lock(), threading.Event()
            clients = []
            for login in ('a', 'b', 'c'):
                # Отдельный адрес, не localhost: так входят удалённые пользователи
                c = Client(self.base)
                self.assertEqual(c.call('POST', '/api/login', dict(login=login, password='test-password'))[0], 200)
                clients.append((login, c))

            def writer(login, c):
                i = 0
                while not stop.is_set():
                    id = 'r%d_%s_%d' % (r, login, i)
                    try:
                        status, _ = c.call('POST', '/api/shared', dict(ops=[dict(id=id, before=None, after=node(id))]))
                    except OSError:
                        return   # сервер убит посреди запроса — ответа нет, правка не считается подтверждённой
                    if status == 200:
                        with lock:
                            acked.append(id)
                    i += 1
            threads = [threading.Thread(target=writer, args=lc) for lc in clients]
            for t in threads:
                t.start()
            time.sleep(random.uniform(0.3, 1.2))
            self.proc.kill()   # SIGKILL / TerminateProcess
            self.proc.wait()
            stop.set()
            for t in threads:
                t.join(15)
            with open(os.path.join(self.tmp.name, 'state.json'), encoding='utf-8') as f:
                objs = json.loads(json.load(f)['karta_net'])['objs']
            for name in ('shared-users.json', 'shared-sessions.json'):
                with open(os.path.join(self.tmp.name, name), encoding='utf-8') as f:
                    json.load(f)
            lost = [i for i in acked if i not in objs]
            self.assertTrue(acked)
            if os.environ.get('KARTA_VERBOSE'):
                print('круг %d: подтверждено %d, потеряно %d' % (r, len(acked), len(lost)))
            self.assertEqual(lost, [], 'потеряны подтверждённые правки в круге %d' % r)
            self.start()
            # Входы переживают перезапуск: тот же клиент работает без повторного входа
            self.assertEqual(clients[0][1].call('GET', '/api/shared')[0], 200)


if __name__ == '__main__':
    unittest.main()
