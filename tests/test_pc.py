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
        self.assertIn('app.js', html)
        self.assertLess(html.index("pc.js"), html.index("const map = L.map"))
        self.assertLess(html.index("const map = L.map"), html.index("app.js"))
        self.assertNotIn("pc-ui.js", html)
        self.assertIn('rel="icon"', html)
        with self.get("/favicon.ico") as r:
            self.assertGreater(len(r.read()), 1000)
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

    def test_tile_cache_offline(self):
        """Без «Онлайн» онлайн-карта берётся только из запаса на диске, в интернет программа не ходит."""
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 100
        folder = os.path.join(self.tmp.name, "tilecache", "osm", "5", "17")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "11"), "wb") as f:
            f.write(png)
        self.post("/api/state", {"wf_online": "0"})
        with self.get("/tc/osm/5/17/11") as r:
            self.assertEqual((r.headers.get_content_type(), r.read()), ("image/png", png))
        for bad in ("/tc/osm/5/17/12", "/tc/evil/5/1/1", "/tc/osm/3/99/1"):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                self.get(bad)
            self.assertEqual(cm.exception.code, 404, bad)

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

    def test_files_tiles_upload_delete(self):
        import gzip
        import io
        blob = self.tiny({(0, 0, 0): b"world", (15, 19352, 11573): b"house"})
        with tempfile.TemporaryDirectory() as d:
            m = run.OfflineMap(os.path.join(d, "map"), lambda *a: None)
            slug = m.upload("Мой район (1).pmtiles", io.BytesIO(blob), len(blob))
            st = m.status()
            self.assertEqual([f["slug"] for f in st["files"]], [slug])
            self.assertEqual(st["files"][0]["bounds"], [33.0, 46.0, 34.0, 47.0])
            data, gz = m.tile(15, 19352, 11573)
            self.assertTrue(gz)
            self.assertEqual(gzip.decompress(data), b"house")
            self.assertIsNone(m.tile(15, 1, 1))
            with self.assertRaises(ValueError):
                m.upload("x.pmtiles", io.BytesIO(b"not a map" * 40), 360)
            self.assertTrue(m.delete(slug))
            self.assertEqual(m.status()["files"], [])
            self.assertIsNone(m.tile(0, 0, 0))


    @staticmethod
    def sat_file(folder):
        """Файл снимков крошечного «района», плитки берутся не из интернета, а подставные."""
        m = run.OfflineMap(os.path.join(folder, "build"), lambda *a: None)
        m.REGIONS = {"t": ("Тест", (46.0, 33.0, 46.02, 33.02))}
        m.SAT_MAXZOOM = 6
        asked = []

        def get(url, *a, **k):
            asked.append(url)
            if "/g/5/" in url:
                raise urllib.error.HTTPError(url, 404, "нет", None, None)
            return b"\xff\xd8" + url.rsplit("/g/", 1)[1].encode()
        m._get = get
        path = os.path.join(folder, "t-sat.pmtiles")
        res = m.build_sat(["t"], path)
        return path, res, asked

    def test_sat_file(self):
        with tempfile.TemporaryDirectory() as d:
            path, res, asked = self.sat_file(d)
            self.assertEqual(len(asked), 7)                      # масштабы 0–6, по одной плитке
            self.assertEqual(res["tiles"], 6)                    # плитки 5-го масштаба «нет на сервере»
            m = run.OfflineMap(os.path.join(d, "map"), lambda *a: None)
            with open(path, "rb") as f:
                slug = m.upload("t-sat.pmtiles", f, os.path.getsize(path))
            f = m.status()["files"][0]
            self.assertEqual((slug, f["kind"]), ("t-sat", "sat"))
            self.assertIsNone(m.tile(6, 37, 22))                 # снимки — не схема
            x, y = int((33.01 + 180) / 360 * 64), 22
            data, gz = m.tile(6, x, y, "sat")
            self.assertEqual((data, gz), (b"\xff\xd8" + ("6/%d/%d.jpg" % (y, x)).encode(), False))
            self.assertIsNone(m.tile(5, x >> 1, y >> 1, "sat"))
            m.delete(slug)


class OfflineHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["KARTA_MAP_DIR"] = os.path.join(cls.tmp.name, "map")
        app = run.App(cls.tmp.name, lambda *a: None)
        os.environ.pop("KARTA_MAP_DIR")
        cls.server = run.Server(("127.0.0.1", 0), run.make_handler(app))
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def test_upload_tile_fonts(self):
        blob = OfflineMapTest.tiny({(15, 19352, 11573): b"house"})
        r = urllib.request.urlopen(urllib.request.Request(self.base + "/api/mapupload?name=test.pmtiles", data=blob, method="POST"), timeout=10)
        self.assertTrue(json.loads(r.read())["ok"])
        st = json.loads(urllib.request.urlopen(self.base + "/api/map", timeout=10).read())
        self.assertEqual([f["slug"] for f in st["files"]], ["test"])
        self.assertEqual([g["slug"] for g in st["regions"]], ["kherson", "zaporozhye", "crimea"])
        r = urllib.request.urlopen(self.base + "/omap/15/19352/11573.mvt", timeout=10)
        self.assertEqual(r.headers.get("Content-Encoding"), "gzip")
        self.assertEqual(__import__("gzip").decompress(r.read()), b"house")
        self.assertEqual(urllib.request.urlopen(self.base + "/omap/15/1/1.mvt", timeout=10).status, 204)
        # шрифты подписей: есть диапазон — отдаётся, нет — пустой ответ, а не ошибка
        r = urllib.request.urlopen(self.base + "/vendor/fonts/Noto%20Sans%20Regular/1024-1279.pbf", timeout=10)
        self.assertGreater(len(r.read()), 1000)
        r = urllib.request.urlopen(self.base + "/vendor/fonts/Noto%20Sans%20Regular/40000-40255.pbf", timeout=10)
        self.assertEqual((r.status, r.read()), (200, b""))
        # снимки района: отдельный файл, плитки-картинки по своему адресу
        with tempfile.TemporaryDirectory() as d:
            path = OfflineMapTest.sat_file(d)[0]
            with open(path, "rb") as f:
                blob = f.read()
        urllib.request.urlopen(urllib.request.Request(self.base + "/api/mapupload?name=t-sat.pmtiles", data=blob, method="POST"), timeout=10)
        st = json.loads(urllib.request.urlopen(self.base + "/api/map", timeout=10).read())
        self.assertEqual(sorted((f["slug"], f["kind"]) for f in st["files"]), [("t-sat", "sat"), ("test", "map")])
        r = urllib.request.urlopen(self.base + "/osat/6/37/22.jpg", timeout=10)
        self.assertEqual((r.headers.get("Content-Type"), r.read()[:2]), ("image/jpeg", b"\xff\xd8"))
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(self.base + "/osat/5/18/11.jpg", timeout=10)
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(urllib.request.Request(self.base + "/api/mapupload?name=bad.pmtiles", data=b"x" * 500, method="POST"), timeout=10)


if __name__ == "__main__":
    unittest.main()
