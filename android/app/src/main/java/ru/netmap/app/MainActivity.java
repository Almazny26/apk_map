package ru.netmap.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.BufferedInputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Оболочка приложения «Карта сети» (основа — приложение товарища «WiFi Френель» 1.24).
 *
 * Поведение перенесено из его оболочки без изменений:
 *   - страница web/index.html открывается из assets; плитки карты и Leaflet отдаются из assets
 *     по адресу https://local.tiles/...;
 *   - без галочки «Онлайн» приложение не выходит в сеть (setBlockNetworkLoads), все внешние запросы
 *     получают пустой ответ;
 *   - мост AndroidBridge: fetchElevations (рельеф из assets/dem/dem.bin, при «Онлайн» — open-meteo),
 *     saveImage (PNG профиля в «Загрузки»), setOnline.
 *
 * Добавлено для обмена файлами (мост KartaFiles, им пользуется web/exchange.js):
 *   - «Поделиться» файлом данных (мессенджер, почта) и «Сохранить» в выбранную папку;
 *   - открытие файла: выбор в памяти телефона или «Открыть с помощью» из мессенджера.
 *
 * Добавлено для подложки (web/maps.js): плитки карт из интернета (OpenStreetMap, Esri, подписи
 * Яндекса) проходят через TileCache — просмотренное хранится в памяти приложения и видно без связи.
 *
 * Добавлено для карты сети (web/net.js): KartaFiles.locate() — местоположение по GPS или сети,
 * ответ в window.__kartaGeo(широта, долгота, точность, ошибка).
 */
public class MainActivity extends Activity {

    private static final String PREFS = "sec";
    private static final int REQ_OPEN = 2;
    private static final int REQ_SAVE = 3;
    private static final int REQ_LOC = 4;
    private static final long LOC_TIMEOUT = 25000;
    private static final long MAX_FILE = 64L * 1024 * 1024;

    private WebView web;
    private Dem dem;
    private TileCache tileCache;
    private OfflineTiles offline;

