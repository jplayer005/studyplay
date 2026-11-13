# AGENTS.md

## Build

Always run from the project root (`C:\Users\desen\Documents\Apps\Studyplay`).

**Full build (after any change to `www/index.html`):**
```bash
npx cap sync android && cd android && ./gradlew.bat assembleDebug
```

**Gradle only (no web changes):**
```bash
cd android && ./gradlew.bat assembleDebug
```

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`

> Never run `npm run build:apk` — the `cd android` inside that npm script fails in PowerShell. Use the two-step approach above.

## Architecture

Capacitor 8 Android app. Toda a lógica e o CSS do app estão em `www/index.html` (~6000 linhas). Sem bundler, sem framework — vanilla JS + CSS inline. Fontes e biblioteca de planilhas ficam embutidas em `www/fonts/` e `www/lib/` (o app funciona sem internet; a biblioteca XLSX só é carregada ao abrir uma planilha).

### File map

| Path | Role |
|---|---|
| `www/index.html` | App completo: player de videoaulas + ponte Capacitor |
| `www/fonts/`, `www/lib/` | Fontes Sora/JetBrains Mono (OFL) e SheetJS (Apache-2.0), com as licenças |
| `index.html`, `fonts/`, `lib/` (raiz) | Cópias de `www/index.html`, `www/fonts/` e `www/lib/`, mantidas iguais: a raiz é publicada pelo GitHub Pages (versão web). `tests/09-copia-raiz.test.js` falha se divergirem |
| `capacitor.config.json` | App ID, nome, plugins — copiado para `android/app/src/main/assets/` pelo `cap sync` |
| `android/app/src/main/java/com/jcorelabs/studyplay/` | `MainActivity`, `VideoFolderPlugin` (pasta SAF, salvar arquivo, abrir link), `VideoPlayerPlugin` (ExoPlayer, PiP, tela cheia, timer de sono, permissões), `PlaybackService` (serviço de mídia/notificação), `VideoWebViewClient` (proxy `https://localhost/_saf_/` com Range) |
| `assets/icon.png` | Ícone fonte para geração via `@capacitor/assets` |

### Diferenças do modo web vs APK

`Platform.isCapacitor` controla comportamento nativo:

- **`true` (APK)**: pasta escolhida pelo seletor nativo (SAF); vídeos tocados pelo ExoPlayer (`VideoPlayerPlugin`) por cima do WebView; playlist nativa continua tocando com a tela desligada; MediaSession para tela de bloqueio / Ilha Dinâmica; exportar notas/progresso pelo seletor nativo; botão Voltar via `Capacitor.Plugins.App`
- **`false` (web)**: comportamento normal do browser (`showDirectoryPicker`, `<video>`)

### Layout responsivo

- **Celular na vertical** (`max-width:559px` + portrait): vídeo 16:9 no topo, controles em duas linhas (`.ctrl-main` / `.ctrl-aux`, botões com no mínimo 40px) e lista de aulas abaixo. Não há gaveta lateral. O cabeçalho da lista é uma barra de curso (*Meus cursos / Trocar*) e uma linha única com busca + Organizar + Recolher só com ícones (título "Playlist" escondido). Rolando a lista para baixo a barra inteira some (`body.sb-compact`, controlado por JS) e volta ao rolar para cima, ao voltar ao topo, ao focar na busca ou ao abrir outro curso; não esconde com busca ativa nem em lista curta. A segunda linha de controles segue a ordem de uso, por CSS `order` só nesta vista (esq → dir): Repetir, PiP, Fones, Favoritar, Concluir, Mais, Tela cheia. Horizontal e desktop não mudam.
- **Celular na horizontal** (`orientation:landscape` + `max-height:520px`): cabeçalho oculto; ações dele ficam no menu ⋮ (`.menu-land-only`); playlist à esquerda, ocultável.
- **Tablet/desktop**: cabeçalho + playlist lateral.

### Progresso salvo (localStorage)

