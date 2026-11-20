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
        cls.app = app
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    def setUp(self):
        # Each HTTP test starts with its own empty state, irrespective of method order.
        if os.path.exists(self.app.state.path):
            os.remove(self.app.state.path)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.app.close()
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
        self.assertIn('app.js', html)
        self.assertLess(html.index("pc.js"), html.index("const map = L.map"))
        self.assertLess(html.index("const map = L.map"), html.index("app.js"))
        self.assertNotIn("pc-ui.js", html)
        self.assertIn('rel="icon"', html)
        with self.get("/favicon.ico") as r:
            self.assertGreater(len(r.read()), 1000)
        for route in ['/tiles/8/159/91.png','/tc/sat/8/159/91','/osat/8/159/91.jpg']:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.get(route)
            self.assertEqual(error.exception.code,404)
            error.exception.close()
        with self.assertRaises(urllib.error.HTTPError):
            self.get("/../run.py")

    def test_state_roundtrip(self):
        r = self.get("/api/state")
        self.assertEqual(r.headers.get("X-State"), "none")
        self.post("/api/state", {"wf_nodes": "[]", "wf_session": "{\"points\":[]}"})
        self.assertEqual(json.loads(self.get("/api/state").read())["wf_nodes"], "[]")
        with self.assertRaises(urllib.error.HTTPError):
            self.post("/api/state", {"wf_nodes": 5})

    def test_old_tile_cache_is_not_served(self):
        """Старый растровый кэш не подменяет единственную офлайн-схему ПК."""
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 100
        folder = os.path.join(self.tmp.name, "tilecache", "osm", "5", "17")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "11"), "wb") as f:
            f.write(png)
        self.post("/api/state", {"wf_online": "0"})
        for bad in ("/tc/osm/5/17/11", "/tc/osm/5/17/12", "/tc/evil/5/1/1", "/tc/osm/3/99/1"):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                self.get(bad)
            self.assertEqual(cm.exception.code, 404, bad)
            cm.exception.close()

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


class OfflineMapTest(unittest.TestCase):
    def test_tileid(self):
        t = run.OfflineMap.tileid
        self.assertEqual([t(0, 0, 0), t(1, 0, 0), t(1, 0, 1), t(1, 1, 1), t(1, 1, 0), t(2, 0, 0)], [0, 1, 2, 3, 4, 5])

    def test_directory_roundtrip_and_file(self):
        om = run.OfflineMap
        entries = [(i * 3, 1 + i % 2, i * 100, 100) for i in range(5000)]
        self.assertEqual(om.read_dir(__import__("gzip").decompress(om.write_dir(entries))), entries)
        self.assertEqual(om.find(entries, 3 * 7)[0], 21)
        self.assertEqual(om.find(entries, 3 * 7 + 1)[0], 21)     # run_length 2
        self.assertIsNone(om.find(entries, 3 * 6 + 1))             # run_length 1
        with tempfile.TemporaryDirectory() as d:
            m = om(os.path.join(d, "map"), lambda *a: None)
            self.assertEqual(m.status()["files"], [])
            rnd = __import__("random").Random(1)
            root, leaves = m._dirs([(i * 7, 1, rnd.randrange(10 ** 9), rnd.randrange(1, 90000)) for i in range(200000)])
            self.assertLessEqual(len(root), 16384 - 127)
            self.assertTrue(leaves)

    @staticmethod
    def tiny(tiles, bounds=(33.0, 46.0, 34.0, 47.0)):
        """Маленький файл PMTiles: tiles = {(z, x, y): байты}."""
        import gzip
        import struct
        om = run.OfflineMap
        data, entries = b"", []
        for key in sorted(tiles, key=lambda k: om.tileid(*k)):
            blob = gzip.compress(tiles[key], mtime=0)
            entries.append((om.tileid(*key), 1, len(data), len(blob)))
            data += blob
        root, meta = om.write_dir(entries), gzip.compress(b"{}", mtime=0)
        hdr = bytearray(b"PMTiles\x03")
        hdr += struct.pack("<11Q", 127, len(root), 127 + len(root), len(meta), 0, 0, 127 + len(root) + len(meta), len(data),
                           len(entries), len(entries), len(entries))
        hdr += bytes([0, 2, 2, 1, 0, 15])
        hdr += struct.pack("<iiii", *[int(v * 1e7) for v in bounds])
        hdr += bytes([8]) + struct.pack("<ii", 0, 0)
        return bytes(hdr) + root + meta + data

    def test_files_tiles(self):
        import gzip
        blob = self.tiny({(0, 0, 0): b"world", (15, 19352, 11573): b"house"})
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "map"))
            with open(os.path.join(d, "map", "kherson.pmtiles"), "wb") as f:
                f.write(blob)
            m = run.OfflineMap(os.path.join(d, "map"), lambda *a: None)
            st = m.status()
            self.assertEqual([f["slug"] for f in st["files"]], ["kherson"])
            self.assertEqual(st["files"][0]["bounds"], [33.0, 46.0, 34.0, 47.0])
            data, gz = m.tile(15, 19352, 11573)
            self.assertTrue(gz)
            self.assertEqual(gzip.decompress(data), b"house")
            self.assertIsNone(m.tile(15, 1, 1))
            # 3.5.3: скачивания и загрузки районов в программе больше нет — файл кладут в папку map
            for gone in ("upload", "delete", "start", "build_sat", "_fetch_release"):
                self.assertFalse(hasattr(m, gone), gone)
            os.remove(os.path.join(d, "map", "kherson.pmtiles"))
            self.assertEqual(m.status()["files"], [])
            self.assertIsNone(m.tile(0, 0, 0))
            m.close()


class OfflineHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["KARTA_MAP_DIR"] = os.path.join(cls.tmp.name, "map")
        app = run.App(cls.tmp.name, lambda *a: None)
        os.environ.pop("KARTA_MAP_DIR")
        cls.server = run.Server(("127.0.0.1", 0), run.make_handler(app))
        cls.app = app
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.app.close()
        cls.tmp.cleanup()

    def test_tile_fonts_and_removed_routes(self):
        blob = OfflineMapTest.tiny({(15, 19352, 11573): b"house"})
        os.makedirs(os.path.join(self.tmp.name, "map"), exist_ok=True)
        with open(os.path.join(self.tmp.name, "map", "kherson.pmtiles"), "wb") as f:
            f.write(blob)
        st = json.loads(urllib.request.urlopen(self.base + "/api/map", timeout=10).read())
        self.assertEqual([(f["slug"], f["kind"]) for f in st["files"]], [("kherson", "map")])
        self.assertNotIn("job", st)
        r = urllib.request.urlopen(self.base + "/omap/15/19352/11573.mvt", timeout=10)
        self.assertIsNone(r.headers.get("Content-Encoding"))   # 3.5.1: без gzip — антивирусы и прокси его портили
        self.assertEqual(r.read(), b"house")
        self.assertEqual(urllib.request.urlopen(self.base + "/omap/15/1/1.mvt", timeout=10).status, 204)
        # шрифты подписей: есть диапазон — отдаётся, нет — пустой ответ, а не ошибка
        r = urllib.request.urlopen(self.base + "/vendor/fonts/Noto%20Sans%20Regular/1024-1279.pbf", timeout=10)
        self.assertGreater(len(r.read()), 1000)
        r = urllib.request.urlopen(self.base + "/vendor/fonts/Noto%20Sans%20Regular/40000-40255.pbf", timeout=10)
        self.assertEqual((r.status, r.read()), (200, b""))
        # 3.5.3: скачивание/загрузка районов, снимки и растровая карта убраны
        for method, url, body in [("POST", "/api/mapupload?name=x.pmtiles", blob), ("POST", "/api/map", b'{"download":["kherson"]}'),
                                  ("GET", "/osat/6/37/22.jpg", None), ("GET", "/tiles/8/159/91.png", None), ("GET", "/tc/osm/5/17/11", None)]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(self.base + url, data=body, method=method,
                                                              headers={"Content-Type": "application/json"}), timeout=10)
            self.assertEqual(error.exception.code, 404, url)
            error.exception.close()


if __name__ == "__main__":
    unittest.main()
