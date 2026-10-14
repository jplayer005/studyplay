# Testes automáticos do StudyPlay

Abrem o app (`www/index.html`) num navegador Chromium sem tela e conferem o comportamento.
**Não precisam de celular.** Eles rodam sozinhos no GitHub a cada envio (aba *Actions*,
workflow "Testes automáticos"). Para rodar no seu computador:

```bash
cd tests
npm install
npx playwright install chromium   # só na primeira vez (baixa o navegador de testes)
node run-all.js                   # todos os testes
node run-all.js layout            # só os arquivos que têm "layout" no nome
```

## O que cada arquivo confere

| Arquivo | Confere |
|---|---|
| `01-progresso` | fim da aula não desmarca; reordenar módulos não perde progresso; nomes repetidos; dados antigos |
| `02-carregamento` | sem requisições externas; fontes locais; durações lidas só das aulas visíveis; busca com atraso |
| `03-layout` | vertical (vídeo 16:9 no topo), horizontal (sem cabeçalho), desktop, modo organizar, configurações |
| `04-ponte-nativa` | Capacitor simulado: fila nativa, timer de sono, exportar, links, botão Voltar, permissões, reabrir |
| `05-abertura-rapida` | fila em partes, cache de durações, leitura em segundo plano, sessão antiga, painel de tempos |
| `06-pasta-web` | abrir pasta no navegador, módulos, reordenar, reabrir, acrescentar módulo |
| `07-migracao` | sessões e dados salvos por versões antigas continuam funcionando |
| `08-notas-capitulos` | notas, capítulos, revisão e histórico ligados à aula certa com nomes repetidos |
| `10-biblioteca` | biblioteca de cursos: guardar, listar por uso, trocar mantendo o progresso de cada um, remover e readicionar, pasta repetida, abrir no último curso, migração da sessão antiga, falha do banco |
| `11-abertura-progressiva` | curso novo toca antes de a pasta terminar, módulos aparecendo aos poucos, retomar módulo posterior, lista plana, cancelar, identidade do curso |
| `12-meus-cursos` | selo, painel, ordem, progresso, trocar, remover com confirmação, botão Voltar, horizontal |
| `13-erros-curso` | pasta movida/apagada, escolher a pasta de novo mantendo o progresso, armazenamento cheio, falha do banco |

Também há `bench-abertura.js` (fora do `run-all`): `node bench-abertura.js` mede, com CPU 4x mais lenta e 850 aulas, reabrir um curso, trocar entre 5 cursos e abrir a lista. Compare **medianas**.

## Quando um teste falha

A linha `FALHA <o que> -> <detalhe>` diz o que esperava e o que recebeu. Capturas de tela do
`03-layout` ficam em `tests/out/` (pasta ignorada pelo git). **Não ajuste o teste só para ele
passar:** primeiro confirme se o app é que está errado.

Os testes simulam o Android com um "Capacitor falso". Eles **não** testam o Java nem o celular
de verdade: isso continua sendo conferido instalando o APK.
