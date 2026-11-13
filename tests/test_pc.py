# -*- coding: utf-8 -*-
"""Проверка программы для компьютера: рельеф, хранение данных, раздача страницы и защита.

    python -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import run  # noqa: E402


class DemTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dem = run.Dem(os.path.join(ROOT, "web", "dem", "dem.bin"))

    def test_known_places(self):
        ai_petri = self.dem.sample(44.4523, 34.0547)       # гора Ай-Петри, ~1200 м
        simferopol = self.dem.sample(44.9521, 34.1024)     # Симферополь, ~250 м
        self.assertTrue(900 < ai_petri < 1350, ai_petri)
        self.assertTrue(150 < simferopol < 400, simferopol)
        self.assertIsNone(self.dem.sample(55.75, 37.62))   # Москвы в файле нет

    def test_fetch_like_android(self):
        r = run.fetch_elevations(self.dem, "44.95210,34.10240|45.00000,34.00000", False)
        self.assertEqual((r["status"], r["source"], len(r["results"])), ("OK", "offline", 2))
        r = run.fetch_elevations(self.dem, "44.95210,34.10240|55.75000,37.62000", False)
        self.assertEqual(r["results"][1]["elevation"], None, "точка вне файла без онлайна — пусто, как на телефоне")
        r = run.fetch_elevations(None, "44.9,34.1", False)
        self.assertEqual(r["status"], "ERROR")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        app = run.App(cls.tmp.name, lambda *a: None)
        cls.server = run.Server(("127.0.0.1", 0), run.make_handler(app))
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def get(self, path, headers=None):
        return urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers or {}), timeout=10)

    def post(self, path, body, headers=None):
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        return urllib.request.urlopen(urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method="POST", headers=h), timeout=10)

    def test_page_and_tiles(self):
        html = self.get("/").read().decode("utf-8")
        self.assertIn('<script src="leaflet/leaflet.js"></script>\n<script src="pc.js', html)
        self.assertIn('exchange.js', html)
        self.assertLess(html.index("pc.js"), html.index("const map = L.map"))
        self.assertLess(html.index("exchange.js"), html.index("pc-ui.js"))
        self.assertLess(html.index("pc-ui.js"), html.index("</body>"))
        with self.get("/tiles/8/159/91.png") as r:
            self.assertEqual(r.headers.get_content_type(), "image/png")
        with self.assertRaises(urllib.error.HTTPError):
            self.get("/../run.py")

    def test_state_roundtrip(self):
        r = self.get("/api/state")
        self.assertEqual(r.headers.get("X-State"), "none")
        self.post("/api/state", {"wf_nodes": "[]", "wf_session": "{\"points\":[]}"})
        self.assertEqual(json.loads(self.get("/api/state").read())["wf_nodes"], "[]")
        with self.assertRaises(urllib.error.HTTPError):
            self.post("/api/state", {"wf_nodes": 5})

    def test_elev(self):
        r = json.loads(self.post("/api/elev", {"locs": "44.95210,34.10240", "online": False}).read())
        self.assertEqual(r["source"], "offline")

    def test_foreign_pages_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/api/state", {"Host": "evil.example"})
        self.assertEqual(cm.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.post("/api/state", {"wf_nodes": "[]"}, {"Origin": "http://evil.example"})
        self.assertEqual(cm.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
