"""Shared server tests: real HTTP sessions, object concurrency, permissions and persistence."""
import copy
import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import run
from shared import Shared, DataLock


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, headers=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers or {})
        try:
            response = self.opener.open(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            result = json.loads(raw) if response.headers.get_content_type() == 'application/json' else raw.decode('utf-8')
            return response.status, result


def node(id, name='Узел'):
    return dict(id=id, type='node', f=dict(name=name, lat=46.5, lng=33.5), ft={}, by='поддельная подпись')


class SharedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = run.App(self.tmp.name, lambda *args: None)
        self.app.shared = Shared(self.app.state, self.tmp.name)
        for login, role in [('admin', 'admin'), ('ivan', 'editor'), ('petr', 'editor'), ('watch', 'viewer')]:
            self.app.shared.set_user(dict(login=login, name=login, role=role, password='test-password'))
        self.server = run.Server(('127.0.0.1', 0), run.make_handler(self.app))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:%s' % self.server.server_address[1]
        self.clients = {}
        for name in ['admin', 'ivan', 'petr', 'watch']:
            client = Client(self.base)
            self.assertEqual(client.call('POST', '/api/login', dict(login=name, password='test-password'))[0], 200)
            self.clients[name] = client

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.tmp.cleanup()

    def apply(self, who, *ops):
        return self.clients[who].call('POST', '/api/shared', dict(ops=list(ops)))

    def test_permissions_login_and_session_revocation(self):
        guest = Client(self.base)
        self.assertEqual(guest.call('GET', '/api/state')[0], 401)
        self.assertIn('Вход', guest.call('GET', '/')[1])
        self.assertEqual(self.apply('watch', dict(id='a', before=None, after=node('a')))[0], 403)
        self.assertEqual(self.clients['ivan'].call('GET', '/api/users')[0], 403)
        for path in ['/api/state', '/api/quit']:
            self.assertEqual(self.clients['admin'].call('POST', path, {})[0], 403)
        self.assertEqual(self.clients['ivan'].call('POST', '/api/map', {})[0], 403)
        self.assertEqual(self.clients['admin'].call('POST', '/api/users', dict(login='admin', name='admin', role='viewer'))[0], 400)
        self.assertEqual(self.clients['admin'].call('POST', '/api/shared', {'ops': []}, {'Origin':'http://foreign.invalid'})[0], 403)
        self.assertEqual(self.clients['admin'].call('POST', '/api/users', dict(login='ivan', name='ivan', role='editor', disable=True))[0], 200)
        self.assertEqual(self.clients['ivan'].call('GET', '/api/shared')[0], 401)
        self.clients['petr'].call('POST', '/api/logout', {})
        self.assertEqual(self.clients['petr'].call('GET', '/api/shared')[0], 401)

    def test_two_editors_distinct_objects_and_author_identity(self):
        def insert(who):
            return self.apply(who, dict(id=who, before=None, after=node(who)))
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(insert, ['ivan', 'petr']))
        self.assertEqual([r[0] for r in results], [200, 200])
        net = self.app.shared.net()
        self.assertEqual(set(net['objs']), {'ivan', 'petr'})
        for id, obj in net['objs'].items():
            self.assertEqual(obj['byId'], id)
            self.assertEqual(obj['createdById'], id)
        users = self.clients['admin'].call('GET', '/api/users')[1]['users']
        self.assertTrue(all(set(u) == {'name', 'login', 'role'} for u in users))
        snapshot = self.clients['admin'].call('GET', '/api/shared')[1]
        self.assertEqual(len(snapshot['online']), 4)
        self.assertNotIn('net', self.clients['admin'].call('GET', '/api/shared?revision=%s' % snapshot['revision'])[1])
        restarted = Shared(self.app.state, self.tmp.name)
        self.assertEqual(restarted.net(), net)
        self.assertIn('ivan', restarted.users)

    def test_same_object_conflict_is_atomic_and_rebase_is_explicit(self):
        before = self.apply('ivan', dict(id='a', before=None, after=node('a')))[1]['net']['objs']['a']
        first, second = copy.deepcopy(before), copy.deepcopy(before)
        first['f']['name'], second['f']['name'] = 'Иван', 'Пётр'
        self.assertEqual(self.apply('ivan', dict(id='a', before=before, after=first))[0], 200)
        code, data = self.apply('petr', dict(id='a', before=before, after=second), dict(id='b', before=None, after=node('b')))
        self.assertEqual(code, 409)
        self.assertEqual(data['conflicts'], ['a'])
        self.assertNotIn('b', self.app.shared.net()['objs'])
        self.assertEqual(self.apply('petr', dict(id='a', before=data['net']['objs']['a'], after=second))[0], 200)
        obj = self.app.shared.net()['objs']['a']
        self.assertEqual((obj['createdById'], obj['byId']), ('ivan', 'petr'))

    def test_linked_node_moves_distances_and_deletion(self):
        a = node('a')
        line = dict(id='line', type='fiber', ft={}, f=dict(name='Кабель', fnodes=[dict(lat=0, lng=0, nid='a'), dict(lat=46.51, lng=33.51)], lay=['surface']))
        code, data = self.apply('ivan', dict(id='a', before=None, after=a), dict(id='line', before=None, after=line))
        self.assertEqual(code, 200)
        linked = data['net']['objs']['line']
        self.assertEqual(linked['f']['fnodes'][0]['lat'], 46.5)
        self.assertGreater(linked['f']['dist'], 0)
        old = data['net']['objs']['a']
        moved = copy.deepcopy(old)
        moved['f']['lat'] = 46.505
        code, data = self.apply('petr', dict(id='a', before=old, after=moved))
        self.assertEqual(data['net']['objs']['line']['f']['fnodes'][0]['lat'], 46.505)
        self.assertNotEqual(data['net']['objs']['line']['f']['dist'], linked['f']['dist'])
        old = data['net']['objs']['a']
        code, data = self.apply('petr', dict(id='a', before=old, after=None))
        self.assertTrue(data['net']['objs']['a']['f']['deleted'])
        self.assertNotIn('nid', data['net']['objs']['line']['f']['fnodes'][0])

    def test_bad_requests_do_not_change_map(self):
        for body in [[], dict(ops='bad'), dict(ops=[dict(id='__proto__', after=node('__proto__'))]), dict(ops=[dict(id='a', after=node('different'))])]:
            self.assertEqual(self.clients['ivan'].call('POST', '/api/shared', body)[0], 400)
        self.assertEqual(self.app.shared.net()['objs'], {})

    def test_state_directory_cannot_have_two_writers(self):
        with DataLock(self.tmp.name):
            with self.assertRaises(OSError):
                DataLock(self.tmp.name)
        with DataLock(self.tmp.name):
            pass

    def test_local_owner_bypass_requires_loopback_host_and_no_proxy(self):
        self.app.allow_local_admin = True
        self.app.local_name = 'Компьютер владельца'
        guest = Client(self.base)
        code, data = guest.call('GET', '/api/shared')
        self.assertEqual(code, 200)
        self.assertEqual(data['user']['login'], '@server')
        self.assertEqual(data['user']['role'], 'admin')
        self.assertEqual(guest.call('GET', '/api/shared', headers={'Host':'192.0.2.1:8793'})[0], 401)
        self.assertEqual(guest.call('GET', '/api/shared', headers={'X-Forwarded-For':'192.0.2.2'})[0], 401)
        self.assertEqual(guest.call('POST','/api/users',dict(login='admin',name='admin',role='admin',disable=True))[0],200)
        self.assertEqual(guest.call('GET','/api/shared')[1]['user']['role'],'admin')

    def test_offline_policy_ignores_old_online_preference(self):
        self.app.state.save({'wf_online':'1'})
        with patch('urllib.request.urlopen',side_effect=AssertionError('No outbound request')) as outbound:
            # HTTP client uses its own opener; only a server-side upstream fetch would hit this mock.
            code,_ = self.clients['admin'].call('GET','/tc/osm/5/17/12')
            self.assertEqual(code,404)
            outbound.assert_not_called()

    def test_desktop_does_not_serve_old_satellite_fill(self):
        from pathlib import Path
        import base64
        original_dir=self.app.offline.dir
        self.app.offline.dir=self.tmp.name
        path=Path(self.tmp.name)/'sat-fill/13/4811/2919.tile'
        path.parent.mkdir(parents=True)
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
        path.write_bytes(png)
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.clients['admin'].opener.open(self.base+'/osat/13/4811/2919.jpg',timeout=5)
            self.assertEqual(error.exception.code,404)
            error.exception.close()
        finally:self.app.offline.dir=original_dir


if __name__ == '__main__':
    unittest.main()
