# Vários cursos pré-carregados e primeira abertura rápida

Data: 2026-10-14 · Status: implementado (aguardando teste no celular) · Branch: `claude/varios-cursos`

## 1. Objetivo

Permitir estudar **vários cursos ao mesmo tempo**. Cada curso aberto fica guardado
("pré-carregado") e reabre na hora, na aula e posição onde parou. E, ao escolher uma
pasta **nova**, a primeira aula deve começar em segundos, sem esperar o Android varrer o
curso inteiro.

Princípio que guia todas as decisões: **quem escolhe a pasta quer começar a estudar
logo.** Nada pode deixar a reabertura mais lenta do que hoje.

### Fora do escopo (nesta versão)
- Renomear curso, ordenar a lista manualmente, capa ou ícone por curso.
- Procurar aulas novas numa pasta que já está guardada (hoje também não existe).
  Possível depois como "Procurar aulas novas" no ⋮ do curso.
- Vários cursos na versão web (navegador): o navegador não guarda acesso a pastas como o
  Android. A versão web continua como hoje.
- Login do Google Drive (adiado em decisão anterior).

## 2. Decisões tomadas com o usuário

| Tema | Decisão |
|---|---|
| Trocar de curso | Tela **Meus cursos** (lista com progresso). O app abre direto no último curso usado |
| Abrir Pasta com curso aberto | Pergunta: **Adicionar como novo curso** (principal) ou **Acrescentar módulos ao curso atual**. Sai "Substituir curso" |
| Remover curso | Tira da lista e **guarda** progresso, notas e capítulos. Abrir a mesma pasta de novo recupera tudo |
| Onde guardar os cursos | **IndexedDB** (abordagem A). Sem limite prático e lê só o curso que vai abrir |
| Foco | Escolher a pasta e já começar a assistir. Varredura progressiva por módulo |

## 3. Dados

### 3.1 Banco `studyplay_library` (IndexedDB, versão 1)

Dois "stores", separados de propósito para a tela Meus cursos não carregar dados pesados:

**`courses`** (pesado, lido só ao abrir aquele curso), `keyPath: 'id'`
```
{ id, treeUri, rootName, isModular,
  modulesCache | lessonsCache + extrasCache,   // mesmo formato do cache de sessão atual
  savedAt }
```

**`summaries`** (leve, lido pela tela Meus cursos), `keyPath: 'id'`
```
{ id, name, treeUri, addedAt, lastOpenedAt,
  total, done, currentName, currentModule }
```

- `id` = a chave do curso (`_courseKey`).
- O resumo é atualizado junto com o salvamento do progresso, no máximo a cada 3 s
  (só o registro leve; o pesado não é regravado durante o estudo).
- Ponteiro do último curso: `localStorage['splay_last_course'] = id` (leitura síncrona,
  para a abertura não esperar o banco para saber qual curso abrir).

### 3.2 O que não muda
Progresso, favoritas, posições, notas, capítulos, histórico (`videoaulas_v3_<chave>`),
ordem dos módulos (`<chave>_modorder`) e durações (`splay_dur_<chave>`) continuam no
`localStorage`, já separados por curso. Nenhum dado existente é movido.

### 3.3 Identidade do curso (nova regra para cursos novos)
Hoje a chave vem só dos nomes das 5 primeiras aulas. Dois cursos que começam com
"Aula 01 ... Aula 05" se misturariam. Regra nova, aplicada ao montar um curso:

1. Se a pasta (`treeUri`) já está na biblioteca: usa o `id` dela.
2. Senão, calcula `chaveNova = chaveAntiga + '_' + hash(rootName)` (hash FNV-1a de 32 bits em base 36: estável e curto).
   - Se existe progresso salvo em `chaveNova`: usa.
   - Senão, se existe progresso em `chaveAntiga` e **nenhum curso da biblioteca** usa
     `chaveAntiga`: adota `chaveAntiga` (recupera progresso de antes desta versão).
   - Senão: usa `chaveNova`.

O curso migrado (seção 3.4) mantém a chave que já tem.

### 3.4 Migração
Na primeira abertura desta versão, se a biblioteca estiver vazia e existir
`splay_native_session`, o curso é aberto como hoje (`quickRestore`, inclusive o caminho
de sessões da 2.0) e em seguida gravado na biblioteca com a chave atual e o resumo.
`splay_native_session` **continua sendo gravado** para o curso aberto (mesmo custo de hoje): é a reserva usada quando o IndexedDB falha.

