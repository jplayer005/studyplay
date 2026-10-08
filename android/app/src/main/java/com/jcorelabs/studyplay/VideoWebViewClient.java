package com.jcorelabs.studyplay;

import android.content.ContentResolver;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * VideoWebViewClient — extends Capacitor's BridgeWebViewClient to proxy
 * SAF content:// URIs through https://localhost/_saf_/?uri=...
 * so the WebView can play videos and serve other files from SAF.
 * Supports Range requests for proper video seeking.
 */
public class VideoWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "VideoProxy";
    private static final String SAF_PATH = "/_saf_";

    public VideoWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri reqUri = request.getUrl();
        String path = reqUri.getPath();

        if (path != null && path.startsWith(SAF_PATH)) {
            String contentUriStr = reqUri.getQueryParameter("uri");
            if (contentUriStr != null && !contentUriStr.isEmpty()) {
                return serveSafContent(view.getContext(), request.getRequestHeaders(), contentUriStr);
            }
        }

        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse serveSafContent(Context ctx,
                                                 Map<String, String> reqHeaders,
                                                 String contentUriStr) {
        AssetFileDescriptor afd = null;
        try {
            Uri contentUri = Uri.parse(contentUriStr);
            ContentResolver cr = ctx.getContentResolver();

            String mimeType = cr.getType(contentUri);
            if (mimeType == null) mimeType = guessMime(contentUriStr);
            if (mimeType == null) mimeType = "application/octet-stream";

            // Abre o arquivo UMA vez (antes eram duas aberturas por pedido: uma só
            // para ler o tamanho e outra para os bytes).
            afd = cr.openAssetFileDescriptor(contentUri, "r");
            if (afd == null) return null;
            long fileSize = afd.getLength();

            Map<String, String> respHeaders = new HashMap<>();
            respHeaders.put("Access-Control-Allow-Origin", "*");
            respHeaders.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
            respHeaders.put("Access-Control-Expose-Headers",
                    "Content-Range, Content-Length, Accept-Ranges");

            String rangeHeader = reqHeaders != null ? reqHeaders.get("Range") : null;

            // ── Range request (needed for video seeking) ──────────────────────
            if (fileSize != AssetFileDescriptor.UNKNOWN_LENGTH
                    && rangeHeader != null
                    && rangeHeader.startsWith("bytes=")) {

                // Formatos aceitos: "a-b", "a-" e o sufixo "-n" (últimos n bytes,
                // usado por alguns MP4/MKV ao ler o índice no fim do arquivo).
                String spec = rangeHeader.substring(6);
                String[] parts = spec.split("-", 2);
                long start, end;
                try {
                    if (parts[0].isEmpty()) {
                        long suffix = Long.parseLong(parts[1]);
                        start = Math.max(0L, fileSize - suffix);
                        end   = fileSize - 1;
                    } else {
                        start = Long.parseLong(parts[0]);
                        end   = (parts.length < 2 || parts[1].isEmpty())
                                ? fileSize - 1
                                : Math.min(Long.parseLong(parts[1]), fileSize - 1);
                    }
                } catch (NumberFormatException nfe) {
                    // Range inválido ou múltiplo ("0-1,5-9"): serve o arquivo inteiro
                    return serveFull(afd, mimeType, respHeaders, fileSize);
                }

                if (start > end || start >= fileSize) {
                    respHeaders.put("Content-Range", "bytes */" + fileSize);
                    closeQuietly(afd);
                    return new WebResourceResponse(mimeType, null,
                            416, "Range Not Satisfiable", respHeaders, null);
                }

                long length = end - start + 1;
                FileInputStream fis = afd.createInputStream();
                skipFully(fis, start);
                InputStream limited = new LimitedInputStream(fis, length);

                respHeaders.put("Content-Range", "bytes " + start + "-" + end + "/" + fileSize);
                respHeaders.put("Content-Length", String.valueOf(length));
                respHeaders.put("Accept-Ranges", "bytes");

                return new WebResourceResponse(mimeType, null,
                        206, "Partial Content", respHeaders, limited);
            }

            // ── Full file ─────────────────────────────────────────────────────
            return serveFull(afd, mimeType, respHeaders, fileSize);

        } catch (Exception e) {
            Log.e(TAG, "Failed to proxy SAF URI: " + contentUriStr, e);
            closeQuietly(afd);
            return null;
        }
    }

    private WebResourceResponse serveFull(AssetFileDescriptor afd, String mimeType,
                                          Map<String, String> respHeaders, long fileSize)
            throws IOException {
        InputStream is = afd.createInputStream();
        if (fileSize != AssetFileDescriptor.UNKNOWN_LENGTH) {
            respHeaders.put("Content-Length", String.valueOf(fileSize));
            respHeaders.put("Accept-Ranges", "bytes");
        }
        return new WebResourceResponse(mimeType, null, 200, "OK", respHeaders, is);
    }

    private static void closeQuietly(AssetFileDescriptor afd) {
        if (afd == null) return;
        try { afd.close(); } catch (IOException ignored) {}
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static void skipFully(InputStream is, long skip) throws IOException {
        long remaining = skip;
        while (remaining > 0) {
            long n = is.skip(remaining);
            if (n > 0) { remaining -= n; continue; }
            // skip() may return 0 on some streams — fall back to read
            int b = is.read();
            if (b < 0) break;
            remaining--;
        }
    }

    private static String guessMime(String uriStr) {
        String s = uriStr.toLowerCase();
        if (s.contains(".mp4") || s.contains(".m4v")) return "video/mp4";
        if (s.contains(".mkv"))  return "video/x-matroska";
        if (s.contains(".webm")) return "video/webm";
        if (s.contains(".avi"))  return "video/x-msvideo";
        if (s.contains(".mov"))  return "video/quicktime";
        if (s.contains(".flv"))  return "video/x-flv";
        if (s.contains(".pdf"))  return "application/pdf";
        if (s.contains(".html") || s.contains(".htm")) return "text/html";
        if (s.contains(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (s.contains(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (s.contains(".mp3"))  return "audio/mpeg";
        if (s.contains(".ogg"))  return "audio/ogg";
        return null;
    }

    /** Wraps an InputStream and returns EOF after reading {@code limit} bytes. */
    private static final class LimitedInputStream extends InputStream {
        private final InputStream src;
        private long remaining;

        LimitedInputStream(InputStream src, long limit) {
            this.src = src;
            this.remaining = limit;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = src.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int toRead = (int) Math.min(len, remaining);
            int n = src.read(buf, off, toRead);
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public void close() throws IOException {
            src.close();
        }
    }
}
