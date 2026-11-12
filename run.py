# -*- coding: utf-8 -*-
"""Запуск сервера «Карта сети».

    python run.py                 обычный запуск (данные в папке data)
    python run.py --port 8790     другой порт
    python run.py --demo          демонстрационный режим: отдельная база с примером сети (data-demo)

Нужен только Python 3.8+ — ничего доустанавливать не требуется.
"""
import argparse
import json
import os
import secrets
import socket
import sys
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from core.app import App, SERVER_VERSION, make_server  # noqa: E402
from core.store import Store  # noqa: E402

DEFAULT_CONFIG = {
    "title": "Карта сети",
    "host": "0.0.0.0",
    "port": 8790,
    "https_cert": "",
    "https_key": "",
    "backup_keep": 14,
}


def load_config(data_dir):
    path = os.path.join(data_dir, "config.json")
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print("Не удалось прочитать %s: %s. Работаю с настройками по умолчанию." % (path, e))
    else:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    return cfg


def local_addresses():
    found = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        found.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith("127."):
                found.append(ip)
    except Exception:
        pass
    return found


class Log:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()

    def __call__(self, text):
        line = "%s  %s" % (time.strftime("%d.%m.%Y %H:%M:%S"), text)
        with self.lock:
            print(line, flush=True)
            try:
                if os.path.exists(self.path) and os.path.getsize(self.path) > 5 * 1024 * 1024:
                    os.replace(self.path, self.path + ".old")
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass


def first_run(store, data_dir, log, demo):
    """При первом запуске создаёт администратора и показывает его пароль."""
    if store.count_users():
        return
    password = "demo-admin" if demo else secrets.token_urlsafe(8)
    store.create_user("admin", "Администратор", "admin", password)
    note = os.path.join(data_dir, "ПЕРВЫЙ ВХОД.txt")
    with open(note, "w", encoding="utf-8") as f:
        f.write(
            "Карта сети — первый вход\r\n\r\n"
            "Логин:  admin\r\nПароль: %s\r\n\r\n"
            "Войдите, смените пароль (меню - Настройки) и заведите учётные записи сотрудникам\r\n"
            "(меню - Пользователи). После этого файл можно удалить.\r\n" % password
        )
    log("Создан администратор: логин admin, пароль %s (также записан в «%s»)" % (password, note))


def seed_demo(store):
    """Небольшая выдуманная сеть для знакомства с программой."""
    if store.snapshot()["objects"]:
        return
    admin = store.list_users()[0]
    nodes = [
        ("n1", "ОУ Центральный", "core", "ok", 58.5215, 31.2755, "ул. Примерная, 1"),
        ("n2", "УА Северный", "aggregation", "ok", 58.5650, 31.2800, "ул. Северная, 12"),
        ("n3", "УА Южный", "aggregation", "work", 58.4800, 31.2900, "ул. Южная, 40"),
        ("n4", "УД-101", "access", "ok", 58.5800, 31.2200, ""),
        ("n5", "УД-102", "access", "fail", 58.5900, 31.3400, ""),
        ("n6", "УД-201", "access", "ok", 58.4600, 31.2200, ""),
        ("n7", "УД-202", "access", "plan", 58.4500, 31.3700, ""),
        ("n8", "БС-17", "bs", "ok", 58.5300, 31.4100, ""),
    ]
    links = [
        ("l1", "n1", "n2", "fiber", "ok"), ("l2", "n1", "n3", "fiber", "ok"),
        ("l3", "n2", "n4", "fiber", "ok"), ("l4", "n2", "n5", "radio", "fail"),
        ("l5", "n3", "n6", "fiber", "ok"), ("l6", "n3", "n7", "radio", "plan"),
        ("l7", "n1", "n8", "rrl", "ok"),
    ]
    ops = []
    for i, name, typ, status, lat, lng, addr in nodes:
        ops.append({"op_id": "demo-" + i, "id": "demo-" + i, "kind": "node", "action": "put",
                    "patch": {"name": name, "type": typ, "status": status, "lat": lat, "lng": lng, "address": addr}})
    for i, a, b, typ, status in links:
        ops.append({"op_id": "demo-" + i, "id": "demo-" + i, "kind": "link", "action": "put",
                    "patch": {"a": "demo-" + a, "b": "demo-" + b, "type": typ, "status": status}})
    store.apply_ops(admin, ops)


def backup_loop(store, data_dir, keep, log):
    """Раз в сутки сохраняет копию базы в data/backups и удаляет старые копии."""
    folder = os.path.join(data_dir, "backups")
    os.makedirs(folder, exist_ok=True)
    while True:
        try:
            name = "netmap-%s.db" % time.strftime("%Y-%m-%d")
            target = os.path.join(folder, name)
            if not os.path.exists(target):
                store.backup(target)
                log("Резервная копия базы: %s" % target)
            copies = sorted(f for f in os.listdir(folder) if f.startswith("netmap-") and f.endswith(".db"))
            for old in copies[:-max(1, int(keep))]:
                os.remove(os.path.join(folder, old))
            store.prune_applied_ops()
        except Exception as e:
            log("Не удалось сделать резервную копию: %s" % e)
        time.sleep(3600)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Сервер «Карта сети»")
    ap.add_argument("--port", type=int)
    ap.add_argument("--host")
    ap.add_argument("--data", help="папка с базой и настройками")
    ap.add_argument("--demo", action="store_true", help="демонстрационный режим с примером сети")
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data or os.path.join(ROOT, "data-demo" if args.demo else "data"))
    os.makedirs(data_dir, exist_ok=True)
    cfg = load_config(data_dir)
    host = args.host or cfg.get("host") or "0.0.0.0"
    port = args.port or int(cfg.get("port") or 8790)

    log = Log(os.path.join(data_dir, "server.log"))
    store = Store(os.path.join(data_dir, "netmap.db"))
    first_run(store, data_dir, log, args.demo)
    if args.demo:
        seed_demo(store)

    app = App(store, os.path.join(ROOT, "web"), os.path.join(ROOT, "apk"),
              title=cfg.get("title") or "Карта сети", log=log)
    cert, key = cfg.get("https_cert") or "", cfg.get("https_key") or ""
    use_https = bool(cert and key)
    try:
        server = make_server(app, host, port, cert if use_https else None, key if use_https else None)
    except OSError as e:
        log("Не удалось занять порт %d: %s. Возможно, сервер уже запущен." % (port, e))
        return 1

    threading.Thread(target=backup_loop, args=(store, data_dir, cfg.get("backup_keep", 14), log), daemon=True).start()

    scheme = "https" if use_https else "http"
    print()
    print("  Карта сети — сервер %s%s" % (SERVER_VERSION, "  [ДЕМО]" if args.demo else ""))
    print("  Данные: %s" % data_dir)
    print("  На этом компьютере:  %s://localhost:%d" % (scheme, port))
    for ip in local_addresses():
        print("  В локальной сети:    %s://%s:%d" % (scheme, ip, port))
    print("  Из интернета — по вашему внешнему адресу и проброшенному порту %d." % port)
    if not use_https:
        print("  Внимание: без HTTPS пароли и данные идут по сети открытым текстом (см. README).")
    print("  Остановить сервер: Ctrl+C или закрыть это окно.")
    print()
    log("Сервер запущен на %s:%d" % (host, port))
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        log("Сервер остановлен")
        server.server_close()
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
