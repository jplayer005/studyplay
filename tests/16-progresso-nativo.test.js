// Ouvir uma sequencia de aulas, fechar o app e reabrir depois: volta onde parou de verdade.
// O ExoPlayer segue tocando sem o WebView; o servico nativo grava a aula/posicao e as aulas
// que terminaram sozinhas, e o app le isso ao reabrir.
const { chromium } = require('playwright');
const { APP, makeChecker, blockExternal } = require('./helpers');
const { check, finish } = makeChecker();

const MOCK = () => {
  window.__calls = []; window.__listeners = {};
  const rec = (name, ret) => function (args) { window.__calls.push({ name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); return Promise.resolve(ret === undefined ? {} : ret); };
  const player = {};
  ['loadVideo', 'setPlaylist', 'appendPlaylist', 'seekToItem', 'show', 'hide', 'updateRect', 'resume', 'pause', 'seekTo', 'setSpeed', 'setVolume', 'enterPiP', 'enterFullscreen', 'exitFullscreen', 'enableTransparency', 'setSleepTimer', 'requestNotificationPermission', 'requestBatteryExemption', 'setMetadata', 'stop'].forEach(n => player[n] = rec(n));
  player.getCurrentIndex = rec('getCurrentIndex', { index: 0, position: 0 });
  player.addListener = (ev, fn) => { window.__listeners[ev] = fn; return Promise.resolve({ remove() {} }); };
  // progresso gravado pelo "servico nativo": definido pelo teste em localStorage (sobrevive ao reload)
  player.getSavedProgress = () => { window.__calls.push({ name: 'getSavedProgress' }); try { return Promise.resolve(JSON.parse(localStorage.getItem('__native_progress') || 'null') || { mediaId: '', positionMs: 0, savedAt: 0, completed: [] }); } catch (e) { return Promise.resolve({ mediaId: '', positionMs: 0, savedAt: 0, completed: [] }); } };
  player.ackSavedProgress = (a) => { window.__calls.push({ name: 'ackSavedProgress', args: a }); return Promise.resolve({}); };
  const folder = { saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'), releaseFolder: rec('releaseFolder'), checkFolder: rec('checkFolder', { ok: true }), cancelScan: rec('cancelScan'), pickFolderOnly: () => new Promise(() => {}), scanFolder: rec('scanFolder'), addListener: () => Promise.resolve({ remove() {} }) };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
};
const uriOf = i => 'https://localhost/_saf_/?uri=' + encodeURIComponent('Curso/Aula ' + (i + 1) + '.mp4');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  await ctx.addInitScript(() => {
    window.makeCourse = (nome, uri, n) => {
      resetCourseState();
      const mk = (i) => ({ name: 'Aula ' + (i + 1) + '.mp4', _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent('Curso/Aula ' + (i + 1) + '.mp4'), _native: true, size: 1, _path: 'Curso/Aula ' + (i + 1) + '.mp4' });
      modules = [{ name: 'Modulo', lessons: Array.from({ length: n }, (_, i) => mk(i)), extras: [], subModules: [] }];
      isModular = true; rebuildLessonsFromModules(); _courseIdentity = { treeUri: uri, rootName: nome }; freezeCourseKey(); _courseIdentity = null; buildSortedLessons();
      saveNativeSessionCache(uri, nome);
      return _courseKey;
    };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page); await page.route(/_saf_/, r => r.fulfill({ status: 206, body: '' }));
  await page.goto(APP); await page.waitForTimeout(500);
  const estado = () => page.evaluate(() => ({ cur: currentIdx, done: [...done].sort((a, b) => a - b), t: Object.fromEntries(Object.entries(lessonTimes).map(([k, v]) => [k, Math.round(v)])) }));
  const reabrir = async () => { await page.reload(); await page.waitForTimeout(900); };

  // curso de 10 aulas; o app tinha parado na aula 2 (indice 1), com a aula 1 concluida
  await page.evaluate(async () => {
    localStorage.clear();
    await CourseLibrary._run(['courses', 'summaries'], 'readwrite', tx => { tx.objectStore('courses').clear(); return tx.objectStore('summaries').clear(); });
    makeCourse('Curso', 'content://C', 10);
    await new Promise(r => setTimeout(r, 300));
    done = new Set([0]); currentIdx = 1; lessonTimes[1] = 40; saveToStorage();
  });

  console.log('# sem registro nativo: abre onde o app gravou');
  await reabrir();
  let e = await estado();
  check('volta na aula 2 (como gravado pelo app)', e.cur === 1 && JSON.stringify(e.done) === '[0]', JSON.stringify(e));

  console.log('# app fechado com o player tocando: o servico avancou ate a aula 6');
  await page.evaluate(([u2, u3, u4, u5, u6]) => {
    localStorage.setItem('__native_progress', JSON.stringify({ mediaId: u6, positionMs: 754000, durationMs: 1800000, savedAt: Date.now() + 5000, completed: [u2, u3, u4, u5] }));
  }, [1, 2, 3, 4, 5].map(uriOf));
  await reabrir();
  e = await estado();
  check('abre na aula 6 (onde o servico parou), nao na 2', e.cur === 5, JSON.stringify(e));
  check('aulas 2 a 5 (terminaram sozinhas) marcadas como concluidas, mais a 1', JSON.stringify(e.done) === '[0,1,2,3,4]', JSON.stringify(e.done));
  check('retoma a aula 6 em 12:34 (754 s)', e.t['5'] === 754, JSON.stringify(e.t));
  const c = await page.evaluate(() => window.__calls);
  check('avisa o servico que as concluidas ja foram aplicadas (ack)', c.some(x => x.name === 'ackSavedProgress' && x.args.completed.length === 4), JSON.stringify(c.filter(x => x.name === 'ackSavedProgress')));
  const sp = c.find(x => x.name === 'setPlaylist');
  check('a fila nativa comeca pela aula 6', sp && /Aula 6/.test(sp.args.items[0].title), JSON.stringify(sp && sp.args.items[0]));

  console.log('# registro nativo MAIS VELHO que o do app: o do app vence');
  await page.evaluate(() => {
    localStorage.removeItem('__native_progress');
  });
  await page.evaluate(() => { currentIdx = 7; lessonTimes[7] = 100; saveToStorage(); });
  await page.evaluate(u => localStorage.setItem('__native_progress', JSON.stringify({ mediaId: u, positionMs: 5000, savedAt: 1000, completed: [] })), uriOf(2));
  await reabrir();
  e = await estado();
  check('fica na aula 8 gravada pelo app (nativo era antigo)', e.cur === 7, JSON.stringify(e));

  console.log('# registro de outro curso (aula que nao existe aqui): ignora');
  await page.evaluate(() => localStorage.setItem('__native_progress', JSON.stringify({ mediaId: 'https://localhost/_saf_/?uri=OUTRO%2FX.mp4', positionMs: 99000, savedAt: Date.now() + 9000, completed: ['https://localhost/_saf_/?uri=OUTRO%2FY.mp4'] })));
  await reabrir();
  e = await estado();
  check('abre normalmente na aula 8, sem erro', e.cur === 7);

  console.log('# voltar do segundo plano: marca as aulas que terminaram sozinhas');
  await page.evaluate(() => localStorage.setItem('__native_progress', JSON.stringify({ mediaId: '', positionMs: 0, savedAt: 0, completed: [] })));
  await reabrir();
  const antes = await estado();
  await page.evaluate(u => localStorage.setItem('__native_progress', JSON.stringify({ mediaId: u[1], positionMs: 1000, savedAt: Date.now(), completed: [u[0], u[1]] })), [uriOf(8), uriOf(9)]);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  e = await estado();
  check('aulas 9 e 10 passam a concluidas ao voltar', e.done.includes(8) && e.done.includes(9) && !antes.done.includes(8), JSON.stringify({ antes: antes.done, depois: e.done }));
  check('a aula atual nao e trocada pelo sync de conclusoes', e.cur === antes.cur, JSON.stringify({ antes: antes.cur, depois: e.cur }));

  console.log('# gravacao enquanto a aula toca (nao so quando para)');
  const g = await page.evaluate(async () => {
    let n = 0; const orig = window.saveToStorage; window.saveToStorage = function () { n++; return orig.apply(this, arguments); };
    // timeupdate a cada 250 ms durante ~7 s, sem parar
    for (let t = 10; t < 17; t += 0.25) { window.__listeners.timeupdate({ currentTime: t, duration: 600 }); await new Promise(r => setTimeout(r, 250)); }
    const durante = n; window.saveToStorage = orig;
    return { durante, pos: Math.round(lessonTimes[currentIdx]) };
  });
  check('gravou pelo menos uma vez em 7 s tocando sem parar (antes: nunca)', g.durante >= 1, JSON.stringify(g));

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
