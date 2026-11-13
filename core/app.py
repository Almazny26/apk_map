# -*- coding: utf-8 -*-
"""HTTP-сервер «Карты сети»: API, поток событий в реальном времени и раздача клиента.

Только стандартная библиотека Python. Изменения клиентам рассылаются через Server-Sent Events:
это обычный долгий HTTP-ответ, он проходит через мобильные сети и прокси без особых условий.
"""
import json
import mimetypes
import os
import queue
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from .store import OpError, ROLES

SERVER_VERSION = "1.3"
MAX_BODY = 64 * 1024 * 1024   # файлы изменений от бригад приходят одним запросом
MAX_OPS_PER_REQUEST = 500

mimetypes.add_type("application/vnd.android.package-archive", ".apk")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


class Hub:
    """Подписчики потока событий. У каждого своя очередь, пишет в сокет поток его запроса."""

    def __init__(self):
        self.lock = threading.Lock()
        self.subs = []

    def subscribe(self, user):
        sub = {"user": user, "q": queue.Queue(maxsize=2000), "since": time.time()}
        with self.lock:
            self.subs.append(sub)
        self.broadcast_presence()
        return sub

    def unsubscribe(self, sub):
        with self.lock:
            if sub in self.subs:
                self.subs.remove(sub)
        self.broadcast_presence()

    def online(self):
        with self.lock:
            names = {}
            for s in self.subs:
                names[s["user"]["id"]] = s["user"]["name"]
        return [{"id": k, "name": v} for k, v in sorted(names.items(), key=lambda kv: kv[1].lower())]

    def broadcast(self, event, payload, only_admins=False):
        msg = ("event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))).encode("utf-8")
        with self.lock:
            targets = list(self.subs)
        for s in targets:
            if only_admins and s["user"]["role"] != "admin":
                continue
            try:
                s["q"].put_nowait(msg)
            except queue.Full:
                # клиент не успевает читать — закрываем поток, он переподключится и догонит изменения
                self._drop(s)

    def broadcast_presence(self):
        self.broadcast("presence", {"online": self.online()})

    def _drop(self, sub):
        try:
            while True:
                sub["q"].get_nowait()
        except queue.Empty:
            pass
        sub["q"].put(None)

    def kick_user(self, user_id):
        """Закрывает потоки пользователя (его отключили или сменили пароль)."""
        with self.lock:
            targets = [s for s in self.subs if s["user"]["id"] == user_id]
        for s in targets:
            self._drop(s)

    def update_user(self, user):
        with self.lock:
            for s in self.subs:
                if s["user"]["id"] == user["id"]:
                    s["user"] = user


class LoginGuard:
    """Защита от подбора пароля: после 5 неудач подряд адрес ждёт минуту, дальше — дольше."""

    def __init__(self):
        self.lock = threading.Lock()
        self.fails = {}

    def wait_seconds(self, key):
        with self.lock:
            rec = self.fails.get(key)
            if not rec:
                return 0
            return max(0, int(rec["until"] - time.time()))

    def fail(self, key):
        with self.lock:
            rec = self.fails.setdefault(key, {"n": 0, "until": 0})
            rec["n"] += 1
            if rec["n"] >= 5:
                rec["until"] = time.time() + min(60 * (2 ** (rec["n"] - 5)), 3600)
            if len(self.fails) > 5000:
                self.fails.clear()

    def ok(self, key):
        with self.lock:
            self.fails.pop(key, None)


class App:
    """Всё, что нужно обработчику запросов: хранилище, подписчики, каталоги."""

    def __init__(self, store, web_dir, apk_dir, title="Карта сети", log=None, local=False, operator="Диспетчер",
                 backup_dir=None):
        self.store = store
        # Локальный режим (с 1.3): программа работает только на этом компьютере, без входа и без сети.
        # Телефоны с ней не соединяются — обмен идёт файлами.
        self.local = local
        self.operator = operator
        self.backup_dir = backup_dir
        self.web_dir = os.path.abspath(web_dir)
        self.apk_dir = os.path.abspath(apk_dir)
        self.title = title
        self.hub = Hub()
        self.guard = LoginGuard()
        # Применение правок и рассылка идут под одной блокировкой: события уходят клиентам
        # строго в порядке ревизий, и клиент может считать «получил rev N» как «получил всё до N».
        self.ops_lock = threading.Lock()
        self.log = log or (lambda *a: None)
        self.started = time.time()

    def apk_info(self):
        try:
            with open(os.path.join(self.apk_dir, "version.json"), "r", encoding="utf-8") as f:
                info = json.load(f)
            if os.path.exists(os.path.join(self.apk_dir, "karta-seti.apk")):
                return {
                    "versionCode": info.get("versionCode"),
                    "versionName": info.get("versionName"),
                    "built": info.get("built"),
                    "url": "/apk/karta-seti.apk",
                }
        except Exception:
            pass
        return None


class HttpError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "KartaSeti/" + SERVER_VERSION
        timeout = 75  # простаивающее соединение закрывается, поток освобождается

        # ---------------------------------------------------------------- ввод-вывод

        def log_message(self, fmt, *args):
            pass  # стандартный построчный лог запросов не нужен; ошибки пишем сами

        def _cors(self):
            if app.local:
                return  # в локальном режиме чужим страницам в браузере доступ к программе не даём
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            self.send_header("Access-Control-Max-Age", "86400")

        def _send(self, status, body=b"", ctype="application/json; charset=utf-8", extra=None):
            self.send_response(status)
            self._cors()
            if body or status not in (204, 304):
                self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, payload, status=200):
            self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       extra={"Cache-Control": "no-store"})

        def _body(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise HttpError(400, "bad_request", "Неверный запрос")
            if length > MAX_BODY:
                self.close_connection = True
                raise HttpError(413, "too_large", "Слишком большой запрос")
            raw = self.rfile.read(length) if length else b""
            if not raw:
                return {}
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                raise HttpError(400, "bad_json", "Неверный формат данных")
            if not isinstance(data, dict):
                raise HttpError(400, "bad_json", "Неверный формат данных")
            return data

        def _token(self, query):
            auth = self.headers.get("Authorization") or ""
            if auth.lower().startswith("bearer "):
                return auth[7:].strip()
            return (query.get("token") or [""])[0]

        def _local_guard(self, method):
            """Защита локальной программы от чужих страниц, открытых в том же браузере."""
            host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
            if host not in ("127.0.0.1", "localhost", "::1"):
                raise HttpError(403, "forbidden", "Программа доступна только на этом компьютере")
            origin = self.headers.get("Origin")
            if origin and method != "GET":
                o = urlsplit(origin).hostname or ""
                if o.lower() not in ("127.0.0.1", "localhost", "::1"):
                    raise HttpError(403, "forbidden", "Запрос с чужой страницы отклонён")

        def _user(self, query, role=None):
            if app.local:
                return {"id": None, "login": "local", "name": app.operator, "role": "admin"}, ""
            token = self._token(query)
            user = app.store.auth(token)
            if not user:
                raise HttpError(401, "unauthorized", "Нужно войти заново")
            if role == "admin" and user["role"] != "admin":
                raise HttpError(403, "forbidden", "Нужны права администратора")
            if role == "editor" and user["role"] not in ("admin", "editor"):
                raise HttpError(403, "forbidden", "У вас доступ только на просмотр")
            return user, token

        # ---------------------------------------------------------------- маршруты

        def do_OPTIONS(self):
            self._send(204)

        def do_HEAD(self):
            self._dispatch("GET")

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_PATCH(self):
            self._dispatch("PATCH")

        def _dispatch(self, method):
            parts = urlsplit(self.path)
            path = parts.path
            query = parse_qs(parts.query)
            try:
                if app.local:
                    self._local_guard(method)
                if path.startswith("/api/"):
                    self._api(method, path[5:], query)
                elif method == "GET":
                    self._static(path)
                else:
                    raise HttpError(405, "method", "Метод не поддерживается")
            except HttpError as e:
                self._json({"error": e.message, "code": e.code}, e.status)
            except OpError as e:
                self._json({"error": e.message, "code": e.code}, 400)
            except (BrokenPipeError, ConnectionError, TimeoutError):
                self.close_connection = True
            except Exception:
                app.log("Ошибка при обработке %s %s\n%s" % (method, path, traceback.format_exc()))
                try:
                    self._json({"error": "Внутренняя ошибка сервера", "code": "server"}, 500)
                except Exception:
                    self.close_connection = True

        def _api(self, method, route, query):
            store = app.store

            if route == "info" and method == "GET":
                return self._json({
                    "app": "karta-seti",
                    "title": app.title,
                    "local": app.local,
                    "operator": app.operator if app.local else None,
                    "map_id": store.map_id(),
                    "version": SERVER_VERSION,
                    "time": time.time(),
                    "apk": app.apk_info(),
                })

            if route == "login" and method == "POST":
                body = self._body()
                key = self.client_address[0]
                wait = app.guard.wait_seconds(key)
                if wait:
                    raise HttpError(429, "too_many", "Слишком много неудачных попыток. Повторите через %d с" % wait)
                found = store.login(body.get("login"), body.get("password"), body.get("device") or "")
                if not found:
                    app.guard.fail(key)
                    app.log("Неудачный вход: логин «%s», адрес %s" % (str(body.get("login"))[:40], key))
                    raise HttpError(401, "bad_login", "Неверный логин или пароль")
                app.guard.ok(key)
                token, user = found
                app.log("Вход: %s (%s), адрес %s" % (user["name"], user["login"], key))
                return self._json({"token": token, "user": user})

            if route == "logout" and method == "POST":
                user, token = self._user(query)
                store.logout(token)
                return self._json({"ok": True})

            if route == "me" and method == "GET":
                user, _ = self._user(query)
                return self._json({"user": user})

            if route == "password" and method == "POST":
                user, token = self._user(query)
                body = self._body()
                store.change_own_password(user["id"], body.get("old"), body.get("new"), token)
                return self._json({"ok": True})

            if route == "snapshot" and method == "GET":
                user, _ = self._user(query)
                snap = store.snapshot()
                snap["settings"] = store.get_settings()
                snap["user"] = user
                snap["online"] = app.hub.online()
                return self._json(snap)

            if route == "changes" and method == "GET":
                user, _ = self._user(query)
                try:
                    since = int((query.get("since") or ["0"])[0])
                except ValueError:
                    raise HttpError(400, "bad_request", "Неверный номер ревизии")
                out = store.changes_since(since)
                out["settings"] = store.get_settings()
                out["user"] = user
                out["online"] = app.hub.online()
                return self._json(out)

            if route == "ops" and method == "POST":
                user, _ = self._user(query, role="editor")
                ops = self._body().get("ops")
                if not isinstance(ops, list) or len(ops) > MAX_OPS_PER_REQUEST:
                    raise HttpError(400, "bad_request", "Неверный список правок")
                ops = [o for o in ops if isinstance(o, dict)]
                with app.ops_lock:
                    results, changed, rev = store.apply_ops(user, ops)
                    if changed:
                        app.hub.broadcast("change", {"rev": rev, "objects": changed})
                return self._json({"results": results, "rev": rev})

            if route == "map/export" and method == "GET":
                self._user(query)
                pkg = store.export_map(app.title)
                app.log("Экспорт карты для бригад: %d объектов, ревизия %d" % (len(pkg["objects"]), pkg["rev"]))
                return self._json(pkg)

            if route == "changes/preview" and method == "POST":
                self._user(query, role="editor")
                files = self._body().get("files")
                if not isinstance(files, list):
                    raise HttpError(400, "bad_request", "Нет файлов")
                pkgs = [f for f in files if isinstance(f, dict)]
                return self._json({"files": store.preview_changes(pkgs), "total_new": store.count_new_ops(pkgs)})

            if route == "changes/import" and method == "POST":
                self._user(query, role="editor")
                files = self._body().get("files")
                if not isinstance(files, list):
                    raise HttpError(400, "bad_request", "Нет файлов")
                files = [f for f in files if isinstance(f, dict)]
                if app.backup_dir:
                    # перед загрузкой чужих правок — копия базы, чтобы можно было вернуться
                    os.makedirs(app.backup_dir, exist_ok=True)
                    store.backup(os.path.join(app.backup_dir, "netmap-before-import-%s.db" % time.strftime("%Y-%m-%d_%H-%M-%S")))
                with app.ops_lock:
                    report = store.import_changes(files)
                    if report["changed"]:
                        app.hub.broadcast("change", {"rev": report["rev"], "objects": report["changed"]})
                app.log("Импорт изменений: файлов %d, применено %d, уже было %d, отклонено %d" % (
                    len(files), report["applied"], report["already"], len(report["rejected"])))
                report["changed"] = len(report["changed"])
                return self._json(report)

            if route == "events" and method == "GET":
                user, _ = self._user(query)
                return self._events(user)

            if route == "journal" and method == "GET":
                self._user(query)
                return self._json({"entries": store.journal(
                    limit=(query.get("limit") or [100])[0],
                    before=(query.get("before") or [None])[0],
                    obj_id=(query.get("obj") or [None])[0],
                )})

            if route == "settings" and method == "PUT":
                self._user(query, role="admin")
                settings = store.set_settings(self._body())
                app.hub.broadcast("settings", settings)
                return self._json(settings)

            if route == "users" and method == "GET":
                self._user(query, role="admin")
                online = {u["id"] for u in app.hub.online()}
                users = store.list_users()
                for u in users:
                    u["online"] = u["id"] in online
                return self._json({"users": users})

            if route == "users" and method == "POST":
                admin, _ = self._user(query, role="admin")
                b = self._body()
                user = store.create_user(b.get("login"), b.get("name"), b.get("role") or "editor", b.get("password"))
                app.log("%s создал пользователя %s (%s)" % (admin["name"], user["login"], user["role"]))
                return self._json({"user": user})

            if route.startswith("users/") and method == "PATCH":
                admin, _ = self._user(query, role="admin")
                try:
                    uid = int(route[6:])
                except ValueError:
                    raise HttpError(404, "not_found", "Пользователь не найден")
                b = self._body()
                role = b.get("role")
                if role is not None and role not in ROLES:
                    raise HttpError(400, "bad_value", "Неизвестная роль")
                user, kick = store.update_user(
                    uid,
                    name=b.get("name"),
                    role=role,
                    active=b.get("active") if isinstance(b.get("active"), bool) else None,
                    password=b.get("password"),
                )
                if kick:
                    app.hub.kick_user(uid)
                else:
                    app.hub.update_user(user)
                app.log("%s изменил пользователя %s" % (admin["name"], user["login"]))
                return self._json({"user": user})

            raise HttpError(404, "not_found", "Нет такого адреса")

        # ---------------------------------------------------------------- поток событий

        def _events(self, user):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            sub = app.hub.subscribe(user)
            try:
                hello = {"rev": app.store.current_rev(), "user": user, "online": app.hub.online()}
                self.wfile.write(("retry: 4000\nevent: hello\ndata: %s\n\n" % json.dumps(hello, ensure_ascii=False))
                                 .encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        msg = sub["q"].get(timeout=20)
                    except queue.Empty:
                        msg = b": ping\n\n"  # не даём промежуточным узлам закрыть «молчащее» соединение
                    if msg is None:
                        break
                    self.wfile.write(msg)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionError, TimeoutError, OSError):
                pass
            finally:
                app.hub.unsubscribe(sub)

        # ---------------------------------------------------------------- клиент и APK

        def _static(self, path):
            if path.startswith("/apk/"):
                base, rel = app.apk_dir, path[5:]
            else:
                base, rel = app.web_dir, path.lstrip("/") or "index.html"
            full = os.path.abspath(os.path.join(base, rel))
            if not (full == base or full.startswith(base + os.sep)) or not os.path.isfile(full):
                raise HttpError(404, "not_found", "Файл не найден")
            st = os.stat(full)
            etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
            headers = {"ETag": etag, "Cache-Control": "no-cache"}
            if self.headers.get("If-None-Match") == etag:
                return self._send(304, extra=headers)
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml"):
                ctype += "; charset=utf-8"
            if full.endswith(".apk"):
                headers["Content-Disposition"] = 'attachment; filename="karta-seti.apk"'
            with open(full, "rb") as f:
                body = f.read()
            self._send(200, body, ctype, headers)

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # на Windows этот флаг позволил бы второй копии программы занять тот же порт
    allow_reuse_address = os.name != "nt"
    request_queue_size = 64

    def handle_error(self, request, client_address):
        pass  # оборванные соединения — обычное дело в мобильных сетях, в консоль их не пишем


def make_server(app, host, port, cert=None, key=None):
    server = Server((host, port), make_handler(app))
    if cert and key:
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        # рукопожатие выполняется в потоке запроса, а не в общем цикле приёма соединений
        server.socket = ctx.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    return server
