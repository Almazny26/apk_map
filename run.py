# -*- coding: utf-8 -*-
"""«Карта сети» для компьютера — то же приложение, что на телефоне (основа — «WiFi Френель»).

    python run.py               запуск: открывается окно программы
    python run.py --no-window   без окна (для проверки)

Обычный запуск работает только на этом компьютере (127.0.0.1).
С --shared доступна совместная работа по IP и порту с учётными записями.
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
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import atomic_write  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
HOST = "127.0.0.1"
PORT = 8793   # стандартный порт; другой — «--port N», он запоминается в data/remote-access.json
VERSION = "3.5.0"

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

_alive_memo = []          # [(строка сети, число живых объектов)] — последние две


def counted(karta_net):
    """Число живых объектов сети; прошлое значение не пересчитывается (сеть 5 МБ разбирается раз)."""
    from shared import alive_count
    for s, n in _alive_memo:
        if s is karta_net or s == karta_net:
            return n
    n = alive_count(karta_net)
    _alive_memo.append((karta_net, n))
    del _alive_memo[:-2]
    return n


class State:
    """Данные приложения (то, что на телефоне лежит в localStorage) — в файле data/state.json."""

    def __init__(self, data_dir):
        self.path = os.path.join(data_dir, "state.json")
        self.lock = threading.Lock()
        self._cache = None      # (размер и время файла, данные): большую сеть не читать с диска на каждое сохранение

    def _key(self):
        st = os.stat(self.path)
        return (st.st_size, st.st_mtime_ns, st.st_ino)

    def load(self):
        with self.lock:
            if not os.path.exists(self.path):
                return None
            key = self._key()
            if self._cache and self._cache[0] == key:
                return dict(self._cache[1])
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._cache = (key, data) if isinstance(data, dict) else None
            return dict(data) if isinstance(data, dict) else data

    def save(self, data):
        with self.lock:
            atomic_write(self.path, json.dumps(data, ensure_ascii=False))
            try:
                self._cache = (self._key(), dict(data)) if isinstance(data, dict) else None
            except OSError:
                self._cache = None

    def read_bytes(self):
        """Содержимое файла под той же блокировкой, что и запись (для резервной копии)."""
        with self.lock:
            try:
                with open(self.path, "rb") as f:
                    return f.read()
            except FileNotFoundError:
                return None


class Tiles:
    """Офлайн-карта: папка web/tiles, а если её нет — архив web/tiles.zip (так её проще перенести)."""

    def __init__(self, enabled=True):
        self.dir = os.path.join(WEB, "tiles")
        self.zip = None
        zpath = os.path.join(WEB, "tiles.zip")
        if enabled and not os.path.isdir(self.dir) and os.path.exists(zpath):
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
    показывается без связи. Страница держит признак wf_online включённым всегда (выключателя с 3.3
    нет); если связи нет, после трёх неудач подряд программа 20 секунд не ходит в интернет и сразу
    отдаёт то, что есть в запасе."""

    SOURCES = {
        "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        # blankTile=false: где снимка нет, Esri отвечает 404, а не картинкой «Map data not yet available»
        "sat": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false",
        "skl": "https://core-renderer-tiles.maps.yandex.net/tiles?l=skl&x={x}&y={y}&z={z}&scale=1&lang=ru_RU&projection=web_mercator",
    }
    FRESH = 30 * 86400          # обновлять плитку не чаще раза в 30 дней
    NONE = 7 * 86400            # «такой плитки нет» помним неделю
    ESRI_EMPTY = "f27d9de7f80c13501f470595e327aa6d"
    LIMIT = 4 * 1024 ** 3       # не больше 4 ГБ на диске
    PAUSE = 20                  # сек. без запросов в интернет после трёх неудач подряд
    UA = "KartaSeti/%s (Windows; https://github.com/Almazny26/apk_map)"

    def __init__(self, data_dir, state):
        self.dir = os.path.join(data_dir, "tilecache")
        self.state = state
        self._online = (0.0, False)
        self.fails = 0
        self.down_until = 0.0

    def online(self):
        if getattr(self, 'offline_only', False):
            return False
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
        if time.time() < self.down_until:      # связи нет — не ждём, отдаём запас
            return (cached, self.kind(cached)) if cached else None
        url = self.SOURCES[src].format(z=z, x=x, y=y)
        for attempt in (1, 2):   # связь бывает медленной — вторая попытка
            try:
                req = urllib.request.Request(url, headers={"User-Agent": self.UA % VERSION})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read(4 * 1024 * 1024)
                self.fails = 0
                break
            except urllib.error.HTTPError as e:
                self.fails = 0
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
                self.fails += 1
                if self.fails >= 3:
                    self.fails, self.down_until = 0, time.time() + self.PAUSE
                    break
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
        self.kind = "map" if head[99] == 1 else "sat"        # 1 — векторные плитки, иначе картинки (снимки)
        self.minzoom, self.maxzoom = head[100], head[101]
        w, s_, e, n = struct.unpack_from("<iiii", head, 102)
        self.bounds = [w / 1e7, s_ / 1e7, e / 1e7, n / 1e7]      # запад, юг, восток, север
        try:
            if self.root_off < 127 or not 0 < self.root_len <= 4 * 1024 ** 2 or self.root_off + self.root_len > self.size:
                raise ValueError("неверный каталог PMTiles")
            self.root = self._dir(self.root_off, self.root_len)
            if not self.root:
                raise ValueError("пустой каталог PMTiles")
        except Exception:
            self.close()
            raise
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

    def __init__(self, folder, log=print, allowed=None):
        self.dir = folder
        self.allowed = frozenset(allowed) if allowed is not None else None
        if self.allowed is not None:
            self.REGIONS = {k: v for k, v in self.REGIONS.items() if k in self.allowed}
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
                if self.allowed is not None and slug not in self.allowed:
                    continue
                old = self.files.get(slug)
                try:
                    st = os.stat(full)
                    if old and old.size == st.st_size and old.mtime == int(st.st_mtime * 1000):
                        found[slug] = old
                    else:
                        candidate = PmFile(full)
                        if self.allowed is not None and candidate.kind != 'map':
                            candidate.close()
                        else:
                            found[slug] = candidate
                except Exception:
                    continue
            for slug, f in self.files.items():
                if found.get(slug) is not f:
                    f.close()
            self.files = found
            return found

    def tile(self, z, x, y, kind="map"):
        """Плитка из первого файла такого вида, где она есть: (байты, сжата ли gzip) или None."""
        if not (0 <= z <= 20 and 0 <= x < 2**z and 0 <= y < 2**z):
            return None
        if self.allowed is not None and kind != 'map':
            return None
        for f in list(self.files.values()):
            if f.kind != kind:
                continue
            try:
                data = f.tile(z, x, y)
            except Exception:
                data = None
            if data:
                return data, f.tile_comp == 2
        if kind == 'sat' and 0 <= z <= 20 and 0 <= x < 2**z and 0 <= y < 2**z:
            # Original releases skipped PNG raster tiles, including some water tiles.
            path = os.path.join(self.dir,'sat-fill',str(z),str(x),str(y)+'.tile')
            try:
                with open(path,'rb') as f:
                    data=f.read(4*1024*1024)
                if data.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8')):
                    return data, False
            except OSError:
                pass
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
            "files": [{"slug": k, "name": self.name_of(k), "size": f.size, "mtime": f.mtime, "bounds": f.bounds, "kind": f.kind, "minzoom": f.minzoom, "maxzoom": f.maxzoom}
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
            self._to_trash(slug)
        return True

    def _to_trash(self, slug, keep=2):
        """Удалённый или заменённый файл карты не стирается сразу, а уходит в map/удалённые
        (хранятся два последних): случайное удаление можно отменить, вернув файл назад."""
        trash = os.path.join(self.dir, "удалённые")
        stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        for ext in (".pmtiles", ".pmtiles.json"):
            src = os.path.join(self.dir, slug + ext)
            if not os.path.exists(src):
                continue
            try:
                os.makedirs(trash, exist_ok=True)
                os.replace(src, os.path.join(trash, "%s-%s%s" % (slug, stamp, ext)))
            except OSError:
                try:
                    os.remove(src)
                except OSError:
                    pass
        try:
            old = sorted(n for n in os.listdir(trash) if n.startswith(slug + "-") and n.endswith(".pmtiles"))
            for n in old[:-keep]:
                for ext in ("", ".json"):
                    try:
                        os.remove(os.path.join(trash, n + ext))
                    except OSError:
                        pass
        except OSError:
            pass

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
        if self.allowed is not None and slug not in self.allowed:
            raise ValueError("На ПК доступны только схемы Херсонской и Запорожской областей")
        os.makedirs(self.dir, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=self.dir, suffix=".part", delete=False) as out:
            tmp = out.name
            try:
                left = length
                while left:
                    chunk = stream.read(min(left, 1 << 20))
                    if not chunk:
                        raise ValueError("файл передан не полностью")
                    out.write(chunk)
                    left -= len(chunk)
                out.close()
                self._install(tmp, slug)
            finally:
                out.close()
                if os.path.exists(tmp):
                    os.remove(tmp)
        return slug

    def _install(self, tmp, slug):
        try:
            candidate = PmFile(tmp)
            kind = candidate.kind
            candidate.close()
            if self.allowed is not None and kind != 'map':
                raise ValueError("Для ПК требуется векторная схема")
        except (ValueError, OSError, IndexError, OverflowError, EOFError, struct.error) as e:
            raise ValueError("повреждённый файл PMTiles") from e
        with self.lock:
            old = self.files.pop(slug, None)
            if old:
                old.close()
            if os.path.exists(os.path.join(self.dir, slug + ".pmtiles")):
                self._to_trash(slug)
            os.replace(tmp, os.path.join(self.dir, slug + ".pmtiles"))
        self.scan()

    def close(self):
        self.stop()
        with self.lock:
            for pm in self.files.values():
                pm.close()
            self.files = {}

    # --- скачивание района

    def known(self, slug):
        if self.allowed is not None and slug not in self.allowed:
            return False
        return slug in self.REGIONS or (slug.endswith("-sat") and slug[:-4] in self.REGIONS)

    def start(self, slugs):
        """Скачать файлы по очереди: «kherson» — схема района, «kherson-sat» — его обзорные снимки."""
        if self.job and self.job.get("state") == "running":
            return False
        slugs = [x for x in ([slugs] if isinstance(slugs, str) else list(slugs or [])) if isinstance(x, str) and self.known(x)]
        if not slugs:
            return False
        self.cancel = False
        self.job = {"state": "running", "slug": slugs[0], "queue": slugs, "stage": "подготовка", "done": 0, "total": 0}
        threading.Thread(target=self._run, args=(slugs,), daemon=True).start()
        return True

    def stop(self):
        self.cancel = True

    def _run(self, slugs):
        os.makedirs(self.dir, exist_ok=True)
        tmp = None
        try:
            for slug in slugs:
                tmp = os.path.join(self.dir, slug + ".pmtiles.part")
                self.job.update(slug=slug, stage="подготовка", done=0, total=0)
                try:
                    self._fetch_release(slug, tmp)
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        raise
                    # готового файла нет — собираем сами
                    if slug.endswith("-sat"):
                        self.build_sat([slug[:-4]], tmp)
                    else:
                        self.extract([slug], tmp)
                self._install(tmp, slug)
                self.log("Офлайн-карта скачана: %s" % slug)
            self.job.update(state="done", stage="готово")
        except Exception as e:
            if self.cancel:
                self.job.update(state="idle", stage="отменено")
            else:
                self.job.update(state="error", error=str(e) or e.__class__.__name__)
                self.log("Офлайн-карта не скачана: %s\n%s" % (e, traceback.format_exc()))
            try:
                if tmp:
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
            except Exception as e:
                if attempt == 3 or (isinstance(e, urllib.error.HTTPError) and e.code in (403, 404)):
                    raise
                time.sleep(2 + attempt * 3)

    # --- снимки района (Sentinel-2 cloudless 2016, EOX, CC BY 4.0)

    SAT_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/%d/%d/%d.jpg"    # z, y, x
    SAT_MAXZOOM = 14          # снимки Sentinel-2 — 10 м на точку: 14-й масштаб (≈6,6 м) передаёт их полностью

    def build_sat(self, regions, path, progress=None):
        """Собрать файл снимков районов: плитки-картинки 0–14 с сервера EOX (скачивать их разрешено)."""
        job = self.job if self.job is not None else {}
        boxes = [self.REGIONS[r][1] for r in regions]
        def tx(lon, z):
            return min((1 << z) - 1, max(0, int((lon + 180) / 360 * (1 << z))))
        def ty(lat, z):
            r = math.radians(lat)
            return min((1 << z) - 1, max(0, int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (1 << z))))
        want = []
        for z in range(0, self.SAT_MAXZOOM + 1):
            seen = set()
            for (s_, w, n, e) in boxes:
                for x in range(tx(w, z), tx(e, z) + 1):
                    for y in range(ty(n, z), ty(s_, z) + 1):
                        if (x, y) not in seen:
                            seen.add((x, y))
                            want.append((z, x, y))
        def fetch(t):
            if self.cancel:
                raise IOError("отменено")
            try:
                return t, self._get(self.SAT_URL % (t[0], t[2], t[1]), timeout=60)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return t, None
                raise
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".build"
        entries, offs, pos, done = [], {}, 0, 0
        from concurrent.futures import ThreadPoolExecutor
        with open(tmp + ".data", "wb") as out, ThreadPoolExecutor(8) as pool:
            got = {}
            for t, data in pool.map(fetch, want):
                done += 1
                if done % 50 == 0 or done == len(want):
                    job.update(stage="снимки", done=done, total=len(want))
                    if progress:
                        progress("снимки, плиток", done, len(want))
                if not data or data[:2] != b"\xff\xd8":
                    continue
                key = hashlib.md5(data).digest()
                if key not in offs:
                    offs[key] = (pos, len(data))
                    out.write(data)
                    pos += len(data)
                got[self.tileid(*t)] = offs[key]
        for tid in sorted(got):
            o, ln = got[tid]
            last = entries[-1] if entries else None
            if last and last[0] + last[1] == tid and last[2] == o and last[3] == ln:
                last[1] += 1
            else:
                entries.append([tid, 1, o, ln])
        if not entries:
            os.remove(tmp + ".data")
            raise IOError("снимки не скачались")
        meta = gzip.compress(json.dumps({"attribution": "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH "
                                                        "(Contains modified Copernicus Sentinel data 2016 & 2017)"}).encode(), mtime=0)
        self._write(tmp, path, [tuple(e) for e in entries], meta, pos, len(offs), boxes, 1, 3, self.SAT_MAXZOOM)
        return {"tiles": sum(e[1] for e in entries), "bytes": os.path.getsize(path), "build": "s2cloudless-2016"}

    def _write(self, tmp, path, entries, meta, data_len, n_contents, boxes, tile_comp, tile_type, maxzoom):
        """Собрать файл PMTiles из каталога и файла данных tmp + '.data'."""
        root, leaves = self._dirs(entries)
        S, W, N, E = min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes)
        hdr = bytearray(b"PMTiles\x03")
        r_off = 127
        m_off = r_off + len(root)
        l_off = m_off + len(meta)
        d_off = l_off + len(leaves)
        hdr += struct.pack("<11Q", r_off, len(root), m_off, len(meta), l_off, len(leaves), d_off, data_len,
                           sum(e[1] for e in entries), len(entries), n_contents)
        hdr += bytes([0, 2, tile_comp, tile_type, 0, maxzoom])
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
        meta = self._get(url, meta_off, meta_len) if meta_len else gzip.compress(b"{}", mtime=0)
        n_tiles = sum(e[1] for e in entries)
        self._write(tmp, path, [tuple(e) for e in entries], meta, pos, len(newoff), boxes, tile_comp, tile_type, self.MAXZOOM)
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
            self.send_header("X-Frame-Options", "DENY")
            if getattr(app, 'restarting', False):
                self.close_connection = True
                self.send_header('Connection', 'close')
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
            if getattr(app, 'restarting', False):
                raise HttpError(503, 'Программа переключает режим подключения')
            if getattr(app, 'shared', None):
                from shared import SharedError
                origin = self.headers.get('Origin')
                if origin and self.command == 'POST' and urllib.parse.urlsplit(origin).netloc.lower() != (self.headers.get('Host') or '').lower():
                    raise HttpError(403, 'Запрос с чужой страницы отклонён')
                route = urllib.parse.urlsplit(self.path).path
                if route in ('/login', '/api/login'):
                    return
                host = (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
                if getattr(app, 'allow_local_admin', False) and self.client_address[0] in ('127.0.0.1', '::1') and host in ('localhost', '127.0.0.1', '::1') and not (self.headers.get('Forwarded') or self.headers.get('X-Forwarded-For')):
                    self.shared_user = dict(login='@server', name=app.local_name, role='admin')
                    self.shared_token = ''
                    with app.shared.lock:
                        before = getattr(app.shared, 'local_presence', None)
                        app.shared.local_presence = (self.shared_user, time.time())
                        if not before or time.time() - before[1] >= 15:
                            app.shared.changed.notify_all()
                else:
                    try:
                        self.shared_user, self.shared_token = app.shared.identify(self.headers.get('Cookie'))
                    except SharedError as e:
                        raise HttpError(e.status, e.message)
                if self.command == 'POST' and route not in ('/api/shared', '/api/users', '/api/logout', '/api/map', '/api/mapupload', '/api/access', '/api/elev', '/api/backups'):
                    raise HttpError(403, 'Действие недоступно в совместном режиме')
                return
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
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n < 0:
                    raise ValueError()
            except ValueError:
                self.close_connection = True
                raise HttpError(400, 'Неверная длина запроса')
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
                if getattr(app, 'shared', None) and path == '/login':
                    with open(os.path.join(WEB, 'login.html'), 'rb') as f:
                        self._send(200, f.read(), 'text/html; charset=utf-8', {'Cache-Control': 'no-store'})
                elif getattr(app, 'shared', None) and path.startswith('/api/'):
                    self._shared_api(path[5:])
                elif path.startswith("/api/"):
                    self._api(path[5:])
                elif self.command in ("GET", "HEAD"):
                    self._static(urllib.parse.unquote(path))
                else:
                    raise HttpError(405, "Метод не поддерживается")
            except HttpError as e:
                if e.status == 401 and self.command == 'GET' and not path.startswith('/api/'):
                    return self._send(303, extra={'Location': '/login', 'Cache-Control': 'no-store'})
                self._json({"error": e.message}, e.status)
            except (BrokenPipeError, ConnectionError, TimeoutError):
                self.close_connection = True
            except Exception:
                app.log("Ошибка %s %s\n%s" % (self.command, path, traceback.format_exc()))
                try:
                    self._json({"error": "Внутренняя ошибка программы"}, 500)
                except Exception:
                    self.close_connection = True

        def _shared_api(self, route):
            from shared import SharedError
            try:
                shared = app.shared
                if route == 'login' and self.command == 'POST':
                    token = shared.login(self._body(16 * 1024), self.client_address[0])
                    return self._json({'ok': True}, extra={'Set-Cookie': 'karta_session=' + token + '; HttpOnly; SameSite=Strict; Path=/'})
                if route == 'logout' and self.command == 'POST':
                    self._body(1024)
                    shared.logout(self.shared_token)
                    return self._json({'ok': True}, extra={'Set-Cookie': 'karta_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict'})
                user = self.shared_user
                owner = user['login'] == '@server'   # сам серверный компьютер
                if route == 'access':
                    if user['role'] != 'admin':
                        raise HttpError(403, 'Только администратор может управлять удалённым доступом')
                    if self.command == 'POST' and not owner:
                        raise HttpError(403, 'Включать и выключать удалённый доступ можно только на серверном компьютере')
                    return self._api(route)
                if route == 'elev' and self.command == 'POST':
                    return self._api(route)
                if route == 'backups' and user['role'] == 'admin':
                    if self.command == 'POST':
                        b = self._body(4096)
                        if not isinstance(b, dict) or not b.get('restore'):
                            raise HttpError(400, 'Неверный запрос')
                        return self._json(shared.restore(user, b['restore']))
                    return self._json({'backups': shared.list_backups()})
                if route == 'shared':
                    if self.command == 'GET':
                        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                        revision = query.get('revision', [None])[0]
                        try:
                            wait = float(query.get('wait', ['0'])[0])
                        except ValueError:
                            wait = 0
                        if wait > 0 and revision is not None and not getattr(app, 'restarting', False):
                            # длинный опрос: ответ приходит сразу после чужой правки
                            return self._json(shared.wait(user, revision, wait))
                        return self._json(shared.snapshot(user, revision))
                    if self.command == 'POST':
                        body = self._body()
                        if getattr(app, 'restarting', False):
                            raise HttpError(503, 'Программа переключает режим подключения')
                        result, status = shared.apply(user, body)
                        return self._json(result, status)
                if route == 'users' and user['role'] == 'admin':
                    if self.command == 'POST':
                        shared.set_user(self._body(16 * 1024), local_owner=user['login'] == '@server')
                    with shared.lock:
                        return self._json({'users': [shared.public(u) for u in shared.users.values()]})
                if route == 'state' and self.command == 'GET':
                    return self._json({'karta_net': json.dumps(shared.snapshot(user)['net'], ensure_ascii=False), 'karta_author': user['name']}, extra={'X-Karta-Shared': '1'})
                if route in ('map', 'info') and self.command == 'GET':
                    return self._api(route)
                if route in ('map', 'mapupload') and self.command == 'POST' and user['role'] == 'admin':
                    if not owner:
                        raise HttpError(403, 'Файлы карты меняются только на серверном компьютере')
                    return self._api(route)
                raise HttpError(403, 'Нет доступа к этому действию')
            except SharedError as e:
                raise HttpError(e.status, e.message)

        def _api(self, route):
            if route == 'access':
                if self.command == 'GET':
                    return self._json(dict(enabled=bool(getattr(app, 'shared', None)), addresses=['http://%s:%s/' % (ip, app.port) for ip in app.addresses]))
                if self.command == 'POST':
                    data = self._body(1024)
                    if not isinstance(data, dict) or not isinstance(data.get('enabled'), bool) or not getattr(app, 'change_access', None):
                        raise HttpError(400, 'Неверная настройка удалённого доступа')
                    app.change_access(data['enabled'])
                    self._json(dict(ok=True))
                    threading.Timer(.6, app.quit).start()
                    return
            if route == "state" and self.command == "GET":
                data = app.state.load()
                if data is None:
                    return self._json({}, extra={"X-State": "none"})
                return self._json(data)
            if route == "state" and self.command == "POST":
                data = self._body()
                if getattr(app, 'restarting', False):
                    raise HttpError(503, 'Программа переключает режим подключения')
                patch = 'patch=1' in (urllib.parse.urlsplit(self.path).query or '')
                if not isinstance(data, dict) or not all(isinstance(k, str) and (isinstance(v, str) or (patch and v is None)) for k, v in data.items()):
                    raise HttpError(400, "Неверные данные")
                # массовое удаление (замена карты файлом, откат) — сначала снимок прежней карты
                from shared import write_snapshot
                old = app.state.load() or {}
                if patch:       # 3.5: изменились отдельные ключи (null — ключ удалён)
                    merged = dict(old)
                    for k, v in data.items():
                        if v is None:
                            merged.pop(k, None)
                        else:
                            merged[k] = v
                    data = merged
                if old.get("karta_net") and old.get("karta_net") != data.get("karta_net") and \
                        counted(data.get("karta_net", "")) <= counted(old["karta_net"]) - 5:
                    try:
                        write_snapshot(os.path.join(app.data_dir, "backups"), old, "mass")
                    except OSError as e:
                        app.log("Не удалось сохранить снимок перед массовой правкой: %s" % e)
                app.state.save(data)
                return self._json({"ok": True})
            if route == "elev" and self.command == "POST":
                b = self._body(limit=1024 * 1024)
                if not isinstance(b, dict):
                    raise HttpError(400, "Неверный запрос")
                return self._json(fetch_elevations(app.dem, str(b.get("locs") or ""), bool(b.get("online")) and not app.offline_only))
            if route == "map" and self.command == "GET":
                return self._json(app.offline.status())
            if route == "map" and self.command == "POST":
                b = self._body(limit=64 * 1024)
                if not isinstance(b, dict):
                    raise HttpError(400, "Неверный запрос")
                if b.get("download"):
                    return self._json({"ok": app.offline.start(b["download"])})
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
            if app.offline_only and rel.startswith(('tiles/', 'tc/', 'osat/')):
                raise HttpError(404, 'В этой версии используется только офлайн-схема')
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
            m = re.match(r"^osat/(\d+)/(\d+)/(\d+)\.jpg$", rel)
            if m:
                # плитка загруженных обзорных снимков
                got = app.offline.tile(int(m.group(1)), int(m.group(2)), int(m.group(3)), "sat")
                if got is None:
                    return self._send(404, b"", "text/plain")
                return self._send(200, got[0], "image/png" if got[0].startswith(b'\x89PNG') else "image/jpeg", {"Cache-Control": "no-cache"})
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
                if getattr(app, 'shared', None):
                    inject = tag + '\n<script>window.KartaSharedMode=true;</script>\n<script src="pc.js?v=%s"></script>' % VERSION
                    inject += '\n<script src="shared.js?v=%s"></script>' % VERSION
                inject += '\n<script src="access.js?v=%s"></script>' % VERSION
                html = html.replace(tag, inject, 1) if tag in html else html.replace("<head>", "<head>\n" + inject, 1)
                # подробная схема и граница левобережья — общие с приложением (3.5): в index.html они уже есть,
                # ПК лишь добавляет версию, чтобы после обновления не взять старое из кэша браузера
                for extra in ('vendor/offline-style-pc.js', 'vendor/coverage-pc.js'):
                    plain = '<script src="%s"></script>' % extra
                    if plain in html:
                        html = html.replace(plain, '<script src="%s?v=%s"></script>' % (extra, VERSION), 1)
                    else:
                        style_tag = '<script src="vendor/offline-style.js"></script>'
                        html = html.replace(style_tag, style_tag + '\n<script src="%s?v=%s"></script>' % (extra, VERSION), 1)
                # значок окна — тот же, что у приложения на телефоне
                html = html.replace("</head>", '<link rel="stylesheet" href="desktop.css?v=%s">\n' % VERSION + '<link rel="icon" type="image/png" sizes="192x192" href="icon.png">\n'
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
        self.port = PORT
        self.addresses = []
        import socket
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(('192.0.2.1', 9))  # route lookup only; no packets are sent
                ip = probe.getsockname()[0]
                if not ip.startswith(('127.', '0.')):
                    self.addresses = [ip]
        except OSError:
            pass
        self.data_dir = data_dir
        self.state = State(data_dir)
        self.tiles = Tiles(enabled=False)
        self.tilecache = TileCache(data_dir, self.state)
        self.offline_only = True
        self.tilecache.offline_only = True
        self.quit = None
        self.log = log
        self.offline = OfflineMap(os.environ.get("KARTA_MAP_DIR") or os.path.join(ROOT, "map"), log,
                                  allowed=('karta-offline', 'kherson', 'zaporozhye'))
        try:
            self.dem = Dem(os.path.join(WEB, "dem", "dem.bin"))
        except Exception as e:
            log("Не удалось прочитать рельеф dem.bin: %s" % e)
            self.dem = None

    def close(self):
        self.offline.close()
        if self.tiles.zip is not None:
            self.tiles.zip.close()


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


def backup_once(data_dir, state=None, hourly_keep=72, daily_keep=30, now=None):
    """Копии data/state.json и data/shared-users.json в data/backups.

    Каждый час, если карта изменилась, — state-ГГГГ-ММ-ДД_ЧЧ.json (последние 72), плюс первая копия
    за день — state-ГГГГ-ММ-ДД.json (последние 30). Так же для учётных записей (users-…)."""
    folder = os.path.join(data_dir, "backups")
    os.makedirs(folder, exist_ok=True)
    now = now or time.localtime()
    made = []
    for prefix, src in (("state", "state.json"), ("users", "shared-users.json")):
        path = os.path.join(data_dir, src)
        if prefix == "state" and state is not None:
            data = state.read_bytes()
        else:
            try:
                with open(path, "rb") as f:
                    data = f.read()
            except FileNotFoundError:
                data = None
        if not data:
            continue
        hourly = re.compile(r"^%s-\d{4}-\d{2}-\d{2}_\d{2}\.json$" % prefix)
        daily = re.compile(r"^%s-\d{4}-\d{2}-\d{2}\.json$" % prefix)
        names = sorted(os.listdir(folder))
        last = [n for n in names if hourly.match(n)]
        changed = True
        if last:
            try:
                with open(os.path.join(folder, last[-1]), "rb") as f:
                    changed = f.read() != data
            except OSError:
                pass
        h = "%s-%s.json" % (prefix, time.strftime("%Y-%m-%d_%H", now))
        if changed and not os.path.exists(os.path.join(folder, h)):
            atomic_write(os.path.join(folder, h), data)
            made.append(h)
        d = "%s-%s.json" % (prefix, time.strftime("%Y-%m-%d", now))
        if not os.path.exists(os.path.join(folder, d)):
            atomic_write(os.path.join(folder, d), data)
            made.append(d)
        names = sorted(os.listdir(folder))
        for pattern, keep in ((hourly, hourly_keep), (daily, daily_keep)):
            old = [n for n in names if pattern.match(n)]
            for name in old[:-keep] if keep else old:
                try:
                    os.remove(os.path.join(folder, name))
                except OSError:
                    pass
    return made


def backup_loop(data_dir, log, keep=30, stop=None, state=None):
    """Раз в час — резервные копии карты и учётных записей (см. backup_once)."""
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            backup_once(data_dir, state, daily_keep=keep)
        except Exception as e:
            log("Не удалось сделать резервную копию: %s" % e)
        stop.wait(3600)


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
                # слово состояния переводится («ПРОСЛУШИВАНИЕ»), поэтому слушающий порт узнаём по пустому удалённому адресу
                if len(parts) >= 5 and parts[1].endswith(":%d" % port) and parts[2] in ("0.0.0.0:0", "[::]:0", "*:*"):
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
    shortcut = os.path.basename(ROOT) or "Карта сети"
    script = (
        "$d=[Environment]::GetFolderPath('Desktop');"
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d %s));"
        "$s.TargetPath=%s;$s.WorkingDirectory=%s;$s.IconLocation=%s;$s.WindowStyle=7;"
        "$s.Description='Карта сети';$s.Save()"
    ) % tuple("'" + v.replace("'", "''") + "'" for v in (
        shortcut + ".lnk", os.path.join(ROOT, "Карта сети.bat"), ROOT, os.path.join(WEB, "favicon.ico") + ",0"))
    try:
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                       check=True, timeout=30, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
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
    ap.add_argument("--port", type=int, default=None, help="порт (по умолчанию %d; выбранный запоминается)" % PORT)
    ap.add_argument("--data", help="папка с данными")
    ap.add_argument("--no-window", action="store_true")
    ap.add_argument('--shared', action='store_true', help='совместная работа по IP и порту с входом пользователей')
    ap.add_argument("--offline-map", nargs="+", metavar="РАЙОН",
                    help="вырезать офлайн-карту районов (%s) в файл --map-file и выйти" % ", ".join(OfflineMap.REGIONS))
    ap.add_argument("--offline-sat", nargs="+", metavar="РАЙОН", help="собрать файл снимков районов (Sentinel-2) в --map-file и выйти")
    ap.add_argument("--map-file", help="куда сохранить офлайн-карту (для --offline-map и --offline-sat)")
    args = ap.parse_args()
    if args.port is not None and not 1 <= args.port <= 65535:
        ap.error('Порт должен быть от 1 до 65535')
    sat = args.offline_sat is not None
    if sat:
        args.offline_map = args.offline_sat
    if args.offline_map is not None:
        bad = [r for r in args.offline_map if r not in OfflineMap.REGIONS]
        if bad:
            print("Нет такого района: %s. Есть: %s" % (", ".join(bad), ", ".join(OfflineMap.REGIONS)))
            return 2
        out = os.path.abspath(args.map_file or os.path.join(ROOT, "map", args.offline_map[0] + ("-sat" if sat else "") + ".pmtiles"))
        om = OfflineMap(os.path.dirname(out))
        last = [0]
        def show(text, done, total):
            if time.time() - last[0] > 3 or done == total:
                last[0] = time.time()
                print("  %s %s" % (text, ("%d из %d" % (done, total) if sat else "%d из %d МБ" % (done >> 20, total >> 20)) if total else ""), flush=True)
        r = om.build_sat(args.offline_map, out, progress=show) if sat else om.extract(args.offline_map, out, progress=show)
        print("Готово: %(tiles)d плиток, %(bytes)d байт, сборка %(build)s" % r)
        return 0

    data_dir = os.path.abspath(args.data or os.path.join(ROOT, "data"))
    os.makedirs(data_dir, exist_ok=True)
    from shared import DataLock
    try:
        data_lock = DataLock(data_dir)
    except OSError:
        if not args.no_window:
            try:
                with open(os.path.join(data_dir, 'desktop-instance.json'), encoding='utf-8') as f:
                    active = json.load(f)
                active_url = 'http://127.0.0.1:%d/' % int(active['port'])
                with urllib.request.urlopen(active_url + 'api/info', timeout=3) as r:
                    info = json.load(r)
                if info.get('app') == 'karta-seti':
                    print('Программа уже запущена, открываю её окно.')
                    open_window(active_url)
                    return 0
            except (OSError, ValueError, KeyError, TypeError):
                pass
        print('Эта папка данных уже используется запущенной программой. Закройте её перед сменой режима или порта.')
        return 1
    with data_lock:
        config_path = os.path.join(data_dir, 'remote-access.json')
        config = {}
        try:
            with open(config_path, encoding='utf-8') as f:
                config = json.load(f)
            if not isinstance(config, dict):
                config = {}
        except (OSError, ValueError):
            pass
        args.shared = args.shared or bool(config.get('enabled'))
        if args.port is None:
            saved = config.get('port')
            args.port = saved if isinstance(saved, int) and 1 <= saved <= 65535 else PORT
        while True:
            result = serve_desktop(args, data_dir)
            if result != 'restart':
                return result
            args.no_window = True


