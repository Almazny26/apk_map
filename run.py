# -*- coding: utf-8 -*-
"""«Карта сети» для компьютера — то же приложение, что на телефоне (основа — «WiFi Френель»).

    python run.py               запуск: открывается окно программы
    python run.py --no-window   без окна (для проверки)

Программа работает только на этом компьютере (адрес 127.0.0.1), по сети к ней подключиться нельзя.
Она показывает страницу из папки web — ту же, что вшита в приложение для телефона, — и делает для
неё то же, что оболочка Android: отдаёт офлайн-карту, считает рельеф по web/dem/dem.bin и хранит
данные приложения в файле data/state.json.

Нужен только Python 3.8+ — ничего доустанавливать не требуется.
"""
import argparse
import array
import hashlib
import json
import math
import mimetypes
import os
import re
import gzip
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
HOST = "127.0.0.1"
PORT = 8790
VERSION = "3.2"

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")


# ------------------------------------------------------------------ рельеф (как в оболочке Android)

class Dem:
    """Файл dem.bin: «DE..», число квадратов, затем квадраты 1°×1°: широта, долгота, n, n×n высот (int16)."""

    def __init__(self, path):
        self.tiles = {}
        with open(path, "rb") as f:
            data = f.read()
        if data[:2] != b"DE":
            raise ValueError("bad dem")
        count = struct.unpack_from("<H", data, 4)[0]
        pos = 6
        for _ in range(count):
            lat, lon, n = struct.unpack_from("<hhH", data, pos)
            pos += 6
            v = array.array("h")
            v.frombytes(data[pos:pos + n * n * 2])
            if sys.byteorder != "little":
                v.byteswap()
            pos += n * n * 2
            self.tiles.setdefault((lat, lon), (n, v))

    def sample(self, lat, lon):
        t = self.tiles.get((math.floor(lat), math.floor(lon)))
        if t is None:
            return None
        n, v = t
        tlat, tlon = math.floor(lat), math.floor(lon)
        r = ((tlat + 1.0) - lat) * (n - 1)
        c = (lon - tlon) * (n - 1)
        r0, c0 = math.floor(r), math.floor(c)
        r1, c1 = min(n - 1, r0 + 1), min(n - 1, c0 + 1)
        r0, c0 = max(0, min(n - 1, r0)), max(0, min(n - 1, c0))
        fr, fc = r - math.floor(r), c - math.floor(c)
        bottom = v[r1 * n + c1] * fc + v[r1 * n + c0] * (1.0 - fc)
        top = v[r0 * n + c1] * fc + v[r0 * n + c0] * (1.0 - fc)
        return bottom * fr + (1.0 - fr) * top


def open_meteo(locs):
    lats, lons = [], []
    for part in locs.split("|"):
        ll = part.split(",")
        if len(ll) >= 2:
            lats.append(ll[0].strip())
            lons.append(ll[1].strip())
    url = "https://api.open-meteo.com/v1/elevation?latitude=%s&longitude=%s" % (",".join(lats), ",".join(lons))
    with urllib.request.urlopen(url, timeout=20) as r:
        el = json.loads(r.read().decode("utf-8"))["elevation"]
    if any(e is None for e in el):
        return {"status": "ERROR", "error": "null elevation"}
    return {"status": "OK", "results": [{"elevation": e} for e in el]}


def fetch_elevations(dem, locs, online):
    """То же, что AndroidBridge.fetchElevations в приложении для телефона."""
    partial = None
    if dem is not None:
        parts = locs.split("|")
        res, ok = [], 0
        for part in parts:
            ll = part.split(",")
            o = {}
            if len(ll) >= 2:
                try:
                    v = dem.sample(float(ll[0]), float(ll[1]))
                except ValueError:
                    v = None
                o["elevation"] = v
                if v is not None:
                    ok += 1
            res.append(o)
        if parts and ok == len(parts):
            return {"status": "OK", "source": "offline", "results": res}
        partial = res
    if online:
        try:
            return open_meteo(locs)
        except Exception:
            pass
    if partial is not None:
        return {"status": "OK", "source": "offline", "results": partial}
    return {"status": "ERROR", "error": "offline"}


# ------------------------------------------------------------------ данные приложения

class State:
    """Данные приложения (то, что на телефоне лежит в localStorage) — в файле data/state.json."""

    def __init__(self, data_dir):
        self.path = os.path.join(data_dir, "state.json")
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            if not os.path.exists(self.path):
                return None
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)

    def save(self, data):
        with self.lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)


class Tiles:
    """Офлайн-карта: папка web/tiles, а если её нет — архив web/tiles.zip (так её проще перенести)."""

    def __init__(self):
        self.dir = os.path.join(WEB, "tiles")
        self.zip = None
        zpath = os.path.join(WEB, "tiles.zip")
        if not os.path.isdir(self.dir) and os.path.exists(zpath):
            self.zip = zipfile.ZipFile(zpath)
            self.names = set(self.zip.namelist())
        self.lock = threading.Lock()

    def get(self, rel):
        if self.zip is None:
            return None
        name = "tiles/" + rel
        if name not in self.names:
            return None
        with self.lock:
            return self.zip.read(name)


# ------------------------------------------------------------------ карта из интернета с запасом на диске

