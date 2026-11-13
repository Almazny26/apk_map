package ru.netmap.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * Офлайн-карта районов: файлы PMTiles v3 (векторные плитки OpenStreetMap, сборка Protomaps) в папке
 * files/maps. По номеру плитки отдаёт её байты — страница (MapLibre GL) рисует карту сама.
 *
 * Формат: заголовок 127 байт, корневой каталог, листовые каталоги, данные плиток. Каталог —
 * записи (номер плитки по кривой Гильберта, длина серии, смещение, размер), сжатые gzip.
 */
final class OfflineTiles {

    private static final class Dir {
        long[] ids;
        long[] runs;
        long[] offs;
        long[] lens;
    }

    private static final class Pm {
        File file;
        String slug;
        long size;
        long mtime;
        RandomAccessFile raf;
        long leafOff;
        long dataOff;
        int internal;
        int tileComp;
        int tileType;       // 1 — векторные плитки (схема), иначе картинки (снимки)
        int minZoom;
        int maxZoom;
        double w;
        double s;
        double e;
        double n;
        Dir root;
        final LinkedHashMap<Long, Dir> leaves = new LinkedHashMap<Long, Dir>(32, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Long, Dir> eldest) {
                return size() > 48;
            }
        };

        synchronized byte[] read(long off, int len) throws IOException {
            byte[] b = new byte[len];
            raf.seek(off);
            raf.readFully(b);
            return b;
        }

        synchronized Dir leaf(long off, int len) throws IOException {
            Dir d = leaves.get(off);
            if (d == null) {
                d = parse(read(leafOff + off, len), internal);
                leaves.put(off, d);
            }
            return d;
        }

