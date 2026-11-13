# -*- coding: utf-8 -*-
"""Программа «Карта сети» для компьютера.

    python run.py                 обычный запуск (данные в папке data)
    python run.py --demo          демонстрационный режим: отдельная база с примером сети (data-demo)
    python run.py --no-window     не открывать окно программы (только для проверки)

С версии 1.3 программа работает только на этом компьютере: она не принимает подключений по сети.
Телефоны с ней не соединяются, обмен идёт файлами: бригады присылают файлы изменений,
диспетчер загружает их в программу и рассылает бригадам файл карты.

Нужен только Python 3.8+ — ничего доустанавливать не требуется.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from core.app import App, SERVER_VERSION, make_server  # noqa: E402
from core.store import Store  # noqa: E402

HOST = "127.0.0.1"   # только этот компьютер; настройка host из прежних версий больше не действует

DEFAULT_CONFIG = {
    "title": "Карта сети",
    "operator": "Диспетчер",
    "port": 8790,
    "backup_keep": 30,
}


def load_config(data_dir):
    path = os.path.join(data_dir, "config.json")
    cfg = dict(DEFAULT_CONFIG)
    saved = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                saved = json.load(f)
        except Exception as e:
            print("Не удалось прочитать %s: %s. Работаю с настройками по умолчанию." % (path, e))
    for k in DEFAULT_CONFIG:
        if k in saved:
            cfg[k] = saved[k]
    if set(saved) != set(DEFAULT_CONFIG):
        # убираем настройки сети от прежних версий и дописываем новые
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    return cfg


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


def seed_demo(store):
    """Небольшая выдуманная сеть для знакомства с программой."""
    if store.snapshot()["objects"]:
        return
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
    store.apply_ops({"id": None, "name": "Демо"}, ops)


def backup_loop(store, data_dir, keep, log):
    """Раз в сутки сохраняет копию базы в data/backups; хранит последние копии каждого вида."""
    folder = os.path.join(data_dir, "backups")
    os.makedirs(folder, exist_ok=True)
    daily = re.compile(r"^netmap-\d{4}-\d{2}-\d{2}\.db$")
    while True:
        try:
            target = os.path.join(folder, "netmap-%s.db" % time.strftime("%Y-%m-%d"))
            if not os.path.exists(target):
                store.backup(target)
                log("Резервная копия базы: %s" % target)
            names = sorted(os.listdir(folder))
            for group in ([n for n in names if daily.match(n)],
                          [n for n in names if n.startswith("netmap-before-import-") and n.endswith(".db")]):
                for old in group[:-max(1, int(keep))]:
                    os.remove(os.path.join(folder, old))
        except Exception as e:
            log("Не удалось сделать резервную копию: %s" % e)
        time.sleep(3600)


def open_window(url):
    """Открывает программу отдельным окном (Edge или Chrome в режиме приложения), иначе — в браузере."""
    if os.name == "nt":
        candidates = []
        for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
            if base:
                candidates += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                               os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
        for exe in candidates:
            if os.path.exists(exe):
                try:
                    subprocess.Popen([exe, "--app=" + url, "--start-maximized"], close_fds=True)
                    return
                except Exception:
                    pass
    else:
        for name in ("chromium", "chromium-browser", "google-chrome", "microsoft-edge"):
            exe = shutil.which(name)
            if exe:
                try:
                    subprocess.Popen([exe, "--app=" + url], close_fds=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    ap.add_argument("--port", type=int)
    ap.add_argument("--data", help="папка с базой и настройками")
    ap.add_argument("--demo", action="store_true", help="демонстрационный режим с примером сети")
    ap.add_argument("--no-window", action="store_true", help="не открывать окно программы")
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data or os.path.join(ROOT, "data-demo" if args.demo else "data"))
    os.makedirs(data_dir, exist_ok=True)
    cfg = load_config(data_dir)
    port = args.port or int(cfg.get("port") or 8790) + (1 if args.demo and not args.port else 0)
    url = "http://%s:%d/" % (HOST, port)

    log = Log(os.path.join(data_dir, "server.log"))
    store = Store(os.path.join(data_dir, "netmap.db"))
    if args.demo:
        seed_demo(store)

    app = App(store, os.path.join(ROOT, "web"), os.path.join(ROOT, "apk"),
              title=cfg.get("title") or "Карта сети", log=log, local=True,
              operator=str(cfg.get("operator") or "Диспетчер"), backup_dir=os.path.join(data_dir, "backups"))
    try:
        server = make_server(app, HOST, port)
    except OSError:
        # программа уже запущена — просто открываем её окно
        print("Программа уже запущена, открываю её окно.")
        if not args.no_window:
            open_window(url)
        return 0

    threading.Thread(target=backup_loop, args=(store, data_dir, cfg.get("backup_keep", 30), log), daemon=True).start()

    print()
    print("  Карта сети %s%s" % (SERVER_VERSION, "  [ДЕМО]" if args.demo else ""))
    print("  Данные: %s" % data_dir)
    print("  Окно программы: %s" % url)
    print("  Программа работает только на этом компьютере, по сети к ней подключиться нельзя.")
    print("  Пока это окно открыто, программа работает. Закрыть программу: закройте это окно.")
    print()
    log("Программа запущена%s" % (" (демо)" if args.demo else ""))
    if not args.no_window:
        threading.Timer(0.6, open_window, args=(url,)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        log("Программа остановлена")
        server.server_close()
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
