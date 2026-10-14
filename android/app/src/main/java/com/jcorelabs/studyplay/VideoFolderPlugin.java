package com.jcorelabs.studyplay;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * VideoFolderPlugin — abre o seletor de pastas nativo (SAF) e devolve
 * a lista completa de arquivos com caminhos relativos e URIs proxy que
 * o WebView consegue reproduzir via VideoWebViewClient.
 *
 * Otimização v2: usa DocumentsContract.buildChildDocumentsUriUsingTree +
 * ContentResolver.query() em vez de DocumentFile.listFiles(), o que faz
 * UMA query por diretório (batch) em vez de múltiplas chamadas IPC para
 * cada propriedade de cada arquivo. Resultado: 10–50× mais rápido em
 * pastas com centenas ou milhares de arquivos.
 */
@CapacitorPlugin(name = "VideoFolder")
public class VideoFolderPlugin extends Plugin {

    private static final String TAG = "VideoFolderPlugin";

    // ── Abre o seletor de pastas ──────────────────────────────
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "handlePickFolder");
    }

    @ActivityCallback
    private void handlePickFolder(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri treeUri = result.getData().getData();
        if (treeUri == null) { call.reject("no_uri"); return; }

        // Salva permissão persistente
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (Exception ignored) {}

        // Executa scan em thread de background (DocumentsContract queries bloqueiam)
        final Uri finalUri = treeUri;
        new Thread(() -> resolveFolder(call, finalUri)).start();
    }

    // ── Salva um arquivo de texto via seletor do sistema (SAF) ─────────────
    // O download por link blob: (a.download) é ignorado pelo WebView do Android,
    // então exportar notas/progresso precisa deste caminho nativo.
    @PluginMethod
    public void saveTextFile(PluginCall call) {
        String filename = call.getString("filename", "arquivo.txt");
        String mime     = call.getString("mime", "text/plain");
        if (call.getString("content") == null) { call.reject("missing content"); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "handleSaveFile");
    }

    @ActivityCallback
    private void handleSaveFile(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
                || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        final Uri uri = result.getData().getData();
        final String content = call.getString("content", "");
        new Thread(() -> {
            try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (os == null) { call.reject("write_failed: stream"); return; }
                os.write(content.getBytes(StandardCharsets.UTF_8));
                os.flush();
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "saveTextFile failed", e);
                call.reject("write_failed: " + e.getMessage());
            }
        }).start();
    }

    // ── Abre um link no navegador/loja (http, https ou market) ──────────────
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("missing url"); return; }
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https") || scheme.equals("market"))) {
            call.reject("scheme_not_allowed");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("no_handler: " + e.getMessage());
        }
    }

    // ── Re-lê uma pasta salva (persistida entre sessões) ──────
    @PluginMethod
    public void listPersistedFolder(PluginCall call) {
        String uriStr = call.getString("treeUri");
        if (uriStr == null || uriStr.isEmpty()) { call.reject("missing treeUri"); return; }
        final Uri treeUri = Uri.parse(uriStr);
        new Thread(() -> resolveFolder(call, treeUri)).start();
    }

    // ── Lógica comum: obtém rootName e inicia scan ─────────────
    private void resolveFolder(PluginCall call, Uri treeUri) {
        // DocumentFile apenas para obter o nome do diretório raiz (custo único, aceitável)
        String rootName = "Pasta";
        try {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
            if (root == null || !root.isDirectory()) { call.reject("invalid_folder"); return; }
            if (root.getName() != null) rootName = root.getName();
        } catch (Exception e) {
            Log.w(TAG, "getRootName fallback: " + e.getMessage());
        }

        JSArray files = new JSArray();
        final long scanStart = System.currentTimeMillis();
        try {
            // Obtém o Document ID da raiz da árvore e inicia scan otimizado
            String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
            listByQuery(treeUri, rootDocId, files, "");
        } catch (Exception e) {
            Log.e(TAG, "resolveFolder scan failed", e);
            call.reject("scan_failed: " + e.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        ret.put("treeUri",  treeUri.toString());
        ret.put("rootName", rootName);
        ret.put("scanMs",   System.currentTimeMillis() - scanStart);   // diagnóstico (Configurações)
        ret.put("files",    files);
        call.resolve(ret);
    }

    /**
     * listByQuery — lista filhos de um diretório usando DocumentsContract + Cursor.
     *
     * Diferença em relação ao DocumentFile.listFiles() antigo:
     *   Antigo: 1 query para listar filhos + N queries extras para cada getName(),
     *           isDirectory(), getType(), length() → muito lento para pastas grandes.
     *   Novo  : 1 query batch retorna TODOS os metadados de uma vez.
     *           Para uma pasta com 100 arquivos: 1 query vs 400+ queries.
     */
    private void listByQuery(Uri treeUri, String parentDocId, JSArray arr, String path) {
        listByQuery(treeUri, parentDocId, arr, path, false, null);
    }

    /** Mesma lista de antes; natural=true ordena "Aula 2" antes de "Aula 10"; cancel interrompe. */
    private void listByQuery(Uri treeUri, String parentDocId, JSArray arr, String path,
                             boolean natural, AtomicBoolean cancel) {
        if (cancel != null && cancel.get()) return;
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);

        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        };

        List<String[]> subdirs   = new ArrayList<>();
        List<String[]> fileRows  = new ArrayList<>();

        try (Cursor cursor = getContext().getContentResolver().query(
                childrenUri, projection, null, null, null)) {

            if (cursor == null) return;

            while (cursor.moveToNext()) {
                String docId = cursor.getString(0);
                String name  = cursor.getString(1);
                String mime  = cursor.getString(2);
                long   size  = cursor.isNull(3) ? 0L : cursor.getLong(3);

                if (name == null || name.startsWith(".")) continue;

                String childPath = path.isEmpty() ? name : path + "/" + name;

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    subdirs.add(new String[]{ docId, name, childPath });
                } else {
                    fileRows.add(new String[]{ docId, name,
                        mime != null ? mime : "",
                        childPath, String.valueOf(size) });
                }
            }

        } catch (Exception e) {
            Log.w(TAG, "listByQuery query error at '" + path + "': " + e.getMessage());
            return;
        }

        // Ordena: case-insensitive (ou natural, no caminho novo da varredura progressiva)
        if (natural) {
            subdirs.sort((a, b)  -> naturalCompare(a[1], b[1]));
            fileRows.sort((a, b) -> naturalCompare(a[1], b[1]));
        } else {
            subdirs.sort((a, b)  -> a[1].compareToIgnoreCase(b[1]));
            fileRows.sort((a, b) -> a[1].compareToIgnoreCase(b[1]));
        }

        // Adiciona arquivos ao resultado
        for (String[] row : fileRows) {
            Uri    docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, row[0]);
            String raw    = docUri.toString();
            String proxy  = "https://localhost/_saf_/?uri=" + Uri.encode(raw);

            JSObject obj = new JSObject();
            obj.put("name",         row[1]);
            obj.put("relativePath", row[3]);
            obj.put("uri",          proxy);
            obj.put("mimeType",     row[2]);
            obj.put("size",         Long.parseLong(row[4]));
            arr.put(obj);
        }

        // Recursão nos subdiretórios (sem limite de profundidade — ilimitado)
        for (String[] subdir : subdirs) {
            listByQuery(treeUri, subdir[0], arr, subdir[2], natural, cancel);
        }
    }

    // ═════════════════════════════════════════════════════════
    //  Varredura progressiva (curso novo): módulo por módulo
    // ═════════════════════════════════════════════════════════

    private static final int SCAN_THREADS = 3;
    private final Map<String, AtomicBoolean> scans = new ConcurrentHashMap<>();

    /** Ordem natural, sem diferenciar maiúsculas nem acentos: "Módulo 2" vem antes de "Módulo 10". */
    static int naturalCompare(String a, String b) {
        String x = fold(a), y = fold(b);
        int i = 0, j = 0;
        while (i < x.length() && j < y.length()) {
            char cx = x.charAt(i), cy = y.charAt(j);
            if (Character.isDigit(cx) && Character.isDigit(cy)) {
                int si = i, sj = j;
                while (si < x.length() && x.charAt(si) == '0') si++;
                while (sj < y.length() && y.charAt(sj) == '0') sj++;
                int ei = si, ej = sj;
                while (ei < x.length() && Character.isDigit(x.charAt(ei))) ei++;
                while (ej < y.length() && Character.isDigit(y.charAt(ej))) ej++;
                int li = ei - si, lj = ej - sj;
                if (li != lj) return li < lj ? -1 : 1;
                int c = x.substring(si, ei).compareTo(y.substring(sj, ej));
                if (c != 0) return c < 0 ? -1 : 1;
                i = ei; j = ej;
            } else {
                if (cx != cy) return cx < cy ? -1 : 1;
                i++; j++;
            }
        }
        int rx = x.length() - i, ry = y.length() - j;
        return rx == ry ? a.compareTo(b) : (rx < ry ? -1 : 1);
    }

    private static String fold(String s) {
        String d = Normalizer.normalize(s, Normalizer.Form.NFD);
        return d.replaceAll("\\p{M}+", "").toLowerCase(java.util.Locale.ROOT);
    }

    private JSObject fileObj(Uri treeUri, String docId, String name, String mime, String relPath, long size) {
        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
        JSObject obj = new JSObject();
        obj.put("name",         name);
        obj.put("relativePath", relPath);
        obj.put("uri",          "https://localhost/_saf_/?uri=" + Uri.encode(docUri.toString()));
        obj.put("mimeType",     mime != null ? mime : "");
        obj.put("size",         size);
        return obj;
    }

    // ── Escolhe a pasta SEM varrer (a varredura vem por scanFolder) ──
    @PluginMethod
    public void pickFolderOnly(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "handlePickFolderOnly");
    }

    @ActivityCallback
    private void handlePickFolderOnly(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        final Uri treeUri = result.getData().getData();
        if (treeUri == null) { call.reject("no_uri"); return; }
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {}
        new Thread(() -> {
            JSObject ret = new JSObject();
            ret.put("treeUri",  treeUri.toString());
            ret.put("rootName", rootNameOf(treeUri));
            call.resolve(ret);
        }).start();
    }

    private String rootNameOf(Uri treeUri) {
        try {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
            if (root != null && root.getName() != null) return root.getName();
        } catch (Exception e) {
            Log.w(TAG, "rootNameOf fallback: " + e.getMessage());
        }
        return "Pasta";
    }

    // ── Varredura progressiva: responde na hora e manda eventos ──
    //   scanRoot   {scanId, rootName, rootFiles[], modules[], flat}
    //   scanModule {scanId, index, name, files[]}      (sempre em ordem)
    //   scanDone   {scanId, totalFiles, scanMs}
    //   scanError  {scanId, message}
    @PluginMethod
    public void scanFolder(PluginCall call) {
        String uriStr = call.getString("treeUri");
        String scanId = call.getString("scanId");
        if (uriStr == null || uriStr.isEmpty()) { call.reject("missing treeUri"); return; }
        if (scanId == null || scanId.isEmpty()) { call.reject("missing scanId"); return; }
        final Uri treeUri = Uri.parse(uriStr);
        final AtomicBoolean cancel = new AtomicBoolean(false);
        scans.put(scanId, cancel);
        call.resolve();
        new Thread(() -> runScan(treeUri, scanId, cancel)).start();
    }

    private void emit(String scanId, AtomicBoolean cancel, String event, JSObject data) {
        if (cancel.get()) return;
        data.put("scanId", scanId);
        notifyListeners(event, data);
    }

    private void runScan(Uri treeUri, String scanId, AtomicBoolean cancel) {
        final long start = System.currentTimeMillis();
        ExecutorService pool = null;
        try {
            String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, rootDocId);
            String[] projection = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE
            };
            final List<String[]> subdirs  = new ArrayList<>();
            final List<String[]> fileRows = new ArrayList<>();
            boolean rootHasVideo = false;
            try (Cursor c = getContext().getContentResolver().query(childrenUri, projection, null, null, null)) {
                if (c == null) throw new IllegalStateException("invalid_folder");
                while (c.moveToNext()) {
                    String docId = c.getString(0), name = c.getString(1), mime = c.getString(2);
                    long size = c.isNull(3) ? 0L : c.getLong(3);
                    if (name == null || name.startsWith(".")) continue;
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        subdirs.add(new String[]{ docId, name });
                    } else {
                        fileRows.add(new String[]{ docId, name, mime != null ? mime : "", String.valueOf(size) });
                        if (mime != null && mime.startsWith("video/")) rootHasVideo = true;
                    }
                }
            }
            subdirs.sort((a, b)  -> naturalCompare(a[1], b[1]));
            fileRows.sort((a, b) -> naturalCompare(a[1], b[1]));

            JSArray rootFiles = new JSArray();
            for (String[] r : fileRows) {
                rootFiles.put(fileObj(treeUri, r[0], r[1], r[2], r[1], Long.parseLong(r[3])));
            }
            JSArray names = new JSArray();
            for (String[] d : subdirs) names.put(d[1]);

            JSObject root = new JSObject();
            root.put("rootName",  rootNameOf(treeUri));
            root.put("rootFiles", rootFiles);
            root.put("modules",   names);
            root.put("flat",      rootHasVideo || subdirs.isEmpty());
            emit(scanId, cancel, "scanRoot", root);

            final int n = subdirs.size();
            final JSArray[] results = new JSArray[n];
            final int[] next = { 0 };
            final int[] total = { rootFiles.length() };
            final Object lock = new Object();

            if (n > 0) {
                pool = Executors.newFixedThreadPool(Math.min(SCAN_THREADS, n));
                for (int i = 0; i < n; i++) {
                    final int idx = i;
                    final String[] d = subdirs.get(i);
                    pool.execute(() -> {
                        if (cancel.get()) return;
                        JSArray arr = new JSArray();
                        try {
                            listByQuery(treeUri, d[0], arr, d[1], true, cancel);
                        } catch (Exception e) {
                            Log.w(TAG, "scan module failed '" + d[1] + "': " + e.getMessage());
                        }
                        synchronized (lock) {
                            results[idx] = arr;
                            // Libera em ordem: o módulo 3 só sai depois do 1 e do 2
                            while (next[0] < n && results[next[0]] != null) {
                                JSObject m = new JSObject();
                                m.put("index", next[0]);
                                m.put("name",  subdirs.get(next[0])[1]);
                                m.put("files", results[next[0]]);
                                total[0] += results[next[0]].length();
                                results[next[0]] = null;
                                next[0]++;
                                emit(scanId, cancel, "scanModule", m);
                            }
                            if (next[0] == n && !cancel.get()) {
                                JSObject done = new JSObject();
                                done.put("totalFiles", total[0]);
                                done.put("scanMs", System.currentTimeMillis() - start);
                                emit(scanId, cancel, "scanDone", done);
                                scans.remove(scanId);
                            }
                        }
                    });
                }
                pool.shutdown();
            } else {
                JSObject done = new JSObject();
                done.put("totalFiles", total[0]);
                done.put("scanMs", System.currentTimeMillis() - start);
                emit(scanId, cancel, "scanDone", done);
                scans.remove(scanId);
            }
        } catch (Exception e) {
            Log.e(TAG, "runScan failed", e);
            JSObject err = new JSObject();
            err.put("message", String.valueOf(e.getMessage()));
            emit(scanId, cancel, "scanError", err);
            scans.remove(scanId);
            if (pool != null) pool.shutdownNow();
        }
    }

    // ── Interrompe uma varredura: nada mais é emitido daquele scanId ──
    @PluginMethod
    public void cancelScan(PluginCall call) {
        String scanId = call.getString("scanId");
        if (scanId != null) {
            AtomicBoolean c = scans.remove(scanId);
            if (c != null) c.set(true);
        }
        call.resolve();
    }

    // ── A pasta ainda existe e a permissão continua válida? ──
    @PluginMethod
    public void checkFolder(PluginCall call) {
        String uriStr = call.getString("treeUri");
        if (uriStr == null || uriStr.isEmpty()) { call.reject("missing treeUri"); return; }
        final Uri treeUri = Uri.parse(uriStr);
        new Thread(() -> {
            boolean ok = false;
            try {
                boolean granted = false;
                for (android.content.UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
                    if (p.getUri().equals(treeUri) && p.isReadPermission()) { granted = true; break; }
                }
                if (granted) {
                    String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                    Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId);
                    try (Cursor c = getContext().getContentResolver().query(docUri,
                            new String[]{ DocumentsContract.Document.COLUMN_DOCUMENT_ID }, null, null, null)) {
                        ok = c != null && c.moveToFirst();
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "checkFolder: " + e.getMessage());
            }
            JSObject ret = new JSObject();
            ret.put("ok", ok);
            call.resolve(ret);
        }).start();
    }

    // ── Libera a permissão persistente de uma pasta (curso removido) ──
    @PluginMethod
    public void releaseFolder(PluginCall call) {
        String uriStr = call.getString("treeUri");
        if (uriStr == null || uriStr.isEmpty()) { call.reject("missing treeUri"); return; }
        try {
            getContext().getContentResolver().releasePersistableUriPermission(
                Uri.parse(uriStr), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {}
        call.resolve();
    }
}
