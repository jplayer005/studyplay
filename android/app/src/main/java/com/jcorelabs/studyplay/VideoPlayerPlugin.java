package com.jcorelabs.studyplay;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.Icon;
import java.io.ByteArrayOutputStream;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import java.util.Collections;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.SeekParameters;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * VideoPlayerPlugin — usa media3 PlayerView:
 *  • RESIZE_MODE_FIT: aspect ratio correto sem distorção (letterboxing automático)
 *  • Modo normal: useController=false → HTML controls gerenciam o player
 *  • Fullscreen: useController=true → controles nativos (YouTube-like)
 *  • Touch pass-through: touches chegam ao WebView quando fora da área de controle
 *  • PiP: PlayerView expande para tela cheia, mostra só vídeo no PiP window
 */
@CapacitorPlugin(name = "VideoPlayer")
public class VideoPlayerPlugin extends Plugin {

    private static final String TAG = "VideoPlayerPlugin";

    /** Action broadcast para o botão de áudio na janela PiP */
    private static final String PIP_ACTION_AUDIO = "com.jcorelabs.studyplay.PIP_AUDIO_TOGGLE";
    private static final int    PIP_REQ_AUDIO    = 1001;

    /** Acesso estático para MainActivity.onPictureInPictureModeChanged e PlaybackService */
    public static volatile VideoPlayerPlugin instance;

    /**
     * Expõe notifyListeners() publicamente para ser chamado pelo PlaybackService.
     * O método original em Plugin é protected e não pode ser acessado por outras classes.
     */
    public void firePluginEvent(String event, JSObject data) {
        notifyListeners(event, data);
    }

    /**
     * Chamado por MainActivity.onResume().
     * Quando o app volta do background em modo fullscreen o PlayerView permanece
     * MATCH_PARENT com setClickable(true) — todos os toques são consumidos pelo player
     * e nenhum botão HTML responde. Sair do fullscreen restaura o estado normal.
     */
    public void handleResume() {
        handler.post(() -> {
            if (isFullscreen) {
                // Sai do fullscreen: repositiona PlayerView, restaura barras do sistema,
                // dispara fullscreenChanged(false) → JS remove body.native-fullscreen
                exitFullscreenInternal(null);
            }
            // Pede ao JS para resincronizar a posição do PlayerView (pode ter mudado
            // enquanto o app estava em background — ex: teclado, split-screen)
            scheduleRectRefresh(300);
        });
    }

    private PlayerView       playerView;
    private boolean          isFullscreen = false;
    private boolean          isPiP        = false;
    private BroadcastReceiver pipActionReceiver;

    // Última área reportada por updateRect (px físicos)
    private int areaLeft, areaTop, areaWidth, areaHeight;

    private final Handler  handler        = new Handler(Looper.getMainLooper());
    private       Runnable timeUpdateTask = null;

    // ── Ciclo de vida ─────────────────────────────────────────────────────────

    @Override
    public void load() {
        instance = this;
        // Pré-inicia o serviço para reduzir latência no primeiro play
        getContext().startService(new Intent(getContext(), PlaybackService.class));
        // Registra receiver para o botão de áudio dentro da janela PiP
        registerPipAudioReceiver();
    }