        synchronized void close() {
            try {
                raf.close();
            } catch (IOException ignored) {
                // всё равно
            }
        }
    }

    private final File dir;
    private List<Pm> files = new ArrayList<>();

    OfflineTiles(File dir) {
        this.dir = dir;
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        scan();
    }

    File dir() {
        return dir;
    }

    /** Перечитать папку: открыть новые и изменённые файлы, закрыть удалённые. */
    synchronized void scan() {
        List<Pm> next = new ArrayList<>();
        File[] list = dir.listFiles();
        if (list != null) {
            Arrays.sort(list);
            for (File f : list) {
                if (!f.isFile() || !f.getName().endsWith(".pmtiles")) {
                    continue;
                }
                Pm old = null;
                for (Pm p : files) {
                    if (p.file.equals(f) && p.size == f.length() && p.mtime == f.lastModified()) {
                        old = p;
                    }
                }
                if (old != null) {
                    next.add(old);
                    continue;
                }
                try {
                    next.add(open(f));
                } catch (Exception ignored) {
                    // испорченный файл пропускаем
                }
            }
        }
        for (Pm p : files) {
            if (!next.contains(p)) {
                p.close();
            }
        }
        files = next;
    }

    private static Pm open(File f) throws IOException {
        Pm p = new Pm();
        p.file = f;
        p.slug = f.getName().substring(0, f.getName().length() - ".pmtiles".length());
        p.size = f.length();
        p.mtime = f.lastModified();
        p.raf = new RandomAccessFile(f, "r");
        byte[] h = new byte[127];
        p.raf.readFully(h);
        if (h[0] != 'P' || h[1] != 'M' || h[2] != 'T' || h[3] != 'i' || h[7] != 3) {
            p.raf.close();
            throw new IOException("не PMTiles");
        }
        ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);
        long rootOff = b.getLong(8);
        long rootLen = b.getLong(16);
        p.leafOff = b.getLong(40);
        p.dataOff = b.getLong(56);
        p.internal = h[97];
        p.tileComp = h[98];
        p.tileType = h[99];
        p.minZoom = h[100];
        p.maxZoom = h[101];
        p.w = b.getInt(102) / 1e7;
        p.s = b.getInt(106) / 1e7;
        p.e = b.getInt(110) / 1e7;
        p.n = b.getInt(114) / 1e7;
        p.root = parse(p.read(rootOff, (int) rootLen), p.internal);
        return p;
    }

    private static byte[] gunzip(byte[] data) throws IOException {
        try (InputStream in = new GZIPInputStream(new ByteArrayInputStream(data))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(data.length * 4);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    private static Dir parse(byte[] raw, int compression) throws IOException {
        byte[] d = compression == 2 ? gunzip(raw) : raw;
        int[] pos = {0};
        int n = (int) varint(d, pos);
        Dir r = new Dir();
        r.ids = new long[n];
        r.runs = new long[n];
        r.offs = new long[n];
        r.lens = new long[n];
        long last = 0;
        for (int i = 0; i < n; i++) {
            last += varint(d, pos);
            r.ids[i] = last;
        }
        for (int i = 0; i < n; i++) {
            r.runs[i] = varint(d, pos);
        }
        for (int i = 0; i < n; i++) {
            r.lens[i] = varint(d, pos);
        }
        for (int i = 0; i < n; i++) {
            long v = varint(d, pos);
            r.offs[i] = v == 0 && i > 0 ? r.offs[i - 1] + r.lens[i - 1] : v - 1;
        }
        return r;
    }

    private static long varint(byte[] d, int[] pos) {
        long v = 0;
        int shift = 0;
        while (true) {
            int b = d[pos[0]++] & 0xFF;
            v |= (long) (b & 0x7F) << shift;
            if (b < 0x80) {
                return v;
            }
            shift += 7;
        }
    }

    /** Запись каталога для плитки: индекс или -1. */
    private static int find(Dir d, long id) {
        int lo = 0, hi = d.ids.length - 1;
        while (lo <= hi) {
            int k = (lo + hi) >>> 1;
            long c = id - d.ids[k];
            if (c > 0) {
                lo = k + 1;
            } else if (c < 0) {
                hi = k - 1;
            } else {
                return k;
            }
        }
        if (hi >= 0 && (d.runs[hi] == 0 || id - d.ids[hi] < d.runs[hi])) {
            return hi;
        }
        return -1;
    }

    /** Номер плитки по кривой Гильберта (как в PMTiles). */
    static long tileId(int z, long x, long y) {
        long acc = ((1L << (2 * z)) - 1) / 3;
        long tx = x, ty = y;
        for (int a = z - 1; a >= 0; a--) {
            long s = 1L << a;
            long rx = s & tx, ry = s & ty;
            acc += ((3 * rx) ^ ry) << a;
            if (ry == 0) {
                if (rx != 0) {
                    tx = s - 1 - tx;
                    ty = s - 1 - ty;
                }
                long t = tx;
                tx = ty;
                ty = t;
            }
        }
        return acc;
    }

    /** Плитка схемы (распакованная) из первого файла, где она есть; null — нет. */
    byte[] tile(int z, int x, int y) {
        return tile(z, x, y, false);
    }

    /** Плитка: sat — снимки (картинка), иначе схема. */
    byte[] tile(int z, int x, int y, boolean sat) {
        List<Pm> list;
        synchronized (this) {
            list = files;
        }
        if (z < 0 || z > 24) {
            return null;
        }
        long id = tileId(z, x, y);
        for (Pm p : list) {
            if ((p.tileType == 1) == sat || z < p.minZoom || z > p.maxZoom) {
                continue;
            }
            try {
                Dir d = p.root;
                for (int depth = 0; depth < 4; depth++) {
                    int i = find(d, id);
                    if (i < 0) {
                        break;
                    }
                    if (d.runs[i] > 0) {
                        byte[] data = p.read(p.dataOff + d.offs[i], (int) d.lens[i]);
                        return p.tileComp == 2 ? gunzip(data) : data;
                    }
                    d = p.leaf(d.offs[i], (int) d.lens[i]);
                }
            } catch (Exception ignored) {
                // файл заменяют или он испорчен — смотрим следующий
            }
        }
        return null;
    }

    /** Список файлов для страницы: [{slug, size, mtime, bounds: [запад, юг, восток, север]}]. */
    synchronized String list() {
        JSONArray a = new JSONArray();
        try {
            for (Pm p : files) {
                JSONObject o = new JSONObject();
                o.put("slug", p.slug);
                o.put("size", p.size);
                o.put("mtime", p.mtime);
                o.put("kind", p.tileType == 1 ? "map" : "sat");
                o.put("bounds", new JSONArray(new double[]{p.w, p.s, p.e, p.n}));
                a.put(o);
            }
        } catch (Exception ignored) {
            // пустой список
        }
        return a.toString();
    }

    synchronized boolean delete(String slug) {
        boolean ok = false;
        for (Pm p : files) {
            if (p.slug.equals(slug)) {
                p.close();
                ok = p.file.delete();
            }
        }
        scan();
        return ok;
    }

    /** Имя файла карты из произвольного имени: буквы, цифры, «_», «-», «.». */
    static String slug(String name) {
        String s = name == null ? "" : name;
        int slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        if (slash >= 0) {
            s = s.substring(slash + 1);
        }
        if (s.toLowerCase().endsWith(".pmtiles")) {
            s = s.substring(0, s.length() - 8);
        }
        s = s.replaceAll("[^0-9A-Za-zА-Яа-яЁё_.-]+", "_").replaceAll("^[._]+|[._]+$", "");
        if (s.isEmpty()) {
            s = "karta";
        }
        return s.length() > 60 ? s.substring(0, 60) : s;
    }
}
