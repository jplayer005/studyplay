package com.jcorelabs.studyplay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.pm.ServiceInfo;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import com.getcapacitor.JSObject;

/**
 * PlaybackService — MediaSessionService com ExoPlayer.
 *
 * Compatibilidade HyperOS / Ilha Dinâmica (Dynamic Island) Xiaomi:
 *  ✓ MediaSessionService com addSession() garante ciclo de vida correto
 *  ✓ Notification.MediaStyle nativo com setMediaSession() (token nativo)
 *  ✓ MIUI/HyperOS reconhece o app como player ativo → roteia botões do fone
 *  ✓ Canal de notificação com IMPORTANCE_LOW (silencioso, mas visível)
 *  ✓ foregroundServiceType="mediaPlayback" no Manifest
 *  ✓ Reproduzindo → startForeground() sempre (notificação persistente)
 *  ✓ Pausado     → stopForeground(false) (notificação dispensável)
 *  ✓ FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK (Android 14+ / API 29+)
 *  ✓ Reprodução com tela desligada  (WAKE_MODE_LOCAL + foreground service)
 *  ✓ Controles na tela de bloqueio  (notificação automática do MediaSessionService)
 *  ✓ Não ser morto pela HyperOS     (battery optimization exemption + foreground)
 *  ✓ Pausa ao desconectar fone      (handleAudioBecomingNoisy)
 *  ✓ Foco de áudio correto          (handleAudioFocus)
 *  ✓ Buffering estável              (DefaultLoadControl ampliado)
 *  ✓ Botões do fone (play/pause/próximo/anterior) via dispatchKeyEvent + ForwardingPlayer
 */
public class PlaybackService extends MediaSessionService {

    /** ID do canal de notificação — deve ser único e estável entre versões */
    public static final String MEDIA_CHANNEL_ID      = "studyplay_media_playback";
    public static final int    MEDIA_NOTIFICATION_ID = 1001;

    /** Ações dos botões da notificação de mídia */
    public static final String ACTION_NOTIF_PREV       = "com.jcorelabs.studyplay.NOTIF_PREV";
    public static final String ACTION_NOTIF_NEXT       = "com.jcorelabs.studyplay.NOTIF_NEXT";
    public static final String ACTION_NOTIF_PLAY_PAUSE = "com.jcorelabs.studyplay.NOTIF_PLAY_PAUSE";
    public static final String ACTION_NOTIF_DISMISS    = "com.jcorelabs.studyplay.NOTIF_DISMISS";

    /** Acesso direto do plugin (mesmo processo, mesma thread). */
    public static volatile PlaybackService instance;

    private MediaSession             mediaSession;
    private ExoPlayer                player;
    private NextPrevInterceptPlayer  interceptPlayer;
    private WifiManager.WifiLock     wifiLock;
    private BroadcastReceiver        notifActionReceiver;

    /**
     * Token nativo da plataforma (android.media.session.MediaSession.Token), resolvido
     * uma vez via reflection logo após a criação do MediaSession e cacheado aqui.
     *
     * Por que reflection?
     * getPlatformToken() é @UnstableApi no Media3 e não aparece no stub JAR de compilação,
     * mas está presente no bytecode de runtime. Reflection acessa o método sem restrição
     * de compilação. O resultado é cacheado: uma única resolução por ciclo de vida do serviço.
     *
     * Por que isso é crítico?
     * Notification.MediaStyle.setMediaSession(token) vincula a notificação foreground ao
     * android.media.session.MediaSession correto. Sem esse vínculo, o HyperOS/MIUI não
     * consegue associar a notificação ao player → cápsula dinâmica não aparece.
     */
    private android.media.session.MediaSession.Token platformSessionToken = null;

    @androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
    @Override
    public void onCreate() {
        instance = this;

        // ── 1. Canais de notificação ───────────────────────────────────────────
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                NotificationChannel ch1 = new NotificationChannel(
                    MEDIA_CHANNEL_ID,
                    getString(R.string.media_channel_name),
                    NotificationManager.IMPORTANCE_LOW);
                ch1.setDescription(getString(R.string.media_channel_desc));
                ch1.setShowBadge(false);
                ch1.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch1);