- A chave do curso (`_courseKey`) é calculada UMA vez ao abrir o curso (`freezeCourseKey()`) a partir das 5 primeiras aulas na ordem original. **Não recalcular depois de reordenar módulos**, senão o progresso "some".
- Cada aula tem `l.key`: o nome, ou nome + caminho quando há nomes repetidos (`assignLessonKeys()`). Progresso, favoritos e posições usam `l.key`.
- Aulas são ligadas aos módulos pelo **objeto do arquivo** (`_lessonByFile`), nunca pelo nome.
- `setDone(idx, valor)` define a conclusão; `markDone()` só alterna (botão/atalho M). O fim do vídeo usa `setDone(...,true)`.
- Cada curso do APK fica na **biblioteca** (IndexedDB `studyplay_library`, ver *Vários cursos*). `splay_native_session` continua sendo gravado para o curso aberto: é a reserva de quando o IndexedDB falha e a origem da migração.
- **Progresso com o app fechado:** o ExoPlayer segue tocando sem o WebView (o serviço vive sozinho; `onTaskRemoved` só o encerra se estiver pausado), então o JS não recebe `trackChanged` nem `timeupdate` e o progresso ficava no ponto em que o app foi fechado. `PlaybackService` grava sozinho em `SharedPreferences` (`splay_progress`): aula atual (`mediaId` = a URI original do JS, definida em `setPlaylist`/`loadVideo`), posição (a cada 5 s tocando, ao pausar, ao trocar de aula, ao remover a tarefa) e as aulas que terminaram sozinhas (`completed`). O JS lê com `getSavedProgress()` já no início (em paralelo com a biblioteca) e aplica em `getResumeIdx` → `nativeResumeIdx` (uso único, só se o registro nativo for mais novo que `savedAt` do progresso salvo e a aula existir no curso aberto), e ao voltar do segundo plano (`syncNativeProgress`, só conclusões). Depois `ackSavedProgress` limpa o que foi aplicado.
- **Gravação enquanto toca:** `timeupdate` grava o progresso no máximo a cada 5 s (throttle `_saveThrottle`). Não voltar para debounce: o evento chega a cada 250 ms e o debounce nunca disparava durante a reprodução.
- **Aulas de áudio (mp3, m4a, aac, ogg, opus, wav, flac, mka):** `isMedia()` = vídeo ou áudio e é o que decide se um arquivo é aula (`isVideo` só diz "é vídeo"; não use para descobrir aulas). `lessonIsAudio(l)` identifica a aula. Aula de áudio mostra `#audio-art` (painel com o nome) no lugar do vídeo, esconde o PlayerView nativo (`applyLessonKind`, chamado em `playLesson`, `trackChanged` e no retorno do segundo plano; `updatePlayerOverlay`/`doSyncRect` não reexibem o player em `body.audio-lesson`) e esconde PiP, tela cheia e fones. Cursos guardados antes disso têm o mp3 como anexo no cache: `_promoteAudioExtras` os transforma em aulas ao reabrir e regrava o cache.
- **Repetir a aula (`#loop-btn`):** 3 estados em `_loopLesson`: 0 desligado, 1 repetir 1 vez (âmbar, "1×"), 2 sem parar (verde, ícone ∞). Não existe "repetir todas". No APK quem repete é o ExoPlayer: `setRepeat({kind})` → `PlaybackService.applyRepeat` (`REPEAT_MODE_ONE`), então funciona com a tela apagada e o app fechado; no "1 vez" o serviço desliga depois da repetição e avisa com o evento `repeatChanged`. O botão se sincroniza com `getRepeat()` ao abrir e ao voltar do segundo plano. Não voltar a repetir pelo JS no `trackChanged` (só vale como reserva quando o plugin não tem `setRepeat`): com o WebView suspenso o evento não chega e a lista segue em frente. Na web a repetição é pelo evento `ended`.
- Preferências: `splay_set_auto90`, `splay_set_autofs`.

### Velocidade de abertura (não regredir)

O diferencial do app é abrir e já seguir o curso. Regras que garantem isso:

