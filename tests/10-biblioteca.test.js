// Biblioteca de cursos (IndexedDB): guardar, listar, remover, migrar e falhar sem derrubar o app
const { chromium } = require('playwright');
const { APP, makeChecker, blockExternal } = require('./helpers');
const { check, finish } = makeChecker();

const MOCK = () => {
  window.__calls = [];
  const rec = (name, ret) => function (args) { window.__calls.push({ name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); return Promise.resolve(ret === undefined ? {} : ret); };
  const player = {};
  ['loadVideo', 'setPlaylist', 'appendPlaylist', 'seekToItem', 'show', 'hide', 'updateRect', 'resume', 'pause', 'seekTo', 'setSpeed', 'setVolume', 'enterPiP', 'enterFullscreen', 'exitFullscreen', 'enableTransparency', 'setSleepTimer', 'requestNotificationPermission', 'requestBatteryExemption', 'setMetadata', 'stop'].forEach(n => player[n] = rec(n));
  player.getCurrentIndex = rec('getCurrentIndex', { index: 0, position: 0 });
  player.addListener = () => Promise.resolve({ remove() {} });
  const folder = { saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'), releaseFolder: rec('releaseFolder'), checkFolder: rec('checkFolder', { ok: true }), cancelScan: rec('cancelScan') };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
};

const entry = (key, nome, uri, aulas) => ({
  treeUri: uri, rootName: nome, savedAt: Date.now(), isModular: true, courseKey: key,
  modulesCache: [{ name: 'M1', lessons: Array.from({ length: aulas }, (_, i) => ({ _uri: 'u' + key + i, _native: true, name: `Aula ${i + 1}.mp4`, size: 1 })), extras: [], subModules: [] }]
});

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page);
  await page.goto(APP); await page.waitForTimeout(400);

  console.log('# guardar e listar cursos');
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('studyplay_library'); CourseLibrary._p = null; CourseLibrary.broken = false;
    await new Promise(r => setTimeout(r, 100));
    for (const [k, n, u] of [['kA', 'Curso A', 'content://A'], ['kB', 'Curso B', 'content://B'], ['kC', 'Curso C', 'content://C']]) {
      const e = { treeUri: u, rootName: n, savedAt: Date.now(), isModular: true, courseKey: k, modulesCache: [{ name: 'M1', lessons: [{ _uri: 'u' + k, _native: true, name: 'Aula 1.mp4', size: 1 }], extras: [], subModules: [] }] };
      await CourseLibrary.saveCourse(e);
    }
    // define a ordem de uso: B (mais recente), C, A
    for (const [k, t] of [['kA', 1000], ['kB', 3000], ['kC', 2000]]) { const s = await CourseLibrary.getSummary(k); s.lastOpenedAt = t; await CourseLibrary.putSummary(s); }
  });
  const lista = await page.evaluate(async () => (await CourseLibrary.listSummaries()).map(s => s.id));
  check('3 cursos guardados, do mais recente ao mais antigo', JSON.stringify(lista) === JSON.stringify(['kB', 'kC', 'kA']), JSON.stringify(lista));
  const leve = await page.evaluate(async () => { const s = (await CourseLibrary.listSummaries())[0]; return { campos: Object.keys(s).sort(), temPesado: 'modulesCache' in s }; });
  check('resumo e leve (sem modulos)', !leve.temPesado && leve.campos.includes('name') && leve.campos.includes('done') && leve.campos.includes('total'), JSON.stringify(leve));
  const pesado = await page.evaluate(async () => { const c = await CourseLibrary.getCourse('kB'); return { id: c.id, mods: c.modulesCache.length, uri: c.treeUri }; });
  check('curso pesado lido so ao pedir', pesado.id === 'kB' && pesado.mods === 1 && pesado.uri === 'content://B', JSON.stringify(pesado));
  check('acha curso pela pasta', await page.evaluate(async () => (await CourseLibrary.findByTreeUri('content://C')).id) === 'kC');
  check('pasta desconhecida nao acha nada', await page.evaluate(async () => await CourseLibrary.findByTreeUri('content://X')) === null);

  console.log('# regravar o mesmo curso nao duplica e mantem a data de entrada');
  const r = await page.evaluate(async () => {
    const antes = (await CourseLibrary.getSummary('kA')).addedAt;
    await new Promise(r => setTimeout(r, 20));
    await CourseLibrary.saveCourse({ treeUri: 'content://A', rootName: 'Curso A', savedAt: Date.now(), isModular: true, courseKey: 'kA', modulesCache: [] });
    const depois = (await CourseLibrary.getSummary('kA')).addedAt;
    return { n: (await CourseLibrary.listSummaries()).length, igual: antes === depois };
  });
  check('continua com 3 cursos', r.n === 3, String(r.n));
  check('data de entrada preservada', r.igual);

  console.log('# remover guarda progresso, notas e capitulos');
  const rem = await page.evaluate(async () => {
    localStorage.setItem('videoaulas_v3_kB', JSON.stringify({ done: ['Aula 1'], notes: [{ text: 'n' }] }));
    await CourseLibrary.remove('kB');
    return { lista: (await CourseLibrary.listSummaries()).map(s => s.id), pesado: await CourseLibrary.getCourse('kB'), prog: !!localStorage.getItem('videoaulas_v3_kB') };
  });
  check('saiu da lista (A foi regravado, por isso e o mais recente)', JSON.stringify(rem.lista) === JSON.stringify(['kA', 'kC']), JSON.stringify(rem.lista));
  check('registro pesado apagado', rem.pesado === undefined || rem.pesado === null);
  check('progresso e notas no localStorage intactos', rem.prog);

  console.log('# salvar o curso aberto grava na biblioteca e no ponteiro');
  const sv = await page.evaluate(async () => {
    localStorage.clear();
    const mk = (n, p) => ({ name: n, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
    modules = [{ name: 'Mod', lessons: ['Aula 1.mp4', 'Aula 2.mp4', 'Aula 3.mp4', 'Aula 4.mp4', 'Aula 5.mp4'].map(n => mk(n, 'Mod/' + n)), extras: [], subModules: [] }];
    isModular = true; _courseKey = null; done = new Set(); lessons = []; rebuildLessonsFromModules(); freezeCourseKey(); buildSortedLessons();
    currentIdx = 2; done.add(0); done.add(1);
    saveNativeSessionCache('content://Z', 'Curso Z');
    await new Promise(r => setTimeout(r, 400));
    const s = await CourseLibrary.getSummary(_courseKey);
    return { key: _courseKey, ponteiro: localStorage.getItem('splay_last_course'), s, sess: !!localStorage.getItem('splay_native_session'), pesado: !!(await CourseLibrary.getCourse(_courseKey)) };
  });
  check('ponteiro do ultimo curso gravado', sv.ponteiro === sv.key, JSON.stringify(sv));
  check('resumo com nome, total, feitas e aula atual', sv.s && sv.s.name === 'Curso Z' && sv.s.total === 5 && sv.s.done === 2 && sv.s.currentName === 'Aula 3' && sv.s.currentModule === 'Mod', JSON.stringify(sv.s));
  check('curso pesado guardado', sv.pesado);
  check('sessao antiga continua gravada (reserva)', sv.sess);

  console.log('# resumo acompanha o progresso (no maximo a cada 3 s)');
  const up = await page.evaluate(async () => {
    done.add(2); done.add(3); saveToStorage(); saveToStorage(); saveToStorage();
    await new Promise(r => setTimeout(r, 3400));
    return (await CourseLibrary.getSummary(_courseKey)).done;
  });
  check('resumo atualizado (4 feitas)', up === 4, String(up));

  console.log('# banco com falha nao derruba o app');
  const f = await page.evaluate(async () => {
    const orig = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => { throw new Error('IDB indisponivel'); };
    CourseLibrary._p = null; CourseLibrary.broken = false;
    const lista = await CourseLibrary.listSummaries();
    const ok = await CourseLibrary.saveCourse({ treeUri: 'u', rootName: 'x', savedAt: 1, isModular: true, courseKey: 'kQ', modulesCache: [] });
    localStorage.removeItem('splay_native_session');
    saveNativeSessionCache('content://Z', 'Curso Z');
    const sess = !!localStorage.getItem('splay_native_session');
    indexedDB.open = orig; CourseLibrary._p = null; CourseLibrary.broken = false;
    return { lista: lista.length, ok, sess };
  });
  check('listar devolve vazio, sem erro', f.lista === 0);
  check('gravar devolve falso', f.ok === false);
  check('sessao em localStorage continua sendo gravada (reserva)', f.sess);

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