class TileCache:
    """Плитки онлайн-карт через программу: что открывали с интернетом, остаётся в data/tilecache и
    показывается без связи. Запрос в интернет — только при галочке «Онлайн» (wf_online в state.json)."""

    SOURCES = {
        "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        # blankTile=false: где снимка нет, Esri отвечает 404, а не картинкой «Map data not yet available»
        "sat": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false",
        "skl": "https://core-renderer-tiles.maps.yandex.net/tiles?l=skl&x={x}&y={y}&z={z}&scale=1&lang=ru_RU&projection=web_mercator",
    }
    FRESH = 30 * 86400          # обновлять плитку не чаще раза в 30 дней
    NONE = 7 * 86400            # «такой плитки нет» помним неделю
    ESRI_EMPTY = "f27d9de7f80c13501f470595e327aa6d"
    LIMIT = 1024 ** 3           # не больше 1 ГБ на диске
    UA = "KartaSeti/%s (Windows; https://github.com/Almazny26/apk_map)"

    def __init__(self, data_dir, state):
        self.dir = os.path.join(data_dir, "tilecache")
        self.state = state
        self._online = (0.0, False)

    def online(self):
        t, v = self._online
        if time.time() - t > 2:
            try:
                v = (self.state.load() or {}).get("wf_online") == "1"
            except Exception:
                v = False
            self._online = (time.time(), v)
        return v

    def get(self, src, z, x, y):
        """→ (данные, тип) или None."""
        if src not in self.SOURCES or not (0 <= z <= 20) or not (0 <= x < 2 ** z) or not (0 <= y < 2 ** z):
            return None
        path = os.path.join(self.dir, src, str(z), str(x), str(y))
        cached = None
        if os.path.exists(path):
            with open(path, "rb") as f:
                cached = f.read()
            if src == "sat" and len(cached) == 2521 and hashlib.md5(cached).hexdigest() == self.ESRI_EMPTY:
                # заглушка «Map data not yet available», сохранённая версией 2.3, — выбросить
                cached = None
                try:
                    os.remove(path)
                except OSError:
                    pass
        if cached is not None:
            if time.time() - os.path.getmtime(path) < self.FRESH or not self.online():
                return cached, self.kind(cached)
        elif not self.online():
            return None
        else:
            none = path + ".none"
            if os.path.exists(none) and time.time() - os.path.getmtime(none) < self.NONE:
                return None
        data = None
        url = self.SOURCES[src].format(z=z, x=x, y=y)
        for attempt in (1, 2):   # связь бывает медленной — вторая попытка
            try:
                req = urllib.request.Request(url, headers={"User-Agent": self.UA % VERSION})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read(4 * 1024 * 1024)
                break
            except urllib.error.HTTPError as e:
                if e.code == 404 and cached is None:
                    # такой плитки у источника нет (например, снимка этого масштаба) — не спрашиваем неделю
                    try:
                        os.makedirs(os.path.dirname(path), exist_ok=True)
                        open(path + ".none", "wb").close()
                    except OSError:
                        pass
                    return None
                break
            except Exception:
                continue
        try:
            if data is None or len(data) < 60 or self.kind(data) is None:
                raise ValueError("не картинка")
            if src == "sat" and len(data) == 2521 and hashlib.md5(data).hexdigest() == self.ESRI_EMPTY:
                open(path + ".none", "wb").close()
                return (cached, self.kind(cached)) if cached else None
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".%d.tmp" % threading.get_ident()
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            return data, self.kind(data)
        except Exception:
            return (cached, self.kind(cached)) if cached else None

    @staticmethod
    def kind(data):
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return "image/png"
        if data[:3] == b"\xff\xd8\xff":
            return "image/jpeg"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        return None

    def prune(self):
        """Если плиток больше лимита — удалить самые старые до 80 % лимита."""
        files, total = [], 0
        for root, _, names in os.walk(self.dir):
            for n in names:
                p = os.path.join(root, n)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                files.append((st.st_mtime, st.st_size, p))
                total += st.st_size
        if total <= self.LIMIT:
            return
        files.sort()
        for _, size, p in files:
            if total <= self.LIMIT * 0.8:
                break
            try:
                os.remove(p)
                total -= size
            except OSError:
                pass


# ------------------------------------------------------------------ сервер

# ------------------------------------------------------------------ офлайн-карта (векторная, PMTiles)

class PmFile:
    """Готовый файл PMTiles v3: по номеру плитки отдаёт её байты (как лежат в файле)."""

    def __init__(self, path):
        self.path = path
        self.slug = os.path.splitext(os.path.basename(path))[0]
        st = os.stat(path)
        self.size, self.mtime = st.st_size, int(st.st_mtime * 1000)
        self.lock = threading.Lock()
        self.fh = open(path, "rb")
        head = self.fh.read(127)
        if len(head) < 127 or head[:7] != b"PMTiles" or head[7] != 3:
            self.fh.close()
            raise ValueError("не файл PMTiles")
        (self.root_off, self.root_len, self.meta_off, self.meta_len, self.leaf_off, _ll, self.data_off, _dl,
         _a, _b, _c) = struct.unpack_from("<11Q", head, 8)
        self.internal, self.tile_comp = head[97], head[98]
        self.minzoom, self.maxzoom = head[100], head[101]
        w, s_, e, n = struct.unpack_from("<iiii", head, 102)
        self.bounds = [w / 1e7, s_ / 1e7, e / 1e7, n / 1e7]      # запад, юг, восток, север
        self.root = self._dir(self.root_off, self.root_len)
        self.leaves = {}

    def _read(self, off, ln):
        with self.lock:
            self.fh.seek(off)
            return self.fh.read(ln)

    def _dir(self, off, ln):
        raw = self._read(off, ln)
        return OfflineMap.read_dir(gzip.decompress(raw) if self.internal == 2 else raw)

    def tile(self, z, x, y):
        if z < self.minzoom or z > self.maxzoom:
            return None
        tid, d = OfflineMap.tileid(z, x, y), self.root
        for _ in range(4):
            e = OfflineMap.find(d, tid)
            if not e:
                return None
            if e[1] > 0:
                return self._read(self.data_off + e[2], e[3])
            key = (e[2], e[3])
            d = self.leaves.get(key)
            if d is None:
                if len(self.leaves) > 64:
                    self.leaves.clear()
                d = self.leaves[key] = self._dir(self.leaf_off + e[2], e[3])
        return None

    def close(self):
        with self.lock:
            self.fh.close()


