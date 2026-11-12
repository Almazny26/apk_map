# -*- coding: utf-8 -*-
"""Хранилище «Карты сети»: SQLite, пользователи, объекты карты, журнал изменений.

Только стандартная библиотека Python. Одно соединение на весь процесс под общей блокировкой —
для десятков пользователей этого достаточно, а порядок изменений получается строгим.

Модель данных
    objects   узлы и линии. Поле data — JSON с полями объекта, rev — номер последнего изменения.
              Удалённые объекты остаются в таблице с deleted=1, чтобы клиенты, бывшие без связи,
              узнали об удалении при синхронизации.
    journal   журнал изменений; его первичный ключ и есть сквозной номер ревизии (rev).
    applied_ops  идентификаторы уже применённых правок: повторная отправка той же правки
              (после обрыва связи клиент не знает, дошла ли она) ничего не меняет.
"""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    salt BLOB NOT NULL,
    hash BLOB NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    device TEXT,
    created_at REAL NOT NULL,
    last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS objects(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    rev INTEGER NOT NULL,
    created_at REAL NOT NULL,
    created_by INTEGER,
    updated_at REAL NOT NULL,
    updated_by INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS objects_rev ON objects(rev);
CREATE TABLE IF NOT EXISTS journal(
    rev INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    user_id INTEGER,
    user_name TEXT,
    kind TEXT NOT NULL,
    obj_id TEXT NOT NULL,
    action TEXT NOT NULL,
    label TEXT,
    changes TEXT
);
CREATE INDEX IF NOT EXISTS journal_obj ON journal(obj_id);
CREATE TABLE IF NOT EXISTS applied_ops(op_id TEXT PRIMARY KEY, rev INTEGER, ts REAL NOT NULL);
"""

ROLES = ("admin", "editor", "viewer")
PBKDF2_ROUNDS = 200_000
SESSION_TTL = 180 * 24 * 3600  # вход на телефоне живёт полгода без обращений

DEFAULT_SETTINGS = {
    "node_types": [
        {"id": "access", "name": "Узел доступа"},
        {"id": "aggregation", "name": "Узел агрегации"},
        {"id": "core", "name": "Опорный узел"},
        {"id": "bs", "name": "Базовая станция"},
        {"id": "other", "name": "Прочее"},
    ],
    "link_types": [
        {"id": "fiber", "name": "ВОЛС", "color": "#1d4ed8", "dash": ""},
        {"id": "radio", "name": "Радиоканал (БШПД)", "color": "#7c3aed", "dash": "8 8"},
        {"id": "rrl", "name": "РРЛ", "color": "#0e7490", "dash": "2 8"},
        {"id": "copper", "name": "Медь", "color": "#92400e", "dash": ""},
        {"id": "leased", "name": "Арендованный канал", "color": "#475569", "dash": "12 6 2 6"},
    ],
    "statuses": [
        {"id": "ok", "name": "В работе", "color": "#16a34a"},
        {"id": "work", "name": "Идут работы", "color": "#f59e0b"},
        {"id": "fail", "name": "Авария", "color": "#dc2626"},
        {"id": "plan", "name": "Планируется", "color": "#64748b"},
    ],
}

NODE_FIELDS = {"name": 200, "type": 40, "status": 40, "address": 500, "note": 4000}
LINK_FIELDS = {"name": 200, "type": 40, "status": 40, "note": 4000}
MAX_PATH_POINTS = 300


class OpError(Exception):
    """Правку нельзя применить; code — короткий код причины для клиента."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _hash_password(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)


def _token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _num(value, lo, hi, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OpError("bad_value", "Поле %s должно быть числом" % name)
    value = float(value)
    if value != value or value < lo or value > hi:
        raise OpError("bad_value", "Поле %s вне допустимых границ" % name)
    return round(value, 7)


def _text(value, limit, name):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise OpError("bad_value", "Поле %s должно быть текстом" % name)
    return value.strip()[:limit]


class Store:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        self._user_names = {}
        self._reload_user_names()

    # ------------------------------------------------------------------ служебное

    def close(self):
        with self.lock:
            self.db.close()

    def backup(self, dest_path):
        """Согласованная копия базы в отдельный файл (можно делать на работающем сервере)."""
        with self.lock:
            dest = sqlite3.connect(dest_path)
            try:
                self.db.backup(dest)
            finally:
                dest.close()

    def _meta_get(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def _meta_set(self, key, value):
        self.db.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )

    def current_rev(self):
        with self.lock:
            row = self.db.execute("SELECT MAX(rev) AS r FROM journal").fetchone()
            return row["r"] or 0

    # ------------------------------------------------------------------ настройки

    def get_settings(self):
        with self.lock:
            saved = self._meta_get("settings", {}) or {}
        out = json.loads(json.dumps(DEFAULT_SETTINGS))
        for key in DEFAULT_SETTINGS:
            if isinstance(saved.get(key), list) and saved[key]:
                out[key] = saved[key]
        out["rev"] = saved.get("rev", 0)
        return out

    def set_settings(self, incoming):
        """Сохраняет списки типов и состояний. Возвращает новые настройки."""
        clean = {}
        for key in DEFAULT_SETTINGS:
            items = incoming.get(key)
            if not isinstance(items, list) or not items:
                raise OpError("bad_value", "Список «%s» не может быть пустым" % key)
            seen = set()
            out = []
            for item in items[:40]:
                if not isinstance(item, dict):
                    raise OpError("bad_value", "Неверная запись в списке «%s»" % key)
                ident = _text(item.get("id"), 40, "id")
                name = _text(item.get("name"), 80, "name")
                if not ident or not name or ident in seen:
                    raise OpError("bad_value", "В списке «%s» у каждой записи нужны уникальный код и название" % key)
                seen.add(ident)
                entry = {"id": ident, "name": name}
                if key != "node_types":
                    color = _text(item.get("color"), 9, "color")
                    entry["color"] = color if (color.startswith("#") and len(color) in (4, 7)) else "#475569"
                if key == "link_types":
                    entry["dash"] = _text(item.get("dash"), 30, "dash")
                out.append(entry)
            clean[key] = out
        with self.lock:
            prev = self._meta_get("settings", {}) or {}
            clean["rev"] = int(prev.get("rev", 0)) + 1
            self._meta_set("settings", clean)
        return self.get_settings()

    # ------------------------------------------------------------------ пользователи

    def _reload_user_names(self):
        with self.lock:
            self._user_names = {
                r["id"]: r["name"] for r in self.db.execute("SELECT id, name FROM users")
            }

    def user_name(self, user_id):
        return self._user_names.get(user_id, "")

    @staticmethod
    def _user_row(row):
        return {
            "id": row["id"],
            "login": row["login"],
            "name": row["name"],
            "role": row["role"],
            "active": bool(row["active"]),
        }

    def count_users(self):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]

    def list_users(self):
        with self.lock:
            rows = self.db.execute(
                "SELECT u.*, (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id=u.id) AS last_seen "
                "FROM users u ORDER BY u.active DESC, u.name COLLATE NOCASE"
            ).fetchall()
        out = []
        for r in rows:
            u = self._user_row(r)
            u["last_seen"] = r["last_seen"]
            out.append(u)
        return out

    def create_user(self, login, name, role, password):
        login = _text(login, 40, "login").lower()
        name = _text(name, 80, "name") or login
        if not login or not all(c.isalnum() or c in "._-" for c in login):
            raise OpError("bad_value", "Логин: только буквы, цифры, точка, дефис и подчёркивание")
        if role not in ROLES:
            raise OpError("bad_value", "Неизвестная роль")
        self._check_password(password)
        salt = secrets.token_bytes(16)
        with self.lock:
            try:
                cur = self.db.execute(
                    "INSERT INTO users(login,name,role,salt,hash,active,created_at) VALUES(?,?,?,?,?,1,?)",
                    (login, name, role, salt, _hash_password(password, salt), time.time()),
                )
            except sqlite3.IntegrityError:
                raise OpError("exists", "Пользователь с таким логином уже есть")
            self._reload_user_names()
            return self.get_user(cur.lastrowid)

    @staticmethod
    def _check_password(password):
        if not isinstance(password, str) or len(password) < 6:
            raise OpError("bad_value", "Пароль должен быть не короче 6 символов")
        if len(password) > 200:
            raise OpError("bad_value", "Слишком длинный пароль")

    def get_user(self, user_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        return self._user_row(row) if row else None

    def update_user(self, user_id, name=None, role=None, active=None, password=None):
        """Меняет учётную запись. Возвращает (пользователь, нужно_ли_разлогинить)."""
        with self.lock:
            row = self.db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if not row:
                raise OpError("not_found", "Пользователь не найден")
            kick = False
            if role is not None and role not in ROLES:
                raise OpError("bad_value", "Неизвестная роль")
            losing_admin = row["role"] == "admin" and row["active"] and (
                (role is not None and role != "admin") or active is False
            )
            if losing_admin:
                others = self.db.execute(
                    "SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1 AND id<>?", (user_id,)
                ).fetchone()["c"]
                if not others:
                    raise OpError("last_admin", "Нельзя оставить систему без администратора")
            if name is not None:
                self.db.execute("UPDATE users SET name=? WHERE id=?", (_text(name, 80, "name") or row["login"], user_id))
            if role is not None:
                self.db.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
            if active is not None:
                self.db.execute("UPDATE users SET active=? WHERE id=?", (1 if active else 0, user_id))
                kick = kick or not active
            if password is not None:
                self._check_password(password)
                salt = secrets.token_bytes(16)
                self.db.execute(
                    "UPDATE users SET salt=?, hash=? WHERE id=?", (salt, _hash_password(password, salt), user_id)
                )
                kick = True
            if kick:
                self.db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
            self._reload_user_names()
            return self.get_user(user_id), kick

    def change_own_password(self, user_id, old, new, keep_token):
        with self.lock:
            row = self.db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if not row or not hmac.compare_digest(_hash_password(old or "", row["salt"]), row["hash"]):
                raise OpError("bad_password", "Текущий пароль указан неверно")
            self._check_password(new)
            salt = secrets.token_bytes(16)
            self.db.execute("UPDATE users SET salt=?, hash=? WHERE id=?", (salt, _hash_password(new, salt), user_id))
            # остальные устройства этого пользователя должны войти заново
            self.db.execute(
                "DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user_id, _token_hash(keep_token))
            )

    # ------------------------------------------------------------------ вход и сессии

    def login(self, login, password, device=""):
        """Возвращает (токен, пользователь) или None, если логин или пароль не подошли."""
        login = (login or "").strip().lower()
        with self.lock:
            row = self.db.execute("SELECT * FROM users WHERE login=?", (login,)).fetchone()
        # считаем хеш и для несуществующего логина, чтобы по времени ответа нельзя было угадать логины
        salt = row["salt"] if row else b"0" * 16
        digest = _hash_password(password or "", salt)
        if not row or not row["active"] or not hmac.compare_digest(digest, row["hash"]):
            return None
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self.lock:
            self.db.execute(
                "INSERT INTO sessions(token_hash,user_id,device,created_at,last_seen) VALUES(?,?,?,?,?)",
                (_token_hash(token), row["id"], (device or "")[:200], now, now),
            )
        return token, self._user_row(row)

    def auth(self, token):
        """Пользователь по токену или None."""
        if not token:
            return None
        th = _token_hash(token)
        now = time.time()
        with self.lock:
            row = self.db.execute(
                "SELECT u.*, s.last_seen AS seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
                (th,),
            ).fetchone()
            if not row or not row["active"]:
                return None
            if now - row["seen"] > SESSION_TTL:
                self.db.execute("DELETE FROM sessions WHERE token_hash=?", (th,))
                return None
            if now - row["seen"] > 60:
                self.db.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now, th))
        return self._user_row(row)

    def logout(self, token):
        with self.lock:
            self.db.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))

    # ------------------------------------------------------------------ объекты карты

    def _obj(self, row):
        return {
            "id": row["id"],
            "kind": row["kind"],
            "rev": row["rev"],
            "deleted": bool(row["deleted"]),
            "data": json.loads(row["data"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "updated_by": self.user_name(row["updated_by"]),
        }

    def snapshot(self):
        """Все живые объекты и номер ревизии, которому они соответствуют."""
        with self.lock:
            rev = self.current_rev()
            rows = self.db.execute("SELECT * FROM objects WHERE deleted=0").fetchall()
            return {"rev": rev, "objects": [self._obj(r) for r in rows]}

    def changes_since(self, since):
        """Объекты, изменённые после ревизии since (включая удалённые)."""
        with self.lock:
            rev = self.current_rev()
            rows = self.db.execute("SELECT * FROM objects WHERE rev>? ORDER BY rev", (int(since),)).fetchall()
            return {"rev": rev, "objects": [self._obj(r) for r in rows]}

    def _get(self, obj_id):
        return self.db.execute("SELECT * FROM objects WHERE id=?", (obj_id,)).fetchone()

    def _clean_patch(self, kind, patch):
        """Проверяет и нормализует поля правки. Незнакомые поля отбрасываются."""
        if not isinstance(patch, dict):
            raise OpError("bad_value", "Правка должна быть объектом")
        out = {}
        fields = NODE_FIELDS if kind == "node" else LINK_FIELDS
        for key, limit in fields.items():
            if key in patch:
                out[key] = _text(patch[key], limit, key)
        if kind == "node":
            if "lat" in patch:
                out["lat"] = _num(patch["lat"], -90, 90, "lat")
            if "lng" in patch:
                out["lng"] = _num(patch["lng"], -180, 180, "lng")
        else:
            for key in ("a", "b"):
                if key in patch:
                    out[key] = _text(patch[key], 64, key)
            if "path" in patch:
                path = patch["path"] or []
                if not isinstance(path, list) or len(path) > MAX_PATH_POINTS:
                    raise OpError("bad_value", "Слишком много точек в трассе линии")
                pts = []
                for p in path:
                    if not isinstance(p, (list, tuple)) or len(p) != 2:
                        raise OpError("bad_value", "Точка трассы — это пара координат")
                    pts.append([_num(p[0], -90, 90, "lat"), _num(p[1], -180, 180, "lng")])
                out["path"] = pts
        return out

    def _live_node(self, node_id):
        row = self._get(node_id)
        return bool(row and row["kind"] == "node" and not row["deleted"])

    def _write_journal(self, user, kind, obj_id, action, label, changes):
        cur = self.db.execute(
            "INSERT INTO journal(ts,user_id,user_name,kind,obj_id,action,label,changes) VALUES(?,?,?,?,?,?,?,?)",
            (time.time(), user["id"], user["name"], kind, obj_id, action, label,
             json.dumps(changes, ensure_ascii=False) if changes else None),
        )
        return cur.lastrowid

    def _label(self, kind, data):
        if data.get("name"):
            return data["name"]
        if kind == "link":
            names = []
            for key in ("a", "b"):
                row = self._get(data.get(key) or "")
                names.append(json.loads(row["data"]).get("name", "?") if row else "?")
            return " — ".join(names)
        return ""

    def _apply_put(self, user, kind, obj_id, patch):
        row = self._get(obj_id)
        now = time.time()
        if row is None:
            data = {"name": "", "type": "", "status": "", "note": ""}
            if kind == "node":
                data.update({"address": "", "lat": None, "lng": None})
            else:
                data.update({"a": "", "b": "", "path": []})
            data.update(patch)
            if kind == "node":
                if not data["name"]:
                    raise OpError("bad_value", "У узла должно быть название")
                if data["lat"] is None or data["lng"] is None:
                    raise OpError("bad_value", "У узла должны быть координаты")
            else:
                if not data["a"] or not data["b"] or data["a"] == data["b"]:
                    raise OpError("bad_value", "Линия должна соединять два разных узла")
                if not self._live_node(data["a"]) or not self._live_node(data["b"]):
                    raise OpError("no_node", "Один из узлов линии уже удалён")
            rev = self._write_journal(user, kind, obj_id, "create", self._label(kind, data), None)
            self.db.execute(
                "INSERT INTO objects(id,kind,data,rev,created_at,created_by,updated_at,updated_by,deleted) "
                "VALUES(?,?,?,?,?,?,?,?,0)",
                (obj_id, kind, json.dumps(data, ensure_ascii=False), rev, now, user["id"], now, user["id"]),
            )
            return [obj_id]
        if row["kind"] != kind:
            raise OpError("bad_value", "Объект с таким идентификатором другого вида")
        if row["deleted"]:
            raise OpError("deleted", "Объект уже удалён другим пользователем")
        data = json.loads(row["data"])
        changes = {}
        for key, value in patch.items():
            if data.get(key) != value:
                changes[key] = [data.get(key), value]
                data[key] = value
        if not changes:
            return []
        if kind == "node" and not data.get("name"):
            raise OpError("bad_value", "У узла должно быть название")
        if kind == "link" and ("a" in changes or "b" in changes):
            if data["a"] == data["b"] or not self._live_node(data["a"]) or not self._live_node(data["b"]):
                raise OpError("no_node", "Линия должна соединять два существующих узла")
        rev = self._write_journal(user, kind, obj_id, "update", self._label(kind, data), changes)
        self.db.execute(
            "UPDATE objects SET data=?, rev=?, updated_at=?, updated_by=? WHERE id=?",
            (json.dumps(data, ensure_ascii=False), rev, now, user["id"], obj_id),
        )
        return [obj_id]

    def _apply_delete(self, user, kind, obj_id):
        row = self._get(obj_id)
        if row is None or row["deleted"]:
            return []
        now = time.time()
        touched = []
        if row["kind"] == "node":
            # вместе с узлом удаляются линии, которые в него приходят
            for link in self.db.execute("SELECT * FROM objects WHERE kind='link' AND deleted=0").fetchall():
                ld = json.loads(link["data"])
                if ld.get("a") == obj_id or ld.get("b") == obj_id:
                    rev = self._write_journal(user, "link", link["id"], "delete", self._label("link", ld), None)
                    self.db.execute(
                        "UPDATE objects SET deleted=1, rev=?, updated_at=?, updated_by=? WHERE id=?",
                        (rev, now, user["id"], link["id"]),
                    )
                    touched.append(link["id"])
        data = json.loads(row["data"])
        rev = self._write_journal(user, row["kind"], obj_id, "delete", self._label(row["kind"], data), None)
        self.db.execute(
            "UPDATE objects SET deleted=1, rev=?, updated_at=?, updated_by=? WHERE id=?",
            (rev, now, user["id"], obj_id),
        )
        touched.append(obj_id)
        return touched

    def apply_ops(self, user, ops):
        """Применяет пачку правок по очереди.

        Возвращает (результаты, изменённые_объекты). Каждая правка — отдельная транзакция:
        ошибка в одной не отменяет остальные, а клиент по результатам знает судьбу каждой.
        """
        results = []
        changed_ids = []
        with self.lock:
            for op in ops:
                op_id = str(op.get("op_id") or "")[:64]
                obj_id = str(op.get("id") or "")[:64]
                kind = op.get("kind")
                action = op.get("action")
                res = {"op_id": op_id, "id": obj_id}
                try:
                    if not op_id or not obj_id or kind not in ("node", "link") or action not in ("put", "delete"):
                        raise OpError("bad_op", "Неверно составленная правка")
                    done = self.db.execute("SELECT rev FROM applied_ops WHERE op_id=?", (op_id,)).fetchone()
                    if done is None:
                        self.db.execute("BEGIN")
                        try:
                            if action == "put":
                                touched = self._apply_put(user, kind, obj_id, self._clean_patch(kind, op.get("patch")))
                            else:
                                touched = self._apply_delete(user, kind, obj_id)
                            self.db.execute(
                                "INSERT INTO applied_ops(op_id,rev,ts) VALUES(?,?,?)",
                                (op_id, self.current_rev(), time.time()),
                            )
                            self.db.execute("COMMIT")
                        except Exception:
                            self.db.execute("ROLLBACK")
                            raise
                        for t in touched:
                            if t not in changed_ids:
                                changed_ids.append(t)
                    res["ok"] = True
                except OpError as e:
                    res.update(ok=False, code=e.code, error=e.message)
                row = self._get(obj_id) if obj_id else None
                res["object"] = self._obj(row) if row else None
                results.append(res)
            changed = [self._obj(self._get(i)) for i in changed_ids]
            rev = self.current_rev()
        return results, changed, rev

    def prune_applied_ops(self, older_than=45 * 24 * 3600):
        with self.lock:
            self.db.execute("DELETE FROM applied_ops WHERE ts<?", (time.time() - older_than,))

    # ------------------------------------------------------------------ журнал

    def journal(self, limit=100, before=None, obj_id=None):
        limit = max(1, min(int(limit or 100), 500))
        sql = "SELECT * FROM journal"
        cond, args = [], []
        if before:
            cond.append("rev<?")
            args.append(int(before))
        if obj_id:
            cond.append("obj_id=?")
            args.append(obj_id)
        if cond:
            sql += " WHERE " + " AND ".join(cond)
        sql += " ORDER BY rev DESC LIMIT ?"
        args.append(limit)
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        return [
            {
                "rev": r["rev"],
                "ts": r["ts"],
                "user": r["user_name"],
                "kind": r["kind"],
                "obj_id": r["obj_id"],
                "action": r["action"],
                "label": r["label"],
                "changes": json.loads(r["changes"]) if r["changes"] else None,
            }
            for r in rows
        ]