    private volatile String openedName = null;
    private volatile String openedText = null;
    private volatile String openedError = null;
    private String pendingSaveText = null;
    private boolean pageReady = false;
    private LocationListener locListener = null;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private boolean isOnline() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("online", false);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        tileCache = new TileCache(new File(getFilesDir(), "tilecache"));
        new Thread(tileCache::prune).start();
        File maps = new File(getFilesDir(), "maps");
        //noinspection ResultOfMethodCallIgnored
        maps.mkdirs();
        // файл карты из версий 3.0–3.1 переезжает в папку карт
        File legacy = new File(getFilesDir(), "karta-offline.pmtiles");
        if (legacy.isFile()) {
            //noinspection ResultOfMethodCallIgnored
            legacy.renameTo(new File(maps, "karta-offline.pmtiles"));
        }
        offline = new OfflineTiles(maps);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) {
            s.setSafeBrowsingEnabled(false);
        }
        s.setLoadsImagesAutomatically(true);
        s.setBlockNetworkImage(false);
        s.setBlockNetworkLoads(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUserAgentString("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
        WebView.setWebContentsDebuggingEnabled(false);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.addJavascriptInterface(new Files(), "KartaFiles");
        web.setWebViewClient(new Client());
        web.loadUrl("file:///android_asset/index.html");
        handleIncoming(getIntent());
    }

    @Override
    public void onBackPressed() {
        // «Назад» сначала закрывает открытое на странице (окно, меню, карточку, нанесение линии);
        // если закрывать нечего — приложение сворачивается, а не закрывается
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.__kartaBack && window.__kartaBack()) ? 1 : 0", v -> {
            if (!"1".equals(v)) {
                moveTaskToBack(true);
            }
        });
    }

    // ------------------------------------------------------------------ страница

    private class Client extends WebViewClient {
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            runOnUiThread(() -> {
                if (web != null) {
                    setContentView(new View(MainActivity.this));
                    web.destroy();
                    web = null;
                }
                recreate();
            });
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost();
            boolean local = host != null && "local.tiles".equals(host);
            if (host == null || local) {
                String path = url.getPath();
                if (path == null) {
                    return null;
                }
                int t = path.indexOf("tiles/");
                int l = path.indexOf("leaflet/");
                String asset = t >= 0 ? path.substring(t) : (l >= 0 ? path.substring(l) : null);
                if (asset == null || asset.contains("..")) {
                    return super.shouldInterceptRequest(view, request);
                }
                try {
                    InputStream in = getAssets().open(asset);
                    String mime = "image/png";
                    if (asset.endsWith(".css")) {
                        mime = "text/css";
                    } else if (asset.endsWith(".js")) {
                        mime = "application/javascript";
                    }
                    return new WebResourceResponse(mime, null, in);
                } catch (IOException e) {
                    return super.shouldInterceptRequest(view, request);
                }
            }
            if (host != null && TileCache.handles(host)) {
                return tileCache.get(url.toString(), isOnline());
            }
            if (isOnline()) {
                return null;
            }
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String scheme = request.getUrl().getScheme();
            if ("mailto".equals(scheme)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception ignored) {
                    // нет почтового приложения
                }
                return true;
            }
            if ("file".equals(scheme)) {
                return false;
            }
            return !isOnline();
        }
    }

    // ------------------------------------------------------------------ рельеф (как у товарища)

    static final class Dem {
        static final class Tile {
            int lat;
            int lon;
            int n;
            short[] v;
        }

        final java.util.ArrayList<Tile> tiles = new java.util.ArrayList<>();

        static Dem load(InputStream in) throws IOException {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
            }
            in.close();
            java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(out.toByteArray()).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            byte[] magic = new byte[4];
            b.get(magic);
            if (magic[0] != 'D' || magic[1] != 'E') {
                throw new IOException("bad dem");
            }
            int count = b.getShort() & 0xFFFF;
            Dem d = new Dem();
            for (int i = 0; i < count; i++) {
                Tile t = new Tile();
                t.lat = b.getShort();
                t.lon = b.getShort();
                t.n = b.getShort() & 0xFFFF;
                t.v = new short[t.n * t.n];
                for (int k = 0; k < t.v.length; k++) {
                    t.v[k] = b.getShort();
                }
                d.tiles.add(t);
            }
            return d;
        }

        Double sample(double lat, double lon) {
            int ilat = (int) Math.floor(lat);
            int ilon = (int) Math.floor(lon);
            for (Tile t : tiles) {
                if (t.lat == ilat && t.lon == ilon) {
                    double r = ((t.lat + 1.0) - lat) * (t.n - 1);
                    double c = (lon - t.lon) * (t.n - 1);
                    int r0 = (int) Math.floor(r);
                    int c0 = (int) Math.floor(c);
                    int r1 = Math.min(t.n - 1, r0 + 1);
                    int c1 = Math.min(t.n - 1, c0 + 1);
                    r0 = Math.max(0, Math.min(t.n - 1, r0));
                    c0 = Math.max(0, Math.min(t.n - 1, c0));
                    double fr = r - Math.floor(r);
                    double fc = c - Math.floor(c);
                    double bottom = t.v[r1 * t.n + c1] * fc + t.v[r1 * t.n + c0] * (1.0 - fc);
                    double top = t.v[r0 * t.n + c1] * fc + t.v[r0 * t.n + c0] * (1.0 - fc);
                    return bottom * fr + (1.0 - fr) * top;
                }
            }
            return null;
        }
    }

    private Dem dem() throws IOException {
        if (dem == null) {
            dem = Dem.load(getAssets().open("dem/dem.bin"));
        }
        return dem;
    }

    // ------------------------------------------------------------------ мост товарища

    private class Bridge {
        @JavascriptInterface
        public String fetchElevations(String locs) {
            JSONArray partial = null;
            try {
                Dem d = dem();
                String[] parts = locs.split("\\|");
                JSONArray arr = new JSONArray();
                int ok = 0;
                for (String part : parts) {
                    String[] ll = part.split(",");
                    JSONObject o = new JSONObject();
                    if (ll.length >= 2) {
                        Double v = d.sample(Double.parseDouble(ll[0]), Double.parseDouble(ll[1]));
                        if (v != null) {
                            o.put("elevation", v);
                            ok++;
                        } else {
                            o.put("elevation", JSONObject.NULL);
                        }
                    }
                    arr.put(o);
                }
                if (ok == parts.length && parts.length > 0) {
                    return offline(arr);
                }
                partial = arr;
            } catch (Exception ignored) {
                // рельефа нет — дальше по обстоятельствам
            }
            if (isOnline()) {
                try {
                    return openMeteo(locs);
                } catch (Exception ignored) {
                    // онлайн не ответил
                }
            }
            try {
                if (partial != null) {
                    return offline(partial);
                }
            } catch (Exception ignored) {
                // ниже — ошибка
            }
            return "{\"status\":\"ERROR\",\"error\":\"offline\"}";
        }

        @JavascriptInterface
        public String saveImage(String dataUrl) {
            if (dataUrl == null || !dataUrl.startsWith("data:image/png;base64,") || dataUrl.length() > 8000000) {
                return "ERR:bad image";
            }
            try {
                byte[] png = Base64.decode(dataUrl.substring(22), Base64.DEFAULT);
                String name = "fresnel_" + System.currentTimeMillis() + ".png";
                if (Build.VERSION.SDK_INT < 29) {
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists()) {
                        dir.mkdirs();
                    }
                    try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                        out.write(png);
                    }
                } else {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) {
                        return "ERR:no uri";
                    }
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) {
                            return "ERR:stream";
                        }
                        out.write(png);
                    }
                }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Сохранено: " + name, Toast.LENGTH_LONG).show());
                return "OK:" + name;
            } catch (Exception e) {
                return "ERR:" + e.getMessage();
            }
        }

        @JavascriptInterface
        public void setOnline(boolean on) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("online", on).commit();
            CountDownLatch latch = new CountDownLatch(1);
            runOnUiThread(() -> {
                try {
                    if (web != null) {
                        WebSettings s = web.getSettings();
                        s.setBlockNetworkLoads(!on);
                        s.setBlockNetworkImage(false);
                        s.setCacheMode(on ? WebSettings.LOAD_DEFAULT : WebSettings.LOAD_NO_CACHE);
                    }
                } finally {
                    latch.countDown();
                }
            });
            try {
                latch.await(1500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static String offline(JSONArray results) throws Exception {
        JSONObject o = new JSONObject();
        o.put("status", "OK");
        o.put("source", "offline");
        o.put("results", results);
        return o.toString();
    }

    private static String openMeteo(String locs) throws Exception {
        StringBuilder lat = new StringBuilder(), lon = new StringBuilder();
        for (String part : locs.split("\\|")) {
            String[] ll = part.split(",");
            if (ll.length >= 2) {
                if (lat.length() > 0) {
                    lat.append(',');
                    lon.append(',');
                }
                lat.append(ll[0]);
                lon.append(ll[1]);
            }
        }
        JSONArray el = new JSONObject(httpGet("https://api.open-meteo.com/v1/elevation?latitude=" + lat + "&longitude=" + lon))
                .getJSONArray("elevation");
        JSONArray res = new JSONArray();
        for (int i = 0; i < el.length(); i++) {
            if (el.isNull(i)) {
                return "{\"status\":\"ERROR\",\"error\":\"null elevation\"}";
            }
            JSONObject o = new JSONObject();
            o.put("elevation", el.getDouble(i));
            res.put(o);
        }
        JSONObject out = new JSONObject();
        out.put("status", "OK");
        out.put("results", res);
        return out.toString();
    }

    private static String httpGet(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("GET");
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        int code = c.getResponseCode();
        InputStream in = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in))) {
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
            }
        }
        c.disconnect();
        if (code < 200 || code >= 300) {
            throw new IOException("HTTP " + code);
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------ обмен файлами (добавлено)

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncoming(intent);
    }

    /** Файл, открытый из мессенджера («Открыть с помощью» или «Поделиться» в приложение). */
    private void handleIncoming(Intent intent) {
        if (intent == null) {
            return;
        }
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri != null) {
            readUri(uri);
        }
    }

    private void readUri(Uri uri) {
        new Thread(() -> {
            String name = displayName(uri), text = null, error = null;
            try (InputStream raw = getContentResolver().openInputStream(uri)) {
                if (raw == null) {
                    throw new IOException("нет доступа к файлу");
                }
                BufferedInputStream in = new BufferedInputStream(raw, 65536);
                // файл офлайн-карты (PMTiles) — не обмен данными, а подложка: копируется к приложению
                in.mark(16);
                byte[] magic = new byte[7];
                int got = 0, k;
                while (got < 7 && (k = in.read(magic, got, 7 - got)) > 0) {
                    got += k;
                }
                in.reset();
                if (got == 7 && "PMTiles".equals(new String(magic, StandardCharsets.US_ASCII))) {
                    importMap(in, name);
                    return;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                int n;
                long total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_FILE) {
                        throw new IOException("файл слишком большой");
                    }
                    out.write(buf, 0, n);
                }
                text = new String(out.toByteArray(), StandardCharsets.UTF_8);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            openedName = name;
            openedText = text;
            openedError = error;
            runOnUiThread(this::notifyOpened);
        }).start();
    }

    // ------------------------------------------------------------------ офлайн-карта районов (3.2)

    private volatile boolean mapBusy = false;
    private volatile boolean mapCancel = false;

    private void mapDone(boolean ok, String msg) {
        final String m = JSONObject.quote(msg == null ? "" : msg);
        runOnUiThread(() -> js("window.__kartaMap && window.__kartaMap(" + ok + "," + m + ")"));
    }

    private void mapProgress(String slug, long done, long total) {
        final String q = JSONObject.quote(slug);
        runOnUiThread(() -> js("window.__kartaMapProgress && window.__kartaMapProgress(" + q + "," + done + "," + total + ")"));
    }

    /** Поток → файл карты в папке карт (через временный файл); ход — странице. */
    private void storeMap(InputStream in, String slug, long total, long already, File tmp) throws IOException {
        try (OutputStream out = new FileOutputStream(tmp, already > 0)) {
            byte[] buf = new byte[1 << 18];
            int n;
            long done = already, shown = 0;
            while ((n = in.read(buf)) > 0) {
                if (mapCancel) {
                    throw new IOException("отменено");
                }
                out.write(buf, 0, n);
                done += n;
                if (done - shown >= 2L << 20) {
                    shown = done;
                    mapProgress(slug, done, total);
                }
            }
            out.flush();
            if (total > 0 && done != total) {
                throw new IOException("связь оборвалась, скачано не всё — нажмите «Скачать» ещё раз, продолжится с того же места");
            }
        }
        byte[] magic = new byte[7];
        try (InputStream chk = new java.io.FileInputStream(tmp)) {
            if (chk.read(magic) != 7 || !"PMTiles".equals(new String(magic, StandardCharsets.US_ASCII))) {
                throw new IOException("это не файл офлайн-карты");
            }
        }
        offline.delete(slug);
        File dst = new File(offline.dir(), slug + ".pmtiles");
        if (!tmp.renameTo(dst)) {
            throw new IOException("не удалось сохранить карту");
        }
        offline.scan();
    }

    /** Файл карты, выбранный на телефоне или открытый из мессенджера. */
    private void importMap(InputStream in, String name) {
        if (mapBusy) {
            mapDone(false, "подождите, идёт загрузка другой карты");
            return;
        }
        mapBusy = true;
        mapCancel = false;
        String slug = OfflineTiles.slug(name);
        File tmp = new File(offline.dir(), slug + ".import");
        try {
            tmp.delete();
            storeMap(in, slug, 0, 0, tmp);
            mapDone(true, slug);
        } catch (Exception e) {
            tmp.delete();
            mapDone(false, e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            mapBusy = false;
        }
    }

    /** Скачать файл района из интернета; при обрыве следующая попытка продолжает с того же места. */
    private void downloadMap(String slug, String address) {
        File tmp = new File(offline.dir(), slug + ".part");
        HttpURLConnection c = null;
        try {
            long have = tmp.isFile() ? tmp.length() : 0;
            c = (HttpURLConnection) new URL(address).openConnection();
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "KartaSeti-Android");
            if (have > 0) {
                c.setRequestProperty("Range", "bytes=" + have + "-");
            }
            int code = c.getResponseCode();
            if (code == 416) {
                // временный файл уже целый или испорчен — начать заново
                tmp.delete();
                throw new IOException("попробуйте ещё раз");
            }
            if (code != 200 && code != 206) {
                throw new IOException(code == 404 ? "файла этого района пока нет" : "сервер ответил " + code);
            }
            if (code == 200) {
                have = 0;
            }
            long len = c.getContentLength() >= 0 ? c.getContentLength() : -1;
            String cl = c.getHeaderField("Content-Length");
            if (cl != null) {
                try {
                    len = Long.parseLong(cl.trim());
                } catch (NumberFormatException ignored) {
                    // размер неизвестен
                }
            }
            long total = len > 0 ? have + len : 0;
            mapProgress(slug, have, total);
            try (InputStream in = c.getInputStream()) {
                storeMap(in, slug, total, have, tmp);
            }
            mapDone(true, slug);
        } catch (Exception e) {
            if (mapCancel) {
                tmp.delete();
                mapDone(false, "отменено");
            } else {
                mapDone(false, e.getMessage() == null ? e.toString() : e.getMessage());
            }
        } finally {
            if (c != null) {
                c.disconnect();
            }
            mapBusy = false;
        }
    }

    private void notifyOpened() {
        if (web == null || !pageReady || (openedText == null && openedError == null)) {
            return;
        }
        web.evaluateJavascript("window.__kartaOpened && window.__kartaOpened()", null);
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                return c.getString(0);
            }
        } catch (Exception ignored) {
            // имя не важно
        }
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }

    private void js(String code) {
        if (web != null) {
            web.evaluateJavascript(code, null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OPEN) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                readUri(data.getData());
            }
        } else if (requestCode == REQ_SAVE) {
            String text = pendingSaveText;
            pendingSaveText = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || text == null) {
                js("window.__kartaSaved && window.__kartaSaved(false)");
                return;
            }
            boolean ok;
            try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "wt")) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                ok = true;
            } catch (Exception e) {
                ok = false;
            }
            js("window.__kartaSaved && window.__kartaSaved(" + ok + ")");
        }
    }

    // ------------------------------------------------------------------ местоположение

    private boolean hasLocPermission() {
        return Build.VERSION.SDK_INT < 23
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void geoAnswer(Location l, String error) {
        if (l != null) {
            js("window.__kartaGeo && window.__kartaGeo(" + l.getLatitude() + "," + l.getLongitude() + "," + (l.hasAccuracy() ? l.getAccuracy() : 0) + ",null)");
        } else {
            js("window.__kartaGeo && window.__kartaGeo(0,0,0," + JSONObject.quote(error) + ")");
        }
    }

    @SuppressWarnings({"MissingPermission", "deprecation"})
    private void startLocate() {
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (lm == null) {
            geoAnswer(null, "нет службы местоположения");
            return;
        }
        boolean gps = false, net = false;
        try { gps = lm.isProviderEnabled(LocationManager.GPS_PROVIDER); } catch (Exception ignored) { }
        try { net = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER); } catch (Exception ignored) { }
        if (!gps && !net) {
            geoAnswer(null, "включите местоположение (GPS) в настройках телефона");
            return;
        }
        stopLocate();
        // сразу — последнее известное, если оно свежее двух минут
        Location best = null;
        for (String p : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) {
                    best = l;
                }
            } catch (Exception ignored) { }
        }
        if (best != null && System.currentTimeMillis() - best.getTime() < 120000) {
            geoAnswer(best, null);
        }
        final Location fallback = best;
        locListener = new LocationListener() {
            @Override
            public void onLocationChanged(Location l) {
                // ждём точность лучше 50 м по GPS; сеть даёт грубое место сразу
                geoAnswer(l, null);
                if (!LocationManager.NETWORK_PROVIDER.equals(l.getProvider()) || !l.hasAccuracy() || l.getAccuracy() < 50) {
                    stopLocate();
                }
            }
            @Override public void onStatusChanged(String p, int s, Bundle b) { }
            @Override public void onProviderEnabled(String p) { }
            @Override public void onProviderDisabled(String p) { }
        };
        try {
            if (gps) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, locListener, Looper.getMainLooper());
            if (net) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000, 0, locListener, Looper.getMainLooper());
        } catch (Exception e) {
            stopLocate();
            geoAnswer(null, "нет доступа к местоположению");
            return;
        }
        final LocationListener mine = locListener;
        ui.postDelayed(() -> {
            if (locListener == mine) {
                stopLocate();
                if (fallback == null) geoAnswer(null, "спутники не найдены, выйдите на открытое место");
            }
        }, LOC_TIMEOUT);
    }

    private void stopLocate() {
        if (locListener != null) {
            try {
                ((LocationManager) getSystemService(LOCATION_SERVICE)).removeUpdates(locListener);
            } catch (Exception ignored) { }
            locListener = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_LOC) {
            if (hasLocPermission()) startLocate();
            else geoAnswer(null, "нет разрешения на местоположение");
        }
    }

    @Override
    protected void onPause() {
        stopLocate();
        super.onPause();
    }

    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
        return n.isEmpty() ? "karta-seti.json" : n;
    }

    private class Files {
        /** Страница загрузилась и готова принять открытый файл. */
        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                pageReady = true;
                notifyOpened();
            });
        }

        @JavascriptInterface
        public String takeOpenedName() {
            return openedName;
        }

        @JavascriptInterface
        public String takeOpenedText() {
            String t = openedText;
            openedText = null;
            return t;
        }

        @JavascriptInterface
        public String takeOpenedError() {
            String e = openedError;
            openedError = null;
            return e;
        }

        @JavascriptInterface
        public void openFile() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(i, REQ_OPEN);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Не удалось открыть выбор файла", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public boolean shareText(String fileName, String text) {
            try {
                File dir = new File(getCacheDir(), ShareProvider.DIR);
                dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) {
                    for (File f : old) {
                        f.delete();
                    }
                }
                File f = new File(dir, safeName(fileName));
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
                Uri uri = Uri.parse("content://" + ShareProvider.AUTHORITY + "/" + Uri.encode(f.getName()));
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("application/json");
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_SUBJECT, f.getName());
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, "Отправить файл");
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(chooser));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void saveText(String fileName, String text) {
            runOnUiThread(() -> {
                pendingSaveText = text;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/json");
                i.putExtra(Intent.EXTRA_TITLE, safeName(fileName));
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    pendingSaveText = null;
                    js("window.__kartaSaved && window.__kartaSaved(false)");
                }
            });
        }

        @JavascriptInterface
        public void locate() {
            runOnUiThread(() -> {
                if (hasLocPermission()) {
                    startLocate();
                } else if (Build.VERSION.SDK_INT >= 23) {
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
                }
            });
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        /** Файлы офлайн-карты: JSON [{slug, size, mtime, bounds}]. */
        @JavascriptInterface
        public String mapList() {
            return offline.list();
        }

        /** Плитка офлайн-карты в base64 (страница рисует карту сама); пусто — плитки нет. */
        @JavascriptInterface
        public String mapTile(int z, int x, int y) {
            byte[] b = offline.tile(z, x, y);
            return b == null ? "" : Base64.encodeToString(b, Base64.NO_WRAP);
        }

        /** Файл из набора приложения (шрифты подписей карты) в base64; пусто — файла нет. */
        @JavascriptInterface
        public String asset(String path) {
            if (path == null || !path.startsWith("vendor/") || path.contains("..")) {
                return "";
            }
            try (InputStream in = getAssets().open(path)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 17);
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
                return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            } catch (IOException e) {
                return "";
            }
        }

        /** Скачать файл района. Ход — __kartaMapProgress(район, скачано, всего), итог — __kartaMap(ok, текст). */
        @JavascriptInterface
        public boolean mapDownload(String slug, String address) {
            if (mapBusy || slug == null || address == null || !address.startsWith("https://")) {
                return false;
            }
            mapBusy = true;
            mapCancel = false;
            final String s = OfflineTiles.slug(slug);
            new Thread(() -> downloadMap(s, address)).start();
            return true;
        }

        @JavascriptInterface
        public void mapCancel() {
            mapCancel = true;
        }

        @JavascriptInterface
        public boolean mapBusy() {
            return mapBusy;
        }

        @JavascriptInterface
        public boolean mapDelete(String slug) {
            return offline.delete(slug);
        }

        /** Не гасить экран, пока приложение открыто (настройка). */
        @JavascriptInterface
        public void keepScreen(boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }
}
