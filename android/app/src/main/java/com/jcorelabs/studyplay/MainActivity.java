package com.jcorelabs.studyplay;

import android.content.res.Configuration;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebSettings;
import android.webkit.WebView;


import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VideoFolderPlugin.class);
        registerPlugin(VideoPlayerPlugin.class);
        super.onCreate(savedInstanceState);

        // Garante que o WebView pode carregar content:// URIs (SAF) e reproduzir mídia
        WebView wv = getBridge().getWebView();
        if (wv != null) {
            WebSettings s = wv.getSettings();
            s.setAllowContentAccess(true);
            s.setAllowFileAccess(true);
            s.setMediaPlaybackRequiresUserGesture(false);

            // Intercepta /_saf_/?uri=… e serve bytes do SAF com suporte a Range requests
            wv.setWebViewClient(new VideoWebViewClient(getBridge()));
        }

        // As permissões de notificação e de bateria NÃO são mais pedidas ao abrir o app
        // (apareciam juntas, sem contexto). O JS pede cada uma no momento certo, via
        // VideoPlayerPlugin.requestNotificationPermission / requestBatteryExemption.
    }

    /**
     * Intercepta eventos de teclado ANTES que o WebView (Capacitor/Chromium) os consuma.
     *
     * Problema: o WebView captura os botões de mídia do fone (KEYCODE_HEADSETHOOK,
     * KEYCODE_MEDIA_PLAY_PAUSE, NEXT, PREVIOUS) e os "engole" sem repassar ao
     * MediaSession nativo nem aos handlers JS do navigator.mediaSession de forma
     * confiável. O resultado é que nenhum botão do fone funciona.
     *
     * Solução: quando há mídia carregada no ExoPlayer, interceptamos os botões de
     * mídia aqui — antes de super.dispatchKeyEvent() — e os enviamos diretamente ao
     * PlaybackService.handleMediaKey(). O WebView nunca vê o evento.
     *
     * Para os casos sem mídia ativa (app na tela inicial, sem vídeo selecionado),
     * PlaybackService.hasActivePlayer() retorna false e o evento passa normalmente
     * para o WebView / outros apps de mídia do sistema.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        if (isMediaKey(keyCode) && PlaybackService.hasActivePlayer()) {
            // Agimos apenas no primeiro ACTION_DOWN (evita repeat em long-press)
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                PlaybackService.handleMediaKey(keyCode);
            }
            // Consome DOWN e UP para o WebView não receber evento órfão
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    /** Retorna true para todos os keyCodes de controle de mídia */
    private static boolean isMediaKey(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_HEADSETHOOK:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
                return true;
            default:
                return false;
        }
    }

    /**
     * Chamado quando o app volta ao primeiro plano (Home → app, tela desbloqueada, etc.).
     * Se o app foi minimizado enquanto estava em tela cheia, o PlayerView permanece
     * MATCH_PARENT com setClickable(true) — bloqueando toda a UI HTML. Saímos do
     * fullscreen imediatamente para restaurar o acesso a todos os controles.
     */
    @Override
    public void onResume() {
        super.onResume();
        VideoPlayerPlugin vp = VideoPlayerPlugin.instance;
        if (vp != null) vp.handleResume();
    }

    /**
     * Chamado quando o app entra/sai do modo Picture-in-Picture.
     * 1. Expande/recolhe o PlayerView via VideoPlayerPlugin (vídeo limpo, sem moldura HTML)
     * 2. Notifica o JS para ajustar a UI
     */
    @Override
    public void onPictureInPictureModeChanged(boolean inPiP, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPiP, newConfig);

        // Plugin nativo: expande PlayerView para preencher janela PiP
        VideoPlayerPlugin vp = VideoPlayerPlugin.instance;
        if (vp != null) vp.onPiPModeChanged(inPiP);

        // Notifica JS (oculta/mostra controles HTML)
        try {
            JSObject data = new JSObject();
            data.put("active", inPiP);
            getBridge().triggerJSEvent("pipModeChanged", "window", data.toString());
        } catch (Exception ignored) {}
    }
}
