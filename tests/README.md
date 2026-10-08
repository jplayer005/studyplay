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

## Quando um teste falha

A linha `FALHA <o que> -> <detalhe>` diz o que esperava e o que recebeu. Capturas de tela do
`03-layout` ficam em `tests/out/` (pasta ignorada pelo git). **Não ajuste o teste só para ele
passar:** primeiro confirme se o app é que está errado.

Os testes simulam o Android com um "Capacitor falso". Eles **não** testam o Java nem o celular
de verdade: isso continua sendo conferido instalando o APK.
