package ru.netmap.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

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
import java.util.HashMap;
import java.util.Map;

/**
 * Оболочка для клиента «Карта сети».
 *
 * Сам клиент (каталог web/ репозитория) вшит в APK и открывается из assets, поэтому приложение
 * запускается и без связи. Оболочка добавляет то, чего нет у страницы в браузере:
 *   - хранение данных в файлах приложения (мост NetMapNative.load/save);
 *   - кэш плиток карты на диске, чтобы карта открывалась без интернета;
 *   - разрешение на геолокацию.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/index.html";
    /** Клиент помечает адреса плиток этим параметром; перед запросом к серверу карт он убирается. */
    private static final String TILE_MARK = "nmcache=1";
    private static final long TILE_MAX_AGE_MS = 90L * 24 * 3600 * 1000;
    private static final int REQ_LOCATION = 1;

    private WebView web;
    private File tileDir;
    private File dataDir;
    private volatile long lastTileFailure = 0;

    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        tileDir = new File(getFilesDir(), "tiles");
        dataDir = new File(getFilesDir(), "data");
        tileDir.mkdirs();
        dataDir.mkdirs();

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        // Страница открыта из assets (file://), а сервер у каждого свой — разрешаем ей ходить к нему.
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setGeolocationEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "NetMapNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.loadUrl(START_URL);
    }

    @Override
    public void onBackPressed() {
        // Сначала даём клиенту закрыть открытую панель; если закрывать нечего — сворачиваем приложение.
        web.evaluateJavascript("(window.__nmBack && window.__nmBack()) ? 'handled' : 'no'", value -> {
            if (value == null || !value.contains("handled")) {
                moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LOCATION || geoCallback == null) {
            return;
        }
        boolean granted = false;
        for (int r : grantResults) {
            if (r == PackageManager.PERMISSION_GRANTED) {
                granted = true;
            }
        }
        geoCallback.invoke(geoOrigin, granted, false);
        geoCallback = null;
        geoOrigin = null;
    }

    // ------------------------------------------------------------------ мост для клиента

    private class Bridge {
        @JavascriptInterface
        public String load(String key) {
            File f = dataFile(key);
            if (f == null || !f.exists()) {
                return null;
            }
            try (InputStream in = new FileInputStream(f)) {
                return new String(readAll(in), StandardCharsets.UTF_8);
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public boolean save(String key, String value) {
            File f = dataFile(key);
            if (f == null) {
                return false;
            }
            if (value == null) {
                return !f.exists() || f.delete();
            }
            // Пишем во временный файл и переименовываем: при обрыве записи старые данные не портятся.
            File tmp = new File(f.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(value.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            } catch (Exception e) {
                tmp.delete();
                return false;
            }
            return tmp.renameTo(f);
        }

        @JavascriptInterface
        public String versionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public int versionCode() {
            try {
                return (int) getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
            } catch (Exception e) {
                return 0;
            }
        }

        /** Сколько места занимает сохранённая карта, в байтах. */
        @JavascriptInterface
        public double tileCacheBytes() {
            long total = 0;
            File[] files = tileDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    total += f.length();
                }
            }
            return (double) total;
        }

        @JavascriptInterface
        public int tileCacheCount() {
            String[] names = tileDir.list();
            return names == null ? 0 : names.length;
        }

        @JavascriptInterface
        public void clearTileCache() {
            File[] files = tileDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    f.delete();
                }
            }
        }

        @JavascriptInterface
        public void openExternal(String url) {
            openInSystem(Uri.parse(url));
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }

    private File dataFile(String key) {
        if (key == null || !key.matches("[A-Za-z0-9_\\-]{1,64}")) {
            return null;
        }
        return new File(dataDir, key + ".json");
    }

    private void openInSystem(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // нет приложения, которое умеет открыть ссылку
        }
    }

    // ------------------------------------------------------------------ страница и кэш карты

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("file".equals(uri.getScheme())) {
                return false;
            }
            // Любая внешняя ссылка (например, скачивание обновления) открывается в браузере телефона.
            openInSystem(uri);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            try {
                if (!"GET".equalsIgnoreCase(request.getMethod())) {
                    return null;
                }
                String url = request.getUrl().toString();
                if (!url.startsWith("http") || !url.contains(TILE_MARK)) {
                    return null;
                }
                return serveTile(stripMark(url));
            } catch (Throwable t) {
                return null;
            }
        }
    }

    private static String stripMark(String url) {
        String u = url.replace("?" + TILE_MARK + "&", "?")
                .replace("?" + TILE_MARK, "")
                .replace("&" + TILE_MARK, "");
        return u;
    }

    private WebResourceResponse serveTile(String url) throws Exception {
        File f = new File(tileDir, sha1(url));
        boolean have = f.exists() && f.length() > 0;
        boolean fresh = have && System.currentTimeMillis() - f.lastModified() < TILE_MAX_AGE_MS;
        if (!fresh) {
            // Недавно уже не получилось скачать — значит, связи нет; не заставляем карту ждать таймаутов.
            boolean offline = System.currentTimeMillis() - lastTileFailure < 20000;
            if (!(have && offline)) {
                try {
                    download(url, f);
                    have = true;
                } catch (Exception e) {
                    lastTileFailure = System.currentTimeMillis();
                }
            }
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        if (!have) {
            return new WebResourceResponse("text/plain", "utf-8", 504, "Offline", headers,
                    new ByteArrayInputStream(new byte[0]));
        }
        headers.put("Cache-Control", "max-age=86400");
        return new WebResourceResponse(sniffMime(f), null, 200, "OK", headers, new FileInputStream(f));
    }

    private void download(String url, File target) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        c.setRequestProperty("User-Agent", "KartaSeti/1.0 (Android; internal network map)");
        try {
            if (c.getResponseCode() != 200) {
                throw new Exception("HTTP " + c.getResponseCode());
            }
            byte[] body;
            try (InputStream in = c.getInputStream()) {
                body = readAll(in);
            }
            if (body.length == 0) {
                throw new Exception("empty");
            }
            File tmp = new File(target.getPath() + "." + Thread.currentThread().getId() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(body);
            }
            if (!tmp.renameTo(target)) {
                tmp.delete();
            }
        } finally {
            c.disconnect();
        }
    }

    private static String sniffMime(File f) {
        byte[] head = new byte[12];
        try (InputStream in = new FileInputStream(f)) {
            int n = in.read(head);
            if (n >= 3 && (head[0] & 0xFF) == 0xFF && (head[1] & 0xFF) == 0xD8) {
                return "image/jpeg";
            }
            if (n >= 12 && head[0] == 'R' && head[1] == 'I' && head[8] == 'W' && head[9] == 'E') {
                return "image/webp";
            }
        } catch (Exception ignored) {
            // считаем PNG
        }
        return "image/png";
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static String sha1(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------ геолокация

    private class Chrome extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                callback.invoke(origin, true, false);
                return;
            }
            geoCallback = callback;
            geoOrigin = origin;
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }
    }
}
