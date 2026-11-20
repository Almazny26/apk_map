package ru.netmap.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * Вшитая офлайн-схема: файл PMTiles v3 (векторные плитки OpenStreetMap, сборка Protomaps) в assets APK
 * без сжатия. По номеру плитки отдаёт её байты — страница (MapLibre GL) рисует карту сама.
 * Скачивание районов и файлы карт с устройства убраны в 3.5.1: схема левобережья уже внутри приложения.
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
        String slug;
        long size;
        Closeable owner;
        FileChannel ch;
        long base;           // начало файла внутри APK
        long leafOff;
        long dataOff;
        int internal;
        int tileComp;
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

        /* Чтение куска по смещению прямо из файла (или из APK): карта целиком в память не читается. */
        byte[] read(long off, int len) throws IOException {
            if (off < 0 || len < 0 || off + len > size) {
                throw new IOException("за пределами файла");
            }
            byte[] b = new byte[len];
            ByteBuffer buf = ByteBuffer.wrap(b);
            long pos = base + off;
            while (buf.hasRemaining()) {
                int n = ch.read(buf, pos);
                if (n < 0) {
                    throw new IOException("файл короче ожидаемого");
                }
                pos += n;
            }
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
                owner.close();
            } catch (IOException ignored) {
                // всё равно
            }
        }
    }

    private final Pm embedded;

    /** embedded — вшитая в APK схема (assets/maps/*.pmtiles без сжатия); null — сборка без карты. */
    OfflineTiles(android.content.res.AssetFileDescriptor embedded) {
        Pm p = null;
        if (embedded != null) {
            try {
                java.io.FileInputStream in = embedded.createInputStream();
                p = new Pm();
                p.slug = "karta-offline";
                p.size = embedded.getLength();
                p.ch = in.getChannel();
                p.base = embedded.getStartOffset();
                p.owner = embedded;
                header(p);
            } catch (IOException | RuntimeException e) {
                if (p != null && p.owner != null) {
                    p.close();
                }
                p = null;
            }
        }
        this.embedded = p;
    }

    private static void header(Pm p) throws IOException {
        {
            byte[] h = p.read(0, 127);
            if (h[0] != 'P' || h[1] != 'M' || h[2] != 'T' || h[3] != 'i' || h[7] != 3) {
                throw new IOException("не PMTiles");
            }
            ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);
            long rootOff = b.getLong(8);
            long rootLen = b.getLong(16);
            if (rootOff < 127 || rootLen <= 0 || rootLen > 4 * 1024 * 1024 || rootLen > p.size - rootOff) {
                throw new IOException("неверный каталог PMTiles");
            }
            p.leafOff = b.getLong(40);
            p.dataOff = b.getLong(56);
            p.internal = h[97];
            p.tileComp = h[98];
            if (h[99] != 1) throw new IOException("не векторная схема");
            p.minZoom = h[100];
            p.maxZoom = h[101];
            p.w = b.getInt(102) / 1e7;
            p.s = b.getInt(106) / 1e7;
            p.e = b.getInt(110) / 1e7;
            p.n = b.getInt(114) / 1e7;
            p.root = parse(p.read(rootOff, (int) rootLen), p.internal);
            if (p.root.ids.length == 0) throw new IOException("пустой каталог PMTiles");
        }
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

    /** Плитка схемы (распакованная); null — нет. */
    byte[] tile(int z, int x, int y) {
        Pm p = embedded;
        if (p == null || z < p.minZoom || z > p.maxZoom || z < 0 || z > 24) {
            return null;
        }
        long id = tileId(z, x, y);
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
            // испорченная плитка — пустое место
        }
        return null;
    }

    /** Список для страницы: [{slug, size, kind, maxzoom, builtin, bounds: [запад, юг, восток, север]}]. */
    String list() {
        JSONArray a = new JSONArray();
        Pm p = embedded;
        if (p == null) {
            return a.toString();
        }
        try {
            JSONObject o = new JSONObject();
            o.put("slug", p.slug);
            o.put("size", p.size);
            o.put("mtime", 0);
            o.put("kind", "map");
            o.put("maxzoom", p.maxZoom);
            o.put("builtin", true);
            o.put("bounds", new JSONArray(new double[]{p.w, p.s, p.e, p.n}));
            a.put(o);
        } catch (Exception ignored) {
            // пустой список
        }
        return a.toString();
    }
}
