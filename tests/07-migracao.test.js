const { chromium } = require('playwright');
const { APP } = require('./helpers');
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] }); const p = await (await b.newContext()).newPage();
  await p.route(/googleapis|gstatic|apis\.google|accounts\.google/, r => r.abort());
  await p.goto(APP); await p.waitForTimeout(300);
  const r = await p.evaluate(() => {
    const out = {};
    // 1) cache da versao 2.0 (sem courseKey) -> nao restaura rapido
    out.legacyFallsBack = quickRestore({ treeUri: 't', rootName: 'x', isModular: false, lessonsCache: [{ name: 'A', _uri: 'u', fname: 'A.mp4', size: 1 }] }) === true && quickRestore({ treeUri: 't', rootName: 'x', isModular: false, lessonsCache: [{ name: 'A', _uri: 'u', fname: 'A.mp4', size: 1 }, { name: 'A', _uri: 'v', fname: 'A.mp4', size: 1 }] }) === false;
    // 2) cache novo -> restaura
    out.newRestores = quickRestore({ treeUri: 't', rootName: 'x', isModular: false, courseKey: 'videoaulas_v3_abc', lessonsCache: [{ name: 'A', _uri: 'u', fname: 'A.mp4', size: 1, path: 'A.mp4' }] }) === true;
    // 3) dado antigo com nome puro, depois o nome passa a ser repetido (acrescentou modulo)
    localStorage.clear(); _courseKey = null;
    const mk = (n, p) => ({ name: n, _uri: 'u' + p, _native: true, size: 1, _path: p });
    modules = [{ name: 'M1', lessons: [mk('Aula 1.mp4', 'M1/Aula 1.mp4')], extras: [], subModules: [] }];
    isModular = true; rebuildLessonsFromModules(); freezeCourseKey();
    localStorage.setItem(buildStorageKey(), JSON.stringify({ done: ['Aula 1'], positions: { 'Aula 1': 50 }, currentName: 'Aula 1' }));
    modules.push({ name: 'M2', lessons: [mk('Aula 1.mp4', 'M2/Aula 1.mp4')], extras: [], subModules: [] });   // agora repetido
    rebuildLessonsFromModules();
    applyStoredProgress(loadFromStorage());
    out.keys = lessons.map(l => l.key);
    out.legacyDoneKept = done.has(0) && !done.has(1) && lessonTimes[0] === 50;
    return out;
  });
  console.log(JSON.stringify(r));
  const ok = r.legacyFallsBack && r.newRestores && r.legacyDoneKept;
  console.log(ok ? 'MIGRACAO OK' : 'FALHA'); await b.close(); process.exit(ok ? 0 : 1);
})();
