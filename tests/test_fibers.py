"""3.5.0: число жил ВОЛС — проверка на сервере, старые файлы без поля остаются годными."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared import Shared, SharedError


def fiber(**extra):
    f = dict(name='ВОЛС', fnodes=[dict(lat=46.5, lng=33.5, kind='опора'), dict(lat=46.6, lng=33.6, kind='муфта')], lay=['air'])
    f.update(extra)
    return dict(id='l1', type='fiber', f=f, ft={})


class FibersTest(unittest.TestCase):
    def check(self, obj):
        Shared.validate(obj, obj['id'])

    def test_old_and_new_values(self):
        self.check(fiber())                  # старый файл: поля нет
        self.check(fiber(fibers='16'))       # выбор чипом
        self.check(fiber(fibers=''))         # сброшено
        self.check(fiber(fibers=144))        # число из чужого импорта
        self.check(fiber(fibers='8 (4 занято)'))  # старый свободный текст

    def test_bad_values(self):
        for bad in (True, [16], {'n': 1}, 'x' * 41, -1, 10 ** 6, 1.5):
            with self.assertRaises(SharedError, msg=repr(bad)):
                self.check(fiber(fibers=bad))


if __name__ == '__main__':
    unittest.main()
