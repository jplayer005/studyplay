# Plano de implementação: vários cursos e primeira abertura rápida

Data: 2026-10-14 · Branch: `claude/varios-cursos` · Base: `docs/superpowers/specs/2026-10-14-varios-cursos-design.md`

## Como ler este plano

- São 9 etapas pequenas. Cada uma termina com **testes passando, commit e envio**, e o
  GitHub compila o APK e roda os testes a cada envio.
- A ordem coloca primeiro o que mais pesa para o usuário: **abrir uma pasta nova e já
  começar a aula** (etapas 1 e 2). A biblioteca de cursos vem depois.
- Regra de ouro em todas as etapas: as regras da seção *Velocidade de abertura (não
  regredir)* do `CLAUDE.md` continuam valendo. Qualquer etapa que deixe a reabertura mais
  lenta que a medição da etapa 0 volta para ajuste antes do envio.
- Ao fim de cada etapa: `cp www/index.html index.html` e `cd tests && node run-all.js`.

## Ajuste em relação ao documento de design

O design diz que `splay_native_session` "deixa de ser escrito". Para a reserva da seção 6
(falha do IndexedDB) funcionar de verdade, ele **continua sendo escrito para o curso
atual**, exatamente como hoje. Custo: o mesmo de hoje, nada a mais. O design é corrigido
na etapa 8.

---

## Etapa 0. Medição de referência (antes de mudar qualquer coisa)

Objetivo: ter números para comparar e provar que nada ficou mais lento.

- Criar `tests/bench-abertura.js` (fora do `run-all.js`, roda à mão):
  - Chromium com CPU 4x mais lenta (`Emulation.setCPUThrottlingRate`).
  - Curso simulado de 850 aulas em 12 módulos, ponte nativa falsa (mesma de `05-abertura-rapida`).
  - Mede: reabrir pelo cache (`quickRestore` até `playLesson`), desenhar a lista.
  - Imprime os tempos e grava em `tests/out/bench-base.json`.
- Registrar os números no fim deste plano (seção *Medições*).

Aceite: o script roda 5 vezes e a variação fica abaixo de 0,05 s.

---

## Etapa 1. Java: varredura progressiva (`VideoFolderPlugin.java`)

Só o lado nativo, sem mudar o app ainda. Os métodos atuais (`pickFolder`,
`listPersistedFolder`, `saveTextFile`, `openUrl`) **não mudam**.

1. **Ordem natural** `naturalCompare(a, b)`: compara trechos de números como números
   ("Módulo 2" antes de "Módulo 10"), sem diferenciar maiúsculas e acentos. Usada na raiz,
   nos módulos e nos arquivos.
2. **`pickFolderOnly()`** → `{treeUri, rootName}`. Abre o seletor, toma a permissão
   persistente, **não varre**.
3. **`scanFolder({treeUri, scanId})`** resolve na hora e trabalha em segundo plano:
   - Lê só a raiz e emite `scanRoot {scanId, rootName, rootFiles[], modules[], flat}`.
     `flat` segue a regra atual do app (raiz com vídeos ou sem subpastas).
   - Pool de 3 threads lê os módulos (recursivo, mesmo formato de arquivo de hoje:
     `name, relativePath, uri, mimeType, size`).
   - Emissão **em ordem**: um mapa `índice → resultado` e um contador `próximoAEmitir`;
     cada módulo pronto tenta liberar a fila em sequência. Assim o módulo 1 sai primeiro
     mesmo que o 3 termine antes.
   - Fim: `scanDone {scanId, totalFiles, scanMs}`. Erro: `scanError {scanId, message}`.
   - Consultas ao `DocumentsContract` com projeção mínima (nome, id, tipo, tamanho), como
     o `listPersistedFolder` já faz.
4. **`cancelScan({scanId})`**: marca o `scanId` como cancelado (`AtomicBoolean`); as
   threads verificam entre pastas e param; nada mais é emitido daquele `scanId`.
5. **`checkFolder({treeUri})`** → `{ok}`: permissão persistente presente e a raiz
   responde a uma consulta.
6. **`releaseFolder({treeUri})`**: `releasePersistableUriPermission`, sem erro se já não
   existir.

Testes: `tests/04-ponte-nativa` ganha a verificação de que a ponte falsa conhece os novos
métodos (o Java em si só se confere no celular). CI precisa compilar o APK sem erro.

Aceite: APK compila; métodos antigos intactos (diff mostra só adições).

---

## Etapa 2. App: montar o curso aos poucos e tocar cedo

Esta é a etapa que entrega "escolhi a pasta e a aula já começou".

1. **Ponte falsa nos testes** (`tests/helpers.js`): implementa `pickFolderOnly`,
   `scanFolder` (emite os eventos com atrasos configuráveis), `cancelScan`, `checkFolder`.
