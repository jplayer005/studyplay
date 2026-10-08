// Roda todos os testes (*.test.js), um por vez, e resume o resultado.
//   uso:  node run-all.js            (todos)
//         node run-all.js layout     (so os arquivos cujo nome contem "layout")
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filtro = (process.argv[2] || '').toLowerCase();
const arquivos = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js') && f.toLowerCase().includes(filtro)).sort();
if (!arquivos.length) { console.log('Nenhum teste encontrado.'); process.exit(1); }

let falhas = 0; const resumo = [];
for (const f of arquivos) {
  console.log('\n==== ' + f + ' ====');
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', cwd: __dirname });
  const ok = r.status === 0;
  if (!ok) falhas++;
  resumo.push((ok ? 'OK    ' : 'FALHA ') + f);
}
console.log('\n==== RESUMO ====\n' + resumo.join('\n'));
console.log(falhas ? `\n${falhas} arquivo(s) com falha` : '\nTodos os testes passaram.');
process.exit(falhas ? 1 : 0);
