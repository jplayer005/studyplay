// Erros do curso: pasta movida/apagada, localStorage cheio, banco de cursos com falha
const { chromium } = require('playwright');
const { APP, makeChecker, blockExternal } = require('./helpers');
const { check, finish } = makeChecker();

const MOCK = () => {
  window.__calls = []; window.__folderOk = true; window.__scanEv = {};
  const rec = (name, ret) => function (args) { window.__calls.push({ name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); return Promise.resolve(ret === undefined ? {} : ret); };
  const player = {};
  ['loadVideo', 'setPlaylist', 'appendPlaylist', 'seekToItem', 'show', 'hide', 'updateRect', 'resume', 'pause', 'seekTo', 'setSpeed', 'setVolume', 'enterPiP', 'enterFullscreen', 'exitFullscreen', 'enableTransparency', 'setSleepTimer', 'requestNotificationPermission', 'requestBatteryExemption', 'setMetadata', 'stop'].forEach(n => player[n] = rec(n));
  player.getCurrentIndex = rec('getCurrentIndex', { index: 0, position: 0 });
  player.addListener = () => Promise.resolve({ remove() {} });
  const folder = {
    saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'),
    releaseFolder: rec('releaseFolder'), cancelScan: rec('cancelScan'), scanFolder: rec('scanFolder'),
    checkFolder: (a) => { window.__calls.push({ name: 'checkFolder', args: a }); return Promise.resolve({ ok: window.__folderOk }); },
    pickFolderOnly: () => Promise.resolve(window.__pick || { treeUri: 'content://novo', rootName: 'Novo' }),
    addListener: (ev, fn) => { window.__scanEv[ev] = fn; return Promise.resolve({ remove() {} }); },
  };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  await ctx.addInitScript(() => {
    window.makeCourse = (nome, uri, prefixo, n) => {
      resetCourseState();
      const mk = (nm, p) => ({ name: nm, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
      modules = [{ name: 'Modulo', lessons: Array.from({ length: n }, (_, i) => mk(`${prefixo} ${i + 1}.mp4`, `${nome}/${prefixo} ${i + 1}.mp4`)), extras: [], subModules: [] }];
      isModular = true; rebuildLessonsFromModules(); _courseIdentity = { treeUri: uri, rootName: nome }; freezeCourseKey(); _courseIdentity = null; buildSortedLessons();
      saveNativeSessionCache(uri, nome);
      return _courseKey;
    };
    window.wipe = async () => {
      await CourseLibrary._run(['courses', 'summaries'], 'readwrite', tx => { tx.objectStore('courses').clear(); return tx.objectStore('summaries').clear(); });
      CourseLibrary.broken = false; CourseLibrary._warned = false; CourseLibrary.uriToId = new Map(); CourseLibrary.ids = new Set();
      localStorage.clear();
    };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page);
  await page.goto(APP); await page.waitForTimeout(500);
  const modal = () => page.evaluate(() => ({ ativo: document.getElementById('modal-overlay').classList.contains('active'), titulo: document.getElementById('modal-title').textContent, btns: [...document.querySelectorAll('#modal-actions .modal-btn')].map(b => b.textContent) }));

  const ks = await page.evaluate(async () => {
    await wipe();
    const a = makeCourse('Curso A', 'content://A', 'Aula', 6);
    await new Promise(r => setTimeout(r, 300));
    done = new Set([0, 1]); currentIdx = 3; saveToStorage(); await persistCurrentCourse();
    const b = makeCourse('Curso B', 'content://B', 'Lição', 6);
    await new Promise(r => setTimeout(r, 300));
    return { a, b };
  });

  console.log('# pasta em ordem: nada de aviso');
  await page.evaluate(k => openCourseById(k), ks.a); await page.waitForTimeout(400);
  check('checou a pasta ao abrir', (await page.evaluate(() => window.__calls)).some(c => c.name === 'checkFolder' && c.args.treeUri === 'content://A'));
  check('sem aviso quando a pasta esta ok', !(await modal()).ativo);

  console.log('# pasta movida ou apagada');
  await page.evaluate(k => { window.__folderOk = false; return openCourseById(k); }, ks.b); await page.waitForTimeout(400);
  let m = await modal();
  check('avisa que nao encontrou os arquivos', m.ativo && /N.o encontrei os arquivos/.test(m.titulo), JSON.stringify(m));
  check('oferece Escolher a pasta de novo e Remover da lista', m.btns.includes('Escolher a pasta de novo') && m.btns.includes('Remover da lista'), JSON.stringify(m.btns));
  check('o curso continua aberto (a abertura nao foi atrasada nem bloqueada)', await page.evaluate(k => _courseKey === k && lessons.length === 6, ks.b));
  await page.evaluate(() => closeModal());

  console.log('# erro ao carregar video: confere a pasta');
  await page.evaluate(k => { window.__folderOk = false; _missingShownFor = null; video.src = 'https://localhost/_saf_/?uri=x'; video.dispatchEvent(new Event('error')); }, ks.b);
  await page.waitForTimeout(300);
  check('erro de arquivo com pasta ausente mostra o mesmo aviso', (await modal()).ativo);
  await page.evaluate(() => closeModal());
  await page.evaluate(() => { window.__folderOk = true; _missingShownFor = null; video.dispatchEvent(new Event('error')); });
  await page.waitForTimeout(300);
  check('erro de arquivo com pasta ok so mostra o aviso simples', !(await modal()).ativo);

  console.log('# Escolher a pasta de novo mantem o progresso');
  await page.evaluate(k => { window.__folderOk = true; return openCourseById(k); }, ks.a); await page.waitForTimeout(300);
  await page.evaluate(() => { window.__pick = { treeUri: 'content://A-movida', rootName: 'Curso A' }; window.__calls.length = 0; });
  await page.evaluate(k => reselectCourseFolder(k), ks.a); await page.waitForTimeout(300);
  const sc = await page.evaluate(() => ({ scan: window.__calls.find(c => c.name === 'scanFolder'), forca: _courseIdentity && _courseIdentity.forceKey }));
  check('varre a pasta nova', sc.scan && sc.scan.args.treeUri === 'content://A-movida', JSON.stringify(sc));
  check('mantem a chave do curso', sc.forca === ks.a);
  await page.evaluate(() => {
    const id = _scan.id, mk = (i) => ({ name: `Aula ${i}.mp4`, relativePath: `Modulo/Aula ${i}.mp4`, uri: 'https://localhost/_saf_/?uri=m' + i, mimeType: 'video/mp4', size: 1 });
    window.__scanEv.scanRoot({ scanId: id, rootName: 'Curso A', rootFiles: [], modules: ['Modulo'], flat: false });
    window.__scanEv.scanModule({ scanId: id, index: 0, name: 'Modulo', files: [1, 2, 3, 4, 5, 6].map(mk) });
    window.__scanEv.scanDone({ scanId: id, totalFiles: 6, scanMs: 1 });
  });
  await page.waitForTimeout(500);
  const re = await page.evaluate(async k => { const s = await CourseLibrary.getSummary(k); return { key: _courseKey === k, done: [...done].sort(), cur: currentIdx, uri: s && s.treeUri, mapa: CourseLibrary.uriToId.get('content://A-movida') === k, antigo: CourseLibrary.uriToId.has('content://A'), n: (await CourseLibrary.listSummaries()).length }; }, ks.a);
  check('curso A com o progresso de antes (2 feitas, aula 4)', re.key && JSON.stringify(re.done) === '[0,1]' && re.cur === 3, JSON.stringify(re));
  check('biblioteca aponta para a pasta nova, sem duplicar', re.uri === 'content://A-movida' && re.mapa && !re.antigo && re.n === 2, JSON.stringify(re));

  console.log('# Remover da lista pelo aviso');
  await page.evaluate(k => { window.__folderOk = false; _missingShownFor = null; return openCourseById(k); }, ks.b); await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('#modal-actions .modal-btn')].find(b => b.textContent === 'Remover da lista').click());
  await page.waitForTimeout(500);
  check('B saiu da lista', await page.evaluate(async k => !(await CourseLibrary.listSummaries()).some(s => s.id === k), ks.b));
  await page.evaluate(() => { window.__folderOk = true; });

  console.log('# armazenamento do aparelho cheio');
  const q = await page.evaluate(async () => {
    const toasts = []; const orig = window.toast; window.toast = m => { toasts.push(m); };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('cheio', 'QuotaExceededError'); };
    _storageWarned = false;
    saveToStorage(); saveToStorage(); saveToStorage();
    Storage.prototype.setItem = setItem; window.toast = orig;
    return toasts;
  });
  check('avisa uma unica vez que falta espaco', q.length === 1 && /sem espa.o/.test(q[0]), JSON.stringify(q));
  const dg = await page.evaluate(() => { openDiag(); return document.getElementById('modal-desc').textContent; });
  check('painel de tempos mostra o uso do armazenamento', /Armazenamento do app/.test(dg), dg);
  await page.evaluate(() => closeModal());

  console.log('# banco de cursos com falha');
  const f = await page.evaluate(async () => {
    const toasts = []; const orig = window.toast; window.toast = m => { toasts.push(m); };
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => { throw new Error('sem IDB'); };
    CourseLibrary._p = null; CourseLibrary._warned = false; CourseLibrary.broken = false;
    await CourseLibrary.listSummaries(); await CourseLibrary.saveCourse({ treeUri: 'u', rootName: 'x', savedAt: 1, isModular: true, courseKey: 'kZ', modulesCache: [] });
    indexedDB.open = open; CourseLibrary._p = null; CourseLibrary.broken = false; window.toast = orig;
    return toasts;
  });
  check('avisa uma unica vez, sem derrubar o app', f.length === 1 && /lista de cursos/.test(f[0]), JSON.stringify(f));

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