class OfflineMap:
    """Подробная карта районов без интернета: файлы map/<район>.pmtiles.

    Данные — OpenStreetMap в виде векторных плиток (сборка Protomaps, масштаб 0–15; в плитке 15-го
    масштаба лежит всё до отдельных домов, страница рисует из них любой масштаб до 19). Скачивать
    такие файлы целиком разрешено (лицензия ODbL), в отличие от плиток-картинок OSM, Esri и Яндекса.

    Готовые файлы районов лежат в выпуске «maps» репозитория (их собирает GitHub Actions командой
    `run.py --offline-map`); программа и приложение скачивают оттуда. Если выпуска нет, программа
    вырезает район сама из сборки всей Земли: читает каталог плиток по частям (HTTP Range) и
    скачивает только плитки района.
    """

    BUILDS = "https://build-metadata.protomaps.dev/builds.json"
    BASE = "https://build.protomaps.com/"
    RELEASE = "https://github.com/Almazny26/apk_map/releases/download/maps/%s.pmtiles"
    REGIONS = {
        # файл: (название, (юг, запад, север, восток))
        "kherson": ("Херсонская область", (45.85, 31.45, 47.65, 35.40)),
        "zaporozhye": ("Запорожская область", (46.05, 34.15, 48.20, 37.35)),
        "crimea": ("Крым", (44.35, 32.45, 46.25, 36.70)),
    }
    MAXZOOM = 15
    UA = "KartaSeti/%s (offline map; https://github.com/Almazny26/apk_map)"

    def __init__(self, folder, log=print):
        self.dir = folder
        self.log = log
        self.lock = threading.Lock()
        self.job = None          # ход скачивания: {state, slug, done, total, error}
        self.cancel = False
        self.files = {}          # slug -> PmFile
        self.scan()

    # --- готовые файлы

    def scan(self):
        """Перечитать папку: открыть новые файлы, закрыть удалённые и изменённые."""
        with self.lock:
            found = {}
            try:
                names = sorted(n for n in os.listdir(self.dir) if n.endswith(".pmtiles"))
            except OSError:
                names = []
            for n in names:
                full = os.path.join(self.dir, n)
                slug = n[:-8]
                old = self.files.get(slug)
                try:
                    st = os.stat(full)
                    if old and old.size == st.st_size and old.mtime == int(st.st_mtime * 1000):
                        found[slug] = old
                    else:
                        found[slug] = PmFile(full)
                except Exception:
                    continue
            for slug, f in self.files.items():
                if found.get(slug) is not f:
                    f.close()
            self.files = found
            return found

    def tile(self, z, x, y):
        """Плитка из первого файла, где она есть: (байты, сжата ли gzip) или None."""
        for f in list(self.files.values()):
            try:
                data = f.tile(z, x, y)
            except Exception:
                data = None
            if data:
                return data, f.tile_comp == 2
        return None

    def name_of(self, slug):
        if slug in self.REGIONS:
            return self.REGIONS[slug][0]
        try:
            with open(os.path.join(self.dir, slug + ".pmtiles.json"), encoding="utf-8") as f:
                r = json.load(f).get("regions")
            if r:
                return ", ".join(r)
        except Exception:
            pass
        return slug

    def status(self):
        files = self.scan()
        return {
            "files": [{"slug": k, "name": self.name_of(k), "size": f.size, "mtime": f.mtime, "bounds": f.bounds}
                      for k, f in files.items()],
            "regions": [{"slug": k, "name": v[0]} for k, v in self.REGIONS.items()],
            "job": dict(self.job) if self.job else {"state": "idle"},
        }

    def delete(self, slug):
        files = self.scan()
        f = files.get(slug)
        if not f:
            return False
        with self.lock:
            f.close()
            self.files.pop(slug, None)
        for ext in (".pmtiles", ".pmtiles.json"):
            try:
                os.remove(os.path.join(self.dir, slug + ext))
            except OSError:
                pass
        return True

    @staticmethod
    def safe_slug(name):
        base = os.path.splitext(os.path.basename(str(name or "")))[0]
        base = re.sub(r"[^0-9A-Za-zА-Яа-яЁё_.-]+", "_", base).strip("._") or "karta"
        return base[:60]

    def upload(self, name, stream, length):
        """Файл карты, выбранный на этом компьютере: сохранить в папку карт."""
        if length < 127 or length > 8 * 1024 ** 3:
            raise ValueError("не похоже на файл карты")
        slug = self.safe_slug(name)
        os.makedirs(self.dir, exist_ok=True)
        tmp = os.path.join(self.dir, slug + ".pmtiles.part")
        left, first = length, True
        with open(tmp, "wb") as out:
            while left > 0:
                chunk = stream.read(min(left, 1 << 20))
                if not chunk:
                    break
                if first and chunk[:7] != b"PMTiles":
                    out.close()
                    os.remove(tmp)
                    raise ValueError("это не файл офлайн-карты (.pmtiles)")
                first = False
                out.write(chunk)
                left -= len(chunk)
        if left:
            os.remove(tmp)
            raise ValueError("файл передан не полностью")
        self._install(tmp, slug)
        return slug

    def _install(self, tmp, slug):
        with self.lock:
            old = self.files.pop(slug, None)
            if old:
                old.close()
        os.replace(tmp, os.path.join(self.dir, slug + ".pmtiles"))
        self.scan()

    # --- скачивание района

    def start(self, slug):
        if self.job and self.job.get("state") == "running":
            return False
        if slug not in self.REGIONS:
            return False
        self.cancel = False
        self.job = {"state": "running", "slug": slug, "name": self.REGIONS[slug][0], "stage": "подготовка", "done": 0, "total": 0}
        threading.Thread(target=self._run, args=(slug,), daemon=True).start()
        return True

    def stop(self):
        self.cancel = True

    def _run(self, slug):
        os.makedirs(self.dir, exist_ok=True)
        tmp = os.path.join(self.dir, slug + ".pmtiles.part")
        try:
            try:
                self._fetch_release(slug, tmp)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                # готового файла нет — вырезаем район сами
                self.extract([slug], tmp)
            self._install(tmp, slug)
            self.job.update(state="done", stage="готово")
            self.log("Офлайн-карта скачана: %s" % self.REGIONS[slug][0])
        except Exception as e:
            if self.cancel:
                self.job.update(state="idle", stage="отменено")
            else:
                self.job.update(state="error", error=str(e) or e.__class__.__name__)
                self.log("Офлайн-карта не скачана: %s\n%s" % (e, traceback.format_exc()))
            try:
                os.remove(tmp)
            except OSError:
                pass

    def _fetch_release(self, slug, tmp):
        req = urllib.request.Request(self.RELEASE % slug, headers={"User-Agent": self.UA % VERSION})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as out:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            self.job.update(stage="скачивание", done=0, total=total)
            while True:
                if self.cancel:
                    raise IOError("отменено")
                chunk = r.read(1 << 18)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                self.job.update(done=done)
            if total and done != total:
                raise IOError("связь оборвалась")
        with open(tmp, "rb") as f:
            if f.read(7) != b"PMTiles":
                raise IOError("скачан не файл карты")

    # --- формат PMTiles v3

    @staticmethod
    def tileid(z, x, y):
        acc = ((1 << (2 * z)) - 1) // 3
        tx, ty = x, y
        for a in range(z - 1, -1, -1):
            s = 1 << a
            rx, ry = s & tx, s & ty
            acc += ((3 * rx) ^ ry) << a
            if ry == 0:
                if rx != 0:
                    tx, ty = s - 1 - tx, s - 1 - ty
                tx, ty = ty, tx
        return acc

    @staticmethod
    def _varint(buf, pos):
        v = shift = 0
        while True:
            b = buf[pos]
            pos += 1
            v |= (b & 0x7F) << shift
            if b < 0x80:
                return v, pos
            shift += 7

    @staticmethod
    def _put_varint(out, v):
        while v >= 0x80:
            out.append((v & 0x7F) | 0x80)
            v >>= 7
        out.append(v)

    @classmethod
    def read_dir(cls, raw):
        buf, pos = raw, 0
        n, pos = cls._varint(buf, pos)
        ids, last = [], 0
        for _ in range(n):
            d, pos = cls._varint(buf, pos)
            last += d
            ids.append(last)
        runs, lens, offs = [], [], []
        for _ in range(n):
            v, pos = cls._varint(buf, pos)
            runs.append(v)
        for _ in range(n):
            v, pos = cls._varint(buf, pos)
            lens.append(v)
        for i in range(n):
            v, pos = cls._varint(buf, pos)
            offs.append(offs[i - 1] + lens[i - 1] if v == 0 and i > 0 else v - 1)
        return list(zip(ids, runs, offs, lens))

    @classmethod
    def write_dir(cls, entries):
        out = bytearray()
        cls._put_varint(out, len(entries))
        last = 0
        for e in entries:
            cls._put_varint(out, e[0] - last)
            last = e[0]
        for e in entries:
            cls._put_varint(out, e[1])
        for e in entries:
            cls._put_varint(out, e[3])
        for i, e in enumerate(entries):
            if i > 0 and e[2] == entries[i - 1][2] + entries[i - 1][3]:
                cls._put_varint(out, 0)
            else:
                cls._put_varint(out, e[2] + 1)
        return gzip.compress(bytes(out), mtime=0)

    @staticmethod
    def find(entries, tid):
        lo, hi = 0, len(entries) - 1
        while lo <= hi:
            k = (lo + hi) >> 1
            c = tid - entries[k][0]
            if c > 0:
                lo = k + 1
            elif c < 0:
                hi = k - 1
            else:
                return entries[k]
        if hi >= 0:
            e = entries[hi]
            if e[1] == 0 or tid - e[0] < e[1]:
                return e
        return None

    # --- скачивание

    def _get(self, url, start=None, length=None, timeout=60):
        h = {"User-Agent": self.UA % VERSION}
        if start is not None:
            h["Range"] = "bytes=%d-%d" % (start, start + length - 1)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                    data = r.read()
                if start is not None and len(data) != length:
                    raise IOError("неполный ответ")
                return data
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 + attempt * 3)

    def extract(self, regions, path, build=None, progress=None):
        """Вырезать районы (список файлов-ключей REGIONS) из сборки всей Земли в файл path."""
        job = self.job if self.job is not None else {}
        def stage(text, done=0, total=0):
            if self.cancel:
                raise IOError("отменено")
            job.update(stage=text, done=done, total=total)
            if progress:
                progress(text, done, total)
        stage("выбор сборки")
        if not build:
            builds = json.loads(self._get(self.BUILDS).decode("utf-8"))
            build = sorted(b["key"] for b in builds if b.get("key", "").endswith(".pmtiles"))[-1]
        url = self.BASE + build
        head = self._get(url, 0, 127)
        if head[:7] != b"PMTiles" or head[7] != 3:
            raise IOError("неизвестный формат сборки")
        (root_off, root_len, meta_off, meta_len, leaf_off, leaf_len, data_off, data_len,
         _a, _b, _c) = struct.unpack_from("<11Q", head, 8)
        internal, tile_comp, tile_type = head[97], head[98], head[99]
        if internal != 2:
            raise IOError("неизвестное сжатие каталога")
        dirs = {}
        def directory(off, ln):
            key = (off, ln)
            if key not in dirs:
                dirs[key] = self.read_dir(gzip.decompress(self._get(url, off, ln)))
            return dirs[key]
        def lookup(tid):
            off, ln = root_off, root_len
            for _ in range(4):
                e = self.find(directory(off, ln), tid)
                if not e:
                    return None
                if e[1] > 0:
                    return e
                off, ln = leaf_off + e[2], e[3]
            return None

        def tx(lon, z):
            return min((1 << z) - 1, max(0, int((lon + 180) / 360 * (1 << z))))
        def ty(lat, z):
            r = math.radians(lat)
            return min((1 << z) - 1, max(0, int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (1 << z))))

        stage("каталог плиток")
        wanted = {}
        boxes = [self.REGIONS[r][1] for r in regions]
        for z in range(0, self.MAXZOOM + 1):
            for (s, w, n, e) in boxes:
                for x in range(tx(w, z), tx(e, z) + 1):
                    for y in range(ty(n, z), ty(s, z) + 1):
                        tid = self.tileid(z, x, y)
                        if tid in wanted:
                            continue
                        ent = lookup(tid)
                        if ent:
                            wanted[tid] = (ent[2], ent[3])
        # куски исходного файла: одинаковые плитки (море) хранятся один раз
        uniq = sorted(set(wanted.values()))
        total = sum(ln for _, ln in uniq)
        chunks, cur = [], None
        for off, ln in uniq:
            if cur and off - (cur[0] + cur[1]) <= 32768 and cur[1] + ln <= 4 * 1024 * 1024:
                cur[1] = max(cur[1], off + ln - cur[0])
                cur[2].append((off, ln))
            else:
                cur = [off, ln, [(off, ln)]]
                chunks.append(cur)

        tmp = path + ".build"
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        newoff, pos, done = {}, 0, 0
        stage("скачивание", 0, total)
        from concurrent.futures import ThreadPoolExecutor
        with open(tmp + ".data", "wb") as out, ThreadPoolExecutor(6) as pool:
            futures = []
            for c in chunks:
                futures.append((c, pool.submit(self._get, url, data_off + c[0], c[1], 120)))
                # не держать в памяти слишком много: ждём, если в очереди больше 24 кусков
                while len(futures) > 24:
                    pos, done = self._write_chunk(futures.pop(0), out, newoff, pos, done)
                    stage("скачивание", done, total)
            while futures:
                pos, done = self._write_chunk(futures.pop(0), out, newoff, pos, done)
                stage("скачивание", done, total)

        stage("сборка файла", total, total)
        entries = []
        for tid in sorted(wanted):
            o, ln = newoff[wanted[tid]], wanted[tid][1]
            last = entries[-1] if entries else None
            if last and last[0] + last[1] == tid and last[2] == o and last[3] == ln:
                last[1] += 1
            else:
                entries.append([tid, 1, o, ln])
        root, leaves = self._dirs([tuple(e) for e in entries])
        meta = self._get(url, meta_off, meta_len) if meta_len else gzip.compress(b"{}", mtime=0)
        b = boxes
        S, W, N, E = min(x[0] for x in b), min(x[1] for x in b), max(x[2] for x in b), max(x[3] for x in b)
        hdr = bytearray(b"PMTiles\x03")
        r_off = 127
        m_off = r_off + len(root)
        l_off = m_off + len(meta)
        d_off = l_off + len(leaves)
        n_tiles = sum(e[1] for e in entries)
        hdr += struct.pack("<11Q", r_off, len(root), m_off, len(meta), l_off, len(leaves), d_off, pos,
                           n_tiles, len(entries), len(newoff))
        hdr += bytes([0, 2, tile_comp, tile_type, 0, self.MAXZOOM])
        e7 = lambda v: int(round(v * 1e7))
        hdr += struct.pack("<iiii", e7(W), e7(S), e7(E), e7(N))
        hdr += bytes([8]) + struct.pack("<ii", e7((W + E) / 2), e7((S + N) / 2))
        assert len(hdr) == 127
        with open(tmp, "wb") as f:
            f.write(hdr)
            f.write(root)
            f.write(meta)
            f.write(leaves)
            with open(tmp + ".data", "rb") as src:
                shutil.copyfileobj(src, f, 1024 * 1024)
        os.remove(tmp + ".data")
        os.replace(tmp, path)
        return {"tiles": n_tiles, "bytes": os.path.getsize(path), "build": build}

    @staticmethod
    def _write_chunk(item, out, newoff, pos, done):
        c, fut = item
        data = fut.result()
        for off, ln in c[2]:
            newoff[(off, ln)] = pos
            out.write(data[off - c[0]:off - c[0] + ln])
            pos += ln
            done += ln
        return pos, done

    def _dirs(self, entries):
        """Каталог: корень до 16 КБ, остальное — в листовых каталогах."""
        root = self.write_dir(entries)
        if len(root) <= 16384 - 127:
            return root, b""
        size = 4096
        while True:
            leaves, root_entries = bytearray(), []
            for i in range(0, len(entries), size):
                part = self.write_dir(entries[i:i + size])
                root_entries.append((entries[i][0], 0, len(leaves), len(part)))
                leaves += part
            root = self.write_dir(root_entries)
            if len(root) <= 16384 - 127:
                return root, bytes(leaves)
            size *= 2


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "KartaSeti/" + VERSION
        timeout = 75

        def log_message(self, fmt, *args):
            pass

        def _send(self, status, body=b"", ctype="application/json; charset=utf-8", extra=None):
            self.send_response(status)
            if body or status not in (204, 304):
                self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, payload, status=200, extra=None):
            h = {"Cache-Control": "no-store"}
            h.update(extra or {})
            self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), extra=h)

        def _guard(self):
            """Только этот компьютер и только эта программа: чужие страницы в браузере сюда не достучатся."""
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            # t1…t4.localhost — тот же компьютер; через них браузер грузит плитки вчетверо параллельнее
            if re.match(r"^t[1-4]\.localhost$", host) and self.command == "GET" and \
                    re.match(r"^/(tc/|tiles/|icon\.png)", urllib.parse.urlsplit(self.path).path):
                return
            if host not in ("127.0.0.1", "localhost"):
                raise HttpError(403, "Программа доступна только на этом компьютере")
            origin = self.headers.get("Origin")
            if origin and self.command != "GET":
                o = (urllib.parse.urlsplit(origin).hostname or "").lower()
                if o not in ("127.0.0.1", "localhost"):
                    raise HttpError(403, "Запрос с чужой страницы отклонён")

        def _body(self, limit=32 * 1024 * 1024):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                self.close_connection = True
                raise HttpError(413, "Слишком большой запрос")
            raw = self.rfile.read(n) if n else b""
            try:
                return json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                raise HttpError(400, "Неверный формат данных")

        def do_HEAD(self):
            self._dispatch()

        def do_GET(self):
            self._dispatch()

        def do_POST(self):
            self._dispatch()

        def _dispatch(self):
            path = urllib.parse.urlsplit(self.path).path
            try:
                self._guard()
                if path.startswith("/api/"):
                    self._api(path[5:])
                elif self.command in ("GET", "HEAD"):
                    self._static(urllib.parse.unquote(path))
                else:
                    raise HttpError(405, "Метод не поддерживается")
            except HttpError as e:
                self._json({"error": e.message}, e.status)
            except (BrokenPipeError, ConnectionError, TimeoutError):
                self.close_connection = True
            except Exception:
                app.log("Ошибка %s %s\n%s" % (self.command, path, traceback.format_exc()))
                try:
                    self._json({"error": "Внутренняя ошибка программы"}, 500)
                except Exception:
                    self.close_connection = True

        def _api(self, route):
            if route == "state" and self.command == "GET":
                data = app.state.load()
                if data is None:
                    return self._json({}, extra={"X-State": "none"})
                return self._json(data)
            if route == "state" and self.command == "POST":
                data = self._body()
                if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items()):
                    raise HttpError(400, "Неверные данные")
                app.state.save(data)
                return self._json({"ok": True})
            if route == "elev" and self.command == "POST":
                b = self._body(limit=1024 * 1024)
                return self._json(fetch_elevations(app.dem, str(b.get("locs") or ""), bool(b.get("online"))))
            if route == "map" and self.command == "GET":
                return self._json(app.offline.status())
            if route == "map" and self.command == "POST":
                b = self._body(limit=64 * 1024)
                if b.get("download"):
                    return self._json({"ok": app.offline.start(str(b["download"]))})
                if b.get("delete"):
                    return self._json({"ok": app.offline.delete(str(b["delete"]))})
                if b.get("cancel"):
                    app.offline.stop()
                    return self._json({"ok": True})
                raise HttpError(400, "Неверный запрос")
            if route == "mapupload" and self.command == "POST":
                # файл карты с этого компьютера: тело запроса — сам файл
                q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                try:
                    slug = app.offline.upload((q.get("name") or ["karta"])[0], self.rfile, int(self.headers.get("Content-Length") or 0))
                except ValueError as e:
                    self.close_connection = True
                    raise HttpError(400, str(e))
                return self._json({"ok": True, "slug": slug})
            if route == "info":
                return self._json({"app": "karta-seti", "version": VERSION})
            if route == "quit" and self.command == "POST" and self.headers.get("X-Karta") == "quit":
                # новая версия программы просит старую уступить место (только с этого компьютера)
                self._json({"ok": True})
                if app.quit:
                    threading.Timer(0.3, app.quit).start()
                return
            raise HttpError(404, "Нет такого адреса")

        def _static(self, path):
            rel = path.lstrip("/") or "index.html"
            m = re.match(r"^omap/(\d+)/(\d+)/(\d+)\.mvt$", rel)
            if m:
                # плитка офлайн-карты района; нет такой — пустой ответ (за границей района карта пустая)
                got = app.offline.tile(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                if got is None:
                    return self._send(204, b"", "application/x-protobuf", {"Cache-Control": "no-cache"})
                return self._send(200, got[0], "application/x-protobuf",
                                  {"Cache-Control": "no-cache", "Content-Encoding": "gzip"} if got[1] else {"Cache-Control": "no-cache"})
            if rel.startswith("vendor/fonts/") and rel.endswith(".pbf") and not os.path.isfile(os.path.join(WEB, rel)):
                # букв этого диапазона в наборе нет — пустой ответ, иначе подписи на плитке не рисуются
                return self._send(200, b"", "application/x-protobuf", {"Cache-Control": "max-age=86400"})
            m = re.match(r"^tc/([a-z]+)/(\d+)/(\d+)/(\d+)$", rel)
            if m:
                got = app.tilecache.get(m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)))
                if got is None:
                    return self._send(404, b"", "text/plain")
                return self._send(200, got[0], got[1] or "image/png", {"Cache-Control": "max-age=3600"})
            if rel.startswith("tiles/"):
                data = app.tiles.get(rel[6:])
                if data is not None:
                    return self._send(200, data, "image/png", {"Cache-Control": "max-age=86400"})
            full = os.path.abspath(os.path.join(WEB, rel))
            if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
                if rel.startswith("tiles/"):
                    # квадрата нет в офлайн-карте — как у оболочки Android, пустой ответ
                    return self._send(404, b"", "text/plain")
                raise HttpError(404, "Файл не найден")
            with open(full, "rb") as f:
                body = f.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if rel == "index.html":
                # подключаем замену оболочки Android сразу после Leaflet, до кода приложения
                html = body.decode("utf-8")
                tag = '<script src="leaflet/leaflet.js"></script>'
                inject = tag + '\n<script src="pc.js?v=%s"></script>' % VERSION
                html = html.replace(tag, inject, 1) if tag in html else html.replace("<head>", "<head>\n" + inject, 1)
                # значок окна — тот же, что у приложения на телефоне
                html = html.replace("</head>", '<link rel="icon" type="image/png" sizes="192x192" href="icon.png">\n'
                                    '<link rel="shortcut icon" href="favicon.ico">\n</head>', 1)
                body = html.encode("utf-8")
            if ctype.startswith("text/") or ctype in ("application/json", "text/javascript"):
                ctype += "; charset=utf-8"
            cache = "max-age=86400" if rel.startswith(("tiles/", "leaflet/", "vendor/fonts/")) else "no-cache"
            self._send(200, body, ctype, {"Cache-Control": cache})

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"   # на Windows иначе вторая копия программы займёт тот же порт

    def handle_error(self, request, client_address):
        pass


