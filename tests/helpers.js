// Utilidades comuns dos testes do StudyPlay
const path = require('path');
const { pathToFileURL } = require('url');

// Página testada: sempre o www/index.html deste repositório
const APP = pathToFileURL(path.resolve(__dirname, '..', 'www', 'index.html')).href;

// Imprime OK/FALHA e conta as falhas
function makeChecker() {
  let fails = 0;
  const check = (nome, ok, detalhe) => {
    if (ok) console.log('  OK  ' + nome);
    else { fails++; console.log('FALHA ' + nome + (detalhe ? ' -> ' + detalhe : '')); }
  };
  const finish = (browser) => async () => {
    if (browser) await browser.close();
    console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
    process.exit(fails ? 1 : 0);
  };
  return { check, finish, fails: () => fails };
}

// Bloqueia o que vem da internet (fontes, Google) para o teste ser rápido e repetível
async function blockExternal(page) {
  await page.route(/googleapis|gstatic|cdnjs|apis\.google|accounts\.google/, r => r.abort());
}

module.exports = { APP, makeChecker, blockExternal };
