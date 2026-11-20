"""3.5: ПК сохраняет изменённый ключ отдельно (?patch=1), большая сеть не пересылается целиком."""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import run


class PatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = run.App(self.tmp.name, lambda *args: None)
        self.server = run.Server(('127.0.0.1', 0), run.make_handler(self.app))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:%d' % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def post(self, body, patch=False):
        req = urllib.request.Request(self.base + '/api/state' + ('?patch=1' if patch else ''), method='POST',
                                     data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status

    def disk(self):
        with open(os.path.join(self.tmp.name, 'state.json'), encoding='utf-8') as f:
            return json.load(f)

    def test_patch_merges_and_removes(self):
        net = json.dumps({'v': 1, 'objs': {'a': {'id': 'a', 'type': 'node', 'f': {'name': 'A', 'lat': 46.5, 'lng': 33.5}}}, 'journal': []})
        self.assertEqual(self.post({'karta_net': net, 'karta_view': '[1,2,3]', 'karta_fibers': '16'}), 200)
        self.assertEqual(self.post({'karta_view': '[4,5,6]'}, patch=True), 200)
        d = self.disk()
        self.assertEqual(d['karta_view'], '[4,5,6]')
        self.assertEqual(d['karta_net'], net)                 # сеть не тронута
        self.assertEqual(self.post({'karta_fibers': None}, patch=True), 200)
        self.assertNotIn('karta_fibers', self.disk())
        self.assertEqual(self.app.state.load()['karta_view'], '[4,5,6]')

    def test_null_only_in_patch(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.post({'karta_view': None})

    def test_cache_sees_outside_change(self):
        self.post({'karta_view': '[1,1,1]'})
        self.app.state.load()
        path = os.path.join(self.tmp.name, 'state.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'karta_view': '[9,9,9]', 'x': 'y' * 10}, f)
        self.assertEqual(self.app.state.load()['karta_view'], '[9,9,9]')


if __name__ == '__main__':
    unittest.main()