class App:
    def __init__(self, data_dir, log):
        self.state = State(data_dir)
        self.tiles = Tiles()
        self.tilecache = TileCache(data_dir, self.state)
        self.quit = None
        self.log = log
        self.offline = OfflineMap(os.environ.get("KARTA_MAP_DIR") or os.path.join(ROOT, "map"), log)
        try:
            self.dem = Dem(os.path.join(WEB, "dem", "dem.bin"))
        except Exception as e:
            log("Не удалось прочитать рельеф dem.bin: %s" % e)
            self.dem = None


class Log:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()

    def __call__(self, text):
        line = "%s  %s" % (time.strftime("%d.%m.%Y %H:%M:%S"), text)
        with self.lock:
            print(line, flush=True)
            try:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass


def backup_loop(data_dir, log, keep=30):
    """Раз в сутки копия data/state.json в data/backups; хранятся последние 30."""
    folder = os.path.join(data_dir, "backups")
    os.makedirs(folder, exist_ok=True)
    pattern = re.compile(r"^state-\d{4}-\d{2}-\d{2}\.json$")
    while True:
        try:
            src = os.path.join(data_dir, "state.json")
            dst = os.path.join(folder, "state-%s.json" % time.strftime("%Y-%m-%d"))
            if os.path.exists(src) and not os.path.exists(dst):
                shutil.copyfile(src, dst)
            old = sorted(n for n in os.listdir(folder) if pattern.match(n))
            for name in old[:-keep]:
                os.remove(os.path.join(folder, name))
        except Exception as e:
            log("Не удалось сделать резервную копию: %s" % e)
        time.sleep(3600)


