package ru.netmap.app;

import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * Запас плиток онлайн-карт на телефоне.
 *
 * Плитка, открытая с интернетом, сохраняется в памяти приложения и потом показывается без связи
 * (как кэш браузера, только надёжнее: не теряется при нехватке места). Обновляется не чаще раза
 * в 30 дней. Всего не больше 500 МБ — при превышении удаляются самые старые.
 * Без «Онлайн» в интернет не ходим: только то, что уже есть. Если источник ответил «такой плитки
 * нет» (404 — например, снимка этого масштаба), неделю его об этой плитке не спрашиваем.
 */
final class TileCache {
    private static final String[] HOSTS = {
            "tile.openstreetmap.org", "server.arcgisonline.com", "core-renderer-tiles.maps.yandex.net"
    };
    private static final long FRESH = 30L * 24 * 3600 * 1000;
    private static final long NONE = 7L * 24 * 3600 * 1000;   // «такой плитки нет» помним неделю
    private static final int MISSING = -404;
    private static final long LIMIT = 500L * 1024 * 1024;
    private static final String UA = "KartaSeti/2 (Android; https://github.com/Almazny26/apk_map)";

    private final File dir;

    TileCache(File dir) {
        this.dir = dir;
        dir.mkdirs();
    }

    static boolean handles(String host) {
        for (String h : HOSTS) {
            if (h.equals(host)) {
                return true;
            }
        }
        return false;
    }

    WebResourceResponse get(String url, boolean online) {
        File f = new File(dir, key(url));
        byte[] cached = null;
        if (f.exists()) {
            cached = read(f);
            if (cached != null && (!online || System.currentTimeMillis() - f.lastModified() < FRESH)) {
                return image(cached);
            }
        }
        if (online) {
            File none = new File(dir, key(url) + ".none");
            if (cached == null && none.exists() && System.currentTimeMillis() - none.lastModified() < NONE) {
                return missing();
            }
            int[] code = new int[1];
            byte[] fresh = download(url, code);
            if (fresh == null && code[0] != MISSING) {
                fresh = download(url, code);   // связь бывает медленной — вторая попытка
            }
            if (fresh != null) {
                write(f, fresh);
                return image(fresh);
            }
            if (code[0] == MISSING && cached == null) {
                write(none, new byte[0]);      // у источника такой плитки нет (например, снимка этого масштаба)
            }
        }
        return cached != null ? image(cached) : missing();
    }

    private static WebResourceResponse image(byte[] data) {
        String mime = "image/png";
        if (data.length > 3 && (data[0] & 0xff) == 0xff && (data[1] & 0xff) == 0xd8) {
            mime = "image/jpeg";
        }
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "max-age=3600");
        return new WebResourceResponse(mime, null, 200, "OK", h, new ByteArrayInputStream(data));
    }

    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                Collections.singletonMap("Access-Control-Allow-Origin", "*"), new ByteArrayInputStream(new byte[0]));
    }

    private static boolean picture(byte[] d) {
        if (d == null || d.length < 60) {
            return false;
        }
        boolean png = (d[0] & 0xff) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G';
        boolean jpg = (d[0] & 0xff) == 0xff && (d[1] & 0xff) == 0xd8;
        return png || jpg;
    }

    private static byte[] download(String url, int[] code) {
        HttpURLConnection c = null;
        code[0] = 0;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setRequestProperty("User-Agent", UA);
            int rc = c.getResponseCode();
            if (rc == 404) {
                code[0] = MISSING;
                return null;
            }
            if (rc != 200) {
                return null;
            }
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > 4 * 1024 * 1024) {
                        return null;
                    }
                }
                byte[] d = out.toByteArray();
                return picture(d) ? d : null;
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    private static byte[] read(File f) {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) f.length());
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    private static void write(File f, byte[] data) {
        File tmp = new File(f.getPath() + "." + Thread.currentThread().getId() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
        } catch (Exception e) {
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(f)) {
            tmp.delete();
        }
    }

    private static String key(String url) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-1").digest(url.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : h) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(url.hashCode());
        }
    }

    /** Удалить самые старые плитки, если запас больше лимита (до 80 % лимита). */
    void prune() {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long total = 0;
        for (File f : files) {
            total += f.length();
        }
        if (total <= LIMIT) {
            return;
        }
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : files) {
            if (total <= LIMIT * 8 / 10) {
                break;
            }
            long len = f.length();
            if (f.delete()) {
                total -= len;
            }
        }
    }
}
