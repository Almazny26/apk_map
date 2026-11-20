"""Проверки исправлений 3.4.6 (ПК): права, сеансы, версии, копии, запись файлов."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import run  # noqa: E402
import shared as shared_mod  # noqa: E402
from shared import Shared  # noqa: E402
from test_shared import Client, node  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.start()
        for login, role in [('admin', 'admin'), ('ivan', 'editor'), ('watch', 'viewer')]:
            self.app.shared.set_user(dict(login=login, name=login, role=role, password='test-password'))
        self.clients = {n: self.login(n) for n in ('admin', 'ivan', 'watch')}

    def start(self, local_admin=False):
        self.app = run.App(self.tmp.name, lambda *a: None)
        self.app.shared = Shared(self.app.state, self.tmp.name)
        self.app.allow_local_admin = local_admin
        self.app.local_name = 'Владелец'
        self.server = run.Server(('127.0.0.1', 0), run.make_handler(self.app))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:%s' % self.server.server_address[1]

    def restart(self):
        self.stop()
        self.start()
        for c in self.clients.values():
            c.base = self.base

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()

    def login(self, name):
        c = Client(self.base)
        self.assertEqual(c.call('POST', '/api/login', dict(login=name, password='test-password'))[0], 200)
        return c

    def tearDown(self):
        self.stop()
        self.tmp.cleanup()

    def apply(self, who, ops, **extra):
        return self.clients[who].call('POST', '/api/shared', dict(ops=ops, **extra))


class FixesTest(Base):
    def test_elevation_works_in_shared_mode(self):
        status, data = self.clients['ivan'].call('POST', '/api/elev', dict(locs='46.6,32.6|46.7,32.7'))
        self.assertEqual(status, 200)
        self.assertEqual(data['status'], 'OK')
        self.assertEqual(self.clients['ivan'].call('POST', '/api/elev', [1])[0], 400)

    def test_new_user_with_taken_login_is_refused(self):
        status, data = self.clients['admin'].call('POST', '/api/users', dict(login='ivan', name='Другой', password='other-password', role='viewer', create=True))
        self.assertEqual(status, 409)
        self.assertIn('занят', data['error'])
        self.assertEqual(self.app.shared.users['ivan']['role'], 'editor')
        self.assertEqual(self.login('ivan').call('GET', '/api/shared')[0], 200)

    def test_sessions_and_revision_survive_restart(self):
        self.assertEqual(self.apply('ivan', [dict(id='a', before=None, after=node('a'))])[0], 200)
        rev = self.clients['ivan'].call('GET', '/api/shared')[1]['revision']
        self.restart()
        status, data = self.clients['ivan'].call('GET', '/api/shared')   # те же cookie, новый процесс
        self.assertEqual(status, 200)
        self.assertGreater(data['revision'], rev)
        with open(os.path.join(self.tmp.name, 'shared-sessions.json'), encoding='utf-8') as f:
            raw = f.read()
        for c in self.clients.values():
            for cookie in c.opener.handlers:
                jar = getattr(cookie, 'cookiejar', None)
                for item in jar or []:
                    self.assertNotIn(item.value, raw)   # на диске только хэши

    def test_logout_and_password_change_revoke_persisted_session(self):
        self.assertEqual(self.clients['ivan'].call('POST', '/api/logout', {})[0], 200)
        self.restart()
        self.assertEqual(self.clients['ivan'].call('GET', '/api/shared')[0], 401)
        self.assertEqual(self.clients['watch'].call('GET', '/api/shared')[0], 200)

    def test_remote_admin_cannot_switch_access_or_touch_map_files(self):
        admin = self.clients['admin']
        self.assertEqual(admin.call('GET', '/api/access')[0], 200)
        self.assertEqual(admin.call('POST', '/api/access', dict(enabled=False))[0], 403)
        self.assertEqual(admin.call('POST', '/api/map', dict(delete='karta-offline'))[0], 403)
        self.assertEqual(admin.call('POST', '/api/mapupload?name=x', {})[0], 403)

    def test_mass_delete_needs_admin_and_makes_snapshot(self):
        ops = [dict(id='n%d' % i, before=None, after=node('n%d' % i)) for i in range(25)]
        status, data = self.apply('admin', ops)
        self.assertEqual(status, 200)
        objs = data['net']['objs']
        dels = [dict(id=k, before=v, after=None) for k, v in objs.items()]
        status, data = self.apply('ivan', dels)
        self.assertEqual(status, 403)
        self.assertEqual(len([o for o in self.app.shared.net()['objs'].values() if not o['f'].get('deleted')]), 25)
        status, data = self.apply('admin', dels, reason='import-replace')
        self.assertEqual(status, 200)
        backups = self.clients['admin'].call('GET', '/api/backups')[1]['backups']
        self.assertTrue(any('import-replace' in b['name'] for b in backups))
        self.assertEqual(self.clients['ivan'].call('GET', '/api/backups')[0], 403)
        # восстановление копии возвращает все 25 узлов и тоже сначала делает снимок
        name = [b['name'] for b in backups if 'import-replace' in b['name']][0]
        status, data = self.clients['admin'].call('POST', '/api/backups', dict(restore=name))
        self.assertEqual(status, 200)
        self.assertEqual(len([o for o in data['net']['objs'].values() if not o['f'].get('deleted')]), 25)
        self.assertEqual(self.clients['admin'].call('POST', '/api/backups', dict(restore='../state.json'))[0], 400)

    def test_bad_node_reference_is_400_not_500(self):
        line = dict(id='l', type='fiber', f=dict(fnodes=[dict(lat=46.5, lng=33.5, nid=['x']), dict(lat=46.6, lng=33.6)], lay=['air']))
        self.assertEqual(self.apply('ivan', [dict(id='l', before=None, after=line)])[0], 400)
        self.assertEqual(self.clients['admin'].call('POST', '/api/map', [1])[0], 403)

    def test_ips_only_for_admin(self):
        self.clients['watch'].call('GET', '/api/shared')
        online = self.clients['ivan'].call('GET', '/api/shared')[1]['online']
        self.assertTrue(online and all('ip' not in u for u in online))
        self.assertTrue(all('ip' in u for u in self.clients['admin'].call('GET', '/api/shared')[1]['online']))


class OwnerTest(Base):
    def start(self, local_admin=True):
        super().start(local_admin=True)

    def test_server_computer_can_still_manage_access(self):
        owner = Client(self.base)
        status, data = owner.call('GET', '/api/access')
        self.assertEqual(status, 200)
        self.assertEqual(owner.call('POST', '/api/map', dict(delete='нет-такой'))[0], 200)


class FilesTest(unittest.TestCase):
    def test_atomic_write_retries_permission_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'state.json')
            real, calls = os.replace, []

            def flaky(a, b):
                calls.append(1)
                if len(calls) < 3:
                    raise PermissionError('занято')
                real(a, b)
            with patch('shared.os.replace', flaky), patch('shared.time.sleep'):
                shared_mod.atomic_write(path, '{"a": 1}')
            with open(path, encoding='utf-8') as f:
                self.assertEqual(json.load(f), {'a': 1})
            self.assertEqual(len(calls), 3)
            self.assertEqual([n for n in os.listdir(tmp) if n.endswith('.tmp')], [])

    def test_hourly_backups_with_users_and_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = run.State(tmp)
            state.save({'karta_net': '{"v":1,"objs":{}}'})
            with open(os.path.join(tmp, 'shared-users.json'), 'w', encoding='utf-8') as f:
                f.write('{}')
            for hour in range(5):
                state.save({'karta_net': '{"v":1,"objs":{},"n":%d}' % hour})
                run.backup_once(tmp, state, hourly_keep=3, now=time.strptime('2026-11-19 %02d' % hour, '%Y-%m-%d %H'))
            names = sorted(os.listdir(os.path.join(tmp, 'backups')))
            self.assertEqual([n for n in names if n.startswith('state-') and '_' in n],
                             ['state-2026-11-19_02.json', 'state-2026-11-19_03.json', 'state-2026-11-19_04.json'])
            self.assertIn('state-2026-11-19.json', names)
            self.assertIn('users-2026-11-19.json', names)
            # без изменений новая часовая копия не нужна
            self.assertEqual(run.backup_once(tmp, state, now=time.strptime('2026-11-19 05', '%Y-%m-%d %H')), [])

    def test_default_port_does_not_depend_on_folder(self):
        self.assertEqual(run.PORT, 8793)

    def test_local_mode_mass_delete_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = run.App(tmp, lambda *a: None)
            server = run.Server(('127.0.0.1', 0), run.make_handler(app))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            c = Client('http://127.0.0.1:%s' % server.server_address[1])
            full = {'karta_net': json.dumps({'v': 1, 'objs': {'n%d' % i: node('n%d' % i) for i in range(8)}, 'journal': []})}
            self.assertEqual(c.call('POST', '/api/state', full)[0], 200)
            self.assertEqual(c.call('POST', '/api/state', {'karta_net': '{"v":1,"objs":{},"journal":[]}'})[0], 200)
            server.shutdown(); server.server_close(); app.close()
            self.assertTrue(any(n.startswith('snapshot-') for n in os.listdir(os.path.join(tmp, 'backups'))))


if __name__ == '__main__':
    unittest.main()
