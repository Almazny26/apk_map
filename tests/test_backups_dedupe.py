"""3.5.1: первая копия часа и дня — один файл на диске и одна строка в «Копиях»."""
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import run
from shared import Shared


class BackupDedupeTest(unittest.TestCase):
    def test_hour_and_day_copy_listed_once(self):
        with tempfile.TemporaryDirectory() as folder:
            app = run.App(folder, lambda *a: None)
            app.state.save({'karta_net': json.dumps({'v': 1, 'objs': {}, 'journal': []})})
            sh = Shared(app.state, folder)
            made = run.backup_once(folder, app.state, now=time.localtime(1795000000))
            self.assertEqual(len([m for m in made if m.startswith('state-')]), 2)
            names = [b['name'] for b in sh.list_backups()]
            self.assertEqual(len(names), 1, names)
            hour = [m for m in made if m.startswith('state-') and '_' in m][0]
            day = [m for m in made if m.startswith('state-') and '_' not in m][0]
            a, b = os.path.join(folder, 'backups', hour), os.path.join(folder, 'backups', day)
            if hasattr(os, 'link'):
                self.assertTrue(os.path.samefile(a, b))
            # копия часа ушла по сроку — копия дня осталась целой
            os.remove(a)
            with open(b) as f:
                self.assertIn('karta_net', json.load(f))
            self.assertEqual([x['name'] for x in sh.list_backups()], [day])

    def test_different_content_kept(self):
        with tempfile.TemporaryDirectory() as folder:
            app = run.App(folder, lambda *a: None)
            app.state.save({'karta_net': json.dumps({'v': 1, 'objs': {}, 'journal': []})})
            sh = Shared(app.state, folder)
            run.backup_once(folder, app.state, now=time.localtime(1795000000))
            app.state.save({'karta_net': json.dumps({'v': 1, 'objs': {}, 'journal': [1]})})
            run.backup_once(folder, app.state, now=time.localtime(1795000000 + 3600))
            self.assertEqual(len(sh.list_backups()), 2)


if __name__ == '__main__':
    unittest.main()