    /** Registra um BroadcastReceiver local para capturar o toque no botão de áudio do PiP. */
    private void registerPipAudioReceiver() {
        if (pipActionReceiver != null) return;
        pipActionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (PIP_ACTION_AUDIO.equals(intent.getAction())) {
                    // 1. Notifica o JS para ativar modo áudio
                    notifyListeners("pipAudioToggle", new JSObject());
                    // 2. Após 150 ms (JS processa o evento), fecha a janela PiP
                    //    mandando o app para background. O áudio continua via PlaybackService.
                    handler.postDelayed(() -> {
                        try { getActivity().moveTaskToBack(true); } catch (Exception ignored) {}
                    }, 150);
                }
            }
        };
        IntentFilter filter = new IntentFilter(PIP_ACTION_AUDIO);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(pipActionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(pipActionReceiver, filter);
        }
    }

    @Override
    protected void handleOnPause() {
        // Intencional: ExoPlayer continua via PlaybackService (foreground service).
        // Limpar a superfície aqui causava paradas inesperadas no HyperOS.
        getActivity().runOnUiThread(() -> {
            if (playerView != null) playerView.onPause();
        });
    }

    @Override
    protected void handleOnResume() {
        getActivity().runOnUiThread(() -> {
            if (playerView == null) return;
            playerView.onResume();

            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null) {
                // Reconecta o PlayerView ao player (pode ter sido desconectado em onPause)
                if (playerView.getPlayer() == null) {
                    playerView.setPlayer(p);
                }
                // Re-adiciona o listener caso o serviço tenha reiniciado com novo ExoPlayer
                p.removeListener(playerListener);
                if (p.getCurrentMediaItem() != null) {
                    p.addListener(playerListener);
                    if (!timeUpdatesRunning()) startTimeUpdates();
                }
            }
            // Após rotação/retorno do background, pede ao JS para re-sincronizar o rect
            // com delay para o layout se acomodar (especialmente após rotação de tela)
            scheduleRectRefresh(350);
        });
    }

    @Override
    protected void handleOnDestroy() {
        stopTimeUpdates();
        handler.removeCallbacks(rectRefreshTask);
        // Remove receiver do botão de áudio PiP
        if (pipActionReceiver != null) {
            try { getContext().unregisterReceiver(pipActionReceiver); } catch (Exception ignored) {}
            pipActionReceiver = null;
        }
        // Notifica JS para resetar modo playlist nativa
        try { notifyListeners("playerDestroyed", new JSObject()); } catch (Exception ignored) {}
        try {
            getActivity().runOnUiThread(() -> {
                ExoPlayer p = PlaybackService.getPlayer();
                if (p != null) p.removeListener(playerListener);
                if (playerView != null) {
                    playerView.setPlayer(null);
                    ViewGroup parent = (ViewGroup) playerView.getParent();
                    if (parent != null) parent.removeView(playerView);
                    playerView = null;
                }
            });
        } catch (Exception ignored) {}
        instance = null;
    }

    /** Agenda envio de 'requestSyncRect' ao JS após delayMs (para layout se acomodar). */
    private void scheduleRectRefresh(long delayMs) {
        handler.removeCallbacks(rectRefreshTask);
        handler.postDelayed(rectRefreshTask, delayMs);
    }

    private final Runnable rectRefreshTask = () -> {
        if (!isFullscreen) {
            notifyListeners("requestSyncRect", new JSObject());
        }
    };

    // ── Métodos do plugin ─────────────────────────────────────────────────────

    /** loadVideo({uri, title?, artist?, album?, startAt?}) */
    @PluginMethod
    public void loadVideo(PluginCall call) {
        final String uriStr  = call.getString("uri",     "");
        final double startAt = call.getDouble("startAt", 0.0);

        getActivity().runOnUiThread(() -> {
            getContext().startService(new Intent(getContext(), PlaybackService.class));
            waitForService(10, () -> doLoadVideo(call, uriStr, startAt),
                           () -> call.reject("PlaybackService not ready"));
        });
    }

    private void doLoadVideo(PluginCall call, String uriStr, double startAt) {
        try {
            Uri contentUri = resolveUri(uriStr);

            ensurePlayerView();

            ExoPlayer player = PlaybackService.getPlayer();
            if (player == null) { call.reject("Player unavailable"); return; }

            // Garante que o PlayerView está conectado
            if (playerView.getPlayer() != player) playerView.setPlayer(player);
            playerView.setVisibility(View.VISIBLE);

            // Metadados para notificação / Ilha Dinâmica (inclui artwork do app)
            String title  = call.getString("title",  "");
            String artist = call.getString("artist", "StudyPlay");
            String album  = call.getString("album",  "");

            MediaItem mediaItem = new MediaItem.Builder()
                .setUri(contentUri)
                .setMediaMetadata(buildMetadata(title, artist, album))
                .build();

            player.removeListener(playerListener);
            player.stop();
            player.clearMediaItems();
            player.addListener(playerListener);
            player.setMediaItem(mediaItem);
            // ⚠ NÃO chamamos setPlayWhenReady(false).
            // resume() chega ao player APÓS loadVideo na fila do UI thread e
            // definir false aqui causaria race condition onde o play seria ignorado.
            player.prepare();
            if (startAt > 0) player.seekTo((long)(startAt * 1000));

            startTimeUpdates();
            call.resolve();

        } catch (Exception e) {
            Log.e(TAG, "loadVideo failed", e);
            call.reject("Failed: " + e.getMessage());
        }
    }

    /** setMetadata — atualiza título/artista sem interromper a reprodução */
    @PluginMethod
    public void setMetadata(PluginCall call) {
        final String title  = call.getString("title",  "");
        final String artist = call.getString("artist", "StudyPlay");
        final String album  = call.getString("album",  "");

        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            if (p == null || p.getCurrentMediaItem() == null) { call.resolve(); return; }
            MediaItem updated = p.getCurrentMediaItem().buildUpon()
                .setMediaMetadata(buildMetadata(title, artist, album))
                .build();
            p.replaceMediaItem(p.getCurrentMediaItemIndex(), updated);
        });
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null) p.play();
        });
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null) p.pause();
        });
        call.resolve();
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        final double pos   = call.getDouble("position", 0.0);
        final boolean exact = call.getBoolean("exact", false);
        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null) {
                /* exact=true → frame-accurate seek (usado no modo frame-a-frame do JS) */
                if (exact) p.setSeekParameters(SeekParameters.EXACT);
                p.seekTo((long)(pos * 1000));
                if (exact) p.setSeekParameters(SeekParameters.DEFAULT);
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        final float speed = call.getFloat("speed", 1.0f);
        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null) p.setPlaybackParameters(new PlaybackParameters(speed));
        });
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        final float vol = call.getFloat("volume", 1.0f);
        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null) p.setVolume(vol);
        });
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            stopTimeUpdates();
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null) { p.stop(); p.clearMediaItems(); }
        });
        call.resolve();
    }

    /**
     * setPlaylist({items:[{uri, title?, artist?}], startMs?}) —
     * Carrega toda a lista de reprodução no ExoPlayer de uma vez.
     * Isso permite que a reprodução continue em background sem depender do WebView:
     * o ExoPlayer avança automaticamente para o próximo item quando um termina.
     * JS recebe evento "trackChanged" a cada troca de faixa para atualizar a UI.
     */
    @PluginMethod
    public void setPlaylist(PluginCall call) {
        JSArray items   = call.getArray("items");
        final long startMs = (long)(double)call.getDouble("startMs", 0.0);
        if (items == null || items.length() == 0) { call.resolve(); return; }

        getActivity().runOnUiThread(() -> {
            getContext().startService(new Intent(getContext(), PlaybackService.class));
            waitForService(10, () -> doSetPlaylist(call, items, startMs),
                           () -> call.reject("PlaybackService not ready"));
        });
    }

    private void doSetPlaylist(PluginCall call, JSArray items, long startMs) {
        try {
            ensurePlayerView();
            ExoPlayer player = PlaybackService.getPlayer();
            if (player == null) { call.reject("Player unavailable"); return; }
            if (playerView.getPlayer() != player) playerView.setPlayer(player);
            playerView.setVisibility(View.VISIBLE);

            List<MediaItem> mediaItems = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) {
                try {
                    JSONObject item = items.getJSONObject(i);
                    String uriStr = item.optString("uri",    "");
                    String title  = item.optString("title",  "");
                    String artist = item.optString("artist", "StudyPlay");
                    if (uriStr.isEmpty()) continue;

                    Uri uri = resolveUri(uriStr);
                    // Inclui artwork do app em cada faixa da playlist
                    mediaItems.add(new MediaItem.Builder()
                        .setUri(uri)
                        .setMediaMetadata(buildMetadata(title, artist, ""))
                        .build());
                } catch (Exception e) {
                    Log.w(TAG, "setPlaylist item " + i + ": " + e.getMessage());
                }
            }
            if (mediaItems.isEmpty()) { call.resolve(); return; }

            player.removeListener(playerListener);
            player.stop();
            player.clearMediaItems();
            player.addListener(playerListener);
            player.setMediaItems(mediaItems, /* resetPosition= */ true);
            player.prepare();
            if (startMs > 0) player.seekTo(0, startMs); // item 0, posição startMs

            startTimeUpdates();
            call.resolve();

        } catch (Exception e) {
            Log.e(TAG, "setPlaylist failed", e);
            call.reject("Failed: " + e.getMessage());
        }
    }

    /**
     * seekToItem({index}) — salta para o item na posição index da playlist atual.
     * Usado pelo JS quando prev/next é pressionado: evita recriar a playlist inteira
     * e o consequente race condition do trackChanged.
     */
    @PluginMethod
    public void seekToItem(PluginCall call) {
        final int index = call.getInt("index", 0);
        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null && index >= 0 && index < p.getMediaItemCount()) {
                p.seekToDefaultPosition(index);
            }
        });
        call.resolve();
    }

    /**
     * getCurrentIndex() — retorna índice do item atual no ExoPlayer e posição em segundos.
     * Usado para sincronizar a UI do JS após retornar do background.
     */
    @PluginMethod
    public void getCurrentIndex(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ExoPlayer p = PlaybackService.getPlayer();
            JSObject ret = new JSObject();
            ret.put("index",    (p != null) ? p.getCurrentMediaItemIndex() : 0);
            ret.put("position", (p != null) ? p.getCurrentPosition() / 1000.0 : 0.0);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ensurePlayerView();
            playerView.setVisibility(View.VISIBLE);
        });
        call.resolve();
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (playerView != null) playerView.setVisibility(View.INVISIBLE);
        });
        call.resolve();
    }

    /**
     * updateRect({x, y, w, h}) — posiciona o PlayerView sobre o elemento <video>.
     * Valores em CSS pixels. O PlayerView tem RESIZE_MODE_FIT, então ele mesmo
     * aplica letterboxing para manter o aspect ratio sem distorção.
     */
    @PluginMethod
    public void updateRect(PluginCall call) {
        final double cx = call.getDouble("x", 0.0);
        final double cy = call.getDouble("y", 0.0);
        final double cw = call.getDouble("w", 0.0);
        final double ch = call.getDouble("h", 0.0);

        getActivity().runOnUiThread(() -> {
            if (cw <= 0 || ch <= 0) return;
            ensurePlayerView();
            if (isFullscreen) return; // em fullscreen ignora atualizações de rect
            if (isPiP) return;        // em PiP ignora: o JS enviaria coords de tela-cheia

            float dp = getContext().getResources().getDisplayMetrics().density;
            areaLeft   = Math.round((float)(cx * dp));
            areaTop    = Math.round((float)(cy * dp));
            areaWidth  = Math.round((float)(cw * dp));
            areaHeight = Math.round((float)(ch * dp));

            positionPlayerView(areaLeft, areaTop, areaWidth, areaHeight);
        });
        call.resolve();
    }

    private void positionPlayerView(int left, int top, int width, int height) {
        if (playerView == null || width <= 0 || height <= 0) return;
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(width, height);
        lp.leftMargin = left;
        lp.topMargin  = top;
        playerView.setLayoutParams(lp);
        playerView.setVisibility(View.VISIBLE);
    }

    /**
     * enableTransparency — define fundo da janela como preto.
     * As barras de letterboxing do RESIZE_MODE_FIT aparecem pretas.
     */
    @PluginMethod
    public void enableTransparency(PluginCall call) {
        getActivity().runOnUiThread(() ->
            getActivity().getWindow().setBackgroundDrawable(
                new android.graphics.drawable.ColorDrawable(Color.BLACK)));
        call.resolve();
    }

    /**
     * enterFullscreen — expande para tela cheia com controles nativos YouTube-like.
     * O PlayerView passa a usar useController=true (ExoPlayer StyledPlayerView UI).
     */
    @PluginMethod
    public void enterFullscreen(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (isFullscreen) { call.resolve(); return; }
            ensurePlayerView();
            isFullscreen = true;

            // Expande para tela cheia
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT);
            playerView.setLayoutParams(lp);
            playerView.setVisibility(View.VISIBLE);

            // Ativa controles nativos (YouTube-like: play/pause, seek, sair FS)
            playerView.setUseController(true);
            playerView.setControllerHideOnTouch(true);
            playerView.setClickable(true);
            playerView.setFocusable(true);

            // Botão de sair do fullscreen no controller nativo
            playerView.setFullscreenButtonClickListener(isEntering -> {
                if (!isEntering) exitFullscreenInternal(null);
            });

            // Oculta status bar e navigation bar
            setSystemBarsVisible(false);

            JSObject data = new JSObject();
            data.put("active", true);
            notifyListeners("fullscreenChanged", data);
            call.resolve();
        });
    }

    /** exitFullscreen — sai do fullscreen e restaura posição normal */
    @PluginMethod
    public void exitFullscreen(PluginCall call) {
        getActivity().runOnUiThread(() -> exitFullscreenInternal(call));
    }

    void exitFullscreenInternal(PluginCall call) {
        if (!isFullscreen) { if (call != null) call.resolve(); return; }
        isFullscreen = false;

        // Volta para controles HTML (sem controller nativo)
        if (playerView != null) {
            playerView.setUseController(false);
            playerView.setClickable(false);
            playerView.setFocusable(false);
            // Restaura posição anterior (JS chamará syncRect logo em seguida)
            if (areaWidth > 0) positionPlayerView(areaLeft, areaTop, areaWidth, areaHeight);
        }

        // Restaura barras do sistema
        setSystemBarsVisible(true);

        JSObject data = new JSObject();
        data.put("active", false);
        notifyListeners("fullscreenChanged", data);
        if (call != null) call.resolve();
    }

    /**
     * enterPiP — entra no modo Picture-in-Picture.
     *
     * O PlayerView é expandido para MATCH_PARENT ANTES de chamar
     * enterPictureInPictureMode, garantindo que:
     *   1. O primeiro frame da janela PiP mostra apenas o vídeo (sem moldura HTML)
     *   2. A animação de zoom parte do vídeo em tela cheia (sourceRectHint correto)
     */
    @PluginMethod
    public void enterPiP(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("PiP requires Android 8+"); return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                ensurePlayerView();

                // ── Expande o PlayerView para tela cheia ANTES da animação de PiP ──
                // Com isso a janela PiP mostra só o vídeo desde o frame 0, e a animação
                // de encolher parte do vídeo em tela cheia (muito mais limpa visualmente).
                if (playerView != null) {
                    playerView.setUseController(false);
                    playerView.setLayoutParams(new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT));
                    playerView.setVisibility(View.VISIBLE);
                }

                // Usa o aspect ratio real do vídeo para a janela PiP encaixar direto
                Rational aspectRatio = new Rational(16, 9);
                ExoPlayer pip = PlaybackService.getPlayer();
                if (pip != null) {
                    VideoSize vs = pip.getVideoSize();
                    if (vs.width > 0 && vs.height > 0) {
                        aspectRatio = new Rational(vs.width, vs.height);
                    }
                }
                PictureInPictureParams.Builder builder =
                    new PictureInPictureParams.Builder()
                        .setAspectRatio(aspectRatio);

                // sourceRectHint: usa as dimensões do decor view (disponíveis imediatamente
                // após o setLayoutParams MATCH_PARENT — getGlobalVisibleRect retornaria o
                // rect antigo antes do layout pass completar).
                View decorView = getActivity().getWindow().getDecorView();
                Rect hint = new Rect(0, 0, decorView.getWidth(), decorView.getHeight());
                if (!hint.isEmpty()) builder.setSourceRectHint(hint);

                // Botão de fone/áudio na janela PiP (API 26+)
                try {
                    Intent audioIntent = new Intent(PIP_ACTION_AUDIO)
                        .setPackage(getContext().getPackageName());
                    PendingIntent audioPi = PendingIntent.getBroadcast(
                        getContext(), PIP_REQ_AUDIO, audioIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    Icon audioIcon = Icon.createWithResource(
                        getContext(), R.drawable.ic_pip_headphone);
                    RemoteAction audioAction = new RemoteAction(
                        audioIcon, "Áudio", "Modo apenas áudio", audioPi);
                    builder.setActions(Collections.singletonList(audioAction));
                } catch (Exception e) {
                    Log.w(TAG, "PiP RemoteAction setup failed: " + e.getMessage());
                }

                getActivity().enterPictureInPictureMode(builder.build());
                call.resolve();
            } catch (Exception e) {
                // Falha → restaura posição original
                if (playerView != null && areaWidth > 0) {
                    positionPlayerView(areaLeft, areaTop, areaWidth, areaHeight);
                }
                call.reject("PiP failed: " + e.getMessage());
            }
        });
    }

    /**
     * Chamado por MainActivity.onPictureInPictureModeChanged.
     * Expande/reduz o PlayerView para PiP sem moldura HTML.
     */
    public void onPiPModeChanged(boolean inPiP) {
        getActivity().runOnUiThread(() -> {
            isPiP = inPiP; // Atualiza flag ANTES de qualquer lógica de layout

            if (playerView == null) return;
            if (inPiP) {
                // Ocupa toda a janela → PiP mostra apenas o vídeo (sem moldura HTML)
                playerView.setLayoutParams(new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT));
                playerView.setUseController(false);
                playerView.setVisibility(View.VISIBLE);
            } else {
                // Sai do PiP — desabilita interação do PlayerView
                playerView.setUseController(false);
                playerView.setClickable(false);
                playerView.setFocusable(false);
                playerView.setFocusableInTouchMode(false);

                // MINIMIZA IMEDIATAMENTE para 1×1 invisível.
                // NÃO usamos positionPlayerView(areaLeft, …) aqui porque:
                //  1. Durante o PiP o WebView renderiza no viewport pequeno (janela PiP).
                //     Qualquer updateRect capturado nesse viewport teria coordenadas erradas.
                //  2. Mesmo com os guards isPiP/pip-active, o window.resize ou
                //     appStateChange podem ter disparado syncRect antes que esses flags
                //     fossem definidos, corrompendo areaLeft/areaTop/areaWidth/areaHeight.
                // O posicionamento correto é responsabilidade exclusiva do JS:
                //  pipChanged(false) → pip-active removido → window.resize → syncRect
                //  → doSyncRect() → updateRect() com coordenadas do viewport correto
                //  → positionPlayerView() → PlayerView visível na posição certa.
                playerView.setLayoutParams(new FrameLayout.LayoutParams(1, 1));
                playerView.setVisibility(View.INVISIBLE);

                // Fallback: pede ao JS para resincronizar caso window.resize não dispare
                scheduleRectRefresh(500);
            }

            // Notifica o JS via canal do plugin (mais confiável que triggerJSEvent do MainActivity)
            // JS usa plugin.addListener('pipChanged') para remover/adicionar body.pip-active
            JSObject data = new JSObject();
            data.put("active", inPiP);
            notifyListeners("pipChanged", data);
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void setSystemBarsVisible(boolean visible) {
        try {
            WindowInsetsControllerCompat wic = ViewCompat.getWindowInsetsController(
                getActivity().getWindow().getDecorView());
            if (wic == null) return;
            if (visible) {
                wic.show(WindowInsetsCompat.Type.systemBars());
            } else {
                wic.hide(WindowInsetsCompat.Type.systemBars());
                wic.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } catch (Exception e) {
            Log.w(TAG, "setSystemBarsVisible failed", e);
        }
    }

    private void waitForService(int retries, Runnable onReady, Runnable onTimeout) {
        if (PlaybackService.getPlayer() != null) { onReady.run(); return; }
        if (retries <= 0) { onTimeout.run(); return; }
        handler.postDelayed(() -> waitForService(retries - 1, onReady, onTimeout), 100);
    }

    /**
     * Retorna o ícone do app como bytes JPEG para usar como artwork da notificação.
     * O HyperOS da Xiaomi exige artwork no MediaMetadata para exibir a Hyper Island
     * (Dynamic Island) e a prévia expandida na barra de notificações.
     * Cache estático: bitmap gerado uma vez e reutilizado em todas as faixas.
     */
    private static byte[] _artworkCache = null;
    private byte[] getAppIconArtwork() {
        if (_artworkCache != null) return _artworkCache;
        try {
            Bitmap bmp = BitmapFactory.decodeResource(
                getContext().getResources(), R.mipmap.ic_launcher);
            if (bmp == null) return null;
            // Escala para 512×512 (padrão recomendado pelo HyperOS para Hyper Island)
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, 512, 512, true);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, 90, bos);
            _artworkCache = bos.toByteArray();
            scaled.recycle();
        } catch (Exception e) {
            Log.w(TAG, "getAppIconArtwork failed: " + e.getMessage());
        }
        return _artworkCache;
    }

    /** Constrói MediaMetadata com título, artista, album e artwork do app. */
    private MediaMetadata buildMetadata(String title, String artist, String album) {
        // HyperOS Media Capsule requer título não-nulo para exibir o player.
        // "StudyPlay" é o fallback — melhor que null ou string vazia.
        MediaMetadata.Builder b = new MediaMetadata.Builder()
            .setTitle( title.isEmpty()  ? "StudyPlay" : title)
            .setArtist(artist.isEmpty() ? "StudyPlay" : artist)
            .setAlbumTitle(album.isEmpty() ? null : album);
        byte[] art = getAppIconArtwork();
        if (art != null) {
            b.setArtworkData(art, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
        }
        return b.build();
    }

    /** Extrai content:// do proxy URL https://localhost/_saf_/?uri=… */
    private Uri resolveUri(String uriStr) {
        if (uriStr != null && uriStr.contains("/_saf_/")) {
            Uri proxy = Uri.parse(uriStr);
            String inner = proxy.getQueryParameter("uri");
            if (inner != null) return Uri.parse(inner);
        }
        return Uri.parse(uriStr);
    }

    /**
     * Cria e configura o PlayerView:
     *  • RESIZE_MODE_FIT = aspecto correto com letterboxing automático (sem distorção)
     *  • useController = false = HTML controls gerenciam o player no modo normal
     *  • setClickable(false) = toques passam para WebView (HTML controls são acessíveis)
     *  • addView sem índice = z-order máximo = ACIMA do WebView
     */
    private void ensurePlayerView() {
        if (playerView != null) return;

        playerView = new PlayerView(getContext());
        playerView.setLayoutParams(new FrameLayout.LayoutParams(1, 1));
        playerView.setVisibility(View.INVISIBLE);

        // Fundo preto: garante letterbox preto em tela cheia e PiP (sem fundo do app)
        playerView.setBackgroundColor(Color.BLACK);

        // Sem distorção: aspect ratio mantido com letterboxing preto
        playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);

        // Modo normal: sem controles nativos (HTML controls)
        playerView.setUseController(false);

        // Permite que toques atravessem para os HTML controls no WebView
        playerView.setClickable(false);
        playerView.setFocusable(false);
        playerView.setFocusableInTouchMode(false);

        // Conecta ao ExoPlayer
        ExoPlayer p = PlaybackService.getPlayer();
        if (p != null) playerView.setPlayer(p);

        // Adiciona ACIMA do WebView (sem índice = último filho = z-order máximo)
        ViewGroup root = getActivity().getWindow().getDecorView()
                             .findViewById(android.R.id.content);
        if (root != null) root.addView(playerView);
    }

    // ── Atualizações de tempo ─────────────────────────────────────────────────

    private void startTimeUpdates() {
        stopTimeUpdates();
        timeUpdateTask = new Runnable() {
            @Override public void run() {
                ExoPlayer p = PlaybackService.getPlayer();
                if (p != null && p.isPlaying()) {
                    long pos = p.getCurrentPosition();
                    long dur = p.getDuration();
                    if (dur > 0) {
                        JSObject e = new JSObject();
                        e.put("currentTime", pos / 1000.0);
                        e.put("duration",    dur / 1000.0);
                        notifyListeners("timeupdate", e);
                    }
                }
                handler.postDelayed(this, 250);
            }
        };
        handler.postDelayed(timeUpdateTask, 250);
    }

    private void stopTimeUpdates() {
        if (timeUpdateTask != null) {
            handler.removeCallbacks(timeUpdateTask);
            timeUpdateTask = null;
        }
    }

    private boolean timeUpdatesRunning() {
        return timeUpdateTask != null;
    }

    // ── Player Listener ───────────────────────────────────────────────────────

    private final Player.Listener playerListener = new Player.Listener() {

        /**
         * Disparado quando o ExoPlayer avança para o próximo item da playlist.
         * Funciona em background — não precisa do WebView ativo para continuar a reprodução.
         * O JS usa esse evento para atualizar o índice corrente e a UI quando o app voltar.
         */
        @Override
        public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
            ExoPlayer p = PlaybackService.getPlayer();
            int index   = (p != null) ? p.getCurrentMediaItemIndex() : 0;
            String title = "";
            if (mediaItem != null && mediaItem.mediaMetadata.title != null) {
                title = mediaItem.mediaMetadata.title.toString();
            }
            JSObject e = new JSObject();
            e.put("index", index);
            e.put("title", title);
            // reason == 1 → avanço automático (item terminou); outros → manual / repeat
            e.put("auto",  reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO);
            notifyListeners("trackChanged", e);
            // Reinicia time-updates para o novo item
            startTimeUpdates();
            /* Se o player já está em STATE_READY (item pré-bufferizado),
               onPlaybackStateChanged(STATE_READY) não dispara novamente —
               enviamos loadedmetadata manualmente para que o JS receba a duração. */
            if (p != null && p.getPlaybackState() == Player.STATE_READY) {
                long dur = p.getDuration();
                JSObject lm = new JSObject();
                lm.put("duration", dur > 0 ? dur / 1000.0 : 0);
                notifyListeners("loadedmetadata", lm);
                notifyListeners("canplay", new JSObject());
            }
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) {
                ExoPlayer p = PlaybackService.getPlayer();
                long dur = (p != null) ? p.getDuration() : 0;
                JSObject e = new JSObject();
                e.put("duration", dur > 0 ? dur / 1000.0 : 0);
                notifyListeners("loadedmetadata", e);
                notifyListeners("canplay", new JSObject());

            } else if (state == Player.STATE_ENDED) {
                stopTimeUpdates();
                notifyListeners("ended", new JSObject());
            }
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            notifyListeners(isPlaying ? "play" : "pause", new JSObject());
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            Log.e(TAG, "ExoPlayer error code=" + error.errorCode, error);

            // Retry automático para falhas de decodificador de hardware (comum no Xiaomi)
            ExoPlayer p = PlaybackService.getPlayer();
            if (p != null
                    && (error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
                    ||  error.errorCode == PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED)
                    && p.getCurrentMediaItem() != null) {
                Log.w(TAG, "Hardware decoder failed — retrying with software decoder");
                handler.postDelayed(() -> {
                    ExoPlayer rp = PlaybackService.getPlayer();
                    if (rp != null) { rp.prepare(); rp.play(); }
                }, 500);
                return;
            }

            stopTimeUpdates();
            JSObject e = new JSObject();
            e.put("message", error.getMessage() != null ? error.getMessage() : "unknown");
            e.put("code", error.errorCode);
            notifyListeners("error", e);
        }
    };
}
