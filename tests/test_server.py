# -*- coding: utf-8 -*-
"""Проверка сервера: запуск на случайном порту и обращения по HTTP, как это делает клиент.

    python -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core.app import App, make_server  # noqa: E402
from core.store import Store  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Client:
    def __init__(self, base, token=None):
        self.base, self.token = base, token

    def call(self, method, path, body=None, token="__own__"):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        tok = self.token if token == "__own__" else token
        if tok:
            req.add_header("Authorization", "Bearer " + tok)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw and r.headers.get_content_type() == "application/json" else raw)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw


class SseReader(threading.Thread):
    """Читает поток событий в фоне и складывает разобранные события в список."""

    def __init__(self, base, token):
        super().__init__(daemon=True)
        self.events = []
        self.resp = urllib.request.urlopen(base + "/api/events?token=" + token, timeout=30)
        self.start()

    def run(self):
        name, data = None, []
        try:
            for raw in self.resp:
                line = raw.decode().rstrip("\n")
                if line.startswith("event: "):
                    name = line[7:]
                elif line.startswith("data: "):
                    data.append(line[6:])
                elif line == "" and name:
                    self.events.append((name, json.loads("\n".join(data))))
                    name, data = None, []
        except Exception:
            pass

    def wait_for(self, name, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            for ev in self.events:
                if ev[0] == name:
                    return ev[1]
            time.sleep(0.02)
        return None

    def close(self):
        try:
            self.resp.close()
        except Exception:
            pass


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.store = Store(os.path.join(cls.tmp.name, "t.db"))
        cls.store.create_user("admin", "Админ", "admin", "secret1")
        cls.app = App(cls.store, os.path.join(ROOT, "web"), os.path.join(ROOT, "apk"))
        cls.server = make_server(cls.app, "127.0.0.1", 0)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        anon = Client(cls.base)
        st, r = anon.call("POST", "/api/login", {"login": "Admin", "password": "secret1"})
        assert st == 200, r
        cls.admin = Client(cls.base, r["token"])
        for login, role in (("ivan", "editor"), ("petr", "editor"), ("guest", "viewer")):
            st, r = cls.admin.call("POST", "/api/users", {"login": login, "name": login.title(), "role": role, "password": "pass123"})
            assert st == 200, r
            st, r = anon.call("POST", "/api/login", {"login": login, "password": "pass123"})
            setattr(cls, login, Client(cls.base, r["token"]))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.store.close()
        cls.tmp.cleanup()

    def put(self, client, op_id, kind, obj_id, patch):
        st, r = client.call("POST", "/api/ops", {"ops": [{"op_id": op_id, "kind": kind, "id": obj_id, "action": "put", "patch": patch}]})
        self.assertEqual(st, 200, r)
        return r["results"][0]

    def test_01_auth(self):
        st, r = Client(self.base).call("GET", "/api/snapshot")
        self.assertEqual(st, 401)
        st, r = Client(self.base).call("POST", "/api/login", {"login": "ivan", "password": "wrong"})
        self.assertEqual((st, r["code"]), (401, "bad_login"))
        st, r = self.ivan.call("GET", "/api/me")
        self.assertEqual(r["user"]["role"], "editor")
        st, r = self.ivan.call("GET", "/api/users")
        self.assertEqual(st, 403)

    def test_02_create_and_realtime(self):
        sse = SseReader(self.base, self.petr.token)
        self.assertIsNotNone(sse.wait_for("hello"))
        res = self.put(self.ivan, "op-a", "node", "A", {"name": "УД-1", "type": "access", "status": "ok", "lat": 55.75, "lng": 37.61})
        self.assertTrue(res["ok"], res)
        ev = sse.wait_for("change")
        self.assertIsNotNone(ev, "второй пользователь не получил изменение")
        self.assertEqual(ev["objects"][0]["data"]["name"], "УД-1")
        self.assertEqual(ev["objects"][0]["updated_by"], "Ivan")
        sse.close()
        self.put(self.ivan, "op-b", "node", "B", {"name": "УД-2", "lat": 55.80, "lng": 37.70})
        res = self.put(self.petr, "op-l", "link", "L", {"a": "A", "b": "B", "type": "fiber"})
        self.assertTrue(res["ok"], res)
        st, snap = self.guest.call("GET", "/api/snapshot")
        self.assertEqual(len(snap["objects"]), 3)

    def test_03_idempotent_retry(self):
        st, before = self.ivan.call("GET", "/api/snapshot")
        res = self.put(self.ivan, "op-a", "node", "A", {"name": "ДРУГОЕ ИМЯ", "lat": 1, "lng": 1})
        self.assertTrue(res["ok"])
        self.assertEqual(res["object"]["data"]["name"], "УД-1", "повторная отправка правки не должна ничего менять")
        st, after = self.ivan.call("GET", "/api/snapshot")
        self.assertEqual(before["rev"], after["rev"])

    def test_04_field_merge(self):
        # двое без связи правили разные поля одного узла — сохраняются обе правки
        self.put(self.ivan, "op-m1", "node", "A", {"status": "fail"})
        self.put(self.petr, "op-m2", "node", "A", {"note": "нет питания"})
        st, ch = self.guest.call("GET", "/api/changes?since=0")
        a = [o for o in ch["objects"] if o["id"] == "A"][0]
        self.assertEqual((a["data"]["status"], a["data"]["note"], a["data"]["name"]), ("fail", "нет питания", "УД-1"))

    def test_05_viewer_cannot_edit(self):
        st, r = self.guest.call("POST", "/api/ops", {"ops": [{"op_id": "x", "kind": "node", "id": "Z", "action": "put", "patch": {"name": "z", "lat": 1, "lng": 1}}]})
        self.assertEqual(st, 403)

    def test_06_validation(self):
        res = self.put(self.ivan, "op-v1", "node", "V1", {"name": "", "lat": 1, "lng": 1})
        self.assertFalse(res["ok"])
        res = self.put(self.ivan, "op-v2", "node", "V2", {"name": "x", "lat": 200, "lng": 1})
        self.assertFalse(res["ok"])
        res = self.put(self.ivan, "op-v3", "link", "V3", {"a": "A", "b": "нет такого"})
        self.assertEqual(res["code"], "no_node")
        res = self.put(self.ivan, "op-v4", "link", "V4", {"a": "A", "b": "A"})
        self.assertFalse(res["ok"])

    def test_07_delete_cascade_and_changes(self):
        st, snap = self.ivan.call("GET", "/api/snapshot")
        rev = snap["rev"]
        st, r = self.ivan.call("POST", "/api/ops", {"ops": [{"op_id": "op-d", "kind": "node", "id": "B", "action": "delete"}]})
        self.assertTrue(r["results"][0]["ok"])
        st, ch = self.petr.call("GET", "/api/changes?since=%d" % rev)
        gone = {o["id"]: o["deleted"] for o in ch["objects"]}
        self.assertEqual(gone, {"L": True, "B": True}, "вместе с узлом должна удалиться его линия")
        # правка удалённого объекта (пришла от того, кто был без связи) отклоняется с понятным кодом
        res = self.put(self.petr, "op-late", "node", "B", {"note": "опоздал"})
        self.assertEqual((res["ok"], res["code"]), (False, "deleted"))
        st, j = self.guest.call("GET", "/api/journal?limit=5")
        self.assertEqual(j["entries"][0]["action"], "delete")

    def test_08_users_admin(self):
        st, r = self.admin.call("GET", "/api/users")
        petr = [u for u in r["users"] if u["login"] == "petr"][0]
        st, r = self.admin.call("PATCH", "/api/users/%d" % petr["id"], {"active": False})
        self.assertEqual(st, 200)
        st, r = self.petr.call("GET", "/api/me")
        self.assertEqual(st, 401, "отключённый пользователь должен потерять доступ сразу")
        admin_id = [u for u in self.admin.call("GET", "/api/users")[1]["users"] if u["login"] == "admin"][0]["id"]
        st, r = self.admin.call("PATCH", "/api/users/%d" % admin_id, {"role": "viewer"})
        self.assertEqual(r["code"], "last_admin")

    def test_09_settings(self):
        st, snap = self.ivan.call("GET", "/api/snapshot")
        s = snap["settings"]
        s["node_types"].append({"id": "mufta", "name": "Муфта"})
        st, r = self.ivan.call("PUT", "/api/settings", s)
        self.assertEqual(st, 403)
        st, r = self.admin.call("PUT", "/api/settings", s)
        self.assertEqual(st, 200, r)
        self.assertEqual(r["node_types"][-1]["name"], "Муфта")

    def test_10_static_and_traversal(self):
        st, r = Client(self.base).call("GET", "/")
        self.assertEqual(st, 200)
        st, r = Client(self.base).call("GET", "/../run.py")
        self.assertEqual(st, 404)
        st, r = Client(self.base).call("GET", "/%2e%2e/run.py")
        self.assertEqual(st, 404)
        st, r = Client(self.base).call("GET", "/api/info")
        self.assertEqual(r["app"], "karta-seti")

    def test_11_bruteforce_lock(self):
        anon = Client(self.base)
        for _ in range(5):
            anon.call("POST", "/api/login", {"login": "guest", "password": "nope"})
        st, r = anon.call("POST", "/api/login", {"login": "guest", "password": "pass123"})
        self.assertEqual(st, 429, "после пяти неудач вход с этого адреса должен временно блокироваться")
        self.app.guard.fails.clear()

    def test_12_password_change(self):
        st, r = self.guest.call("POST", "/api/password", {"old": "bad", "new": "newpass1"})
        self.assertEqual(st, 400)
        st, r = self.guest.call("POST", "/api/password", {"old": "pass123", "new": "newpass1"})
        self.assertEqual(st, 200)
        st, r = Client(self.base).call("POST", "/api/login", {"login": "guest", "password": "newpass1"})
        self.assertEqual(st, 200)


if __name__ == "__main__":
    unittest.main()
