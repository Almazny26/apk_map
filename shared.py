"""Authenticated shared desktop sessions and atomic map updates."""
import copy
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import threading
import time
from http.cookies import SimpleCookie

MASS_DELETE = 10        # больше удалений за одну правку — только администратор
SNAPSHOT_OPS = 20       # перед правкой из стольких объектов (или 5+ удалений) — снимок на сервере
SNAPSHOT_KEEP = 50
SESSION_IDLE = 12 * 3600
BACKUP_NAME = re.compile(r'^(state|snapshot)-[0-9A-Za-z_.-]+\.json$')


def atomic_write(path, data, attempts=10):
    """Записать файл целиком через временный файл. На Windows замену может ненадолго
    заблокировать антивирус, индексатор или копирование: тогда несколько повторов."""
    if isinstance(data, str):
        data = data.encode('utf-8')
    tmp = '%s.%d-%d.tmp' % (path, os.getpid(), threading.get_ident())
    with open(tmp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())   # на Windows — FlushFileBuffers: данные на диске до ответа пользователю
    for attempt in range(attempts):
        try:
            _replace_durable(tmp, path)
            return
        except PermissionError:
            if attempt == attempts - 1:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise
            time.sleep(0.05 * (attempt + 1))


def _replace_durable(tmp, path):
    """os.replace, после которого и новое имя файла уже на диске (на случай отключения питания)."""
    if os.name == 'nt':
        try:
            import ctypes
            kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
            move = kernel32.MoveFileExW
            move.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
            move.restype = ctypes.c_int
        except (ImportError, AttributeError, OSError):
            move = None
        if move is not None:
            # MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH: функция возвращается, когда замена записана на диск
            if move(os.path.abspath(tmp), os.path.abspath(path), 0x1 | 0x8):
                return
            err = ctypes.get_last_error()
            if err in (5, 32, 33):   # доступ запрещён / файл занят антивирусом или копированием
                raise PermissionError(err, 'Файл занят', path)
        os.replace(tmp, path)
        return
    os.replace(tmp, path)
    try:
        fd = os.open(os.path.dirname(os.path.abspath(path)) or '.', os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)   # запись о новом имени в каталоге — тоже на диск
    except OSError:
        pass
    finally:
        os.close(fd)


def read_json(path, what):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except ValueError as e:
        raise SystemExit('Файл %s повреждён (%s): %s. Восстановите его из папки backups или удалите.' % (what, path, e))


def token_key(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


class SharedError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class DataLock:
    """Only one desktop process may write a given state directory, on any port."""
    def __init__(self, folder):
        self.file = open(os.path.join(folder, 'program.lock'), 'a+b')
        self.file.seek(0, 2)
        if not self.file.tell():
            self.file.write(b'0')
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise

    def close(self):
        if not self.file.closed:
            self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 200000).hex()


def alive_count(karta_net):
    try:
        return sum(1 for o in json.loads(karta_net).get('objs', {}).values() if not o.get('f', {}).get('deleted'))
    except (ValueError, TypeError, AttributeError):
        return 0


def write_snapshot(folder, state, reason):
    if not state or not state.get('karta_net'):
        return None
    os.makedirs(folder, exist_ok=True)
    reason = re.sub(r'[^0-9A-Za-z_-]+', '_', reason)[:30] or 'mass'
    name = 'snapshot-%s-%03d-%s.json' % (time.strftime('%Y-%m-%d_%H-%M-%S'), int(time.time() * 1000) % 1000, reason)
    atomic_write(os.path.join(folder, name), json.dumps(state, ensure_ascii=False))
    old = sorted(n for n in os.listdir(folder) if n.startswith('snapshot-') and n.endswith('.json'))
    for n in old[:-SNAPSHOT_KEEP]:
        try:
            os.remove(os.path.join(folder, n))
        except OSError:
            pass
    return name


