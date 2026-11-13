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
import json
import math
import mimetypes
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
HOST = "127.0.0.1"
PORT = 8790
VERSION = "2.0"

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


# ------------------------------------------------------------------ сервер

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
            if route == "info":
                return self._json({"app": "karta-seti", "version": VERSION})
            raise HttpError(404, "Нет такого адреса")

        def _static(self, path):
            rel = path.lstrip("/") or "index.html"
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
                body = html.encode("utf-8")
            if ctype.startswith("text/") or ctype in ("application/json", "text/javascript"):
                ctype += "; charset=utf-8"
            cache = "max-age=86400" if rel.startswith(("tiles/", "leaflet/")) else "no-cache"
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
        self.log = log
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
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data or os.path.join(ROOT, "data"))
    os.makedirs(data_dir, exist_ok=True)
    log = Log(os.path.join(data_dir, "program.log"))
    url = "http://%s:%d/" % (HOST, args.port)
    try:
        server = Server((HOST, args.port), make_handler(App(data_dir, log)))
    except OSError:
        print("Программа уже запущена, открываю её окно.")
        if not args.no_window:
            open_window(url)
        return 0
    threading.Thread(target=backup_loop, args=(data_dir, log), daemon=True).start()
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