2. **Montagem incremental** (`www/index.html`), funções novas:
   - `startProgressiveScan(treeUri, rootName)`: gera `scanId`, registra os ouvintes,
     chama `scanFolder`, marca no `Diag` o início.
   - `onScanRoot(ev)`: limpa o curso em memória, prepara `modules = []`, guarda os
     arquivos da raiz (PDFs e planilhas como hoje) e mostra o aviso
     "Carregando curso… 0 de N módulos" no topo da playlist.
   - `onScanModule(ev)`: monta o módulo com as regras atuais (`nodeToMod`,
     `normalizeModules`), **acrescenta ao fim** de `modules`, reconstrói as aulas só
     acrescentando (os índices já existentes não mudam), desenha só o módulo novo e
     atualiza contadores e aviso.
   - `onScanDone(ev)` e `onScanError(ev)`.
   - Todo evento com `scanId` diferente do atual é ignorado.
3. **Quando tocar**:
   - Assim que houver 5 aulas (ou o fim da varredura): `freezeCourseKey()` provisório
     com a regra atual (a regra nova entra na etapa 3) e aplica o progresso salvo.
   - Sem progresso salvo: `playLesson(0)` logo que a primeira aula existir.
   - Com progresso salvo: espera chegar o módulo da aula onde parou e toca nela.
   - Fila nativa: `setPlaylist` com até 30 aulas a partir da atual; a cada módulo novo,
     `appendPlaylist` com as aulas novas, reaproveitando `_queueGen` e a confirmação do
     nativo antes de atualizar `_nativeQueue` (regra atual).
4. **No `scanDone`**: aplica a ordem personalizada salva (`rebuildLessonsKeepingState`),
   salva a sessão (`saveNativeSessionCache`), registra no `Diag` "da escolha da pasta
   até a aula tocar" e "varredura completa", remove o aviso.
5. **Ligação**: no APK, "Abrir Pasta" passa a usar `pickFolderOnly` + varredura
   progressiva. "Acrescentar módulos" continua com o fluxo atual (`pickFolder`).

Teste novo `tests/11-abertura-progressiva.test.js`:
- `playLesson` chamado antes do `scanDone` (com o módulo 2 atrasado em 2 s).
- módulos aparecendo na lista aos poucos e na ordem certa;
- retomar uma aula do módulo 3 (toca só quando o módulo 3 chega);
- curso plano (`flat=true`);
- evento atrasado de outro `scanId` ignorado;
- ordem personalizada aplicada no fim sem perder concluídas e posição.

Aceite: os testes atuais e o 11 passam; no bench, "pasta nova até tocar" depende só do
1º módulo; reabrir continua igual à etapa 0.

---

## Etapa 3. Identidade do curso

1. `fnv1a32(texto)` → base 36.
2. `resolveCourseKey(treeUri, rootName)` com a regra 3.3 do design:
   biblioteca pelo `treeUri` → `chaveNova` com progresso → `chaveAntiga` com progresso e
   livre → `chaveNova`. Enquanto a biblioteca não existe (até a etapa 4), "livre" = sempre.
3. Usada só ao montar curso **novo** pela varredura progressiva. Reabrir pelo cache usa a
   chave guardada (nada muda para o curso atual do usuário).

Testes (em `11`): curso antigo recupera o progresso pela chave antiga; dois cursos com
"Aula 01…05" e pastas diferentes ficam com chaves diferentes.

---

## Etapa 4. Biblioteca no IndexedDB

1. Objeto `CourseLibrary` no `www/index.html`:
   - `open()`: banco `studyplay_library` v1, stores `courses` e `summaries` (`keyPath: 'id'`).
   - `putCourse(rec)`, `getCourse(id)`, `putSummary(sum)`, `listSummaries()`,
     `findByTreeUri(uri)`, `remove(id)`.
   - Cada chamada com tempo limite de 3 s; erro vira `null` e marca `CourseLibrary.broken`.
2. Gravação:
   - Curso completo (`courses` + `summaries`) no `scanDone`, ao acrescentar módulos e na
     migração. O registro pesado usa o mesmo formato de `saveNativeSessionCache`
     (função de serialização compartilhada, sem duplicar código).
   - Resumo leve junto com o salvamento de progresso, no máximo a cada 3 s.
   - Ponteiro `localStorage['splay_last_course']`.
3. Migração (3.4): biblioteca vazia + `splay_native_session` existente → abre como hoje e
   grava na biblioteca com a chave atual.

Teste novo `tests/10-biblioteca.test.js` (primeira parte): gravar e ler 3 cursos;
ordem por último uso; migração da sessão atual; pasta repetida não duplica; IndexedDB
quebrado (simulado) mantém o curso aberto e a reserva reabre.

---

## Etapa 5. Abrir, trocar, remover

1. **Abertura do app**: ponteiro → `getCourse` → mesmo caminho do `quickRestore`
   (tocar antes de desenhar). Sem ponteiro: migração. Sem nada: tela inicial.
   O diálogo "Curso anterior encontrado" sai.
   Para não esperar o banco à toa: a leitura do IndexedDB começa no início do script,
   em paralelo com o resto da inicialização.