def dedupe_backups(folder, items):
    """Одинаковые по содержимому копии — одной строкой (самая новая). Первая копия часа и первая копия
    дня делаются в одну минуту из одного и того же файла; снимок перед правкой тоже может совпасть
    с плановой копией. Сравниваются только файлы одного размера, их содержимое — по SHA-256."""
    sizes = {}
    for b in items:
        sizes[b['size']] = sizes.get(b['size'], 0) + 1
    seen, out = set(), []
    for b in items:
        if sizes[b['size']] > 1:
            h = hashlib.sha256()
            try:
                with open(os.path.join(folder, b['name']), 'rb') as f:
                    for chunk in iter(lambda: f.read(1 << 20), b''):
                        h.update(chunk)
            except OSError:
                continue
            key = (b['size'], h.hexdigest())
            if key in seen:
                continue
            seen.add(key)
        out.append(b)
    return out


class Shared:
    def __init__(self, state, folder):
        self.state = state
        self.folder = folder
        self.path = os.path.join(folder, 'shared-users.json')
        self.sessions_path = os.path.join(folder, 'shared-sessions.json')
        # Обрывки записи, прерванной отключением питания (сам файл при этом цел — замена атомарная).
        for n in os.listdir(folder):
            if n.endswith('.tmp') and n.split('.json.')[0] + '.json' in ('state.json', 'shared-users.json', 'shared-sessions.json'):
                try:
                    os.remove(os.path.join(folder, n))
                except OSError:
                    pass
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)   # будит ожидающие запросы окон при каждой правке
        self.failures = {}
        if os.path.exists(self.path):
            self.users = read_json(self.path, 'учётных записей')
        else:
            self.users = {}
            atomic_write(self.path, '{}')
        # Входы переживают перезапуск сервера: в файле только хэши ключей, не сами ключи.
        self.sessions = {}
        if os.path.exists(self.sessions_path):
            try:
                with open(self.sessions_path, encoding='utf-8') as f:
                    saved = json.load(f)
                now = time.time()
                self.sessions = {k: v for k, v in saved.items()
                                 if isinstance(v, dict) and v.get('login') in self.users and now - v.get('seen', 0) < SESSION_IDLE}
            except (OSError, ValueError, AttributeError):
                self.sessions = {}
        # Номер версии растёт и после перезапуска (иначе открытые окна перестают видеть правки).
        stored = 0
        try:
            stored = int((self.state.load() or {}).get('_shared_rev', 0))
        except (ValueError, TypeError, OSError):
            stored = 0
        self.revision = max(int(time.time() * 1000), stored + 1)

    def _save_sessions(self):
        now = time.time()
        for key in [k for k, v in self.sessions.items() if now - v['seen'] > SESSION_IDLE]:
            del self.sessions[key]
        for v in self.sessions.values():
            v['saved'] = v['seen']
        try:
            atomic_write(self.sessions_path, json.dumps(self.sessions, ensure_ascii=False))
        except OSError:
            pass

    def bump(self):
        self.revision = max(self.revision + 1, int(time.time() * 1000))
        self.changed.notify_all()
        return self.revision

    def notify(self):
        with self.lock:
            self.changed.notify_all()

    def wait(self, user, revision, timeout):
        """Длинный опрос: ответить сразу, если карта изменилась, иначе ждать правки (или входа/выхода
        участника) не дольше timeout секунд. Так окна получают правки за доли секунды, без частого опроса."""
        deadline = time.monotonic() + max(0.0, min(float(timeout), 25.0))
        with self.lock:
            presence = self._presence_key()
            while revision == str(self.revision) and self._presence_key() == presence:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self.changed.wait(left)
            return self.snapshot(user, revision)

    def _presence_key(self):
        now = time.time()
        logins = sorted({s['login'] for s in self.sessions.values() if now - s['seen'] < 15})
        local = getattr(self, 'local_presence', None)
        return (tuple(logins), bool(local and now - local[1] < 15))

    def logout(self, key):
        with self.lock:
            if self.sessions.pop(key, None) is not None:
                self._save_sessions()
                self.changed.notify_all()

    def set_user(self, data, local_owner=False):
        if not isinstance(data, dict):
            raise SharedError(400, 'Неверные данные пользователя')
        with self.lock:
            login = str(data.get('login', '')).strip().lower()
            name = str(data.get('name', '')).strip()
            role = data.get('role')
            if not login or login == '@server' or len(login) > 40 or not name or len(name) > 80 or role not in ('admin', 'editor', 'viewer'):
                raise SharedError(400, 'Укажите логин, имя и роль')
            users = copy.deepcopy(self.users)
            old = users.get(login, {})
            if data.get('create') and old:
                raise SharedError(409, 'Логин «%s» уже занят. Выберите другой или измените существующего пользователя.' % login)
            if data.get('disable'):
                users.pop(login, None)
            else:
                password = str(data.get('password', ''))
                if password and len(password) < 8 or not old and not password:
                    raise SharedError(400, 'Пароль должен содержать не менее 8 символов')
                user = dict(old, login=login, name=name, role=role)
                if password:
                    user['salt'] = secrets.token_hex(16)
                    user['hash'] = password_hash(password, user['salt'])
                users[login] = user
            if not local_owner and any(u['role'] == 'admin' for u in self.users.values()) and not any(u['role'] == 'admin' for u in users.values()):
                raise SharedError(400, 'Нужно сохранить хотя бы одного администратора')
            atomic_write(self.path, json.dumps(users, ensure_ascii=False))
            self.users = users
            changed = False
            for token, session in list(self.sessions.items()):
                if session['login'] == login:
                    del self.sessions[token]
                    changed = True
            if changed:
                self._save_sessions()

    def login(self, data, ip):
        if not isinstance(data, dict):
            raise SharedError(400, 'Неверные данные входа')
        with self.lock:
            now = time.time()
            for key in [k for k, v in self.failures.items() if now - v[1] > 60]:
                del self.failures[key]
            count, ts = self.failures.get(ip, (0, 0))
            if count >= 5 and now - ts < 60:
                raise SharedError(429, 'Повторите вход через минуту')
            user = self.users.get(str(data.get('login', '')).strip().lower())
            user = dict(user) if user else None
        # PBKDF2 считается без общей блокировки: вход одного не тормозит работу остальных
        password = str(data.get('password', ''))[:1024]
        ok = bool(user) and hmac.compare_digest(user['hash'], password_hash(password, user['salt']))
        with self.lock:
            if not ok or self.users.get(user['login'], {}).get('hash') != user['hash']:
                count, ts = self.failures.get(ip, (0, 0))
                self.failures[ip] = (count + 1 if time.time() - ts < 60 else 1, time.time())
                raise SharedError(401, 'Неверный логин или пароль')
            self.failures.pop(ip, None)
            token = secrets.token_urlsafe(32)
            self.sessions[token_key(token)] = dict(login=user['login'], ip=ip, seen=time.time(), since=time.time())
            self._save_sessions()
            self.changed.notify_all()
            return token

    def identify(self, cookie):
        cookies = SimpleCookie()
        try:
            cookies.load(cookie or '')
            token = cookies['karta_session'].value
        except (KeyError, ValueError):
            raise SharedError(401, 'Войдите в программу')
        key = token_key(token)
        with self.lock:
            session = self.sessions.get(key)
            if not session or time.time() - session['seen'] > SESSION_IDLE or session['login'] not in self.users:
                if self.sessions.pop(key, None) is not None:
                    self._save_sessions()
                raise SharedError(401, 'Войдите в программу')
            returned = time.time() - session['seen'] >= 15   # участник снова в сети — сообщить остальным
            session['seen'] = time.time()
            if returned:
                self.changed.notify_all()
            if session['seen'] - session.get('saved', 0) > 300:
                self._save_sessions()
            return self.public(self.users[session['login']]), key

    @staticmethod
    def public(user):
        return {k: user[k] for k in ('login', 'name', 'role')}

    def net(self):
        return json.loads((self.state.load() or {}).get('karta_net', '{"v":1,"objs":{},"journal":[]}'))

    def snapshot(self, user, revision=None):
        with self.lock:
            online = {}
            for session in self.sessions.values():
                if time.time() - session['seen'] < 15 and session['login'] in self.users:
                    u = self.public(self.users[session['login']])
                    online[u['login']] = dict(u, ip=session['ip'])
            result = dict(revision=self.revision, user=user, online=list(online.values()))
            local = getattr(self, 'local_presence', None)
            if local and time.time() - local[1] < 15:
                result['online'].insert(0, dict(local[0], ip='127.0.0.1'))
            if not user or user.get('role') != 'admin':
                result['online'] = [{k: v for k, v in u.items() if k != 'ip'} for u in result['online']]
            if revision != str(self.revision):
                result['net'] = self.net()
            return result

    @staticmethod
    def validate(obj, id):
        if not isinstance(obj, dict) or obj.get('id') != id or obj.get('type') not in ('node', 'fiber', 'radio') or not isinstance(obj.get('f'), dict):
            raise SharedError(400, 'Неверная структура объекта')
        f = obj['f']
        if f.get('deleted'):
            return
        points = [f] if obj['type'] == 'node' else f.get('fnodes' if obj['type'] == 'fiber' else 'points')
        if not isinstance(points, list) or (obj['type'] != 'node' and len(points) < 2):
            raise SharedError(400, 'У линии должно быть не меньше двух точек')
        for p in points:
            if isinstance(p, dict) and obj['type'] != 'node' and not isinstance(p.get('nid', ''), str):
                raise SharedError(400, 'Неверная ссылка на узел')
            if not isinstance(p, dict) or any(not isinstance(p.get(k), (int, float)) or not math.isfinite(p[k]) or abs(p[k]) > limit for k, limit in [('lat', 90), ('lng', 180)]):
                raise SharedError(400, 'Неверные координаты')
        if obj['type'] == 'radio' and len(points) != 2:
            raise SharedError(400, 'Радиолиния соединяет две точки')
        if obj['type'] == 'fiber' and (not isinstance(f.get('lay'), list) or len(f['lay']) != len(points)-1 or any(k not in ('air','ground','surface','air_guess','ground_guess') for k in f['lay'])):
            raise SharedError(400, 'Неверные участки ВОЛС')
        fib = f.get('fibers')   # число жил: необязательно; старые файлы — строкой свободного вида
        if fib is not None and (isinstance(fib, bool) or not isinstance(fib, (str, int)) or len(str(fib)) > 40
                                or (isinstance(fib, int) and not 0 <= fib <= 10000)):
            raise SharedError(400, 'Неверное число жил')

    def apply(self, user, data):
        if user['role'] == 'viewer':
            raise SharedError(403, 'Доступен только просмотр')
        ops = data.get('ops') if isinstance(data, dict) else None
        if not isinstance(ops, list) or len(ops) > 10000:
            raise SharedError(400, 'Неверный список изменений')
        with self.lock:
            net = self.net()
            ids = set()
            conflicts = []
            for op in ops:
                if not isinstance(op, dict):
                    raise SharedError(400, 'Неверное изменение')
                id = op.get('id')
                if not isinstance(id, str) or not id or len(id) > 200 or id in ('__proto__', 'constructor', 'prototype') or id in ids:
                    raise SharedError(400, 'Неверный идентификатор')
                ids.add(id)
                if net['objs'].get(id) != op.get('before'):
                    conflicts.append(id)
                if op.get('after') is not None:
                    self.validate(op['after'], id)
            if conflicts:
                return dict(conflicts=conflicts, **self.snapshot(user)), 409
            deletions = sum(1 for op in ops if (net['objs'].get(op['id']) and not net['objs'][op['id']]['f'].get('deleted'))
                            and (op.get('after') is None or op['after']['f'].get('deleted')))
            if deletions > MASS_DELETE and user['role'] != 'admin':
                raise SharedError(403, 'Удалить сразу больше %d объектов (замена или откат карты) может только администратор' % MASS_DELETE)
            if len(ops) >= SNAPSHOT_OPS or deletions >= 5 or data.get('reason'):
                self.make_snapshot(str(data.get('reason') or 'mass'))
            now = int(time.time() * 1000)
            for op in ops:
                id, old, obj = op['id'], net['objs'].get(op['id']), copy.deepcopy(op.get('after'))
                if obj is None:
                    if not old:
                        continue
                    obj = copy.deepcopy(old)
                    obj['f']['deleted'] = True
                obj['by'], obj['byId'], obj['t'] = user['name'], user['login'], now
                if old:
                    obj['createdBy'] = old.get('createdBy', old.get('by', user['name']))
                    obj['createdById'] = old.get('createdById', old.get('byId', ''))
                else:
                    obj['createdBy'], obj['createdById'] = user['name'], user['login']
                ft = dict((old or {}).get('ft', {}))
                for key in obj['f']:
                    if not old or obj['f'].get(key) != old['f'].get(key):
                        ft[key] = max(now, ft.get(key, 0) + 1)
                obj['ft'] = ft
                net['objs'][id] = obj
                net.setdefault('journal', []).insert(0, dict(t=now, by=user['name'], byId=user['login'], id=id, type=obj['type'], name=obj['f'].get('name', ''), what='удалён' if obj['f'].get('deleted') else 'изменён' if old else 'добавлен'))
            # Node coordinates are authoritative for attached endpoints.
            for line in net['objs'].values():
                if line['type'] == 'node' or line['f'].get('deleted'):
                    continue
                f = line['f']
                previous_fields = copy.deepcopy(f)
                pts = f.get('fnodes' if line['type'] == 'fiber' else 'points', [])
                for p in pts:
                    if not p.get('nid'):
                        continue
                    node = net['objs'].get(p['nid'])
                    if node and node['type'] == 'node' and not node['f'].get('deleted'):
                        p.update(lat=node['f']['lat'], lng=node['f']['lng'], name=node['f'].get('name', ''))
                    else:
                        p.pop('nid', None)
                        p['name'] = ''
                        if p.get('kind') == 'узел':
                            p['kind'] = 'точка'
                f['from'], f['to'] = pts[0].get('nid', ''), pts[-1].get('nid', '')
                distance = 0
                for a, b in zip(pts, pts[1:]):
                    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
                    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b['lng']-a['lng'])/2)**2
                    distance += 6371 * 2 * math.asin(min(1, math.sqrt(h)))
                f['dist'] = round(distance, 4)
                if f != previous_fields:
                    line.setdefault('createdBy', line.get('by', user['name']))
                    line.setdefault('createdById', line.get('byId', ''))
                    line['t'], line['by'], line['byId'] = now, user['name'], user['login']
                    for key in f:
                        if f.get(key) != previous_fields.get(key):
                            ft = line.setdefault('ft', {})
                            ft[key] = max(now, ft.get(key, 0) + 1)
            net['journal'] = net.get('journal', [])[:1000]
            state = self.state.load() or {}
            state['karta_net'] = json.dumps(net, ensure_ascii=False)
            if ops:
                state['_shared_rev'] = str(self.bump())
            self.state.save(state)
            return self.snapshot(user), 200

    # --- снимки и восстановление (только администратор)

    def backups_dir(self):
        return os.path.join(self.folder, 'backups')

    def make_snapshot(self, reason):
        """Копия общей карты перед массовой правкой: backups/snapshot-<время>-<причина>.json."""
        return write_snapshot(self.backups_dir(), self.state.load(), reason)

    def list_backups(self):
        folder = self.backups_dir()
        try:
            names = [n for n in os.listdir(folder) if BACKUP_NAME.match(n)]
        except OSError:
            names = []
        out = []
        for n in names:
            full = os.path.join(folder, n)
            try:
                st = os.stat(full)
            except OSError:
                continue
            out.append(dict(name=n, size=st.st_size, mtime=int(st.st_mtime * 1000),
                            kind='снимок перед массовой правкой' if n.startswith('snapshot-') else 'плановая копия'))
        out.sort(key=lambda b: (b['mtime'], b['name']), reverse=True)
        return dedupe_backups(folder, out)[:200]

    def restore(self, user, name):
        if user['role'] != 'admin':
            raise SharedError(403, 'Восстанавливать карту может только администратор')
        if not isinstance(name, str) or not BACKUP_NAME.match(name):
            raise SharedError(400, 'Неверное имя копии')
        path = os.path.join(self.backups_dir(), name)
        try:
            with open(path, encoding='utf-8') as f:
                backup = json.loads(json.load(f)['karta_net'])
            if not isinstance(backup, dict) or not isinstance(backup.get('objs'), dict):
                raise ValueError
        except (OSError, ValueError, KeyError, TypeError):
            raise SharedError(400, 'Копия повреждена или не найдена')
        with self.lock:
            self.make_snapshot('before-restore')
            net = self.net()
            now = int(time.time() * 1000)
            restored = dict(net, objs=backup['objs'])
            restored['journal'] = ([dict(t=now, by=user['name'], byId=user['login'], id='', type='', name=name,
                                         what='карта восстановлена из копии')] + net.get('journal', []))[:1000]
            state = self.state.load() or {}
            state['karta_net'] = json.dumps(restored, ensure_ascii=False)
            state['_shared_rev'] = str(self.bump())
            self.state.save(state)
            return self.snapshot(user)