### 3.5 Remover curso
Apaga os registros de `courses` e `summaries`. Não apaga nada do `localStorage`.
Chama o Java para liberar a permissão persistente da pasta, se nenhum outro curso usa o
mesmo `treeUri`.

## 4. Telas

### 4.1 Acesso
- **Vertical e desktop:** o selo do cabeçalho ("60 / 159") vira um botão com o nome
  abreviado do curso e o progresso. Toque abre Meus cursos.
- **Horizontal (cabeçalho oculto):** item "Meus cursos" no topo do menu ⋮.
- **Web:** selo como hoje, sem Meus cursos.

### 4.2 Meus cursos
Painel que sobe da base (celular) ou janela (desktop). Itens em ordem de último uso:
nome (até 2 linhas), "Módulo X · aula atual", barra de progresso com "feitas/total ·
%", último acesso ("Hoje", "Ontem", data). O curso atual aparece como "Estudando".
- Toque no curso: troca (seção 5.2).
- ⋮ do curso: "Remover da lista" com confirmação ("O progresso, as notas e os capítulos
  ficam guardados. Se abrir a mesma pasta de novo, tudo volta.").
- **+ Novo:** seletor de pastas, adiciona curso (seção 5.3).
- Voltar do Android fecha o painel.

### 4.3 Abrir Pasta com curso aberto
Diálogo: **Adicionar como novo curso** (primário) · Acrescentar módulos a *nome do
curso* · Cancelar. Sem curso aberto, vai direto ao seletor.

## 5. Fluxos

### 5.1 Abrir o app
1. Lê `splay_last_course`. Se existe: busca `courses[id]` no banco e abre como o
   `quickRestore` de hoje (tocar antes de desenhar, fila nativa em partes).
2. Sem ponteiro e com `splay_native_session`: migração (3.4).
3. Sem nada: tela inicial atual. **O diálogo "Curso anterior encontrado" é removido.**

### 5.2 Trocar de curso
1. Salva o progresso do curso atual (posição incluída) e atualiza o resumo.
2. Cancela varredura em andamento, se houver (5.4).
3. Para o player, zera a fila nativa (`_queueGen++`, `_nativePlaylistMode=false`).
4. Limpa o estado do curso em memória (aulas, módulos, concluídas, favoritas,
   posições, durações, notas, capítulos, histórico, A-B, frame, timer de sono continua).
5. Abre o curso escolhido como em 5.1 e atualiza `lastOpenedAt` e o ponteiro.

### 5.3 Abrir uma pasta
1. Seletor nativo devolve `treeUri` e `rootName` **sem varrer** (novo `pickFolderOnly`).
2. Se `treeUri` já está na biblioteca: abre esse curso (5.1) e avisa "Esse curso já
   está em Meus cursos".
3. Se o usuário escolheu "Acrescentar módulos": fluxo atual de acrescentar (varredura
   completa, como hoje) e atualiza o registro do curso atual.
4. Senão: varredura progressiva (5.4) como curso novo.

### 5.4 Varredura progressiva (curso novo)

**Java (`VideoFolderPlugin`)**
- `pickFolderOnly()` → `{treeUri, rootName}`; toma a permissão persistente.
- `scanFolder({treeUri, scanId})` → resolve na hora e emite eventos:
  - `scanRoot {scanId, rootName, rootFiles[], modules: [nome,...], flat: bool}`:
    lista da raiz, módulos já em **ordem natural** ("Módulo 2" antes de "Módulo 10").
    `flat=true` quando a raiz tem vídeos ou não tem subpastas (mesma regra do app hoje).
  - `scanModule {scanId, index, name, files[]}`: todos os arquivos de um módulo
    (recursivo), no mesmo formato de hoje (`name, relativePath, uri, mimeType, size`).
  - `scanDone {scanId, totalFiles, scanMs}` / `scanError {scanId, message}`.
- Lê até **3 módulos em paralelo** (pool de threads), mas emite `scanModule` **sempre
  na ordem** (fila de saída por índice).
- `cancelScan({scanId})`: interrompe e não emite mais nada daquele `scanId`.
- `releaseFolder({treeUri})`: libera a permissão persistente.
- `checkFolder({treeUri})` → `{ok}`: permissão ainda válida e pasta existe.
- `pickFolder` e `listPersistedFolder` permanecem (acrescentar módulos e caminhos antigos).

**App (JS)**
- Com `scanRoot`: prepara o curso vazio e mostra "Carregando curso… 0 de N módulos" no
  topo da playlist.
- A cada `scanModule`: monta o módulo com as regras atuais (`nodeToMod`,
  `normalizeModules`), acrescenta ao fim de `modules`, reconstrói as aulas **só
  acrescentando** (índices existentes não mudam), desenha o módulo e atualiza contadores.
- Assim que houver 5 aulas (ou o fim): calcula a chave (3.3) e aplica o progresso salvo.
- **Quando começar a tocar:**
  - Sem progresso salvo: na primeira aula, logo que ela existir.
  - Com progresso salvo: assim que chegar a aula onde parou.
  - Fila nativa: `setPlaylist` com o que já existe a partir da aula (até 30) e, a cada
    módulo novo, `appendPlaylist` com as aulas novas (fila cresce, como hoje).
- `scanDone`: aplica a ordem personalizada salva, se houver
  (`rebuildLessonsKeepingState`), grava o curso na biblioteca, atualiza o ponteiro,
  registra no painel "da escolha da pasta até a aula tocar" e "varredura completa".
- Fluxo plano (`flat=true`): mesmos passos, juntando os vídeos de todas as partes numa
  lista única na ordem natural.
- Interrompida (app fechado, troca de curso): nada é gravado na biblioteca; o progresso
  feito nesse meio-tempo já está salvo pela chave do curso.

## 6. Erros e casos especiais

| Caso | Comportamento |
|---|---|
| Pasta movida, apagada, renomeada, cartão SD removido, permissão perdida | Antes de tocar, `checkFolder`. Se falhar (ou o vídeo der erro de arquivo): "Não encontrei os arquivos deste curso. A pasta pode ter sido movida ou apagada." → **Escolher a pasta de novo** (varre e mantém o progresso pela chave) · **Remover da lista** |
| Dois cursos com aulas de nomes iguais | Regra de identidade 3.3 |
| Trocar de curso durante a varredura | `cancelScan`; eventos atrasados com outro `scanId` são ignorados |
| Pasta já na biblioteca | Abre a guardada, sem duplicar. Subpasta de um curso = curso separado |
| Falha do IndexedDB | O app segue com o curso em memória, mostra aviso; a reserva `splay_native_session` reabre o último curso |
| `localStorage` cheio | Aviso claro "O app está sem espaço para salvar o progresso" em vez de falha silenciosa; painel mostra uso |
| Remover curso | Libera a permissão da pasta se nenhum outro curso usa |

## 7. Critérios de aceite

### 7.1 Velocidade (simulador: CPU 4x mais lenta, curso de 850 aulas; e painel no celular)
| Situação | Critério |
|---|---|
| Reabrir o último curso | Não mais lento que hoje (0,20 s no simulador, tolerância de 0,05 s), com 1 e com 5 cursos guardados |
| Trocar de curso | Igual a reabrir |
| Abrir Meus cursos | Lista em menos de 0,1 s |
| Pasta nova | `playLesson` chamado assim que chega o 1º módulo, sem esperar `scanDone`. Meta no celular: 1 a 2 s da escolha até a aula tocar |

### 7.2 Testes automáticos novos (`tests/`)
- `10-biblioteca`: 3 cursos e ordem por uso; trocar mantendo o progresso de cada um;
  abrir no último curso; remover mantendo progresso e readicionar; migração da sessão
  atual; pasta repetida sem duplicar; dois cursos com nomes iguais separados; falha do
  IndexedDB com reserva.
- `11-abertura-progressiva`: tocar antes de `scanDone`; módulos aparecendo aos poucos;
  retomar aula de módulo posterior; cancelar ao trocar; curso só gravado completo; ordem
  personalizada aplicada no fim sem perder progresso.
- Os 140 testes atuais continuam passando.

### 7.3 Celular (o Java não roda nos testes)
Escolher pasta grande e ver a aula começar rápido · adicionar 2º curso · alternar ·
fechar e reabrir o app · remover e reabrir a pasta · mover a pasta e ver o aviso.

## 8. Entrega
Branch `claude/varios-cursos` com Pull Request; GitHub compila o APK e roda os testes a
cada envio. **União à `main` só depois do teste no celular e da aprovação do usuário.**

## 9. Arquivos afetados
- `www/index.html` (e cópia na raiz): biblioteca, Meus cursos, fluxos, varredura progressiva.
- `android/.../VideoFolderPlugin.java`: `pickFolderOnly`, `scanFolder`, `cancelScan`,
  `releaseFolder`, `checkFolder`, ordem natural, pool de threads.
- `tests/10-biblioteca.test.js`, `tests/11-abertura-progressiva.test.js`.
- `CLAUDE.md` e `AGENTS.md`: regras da biblioteca e da varredura progressiva.