def replace_old(port):
    """Порт занят. Если это наша программа другой версии (например, старое окно свёрнуто и забыто),
    закрыть её, чтобы работала новая. → True, если порт освободился."""
    base = "http://%s:%d" % (HOST, port)
    try:
        with urllib.request.urlopen(base + "/api/info", timeout=3) as r:
            info = json.loads(r.read().decode("utf-8"))
    except Exception:
        return False
    if info.get("app") != "karta-seti" or info.get("version") == VERSION:
        return False
    print("  Работает прежняя версия программы (%s) — закрываю её." % info.get("version"))
    try:   # версии 2.8 и новее закрываются сами по просьбе
        req = urllib.request.Request(base + "/api/quit", data=b"{}", method="POST",
                                     headers={"X-Karta": "quit", "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass
    for _ in range(10):
        time.sleep(0.5)
        if port_free(port):
            return True
    if os.name == "nt":   # более старые — завершить процесс, который держит порт (только Python)
        try:
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, timeout=15).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[1].endswith(":%d" % port) and parts[3].upper() == "LISTENING":
                    pid = parts[4]
                    name = subprocess.run(["tasklist", "/FI", "PID eq %s" % pid, "/FO", "CSV", "/NH"],
                                          capture_output=True, text=True, timeout=15).stdout.lower()
                    if "python" in name or "py.exe" in name:
                        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, timeout=15)
        except Exception:
            pass
        for _ in range(10):
            time.sleep(0.5)
            if port_free(port):
                return True
    return False


