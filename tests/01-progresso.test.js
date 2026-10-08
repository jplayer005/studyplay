// Testes de comportamento da Fase 1 (rodam no Chromium headless, modo web)
const { chromium } = require('playwright');
const { APP } = require('./helpers');
const path = require('path');

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { fails++; console.log('FALHA ' + name + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route(/googleapis|cdnjs|gstatic|google/, r => r.abort());
  await page.goto(APP);
  await page.waitForTimeout(300);

  // monta um curso modular com NOMES REPETIDOS entre módulos
  const setup = () => page.evaluate(() => {
    localStorage.clear();
    const mk = (n, p) => ({ name: n, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
    modules = [
      { name: 'Modulo A', lessons: [mk('Aula 01.mp4', 'A/Aula 01.mp4'), mk('Aula 02.mp4', 'A/Aula 02.mp4')], extras: [], subModules: [] },
      { name: 'Modulo B', lessons: [mk('Aula 01.mp4', 'B/Aula 01.mp4'), mk('Aula 02.mp4', 'B/Aula 02.mp4')], extras: [], subModules: [] },
      { name: 'Modulo C', lessons: [mk('Final.mp4', 'C/Final.mp4')], extras: [], subModules: [] },
    ];
    _courseKey = null;
    isModular = true; document.body.classList.add('is-modular');
    done = new Set(); lessons = [];
    rebuildLessonsFromModules();
    freezeCourseKey();
    buildSortedLessons();
    renderModularPlaylist();
    return { keys: lessons.map(l => l.key), courseKey: _courseKey };
  });

  console.log('# nomes repetidos');
  const s = await setup();
  check('chaves unicas para 5 aulas', new Set(s.keys).size === 5, JSON.stringify(s.keys));
  check('"Final" mantem nome puro (compat. dados antigos)', s.keys.includes('Final'));

  const r1 = await page.evaluate(() => {
    setDone(2, true, true); // 1a aula do Modulo B
    const items = [...document.querySelectorAll('.lesson-item')].length;
    const badges = [...document.querySelectorAll('.module-count')].map(b => b.closest('.module-header').querySelector('.module-title').textContent + ':' + b.textContent);
    return { done: [...done], items, badges };
  });
  check('so a aula 2 (Modulo B) foi marcada', JSON.stringify(r1.done) === '[2]', JSON.stringify(r1.done));
  check('5 itens renderizados (nenhum perdido)', r1.items === 5, String(r1.items));
  check('selo "feitas/total" correto por modulo', JSON.stringify(r1.badges) === '["Modulo A:0/2","Modulo B:1/2","Modulo C:0/1"]', JSON.stringify(r1.badges));

  console.log('# persistencia + reordenar');
  const r2 = await page.evaluate(() => {
    const keyBefore = buildStorageKey();
    saveToStorage();
    // reordena: Modulo C vai para o inicio
    const c = modules.pop(); modules.unshift(c);
    rebuildLessonsFromModules(); buildSortedLessons(); saveModuleOrder();
    const keyAfter = buildStorageKey();
    // "reinicia": zera o estado e recarrega do storage
    done = new Set();
    const stored = loadFromStorage();
    applyStoredProgress(stored);
    const doneNames = [...done].map(i => lessons[i].key);
    return { keyBefore, keyAfter, doneNames, order: loadModuleOrder() };
  });
  check('chave nao muda ao reordenar', r2.keyBefore === r2.keyAfter, r2.keyBefore + ' vs ' + r2.keyAfter);
  check('progresso recuperado apos reordenar (so a aula B/01)', r2.doneNames.length === 1 && r2.doneNames[0].includes('B/Aula 01'), JSON.stringify(r2.doneNames));
  check('ordem dos modulos salva sob a mesma chave', r2.order && r2.order[0] === 'Modulo C', JSON.stringify(r2.order));

  console.log('# migracao de dados antigos (formato so-nome)');
  const r3 = await page.evaluate(() => {
    localStorage.clear(); _courseKey = null;
    done = new Set(); lessons = []; rebuildLessonsFromModules(); freezeCourseKey();
    // dado salvo pela versao antiga: nomes puros; "Final" e unico
    localStorage.setItem(buildStorageKey(), JSON.stringify({ done: ['Final'], favorites: ['Final'], positions: { Final: 33 }, currentName: 'Final', speedIdx: 3 }));
    applyStoredProgress(loadFromStorage());
    const i = lessons.findIndex(l => l.name === 'Final');
    return { doneHasFinal: done.has(i), fav: favorites.has(i), pos: lessonTimes[i], resume: getResumeIdx(loadFromStorage()) === i, speed: speedIdx };
  });
  check('dado antigo: concluida', r3.doneHasFinal);
  check('dado antigo: favorita', r3.fav);
  check('dado antigo: posicao 33s', r3.pos === 33, String(r3.pos));
  check('dado antigo: retoma na aula certa', r3.resume);
  check('dado antigo: velocidade', r3.speed === 3, String(r3.speed));

  console.log('# fim da aula nao desmarca');
  const r4 = await page.evaluate(() => {
    done = new Set(); currentIdx = 1;
    done.add(1);                                 // marcada automaticamente aos 90%
    video.dispatchEvent(new Event('ended'));     // fim do video
    return { stillDone: done.has(1) };
  });
  check('aula continua concluida apos "ended"', r4.stillDone);
  const r4b = await page.evaluate(() => { currentIdx = 0; markDone(); const a = done.has(0); markDone(); return { a, b: done.has(0) }; });
  check('botao Marcar concluida ainda alterna', r4b.a === true && r4b.b === false);

  console.log('# datas locais');
  const r5 = await page.evaluate(() => {
    const d = new Date(2025, 0, 15, 23, 30); // 15/jan 23:30 local
    return localDate(d);
  });
  check('23:30 local continua no mesmo dia', r5 === '2025-01-15', r5);

  console.log('# erros de pagina');
  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(fails ? 1 : 0);
})();
