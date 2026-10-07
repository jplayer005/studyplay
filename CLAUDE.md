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

Capacitor 8 Android app. Toda a lógica do app está em `www/index.html` (~3400 linhas). Sem bundler, sem framework — vanilla JS + CSS inline.

### File map

| Path | Role |
|---|---|
| `www/index.html` | App completo: player de videoaulas + Capacitor + persistência IDB |
| `capacitor.config.json` | App ID, nome, plugins — copiado para `android/app/src/main/assets/` pelo `cap sync` |
| `assets/icon.png` | Ícone fonte para geração via `@capacitor/assets` |

### Diferenças do modo web vs APK

`Platform.isCapacitor` controla comportamento nativo:

- **`true` (APK)**: `showDirectoryPicker` indisponível → usa `<input type="file" multiple>`; vídeos salvos em IndexedDB; restauração automática na inicialização; MediaSession para Dynamic Island / controles de tela bloqueada; botão Voltar tratado via `Capacitor.Plugins.App`
- **`false` (web)**: comportamento normal do browser

### Persistência de vídeos (IDB)

Quando o usuário abre vídeos no APK:
1. Metadados da sessão salvos em `localStorage` (`splay_apk_session`)
2. Blobs dos arquivos salvos em `IndexedDB` (`studyplay_v1_videos`) em background
3. Na próxima abertura: modal pergunta se quer reabrir o curso anterior
4. Vídeos carregados sob demanda (lazy loading do IDB ao clicar na aula)

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