2. **`resetCourseState()`**: uma função só que limpa tudo do curso em memória (aulas,
   módulos, concluídas, favoritas, posições, durações, notas, capítulos, histórico, A-B,
   frame, observadores de duração, `_warmupStep`). O timer de sono continua.
3. **`switchCourse(id)`**: salva progresso e resumo → `cancelScan` → para o player e zera
   a fila (`_queueGen++`, `_nativePlaylistMode=false`) → `resetCourseState()` → abre →
   atualiza `lastOpenedAt` e ponteiro.
4. **`removeCourse(id)`**: apaga da biblioteca, não toca no `localStorage`, chama
   `releaseFolder` se nenhum outro curso usa o mesmo `treeUri`. Se era o curso aberto,
   abre o próximo da lista ou a tela inicial.
5. **Abrir Pasta**: com curso aberto, diálogo "Adicionar como novo curso" (primário) ·
   "Acrescentar módulos a *nome*" · "Cancelar". `treeUri` já guardado → abre o
   existente e avisa "Esse curso já está em Meus cursos".

Testes (`10`, segunda parte): trocar entre 3 cursos mantendo o progresso de cada um;
abrir no último usado; remover e readicionar recuperando tudo; trocar durante a varredura
cancela e ignora eventos atrasados; bench com 5 cursos guardados igual à etapa 0.

---

## Etapa 6. Tela Meus cursos

1. Selo do cabeçalho vira botão (nome abreviado + "feitas/total"); na horizontal, item
   "Meus cursos" no topo do ⋮ (`.menu-land-only`); na web, selo como hoje.
2. Painel de baixo para cima (celular) ou janela (desktop), mesmo estilo dos painéis
   atuais: nome em até 2 linhas, "Módulo X · aula atual", barra e "feitas/total · %",
   último acesso ("Hoje", "Ontem", data), selo "Estudando" no atual, ⋮ com "Remover da
   lista" e confirmação, botão "+ Novo".
3. Lê só `summaries`. Voltar do Android fecha o painel (entra na ordem atual do
   `backButton`, antes de fechar outros painéis).

Testes: lista em menos de 0,1 s com 5 cursos; layout em vertical, horizontal e desktop
(`03-layout` ganha os casos); voltar fecha o painel.

---

## Etapa 7. Erros e casos especiais

1. `checkFolder` antes de tocar ao abrir/trocar (em paralelo com a montagem, sem atrasar a
   abertura; se falhar, interrompe e mostra o aviso). Erro de arquivo do player leva ao
   mesmo aviso: "Não encontrei os arquivos deste curso…" → **Escolher a pasta de novo**
   (varre e mantém o progresso pela chave) · **Remover da lista**.
2. `localStorage` cheio: os `setItem` de progresso passam por um ajudante que, em erro de
   cota, mostra uma vez "O app está sem espaço para salvar o progresso". Painel `Diag`
   mostra o uso.
3. IndexedDB quebrado: aviso discreto uma vez; app segue em memória com a reserva.

Testes: pasta inválida mostra o aviso e "Escolher de novo" mantém o progresso; cota cheia
simulada mostra o aviso uma vez.

---

## Etapa 8. Fechamento

1. `CLAUDE.md` e `AGENTS.md`: regras da biblioteca, identidade do curso, varredura
   progressiva e o novo item do `Diag`. Corrigir o design (reserva `splay_native_session`).
2. `tests/README.md` com os testes 10 e 11.
3. Cópias da raiz iguais (`09-copia-raiz`), todos os testes, bench final comparado à etapa 0.
4. Pull Request da `claude/varios-cursos`, CI verde, link do APK.
5. Checklist no celular para o usuário (seção 7.3 do design) e pedido dos números do
   painel *Tempos de abertura*.
6. **União à `main` só depois do teste no celular e da aprovação do usuário.**

---

## Riscos e como foram tratados

| Risco | Tratamento |
|---|---|
| Reabrir ficar mais lento por esperar o IndexedDB | Ponteiro síncrono no `localStorage`; leitura do banco começa logo no início; bench com 1 e 5 cursos em todas as etapas a partir da 4 |
| Índices de aula mudarem durante a varredura e corromperem progresso | Só acrescentar; ordem personalizada aplicada uma vez no fim com `rebuildLessonsKeepingState` |
| Eventos de varredura antiga chegarem depois de trocar | `scanId` em todos os eventos, `cancelScan` no Java |
| Misturar progresso de cursos com nomes iguais | Regra de identidade da etapa 3, sem mexer em chaves existentes |
| Java não roda nos testes | Ponte falsa fiel nos testes + checklist no celular antes de unir à `main` |

## Medições

| Medição (simulador, CPU 4x) | Etapa 0 | Final |
|---|---|---|
| Reabrir último curso (1 curso) | a medir | |
| Reabrir último curso (5 cursos) | n/a | |
| Pasta nova até `playLesson` | n/a | |
| Abrir Meus cursos | n/a | |