def serve_desktop(args, data_dir):
    log = Log(os.path.join(data_dir, "program.log"))
    url = "http://%s:%d/" % (HOST, args.port)
    the_app = App(data_dir, log)
    the_app.port = args.port
    the_app.allow_local_admin = True
    the_app.local_name = (the_app.state.load() or {}).get('karta_author') or 'Владелец'
    if the_app.local_name.strip().lower() in ('компьютер','телефон','браузер','серверный компьютер'):
        the_app.local_name = 'Владелец'
    restart = [False]
    def save_access(enabled):
        path = os.path.join(data_dir, 'remote-access.json')
        atomic_write(path, json.dumps(dict(enabled=enabled, port=args.port)))
    def change_access(enabled):
        save_access(enabled)
        args.shared = enabled
        restart[0] = True
        the_app.restarting = True
        if getattr(the_app, 'shared', None):
            the_app.shared.notify()   # отпустить окна, ждущие правок, — они переподключатся к новому режиму
    the_app.change_access = change_access
    def resolve_addresses():
        import socket
        try:
            ips = {a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET) if not a[4][0].startswith(('127.', '169.254.'))}
            the_app.addresses = sorted(set(the_app.addresses) | ips)
        except OSError:
            pass
    threading.Thread(target=resolve_addresses, daemon=True).start()
    if args.shared:
        from shared import Shared
        the_app.shared = Shared(the_app.state, data_dir)
        print('Совместная работа. На серверном компьютере вход без пароля. Учётные записи для удалённых пользователей — в программе.')
    listen_host = '0.0.0.0' if args.shared else HOST
    try:
        server = Server((listen_host, args.port), make_handler(the_app))
    except OSError:
        server = None
        if not args.shared and replace_old(args.port):
            try:
                server = Server((HOST, args.port), make_handler(the_app))
            except OSError:
                server = None
        if server is None:
            if args.shared:
                the_app.close()
                print('Порт занят. Закройте прежнюю копию или укажите другой --port.')
                return 1
            print("Программа уже запущена, открываю её окно.")
            if not args.no_window:
                open_window(url)
            return 0
    the_app.quit = server.shutdown
    atomic_write(os.path.join(data_dir, 'desktop-instance.json'), json.dumps(dict(port=args.port, pid=os.getpid())))
    save_access(args.shared)
    backup_stop = threading.Event()
    threading.Thread(target=backup_loop, args=(data_dir, log), kwargs={'stop': backup_stop, 'state': the_app.state}, daemon=True).start()
    threading.Thread(target=the_app.tilecache.prune, daemon=True).start()
    if not args.no_window and not args.shared:
        threading.Thread(target=make_shortcut, args=(data_dir, log), daemon=True).start()
    print()
    print("  Карта сети %s (основа — «WiFi Френель»)" % VERSION)
    print("  Данные: %s" % os.path.join(data_dir, "state.json"))
    print("  Окно программы: %s" % url)
    print("  Доступ по сети: http://IP-компьютера:%d/" % args.port if args.shared else "  Работает только на этом компьютере.")
    if args.shared:
        for ip in the_app.addresses:
            print('  Адрес для пользователей: http://%s:%d/' % (ip, args.port))
    print()
    log("Программа запущена")
    if not args.no_window:
        threading.Timer(0.6, open_window, args=(url,)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        backup_stop.set()
        server.server_close()
        the_app.close()
        log("Программа остановлена")
    return 'restart' if restart[0] else 0


if __name__ == "__main__":
    sys.exit(main())
