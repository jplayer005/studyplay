# CLAUDE.md

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

Capacitor 8 Android app. Toda a lógica e o CSS do app estão em `www/index.html` (~5200 linhas). Sem bundler, sem framework — vanilla JS + CSS inline. Fontes e biblioteca de planilhas ficam embutidas em `www/fonts/` e `www/lib/` (o app funciona sem internet; a biblioteca XLSX só é carregada ao abrir uma planilha).

### File map

| Path | Role |
|---|---|
| `www/index.html` | App completo: player de videoaulas + ponte Capacitor |
| `www/fonts/`, `www/lib/` | Fontes Sora/JetBrains Mono (OFL) e SheetJS (Apache-2.0), com as licenças |
| `index.html` (raiz) | Cópia de `www/index.html`, mantida igual |
| `capacitor.config.json` | App ID, nome, plugins — copiado para `android/app/src/main/assets/` pelo `cap sync` |
| `android/app/src/main/java/com/jcorelabs/studyplay/` | `MainActivity`, `VideoFolderPlugin` (pasta SAF, salvar arquivo, abrir link), `VideoPlayerPlugin` (ExoPlayer, PiP, tela cheia, timer de sono, permissões), `PlaybackService` (serviço de mídia/notificação), `VideoWebViewClient` (proxy `https://localhost/_saf_/` com Range) |
| `assets/icon.png` | Ícone fonte para geração via `@capacitor/assets` |

### Diferenças do modo web vs APK

`Platform.isCapacitor` controla comportamento nativo:

- **`true` (APK)**: pasta escolhida pelo seletor nativo (SAF); vídeos tocados pelo ExoPlayer (`VideoPlayerPlugin`) por cima do WebView; playlist nativa continua tocando com a tela desligada; MediaSession para tela de bloqueio / Ilha Dinâmica; exportar notas/progresso pelo seletor nativo; botão Voltar via `Capacitor.Plugins.App`
- **`false` (web)**: comportamento normal do browser (`showDirectoryPicker`, `<video>`)

### Layout responsivo

- **Celular na vertical** (`max-width:559px` + portrait): vídeo 16:9 no topo, controles em duas linhas (`.ctrl-main` / `.ctrl-aux`) e lista de aulas abaixo. Não há gaveta lateral.
- **Celular na horizontal** (`orientation:landscape` + `max-height:520px`): cabeçalho oculto; ações dele ficam no menu ⋮ (`.menu-land-only`); playlist à esquerda, ocultável.
- **Tablet/desktop**: cabeçalho + playlist lateral.

### Progresso salvo (localStorage)

- A chave do curso (`_courseKey`) é calculada UMA vez ao abrir o curso (`freezeCourseKey()`) a partir das 5 primeiras aulas na ordem original. **Não recalcular depois de reordenar módulos**, senão o progresso "some".
- Cada aula tem `l.key`: o nome, ou nome + caminho quando há nomes repetidos (`assignLessonKeys()`). Progresso, favoritos e posições usam `l.key`.
- Aulas são ligadas aos módulos pelo **objeto do arquivo** (`_lessonByFile`), nunca pelo nome.
- `setDone(idx, valor)` define a conclusão; `markDone()` só alterna (botão/atalho M). O fim do vídeo usa `setDone(...,true)`.
- Sessão do APK (`splay_native_session`) guarda pasta, módulos, PDFs/planilhas e a chave do curso para reabrir sem re-escanear.
- Preferências: `splay_set_auto90`, `splay_set_autofs`.

### Velocidade de abertura (não regredir)

O diferencial do app é abrir e já seguir o curso. Regras que garantem isso:

- **Tocar antes de desenhar:** ao abrir/reabrir, `playLesson()` é chamado ANTES de `renderModularPlaylist()`, para a fila nativa sair primeiro.
- **Fila nativa em partes:** `setPlaylist` recebe só as primeiras `QUEUE_FIRST_CHUNK` (30) aulas; o resto entra por `appendPlaylist` em blocos de 150 (`_appendRestOfQueue`). Montar ~850 itens com capa antes de tocar era a maior espera. `_nativeQueue` só ganha os arquivos depois que o nativo confirma o bloco; aula fora da fila refaz a fila a partir dela.
- **Durações:** nunca criar um `<video>` por aula na abertura. Ordem: cache salvo por curso (`splay_dur_<chave>`) → aulas visíveis (4 por vez, via `IntersectionObserver`) → leitura em segundo plano das que faltam (`_warmupStep`, 1 por vez, só com o app visível).
- **Sessão do APK:** reabre pelo cache (`quickRestore`), sem varrer a pasta. Só refaz a varredura se o cache for da versão 2.0 E houver nomes de aula repetidos.
- **Medir:** Configurações > Tempos de abertura (`Diag`) mostra cada etapa no aparelho (varredura nativa, montar o curso, desenhar a lista, fila nativa, aula pronta).

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