- **Tocar antes de desenhar:** ao abrir/reabrir, `playLesson()` é chamado ANTES de `renderModularPlaylist()`, para a fila nativa sair primeiro.
- **Fila nativa em partes:** `setPlaylist` recebe só as primeiras `QUEUE_FIRST_CHUNK` (30) aulas; o resto entra por `appendPlaylist` em blocos de 150 (`_appendRestOfQueue`). Montar ~850 itens com capa antes de tocar era a maior espera. `_nativeQueue` só ganha os arquivos depois que o nativo confirma o bloco; aula fora da fila refaz a fila a partir dela.
- **Durações:** nunca criar um `<video>` por aula na abertura. Ordem: cache salvo por curso (`splay_dur_<chave>`) → aulas visíveis (4 por vez, via `IntersectionObserver`) → leitura em segundo plano das que faltam (`_warmupStep`, 1 por vez, só com o app visível).
- **Reabrir/trocar de curso:** lê o curso da biblioteca e usa o `quickRestore`, sem varrer a pasta. O ponteiro do último curso fica em `localStorage['splay_last_course']` e o banco é aberto logo no início do script. Só refaz a varredura se o cache for da versão 2.0 E houver nomes de aula repetidos.
- **Pasta nova:** varredura progressiva (ver abaixo). A aula começa quando chega o 1º módulo (ou o módulo onde o curso parou), sem esperar a pasta inteira. Meta: 1 a 2 s da escolha da pasta até a aula tocar.
- **Medir:** Configurações > Tempos de abertura (`Diag`) mostra cada etapa no aparelho (varredura nativa, montar o curso, desenhar a lista, fila nativa, aula pronta).

### Testes automáticos

`tests/` tem os testes do app (Playwright + Chromium, sem celular). Rodam sozinhos no GitHub (workflow *Testes automáticos*) a cada envio. Localmente: `cd tests && npm install && npx playwright install chromium && node run-all.js`. Veja `tests/README.md`. **Ao mudar progresso, fila nativa, layout ou notas, rode os testes antes de enviar.** Eles não cobrem o Java: isso só se confere no celular.

### Assinatura do APK compilado no GitHub

O workflow *Gerar APK (debug)* usa o segredo `DEBUG_KEYSTORE_BASE64` (o `debug.keystore` do PC em base64). Sem ele, cada compilação nasce com uma chave nova e o APK não instala por cima do anterior. Notas e capítulos guardam `lessonKey` (a chave da aula) além do nome.

### MediaSession / Dynamic Island / Ilha Dinâmica Xiaomi

O app implementa a `MediaSession API`:
- Metadados atualizados em cada `playLesson()`
- Action handlers para play/pause/próximo/anterior/seek
- Permite controlar o app pela barra de notificação, tela de bloqueio e Ilha Dinâmica

### Reprodução com tela desligada

- `MediaSession` mantém o estado de reprodução ativo
- Android permite reprodução de áudio em background quando o app tem foco de áudio
- Para garantia total, considere adicionar um `ForegroundService` nativo no futuro

## Package name

`com.jcorelabs.studyplay` — não alterar após publicação.

## Important constraints

- **`cap sync android` deve rodar antes de `gradlew assembleDebug`** sempre que `www/index.html` mudar.
- O `android/app/src/main/assets/capacitor.config.json` é gerado pelo `cap sync`; edite apenas o `capacitor.config.json` raiz.

## Reproduzir o build em outra maquina

Pre-requisitos: Node (lockfile em `package-lock.json`), JDK, Android SDK com platform 36. O Gradle 8.14.3 vem do wrapper em `android/gradle/wrapper`.

```bash
npm ci
npx cap sync android          # gera android/app/src/main/assets/public, config.xml e capacitor-cordova-android-plugins
# criar android/local.properties (nao versionado) com: sdk.dir=<caminho do Android SDK>
cd android && ./gradlew.bat assembleDebug
```

- `.gitattributes` forca LF; sem ele o clone no Windows vira CRLF e o `assets/public/index.html` do APK sai maior que o original.
- Nao versionados de proposito: `node_modules`, `*.apk`, `android/build`, `android/.gradle`, `android/local.properties` e o `~/.android/debug.keystore` (assina o APK debug; outra maquina gera outra assinatura e nao atualiza por cima do app instalado).
- `www/index.html` e a fonte do app; o `index.html` da raiz e uma copia mantida igual a ele.
- Notas de preferencia do Claude para este projeto: `docs/memoria-claude/`.