def port_free(port):
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name != "nt":   # как у самого сервера: старые соединения в TIME_WAIT не мешают
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((HOST, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def make_shortcut(data_dir, log):
    """Один раз: ярлык «Карта сети» на рабочем столе со значком приложения (только Windows)."""
    mark = os.path.join(data_dir, "shortcut.done")
    if os.name != "nt" or os.path.exists(mark):
        return
    script = (
        "$d=[Environment]::GetFolderPath('Desktop');"
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Карта сети.lnk'));"
        "$s.TargetPath=%s;$s.WorkingDirectory=%s;$s.IconLocation=%s;$s.WindowStyle=7;"
        "$s.Description='Карта сети';$s.Save()"
    ) % tuple("'" + v.replace("'", "''") + "'" for v in (
        os.path.join(ROOT, "Карта сети.bat"), ROOT, os.path.join(WEB, "favicon.ico") + ",0"))
    try:
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                       timeout=30, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        with open(mark, "w", encoding="utf-8") as f:
            f.write(time.strftime("%d.%m.%Y %H:%M"))
        log("Создан ярлык «Карта сети» на рабочем столе")
    except Exception as e:
        log("Не удалось создать ярлык: %s" % e)


def open_window(url):
    """Отдельное окно программы (Edge или Chrome в режиме приложения), иначе — браузер."""
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
            if not base:
                continue
            for exe in (os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                        os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")):
                if os.path.exists(exe):
                    try:
                        subprocess.Popen([exe, "--app=" + url, "--start-maximized"], close_fds=True)
                        return
                    except Exception:
                        pass
    webbrowser.open(url)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Карта сети")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--data", help="папка с данными")
    ap.add_argument("--no-window", action="store_true")
    ap.add_argument("--offline-map", nargs="+", metavar="РАЙОН",
                    help="вырезать офлайн-карту районов (%s) в файл --map-file и выйти" % ", ".join(OfflineMap.REGIONS))
    ap.add_argument("--map-file", help="куда сохранить офлайн-карту (для --offline-map)")
    args = ap.parse_args()
    if args.offline_map is not None:
        bad = [r for r in args.offline_map if r not in OfflineMap.REGIONS]
        if bad:
            print("Нет такого района: %s. Есть: %s" % (", ".join(bad), ", ".join(OfflineMap.REGIONS)))
            return 2
        out = os.path.abspath(args.map_file or os.path.join(ROOT, "map", args.offline_map[0] + ".pmtiles"))
        om = OfflineMap(os.path.dirname(out))
        last = [0]
        def show(text, done, total):
            if time.time() - last[0] > 3 or done == total:
                last[0] = time.time()
                print("  %s %s" % (text, "%d из %d МБ" % (done >> 20, total >> 20) if total else ""), flush=True)
        r = om.extract(args.offline_map, out, progress=show)
        print("Готово: %(tiles)d плиток, %(bytes)d байт, сборка %(build)s" % r)
        return 0

    data_dir = os.path.abspath(args.data or os.path.join(ROOT, "data"))
    os.makedirs(data_dir, exist_ok=True)
    log = Log(os.path.join(data_dir, "program.log"))
    url = "http://%s:%d/" % (HOST, args.port)
    the_app = App(data_dir, log)
    try:
        server = Server((HOST, args.port), make_handler(the_app))
    except OSError:
        server = None
        if replace_old(args.port):
            try:
                server = Server((HOST, args.port), make_handler(the_app))
            except OSError:
                server = None
        if server is None:
            print("Программа уже запущена, открываю её окно.")
            if not args.no_window:
                open_window(url)
            return 0
    the_app.quit = server.shutdown
    threading.Thread(target=backup_loop, args=(data_dir, log), daemon=True).start()
    threading.Thread(target=the_app.tilecache.prune, daemon=True).start()
    if not args.no_window:
        threading.Thread(target=make_shortcut, args=(data_dir, log), daemon=True).start()
    print()
    print("  Карта сети %s (основа — «WiFi Френель»)" % VERSION)
    print("  Данные: %s" % os.path.join(data_dir, "state.json"))
    print("  Окно программы: %s" % url)
    print("  Работает только на этом компьютере. Пока это окно открыто, программа работает.")
    print()
    log("Программа запущена")
    if not args.no_window:
        threading.Timer(0.6, open_window, args=(url,)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log("Программа остановлена")
    return 0


if __name__ == "__main__":
    sys.exit(main())
