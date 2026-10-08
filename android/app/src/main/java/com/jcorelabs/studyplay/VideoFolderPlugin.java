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
import java.util.ArrayList;
import java.util.List;

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

        // Ordena: natural-case-insensitive
        subdirs.sort((a, b)  -> a[1].compareToIgnoreCase(b[1]));
        fileRows.sort((a, b) -> a[1].compareToIgnoreCase(b[1]));

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
            listByQuery(treeUri, subdir[0], arr, subdir[2]);
        }
    }
}
