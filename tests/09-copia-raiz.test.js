// A raiz do repositório é publicada pelo GitHub Pages (versão web do app). Ela precisa ser uma
// cópia fiel de www/: index.html, fonts/ e lib/. Se alguém mudar só um dos lados, este teste falha.
const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./helpers');
const { check, finish } = makeChecker();

const raiz = path.resolve(__dirname, '..');
const lerTudo = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? lerTudo(p, base) : [path.relative(base, p).split(path.sep).join('/')];
});
const igual = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

console.log('# raiz = cópia de www/ (versão web no GitHub Pages)');
check('index.html da raiz igual ao de www/', igual(path.join(raiz, 'index.html'), path.join(raiz, 'www', 'index.html')));
for (const pasta of ['fonts', 'lib']) {
  const a = lerTudo(path.join(raiz, 'www', pasta)).sort();
  const b = fs.existsSync(path.join(raiz, pasta)) ? lerTudo(path.join(raiz, pasta)).sort() : [];
  check(`${pasta}/ existe na raiz com os mesmos arquivos`, JSON.stringify(a) === JSON.stringify(b), `www: ${a.length} arquivos, raiz: ${b.length}`);
  check(`${pasta}/ com conteúdo idêntico`, a.every(f => b.includes(f) && igual(path.join(raiz, 'www', pasta, f), path.join(raiz, pasta, f))));
}

console.log('# tudo que o index.html usa existe');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const refs = [...html.matchAll(/url\('(fonts\/[^']+)'\)/g)].map(m => m[1]).concat(html.includes("'lib/xlsx.full.min.js'") ? ['lib/xlsx.full.min.js'] : []);
check('referências a fonts/ e lib/ encontradas', refs.length >= 6, String(refs.length));
check('todas existem na raiz', refs.every(r => fs.existsSync(path.join(raiz, r))), refs.filter(r => !fs.existsSync(path.join(raiz, r))).join(', '));

finish(null)();
