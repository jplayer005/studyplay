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
  const folder = { saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'), releaseFolder: rec('releaseFolder'), checkFolder: rec('checkFolder', { ok: true }), cancelScan: rec('cancelScan'), pickFolderOnly: () => Promise.resolve(window.__pick || { treeUri: 'content://novo', rootName: 'Novo' }), scanFolder: rec('scanFolder'), addListener: () => Promise.resolve({ remove() {} }) };
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
  await ctx.addInitScript(() => {          // sobrevive aos reloads da pagina
    window.wipe = async () => {
      await CourseLibrary._run(['courses', 'summaries'], 'readwrite', tx => { tx.objectStore('courses').clear(); return tx.objectStore('summaries').clear(); });
      CourseLibrary.broken = false; CourseLibrary.uriToId = new Map(); CourseLibrary.ids = new Set();
      localStorage.clear();
    };
    // monta um curso como o app faz ao abrir uma pasta nova e o guarda na biblioteca
    window.makeCourse = (nome, uri, prefixo, n) => {
      resetCourseState();
      const mk = (nm, p) => ({ name: nm, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
      modules = [{ name: 'Modulo', lessons: Array.from({ length: n }, (_, i) => mk(`${prefixo} ${i + 1}.mp4`, `${nome}/${prefixo} ${i + 1}.mp4`)), extras: [], subModules: [] }];
      isModular = true; rebuildLessonsFromModules(); _courseIdentity = { treeUri: uri, rootName: nome }; freezeCourseKey(); _courseIdentity = null; buildSortedLessons();
      saveNativeSessionCache(uri, nome);
      return _courseKey;
    };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page);
  await page.goto(APP); await page.waitForTimeout(400);

  await page.evaluate(() => {
    window.wipe = async () => {
      await CourseLibrary._run(['courses', 'summaries'], 'readwrite', tx => { tx.objectStore('courses').clear(); return tx.objectStore('summaries').clear(); });
      CourseLibrary.broken = false; CourseLibrary.uriToId = new Map(); CourseLibrary.ids = new Set();
      localStorage.clear();
    };
  });
  console.log('# guardar e listar cursos');
  await page.evaluate(async () => {
    await wipe();
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

  console.log('# varios cursos: trocar mantendo o progresso de cada um');
  await page.evaluate(() => {
  });
  await page.evaluate(() => wipe());
  const ks = await page.evaluate(async () => {
    const kA = makeCourse('Curso A', 'content://A', 'Aula', 6); done = new Set([0, 1]); currentIdx = 3; saveToStorage();
    const kB = makeCourse('Curso B', 'content://B', 'Aula', 6); done = new Set([4]); currentIdx = 1; saveToStorage();
    const kC = makeCourse('Curso C', 'content://C', 'Lição', 7); done = new Set([6]); currentIdx = 5; saveToStorage();
    await new Promise(r => setTimeout(r, 400));
    return { kA, kB, kC };
  });
  check('mesmos nomes de aula em pastas diferentes: 3 chaves diferentes', new Set(Object.values(ks)).size === 3, JSON.stringify(ks));
  const estado = () => page.evaluate(() => ({ key: _courseKey, done: [...done].sort(), cur: currentIdx, n: lessons.length, ptr: localStorage.getItem('splay_last_course') }));
  await page.evaluate(k => openCourseById(k), ks.kA);
  let e = await estado();
  check('abre A no ponto onde parou (aula 4, 2 feitas)', e.key === ks.kA && e.cur === 3 && JSON.stringify(e.done) === '[0,1]', JSON.stringify(e));
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(k => openCourseById(k), ks.kB);
  e = await estado();
  check('troca para B com o progresso de B', e.key === ks.kB && e.cur === 1 && JSON.stringify(e.done) === '[4]', JSON.stringify(e));
  check('player foi parado na troca', (await page.evaluate(() => window.__calls)).some(c => c.name === 'stop'));
  await page.evaluate(k => openCourseById(k), ks.kC);
  e = await estado();
  check('troca para C (outras aulas, 7 aulas)', e.key === ks.kC && e.n === 7 && e.cur === 5, JSON.stringify(e));
  check('ponteiro do ultimo curso e C', e.ptr === ks.kC);
  await page.evaluate(() => { done.add(0); saveToStorage(); });
  await page.evaluate(k => openCourseById(k), ks.kA);
  e = await estado();
  check('voltar para A: progresso de A intacto', JSON.stringify(e.done) === '[0,1]' && e.cur === 3, JSON.stringify(e));
  const cdone = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).done.length, ks.kC);
  check('progresso de C ficou gravado (2 feitas)', cdone === 2, String(cdone));
  const ordem = await page.evaluate(async () => (await CourseLibrary.listSummaries()).map(x => x.id));
  check('Meus cursos: A (mais recente), depois C, depois B', JSON.stringify(ordem) === JSON.stringify([ks.kA, ks.kC, ks.kB]), JSON.stringify(ordem));

  console.log('# abrir uma pasta que ja esta na biblioteca nao duplica');
  await page.evaluate(() => { window.__pick = { treeUri: 'content://B', rootName: 'Curso B' }; window.__calls.length = 0; });
  await page.evaluate(() => pickAndLoadFolder(false));
  await page.waitForTimeout(300);
  e = await estado();
  check('abriu o curso guardado B', e.key === ks.kB, JSON.stringify(e));
  check('nao varreu a pasta de novo', !(await page.evaluate(() => window.__calls)).some(c => c.name === 'scanFolder'));
  check('continua com 3 cursos', (await page.evaluate(async () => (await CourseLibrary.listSummaries()).length)) === 3);

  console.log('# dialogo de Abrir Pasta com curso aberto');
  await page.evaluate(() => openFolder());
  const dlg = await page.evaluate(() => ({ ativo: document.getElementById('modal-overlay').classList.contains('active'), btns: [...document.querySelectorAll('#modal-actions .modal-btn')].map(b => b.textContent) }));
  check('oferece Adicionar como novo curso, Acrescentar modulos e Cancelar', dlg.ativo && dlg.btns.length === 3 && /Adicionar como novo curso/.test(dlg.btns[0]) && /Acrescentar/.test(dlg.btns[1]) && dlg.btns[2] === 'Cancelar', JSON.stringify(dlg));
  check('nao oferece mais Substituir curso', !dlg.btns.some(b => /Substituir/.test(b)));
  await page.evaluate(() => closeModal());

  console.log('# remover: sai da lista, guarda o progresso, libera a pasta e reabre pelo mesmo caminho');
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(k => removeCourse(k), ks.kB);          // B esta aberto
  e = await estado();
  const rm = await page.evaluate(async k => ({ lista: (await CourseLibrary.listSummaries()).map(x => x.id), prog: !!localStorage.getItem(k), calls: window.__calls.filter(c => c.name === 'releaseFolder') }), ks.kB);
  check('B saiu da lista', !rm.lista.includes(ks.kB) && rm.lista.length === 2, JSON.stringify(rm.lista));
  check('abriu o proximo curso (nao ficou em B)', e.key !== ks.kB && !!e.key, JSON.stringify(e));
  check('progresso de B guardado', rm.prog);
  check('permissao da pasta liberada', rm.calls.length === 1 && rm.calls[0].args.treeUri === 'content://B', JSON.stringify(rm.calls));
  const back = await page.evaluate(() => { const k = makeCourse('Curso B', 'content://B', 'Aula', 6); return { k, done: JSON.parse(localStorage.getItem(k)).done }; });
  check('adicionar a mesma pasta de novo recupera a chave e o progresso de B', back.k === ks.kB && back.done.length === 1, JSON.stringify(back));

  console.log('# remover todos: tela inicial');
  await page.evaluate(async () => { for (const s of await CourseLibrary.listSummaries()) await removeCourse(s.id); });
  const vazio = await page.evaluate(() => ({ lessons: lessons.length, vazio: !!document.querySelector('#playlist .empty-state'), ptr: localStorage.getItem('splay_last_course'), sess: localStorage.getItem('splay_native_session') }));
  check('sem cursos: tela inicial, sem ponteiro nem reserva', vazio.lessons === 0 && vazio.vazio && vazio.ptr === null && vazio.sess === null, JSON.stringify(vazio));

  console.log('# abrir o app abre o ultimo curso, pela biblioteca');
  await page.evaluate(() => wipe());
  const k2 = await page.evaluate(async () => {
    const a = makeCourse('Curso A', 'content://A', 'Aula', 6); done = new Set([2]); currentIdx = 4; saveToStorage();
    const b = makeCourse('Curso B', 'content://B', 'Lição', 5); done = new Set([1]); currentIdx = 2; saveToStorage();
    await new Promise(r => setTimeout(r, 4000));      // deixa o resumo e a reserva serem gravados
    return { a, b };
  });
  await page.evaluate(() => localStorage.removeItem('splay_native_session'));   // prova que vem do banco
  await page.reload(); await page.waitForTimeout(700);
  const ab = await page.evaluate(() => ({ key: _courseKey, n: lessons.length, cur: currentIdx, modal: document.getElementById('modal-overlay').classList.contains('active') }));
  check('abriu o ultimo curso (B) sem perguntar', ab.key === k2.b && ab.n === 5 && ab.cur === 2 && !ab.modal, JSON.stringify(ab));

  console.log('# migracao: so existe a sessao antiga');
  const sessao = await page.evaluate(() => JSON.parse(localStorage.getItem('splay_native_session') || 'null') || { treeUri: 'content://A', rootName: 'Curso A', isModular: true, modulesCache: [{ name: 'M', lessons: [1, 2, 3, 4, 5].map(i => ({ _uri: 'u' + i, _native: true, name: `Aula ${i}.mp4`, size: 1 })), extras: [], subModules: [] }] });
  await page.evaluate(async sess => {
    await wipe();
    localStorage.setItem('splay_native_session', JSON.stringify(Object.assign({}, sess, { courseKey: undefined })));
  }, sessao);
  await page.reload(); await page.waitForTimeout(700);
  check('curso da sessao antiga abriu', (await page.evaluate(() => lessons.length)) > 0);
  await page.waitForTimeout(2200);
  const mig = await page.evaluate(async () => ({ lista: (await CourseLibrary.listSummaries()).length, ptr: !!localStorage.getItem('splay_last_course') }));
  check('entrou na biblioteca sozinho', mig.lista === 1 && mig.ptr, JSON.stringify(mig));

  console.log('# trocar de curso durante a varredura cancela a varredura');
  await page.evaluate(() => wipe());
  const sw = await page.evaluate(async () => {
    const k = makeCourse('Curso A', 'content://A', 'Aula', 6);
    await new Promise(r => setTimeout(r, 300));
    window.__calls.length = 0;
    await startProgressiveScan(window.Capacitor.Plugins.VideoFolder, 'content://N', 'Novo', performance.now());
    const ativa = _scanActive();
    const ok = await openCourseById(k);
    return { ativa, ok, ainda: _scanActive(), cancel: window.__calls.some(c => c.name === 'cancelScan'), key: _courseKey, banner: document.getElementById('scan-banner').hidden };
  });
  check('troca cancela a varredura e abre o curso guardado', sw.ativa && sw.ok && !sw.ainda && sw.cancel && sw.banner, JSON.stringify(sw));

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