                // Canal do DefaultMediaNotificationManager do Media3 (ID fixo)
                NotificationChannel ch2 = new NotificationChannel(
                    "media3_session_notification",
                    getString(R.string.media_channel_name),
                    NotificationManager.IMPORTANCE_LOW);
                ch2.setDescription(getString(R.string.media_channel_desc));
                ch2.setShowBadge(false);
                ch2.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch2);
            }
        }

        super.onCreate();

        // ── 2. Buffer ampliado ────────────────────────────────────────────────
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(15_000, 50_000, 2_500, 5_000)
            .build();

        player = new ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus= */ true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build();

        // Observa mudanças de estado do player para atualizar a notificação.
        // Belt-and-suspenders: garante atualização mesmo em casos onde o Media3
        // interno não dispara onUpdateNotification() (comum no HyperOS).
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                postNotificationUpdate();
            }
            @Override
            public void onPlaybackStateChanged(int state) {
                postNotificationUpdate();
            }
            @Override
            public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
                postNotificationUpdate();
            }
        });

        // Intent para reabrir o app ao tocar na notificação
        PendingIntent backToApp = PendingIntent.getActivity(
            this, 0,
            new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // ── 3. ForwardingPlayer ────────────────────────────────────────────────
        // Intercepta seekToNext/Previous() em modo single-video (1 item na fila)
        // para disparar eventos JS (nextTrack/prevTrack).
        // Em modo playlist (múltiplos itens), delega direto ao ExoPlayer.
        // Sempre anuncia SEEK_TO_NEXT/PREVIOUS como disponíveis → botões ◀ ▶
        // aparecem na notificação, tela de bloqueio e respondem ao fone.
        interceptPlayer = new NextPrevInterceptPlayer(player);

        mediaSession = new MediaSession.Builder(this, interceptPlayer)
            .setSessionActivity(backToApp)
            .build();

        // Resolve o token nativo IMEDIATAMENTE após criar o MediaSession.
        // O android.media.session.MediaSession subjacente já existe neste ponto.
        // Cacheado aqui para evitar reflection repetida a cada atualização de notificação.
        resolvePlatformToken();

        // Registra a sessão no serviço para que o Media3 gerencie o ciclo de vida
        // da notificação automaticamente. Sem addSession(), onUpdateNotification()
        // não é chamado quando o serviço sobe sem um MediaController vinculado —
        // o que é exatamente o caso do StudyPlay (o plugin inicia o serviço diretamente).
        addSession(mediaSession);

        // ── 4. Receptor de ações dos botões da notificação ───────────────────
        registerNotifActionReceiver();

        // ── 5. WifiLock ───────────────────────────────────────────────────────
        try {
            WifiManager wm = (WifiManager) getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                    "studyplay:wifi");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Exception ignored) {}
    }

    /**
     * Resolve e cacheia o android.media.session.MediaSession.Token a partir do
     * Media3 SessionToken usando reflection hierárquica.
     *
     * Estratégia:
     *  1. Obtém o objeto SessionToken do Media3 MediaSession.
     *  2. Percorre a hierarquia de classes (SessionToken → seus supertipos) usando
     *     getDeclaredMethod() — cobre casos onde o método está em uma superclasse
     *     não incluída no stub de compilação.
     *  3. setAccessible(true) garante acesso mesmo se o método for package-private
     *     na implementação interna do Media3.
     *  4. Verifica se o resultado é realmente um android.media.session.MediaSession.Token
     *     antes de armazenar (proteção contra mudanças de API entre versões).
     */
    private void resolvePlatformToken() {
        if (mediaSession == null) return;
        try {
            Object sessionToken = mediaSession.getToken();
            Class<?> clz = sessionToken.getClass();
            java.lang.reflect.Method method = null;
            // Percorre toda a hierarquia de classes para encontrar getPlatformToken()
            while (clz != null && method == null) {
                try {
                    method = clz.getDeclaredMethod("getPlatformToken");
                } catch (NoSuchMethodException ignored) {
                    clz = clz.getSuperclass();
                }
            }
            if (method != null) {
                method.setAccessible(true);
                Object result = method.invoke(sessionToken);
                if (result instanceof android.media.session.MediaSession.Token) {
                    platformSessionToken = (android.media.session.MediaSession.Token) result;
                }
            }
        } catch (Exception ignored) {
            // Falha silenciosa: notificação funciona normalmente, só perde o vínculo
            // direto ao MediaSession nativo (cápsula pode não aparecer neste caso)
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);
        return START_STICKY;
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo info) {
        return mediaSession;
    }

    // ── API estática ──────────────────────────────────────────────────────────

    public static ExoPlayer getPlayer() {
        return instance != null ? instance.player : null;
    }

    /**
     * Retorna true se há mídia carregada (pelo menos 1 item na fila).
     * Usado por MainActivity.dispatchKeyEvent() para decidir se deve interceptar
     * os botões físicos de mídia antes que o WebView os consuma.
     */
    public static boolean hasActivePlayer() {
        ExoPlayer p = getPlayer();
        return p != null && p.getMediaItemCount() > 0;
    }

    /**
     * Trata keyCode de mídia dos botões físicos do fone/headset.
     * Chamado por MainActivity.dispatchKeyEvent() para garantir que os botões
     * cheguem ao ExoPlayer mesmo quando o WebView tem foco.
     */
    public static boolean handleMediaKey(int keyCode) {
        PlaybackService svc = instance;
        if (svc == null || svc.player == null || svc.interceptPlayer == null) return false;
        ExoPlayer               p  = svc.player;
        NextPrevInterceptPlayer ip = svc.interceptPlayer;

        switch (keyCode) {
            case KeyEvent.KEYCODE_HEADSETHOOK:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                if (p.isPlaying()) p.pause(); else p.play();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                p.play();  return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                p.pause(); return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
                ip.seekToNext();     return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
                ip.seekToPrevious(); return true;
            default:
                return false;
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (player == null || !player.getPlayWhenReady()) {
            stopSelf();
        }
    }

    @androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
    @Override
    public void onDestroy() {
        if (notifActionReceiver != null) {
            try { unregisterReceiver(notifActionReceiver); } catch (Exception ignored) {}
            notifActionReceiver = null;
        }
        if (wifiLock     != null && wifiLock.isHeld()) { wifiLock.release(); wifiLock = null; }
        if (player       != null) { player.release();       player       = null; }
        if (mediaSession != null) {
            try { removeSession(mediaSession); } catch (Exception ignored) {}
            mediaSession.release();
            mediaSession = null;
        }
        interceptPlayer = null;
        instance = null;
        super.onDestroy();
    }

    // ── Notificação de mídia ──────────────────────────────────────────────────

    /**
     * Chamado pelo Media3 sempre que o estado da sessão muda.
     *
     * Regras de ciclo de vida do foreground service (igual ao Spotify/YT Music):
     *  – Reproduzindo (ou buffering com playWhenReady) → startForeground()
     *    Notificação persistente, não dispensável. MIUI/HyperOS não mata o serviço.
     *  – Pausado → stopForeground(false) + nm.notify()
     *    Notificação permanece visível, mas é dispensável pelo usuário.
     *  – Ocioso/Finalizado → remove notificação completamente.
     *
     * startForeground() é chamado SEMPRE que isPlaying=true — independente do
     * parâmetro startInForeground — para prevenir que o HyperOS degrade o serviço
     * após a primeira atualização de estado.
     */
    @SuppressWarnings("deprecation")
    @androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
    @Override
    public void onUpdateNotification(@NonNull MediaSession session, boolean startInForeground) {
        if (player == null) return;

        int     state  = player.getPlaybackState();
        boolean active = state != Player.STATE_IDLE && state != Player.STATE_ENDED;

        if (!active && !startInForeground) {
            // Sem mídia ativa: remove notificação e sai do foreground
            stopForeground(true);
            return;
        }

        boolean isPlaying = player.isPlaying()
            || (player.getPlayWhenReady() && state == Player.STATE_BUFFERING);

        Notification n = buildPlaybackNotification();

        if (isPlaying || startInForeground) {
            // Reproduzindo: foreground obrigatório (Android 10+ requer tipo explícito)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(MEDIA_NOTIFICATION_ID, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(MEDIA_NOTIFICATION_ID, n);
            }
        } else {
            // Pausado: desfaz foreground mas mantém notificação (dispensável)
            stopForeground(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(MEDIA_NOTIFICATION_ID, n);
        }
    }

    /**
     * Posta uma atualização de notificação na main thread a partir dos listeners
     * do Player. Chamado quando isPlaying, playbackState ou mediaItem mudam.
     * Belt-and-suspenders para o HyperOS, onde o observador interno do Media3
     * pode não disparar onUpdateNotification() em todos os casos.
     */
    @androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
    private void postNotificationUpdate() {
        if (mediaSession == null || player == null) return;
        new Handler(Looper.getMainLooper()).post(() -> {
            if (mediaSession == null || player == null) return;
            boolean playing = player.isPlaying()
                || (player.getPlayWhenReady()
                    && player.getPlaybackState() == Player.STATE_BUFFERING);
            onUpdateNotification(mediaSession, playing);
        });
    }

    /**
     * Monta a notificação MediaStyle com botões Anterior / Play-Pause / Próximo.
     *
     * Usa Notification.Builder (plataforma, API 11+) em vez de NotificationCompat para ter
     * acesso a Notification.MediaStyle.setMediaSession() com o token nativo do Android.
     *
     * setMediaSession() é ESSENCIAL no MIUI/HyperOS: ele vincula a notificação ao
     * MediaSession do sistema, permitindo que:
     *  – O MIUI reconheça o app como player ativo e roteia botões do fone
     *  – A tela de bloqueio exiba os controles de mídia
     *  – A Ilha Dinâmica (HyperOS 3) exiba o player em destaque
     */
    @androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
    private Notification buildPlaybackNotification() {
        boolean isPlaying = player != null && player.isPlaying();

        // ── Metadados (título, artista e artwork) ─────────────────────────────
        String title = "StudyPlay", artist = "";
        Bitmap artwork = null;

        if (player != null) {
            MediaItem item = player.getCurrentMediaItem();
            if (item != null && item.mediaMetadata != null) {
                MediaMetadata m = item.mediaMetadata;
                if (m.title    != null) title  = m.title.toString();
                if (m.artist   != null) artist = m.artist.toString();
                if (m.artworkData != null) {
                    artwork = BitmapFactory.decodeByteArray(
                        m.artworkData, 0, m.artworkData.length);
                }
            }
        }
        // Fallback: ícone do app como artwork (evita notificação sem imagem)
        if (artwork == null) {
            try {
                artwork = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
            } catch (Exception ignored) {}
        }

        // ── PendingIntents ────────────────────────────────────────────────────
        PendingIntent openApp = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        PendingIntent prevPi = PendingIntent.getBroadcast(this, 201,
            new Intent(ACTION_NOTIF_PREV).setPackage(getPackageName()),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent ppPi = PendingIntent.getBroadcast(this, 202,
            new Intent(ACTION_NOTIF_PLAY_PAUSE).setPackage(getPackageName()),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent nextPi = PendingIntent.getBroadcast(this, 203,
            new Intent(ACTION_NOTIF_NEXT).setPackage(getPackageName()),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent dismissPi = PendingIntent.getBroadcast(this, 204,
            new Intent(ACTION_NOTIF_DISMISS).setPackage(getPackageName()),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // ── MediaStyle nativo com token de sessão ─────────────────────────────
        // Usa Notification.MediaStyle (plataforma, API 21+) em vez de NotificationCompat.
        // setMediaSession() com o token nativo é OBRIGATÓRIO para:
        //   – HyperOS/MIUI reconhecer o app como player ativo (cápsula dinâmica)
        //   – Tela de bloqueio exibir controles de mídia corretamente
        //   – Sistema rotear os botões do fone para este player e não para outro
        // O token foi resolvido via reflection em onCreate() e está cacheado em
        // platformSessionToken. Se a resolução falhou, a notificação funciona mas
        // sem o vínculo direto ao MediaSession nativo.
        Notification.MediaStyle mediaStyle = new Notification.MediaStyle()
            .setShowActionsInCompactView(0, 1, 2);
        if (platformSessionToken != null) {
            mediaStyle.setMediaSession(platformSessionToken);
        }

        // ── Ações (botões da notificação) ─────────────────────────────────────
        Notification.Action prevAction = new Notification.Action.Builder(
            android.R.drawable.ic_media_previous, "Anterior", prevPi).build();
        Notification.Action ppAction = new Notification.Action.Builder(
            isPlaying ? android.R.drawable.ic_media_pause
                      : android.R.drawable.ic_media_play,
            isPlaying ? "Pausar" : "Reproduzir", ppPi).build();
        Notification.Action nextAction = new Notification.Action.Builder(
            android.R.drawable.ic_media_next, "Próximo", nextPi).build();

        // ── Builder (plataforma, API 11+) ─────────────────────────────────────
        // CATEGORY_TRANSPORT: informa ao sistema (incluindo HyperOS) que esta notificação
        // é um controle de transporte de mídia. SEM esta categoria, o HyperOS não promove
        // a notificação para a cápsula dinâmica (Media Capsule / Dynamic Island).
        Notification.Builder builder = new Notification.Builder(this, MEDIA_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(openApp)
            .setDeleteIntent(dismissPi)      // ao dispensar: para reprodução
            .setCategory(Notification.CATEGORY_TRANSPORT) // ← HyperOS capsule detection
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(isPlaying)           // não dispensável enquanto reproduzindo
            .setOnlyAlertOnce(true)
            .setShowWhen(false)              // sem timestamp — desnecessário em player
            .setStyle(mediaStyle)
            .addAction(prevAction)
            .addAction(ppAction)
            .addAction(nextAction);

        if (artwork != null) {
            builder.setLargeIcon(artwork);
        }

        return builder.build();
    }

    /**
     * Registra BroadcastReceiver para os botões da notificação de mídia.
     *
     * PREV/NEXT → NextPrevInterceptPlayer (trata single-video vs playlist)
     * PLAY_PAUSE → ExoPlayer direto
     * DISMISS → pausa e para o serviço (usuário dispensou a notificação)
     */
    private void registerNotifActionReceiver() {
        notifActionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                String action = intent.getAction();
                if (ACTION_NOTIF_PLAY_PAUSE.equals(action)) {
                    if (player != null) {
                        if (player.isPlaying()) player.pause();
                        else                    player.play();
                    }
                } else if (ACTION_NOTIF_PREV.equals(action)) {
                    if (interceptPlayer != null) interceptPlayer.seekToPrevious();
                } else if (ACTION_NOTIF_NEXT.equals(action)) {
                    if (interceptPlayer != null) interceptPlayer.seekToNext();
                } else if (ACTION_NOTIF_DISMISS.equals(action)) {
                    // Usuário dispensou a notificação → pausa reprodução e encerra serviço
                    if (player != null) player.pause();
                    stopSelf();
                }
            }
        };

        IntentFilter f = new IntentFilter();
        f.addAction(ACTION_NOTIF_PREV);
        f.addAction(ACTION_NOTIF_NEXT);
        f.addAction(ACTION_NOTIF_PLAY_PAUSE);
        f.addAction(ACTION_NOTIF_DISMISS);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(notifActionReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(notifActionReceiver, f);
        }
    }

    // ── ForwardingPlayer: intercepta next/prev em modo single-video ───────────

    /**
     * Envolve o ExoPlayer e intercepta seekToNext/Previous() quando há apenas 1
     * item na fila (modo loadVideo). Nesse caso dispara evento JS (nextTrack/prevTrack)
     * em vez de não fazer nada. Em modo playlist (múltiplos itens), delega ao ExoPlayer.
     *
     * getAvailableCommands() sempre inclui SEEK_TO_NEXT/PREVIOUS para que os botões ◀ ▶
     * apareçam na notificação, tela de bloqueio e respondam aos botões físicos do fone.
     */
    private static class NextPrevInterceptPlayer extends ForwardingPlayer {

        NextPrevInterceptPlayer(@NonNull Player delegate) {
            super(delegate);
        }

        @NonNull
        @Override
        public Commands getAvailableCommands() {
            return super.getAvailableCommands().buildUpon()
                .addAll(
                    COMMAND_SEEK_TO_PREVIOUS,
                    COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                    COMMAND_SEEK_TO_NEXT,
                    COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .build();
        }

        @Override
        public void seekToNext() {
            if (isSingleVideo()) fireJS("nextTrack");
            else super.seekToNext();
        }

        @Override
        public void seekToNextMediaItem() {
            if (isSingleVideo()) fireJS("nextTrack");
            else super.seekToNextMediaItem();
        }

        @Override
        public void seekToPrevious() {
            if (isSingleVideo()) {
                // posição > threshold → retrocede ao início do vídeo atual
                // posição ≤ threshold → vai para aula anterior (via JS)
                if (getCurrentPosition() > getMaxSeekToPreviousPosition()) {
                    super.seekToPrevious();
                } else {
                    fireJS("prevTrack");
                }
            } else {
                super.seekToPrevious();
            }
        }

        @Override
        public void seekToPreviousMediaItem() {
            if (isSingleVideo()) fireJS("prevTrack");
            else super.seekToPreviousMediaItem();
        }

        private boolean isSingleVideo() {
            return getMediaItemCount() <= 1;
        }

        private void fireJS(String event) {
            VideoPlayerPlugin vp = VideoPlayerPlugin.instance;
            if (vp == null) return;
            if (Looper.myLooper() == Looper.getMainLooper()) {
                vp.firePluginEvent(event, new JSObject());
            } else {
                new Handler(Looper.getMainLooper()).post(
                    () -> vp.firePluginEvent(event, new JSObject()));
            }
        }
    }
}
