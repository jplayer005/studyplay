// Celular na vertical: linha unica de busca, barra que esconde ao rolar, controles compactos
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
  const folder = { saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'), releaseFolder: rec('releaseFolder'), checkFolder: rec('checkFolder', { ok: true }), cancelScan: rec('cancelScan'), pickFolderOnly: () => new Promise(() => {}), scanFolder: rec('scanFolder'), addListener: () => Promise.resolve({ remove() {} }) };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  await ctx.addInitScript(() => {
    window.makeBig = (n) => {      // curso com n aulas em modulos de 10
      resetCourseState();
      const mk = (nm, p) => ({ name: nm, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
      modules = Array.from({ length: Math.ceil(n / 10) }, (_, m) => ({ name: 'Modulo ' + (m + 1), lessons: Array.from({ length: Math.min(10, n - m * 10) }, (_, i) => mk(`Aula ${m + 1}.${i + 1}.mp4`, `M${m}/a${i}.mp4`)), extras: [], subModules: [] }));
      isModular = true; rebuildLessonsFromModules(); _courseIdentity = { treeUri: 'content://X' + n, rootName: 'Curso Grande ' + n }; freezeCourseKey(); _courseIdentity = null; buildSortedLessons();
      currentIdx = 0; renderModularPlaylist(); expandAllModules(); updateCourseChip();
    };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page);
  await page.goto(APP); await page.waitForTimeout(500);
  const rect = sel => page.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; }, sel);
  const compact = () => page.evaluate(() => document.body.classList.contains('sb-compact'));
  const scrollTo = async y => { await page.evaluate(v => { document.getElementById('playlist').scrollTop = v; }, y); await page.waitForTimeout(600); };

  await page.evaluate(() => makeBig(80));
  await page.waitForTimeout(300);

  console.log('# 1. busca e botoes na mesma linha, so icones');
  const sb = await rect('#search-input'), sbox = await rect('.search-box'), org = await rect('#btn-organize'), col = await rect('#btn-collapse-all');
  check('busca, Organizar e Recolher na mesma linha', Math.abs(sbox.top - org.top) <= 2 && Math.abs(org.top - col.top) <= 2, JSON.stringify({ sbox, org, col }));
  check('botoes quadrados de pelo menos 40px (area de toque)', org.w >= 40 && org.h >= 40 && col.w >= 40 && col.h >= 40 && sbox.h >= 40, JSON.stringify({ org, col, sbox }));
  check('tudo dentro da largura da tela', col.right <= 393 && org.left >= 0);
  const rotulos = await page.evaluate(() => ({ org: getComputedStyle(document.getElementById('organize-label')).display, col: getComputedStyle(document.getElementById('collapse-all-label')).display, titulo: getComputedStyle(document.querySelector('.sidebar-title')).display, aria: document.getElementById('btn-organize').getAttribute('aria-label') }));
  check('rotulos de texto escondidos (so icones) e titulo Playlist fora', rotulos.org === 'none' && rotulos.col === 'none' && rotulos.titulo === 'none', JSON.stringify(rotulos));
  check('botoes de icone tem nome para leitor de tela', !!rotulos.aria);
  const lista = await rect('#playlist');
  check('lista de aulas com mais espaco (>= 240px de altura)', lista.h >= 240, JSON.stringify(lista));

  console.log('# 2. controles compactos');
  const aux = await page.evaluate(() => [...document.querySelectorAll('.ctrl-aux .ctrl-btn, .ctrl-aux .fav-ctrl-btn, .ctrl-aux .mark-done-btn')].map(b => Math.round(b.getBoundingClientRect().height)));
  const main = await page.evaluate(() => [...document.querySelectorAll('.ctrl-main .ctrl-btn')].map(b => Math.round(b.getBoundingClientRect().height)));
  check('segunda linha de controles com 40px (minimo de toque)', aux.length >= 6 && aux.every(h => h >= 40 && h <= 40), JSON.stringify(aux));
  check('linha principal com 44px ou mais', main.every(h => h >= 44), JSON.stringify(main));

  console.log('# 3. esconde ao rolar para baixo, mostra ao rolar para cima');
  const antes = await rect('#playlist'), cab0 = await rect('.sidebar-header');
  check('no topo a barra aparece', !(await compact()) && cab0.h > 80, JSON.stringify(cab0));
  await scrollTo(60);
  check('rolagem curta (60px) nao esconde', !(await compact()));
  await scrollTo(60 + 40); await scrollTo(60 + 40 + 120);
  check('rolando para baixo esconde a barra de curso e a busca', await compact());
  const cab1 = await rect('.sidebar-header'), dep = await rect('#playlist');
  check('barra some e a lista ganha a altura dela', cab1.h <= 2 && dep.h >= antes.h + cab0.h - 6, JSON.stringify({ cab1, antes: antes.h, depois: dep.h, cab0: cab0.h }));
  const op = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar-header')).opacity);
  check('barra escondida fica transparente (sem tocar por engano)', parseFloat(op) === 0, op);
  await scrollTo(200);
  check('rolando para cima mostra de novo', !(await compact()));
  await scrollTo(400); await scrollTo(520);
  check('esconde outra vez ao descer', await compact());
  await scrollTo(0);
  check('voltar ao topo mostra a barra', !(await compact()));

  console.log('# 4. nao esconde quando nao deve');
  await page.evaluate(() => { const i = document.getElementById('search-input'); i.value = 'Aula'; i.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(400);
  await scrollTo(100); await scrollTo(260);
  check('com texto na busca a barra fica', !(await compact()));
  await page.evaluate(() => { const i = document.getElementById('search-input'); i.value = ''; i.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(400);
  await scrollTo(0);
  await scrollTo(100); await scrollTo(260);
  check('sem busca esconde de novo', await compact());
  await page.evaluate(() => document.getElementById('search-input').focus());
  await page.waitForTimeout(200);
  check('tocar na busca mostra a barra', !(await compact()));
  await page.evaluate(() => { document.getElementById('search-input').blur(); });
  await page.evaluate(() => makeBig(5));
  await page.waitForTimeout(300);
  await scrollTo(30); await scrollTo(90);
  check('lista curta (sem folga para rolar) nunca esconde', !(await compact()));
  await page.evaluate(() => makeBig(80)); await page.waitForTimeout(300);
  await scrollTo(100); await scrollTo(300);
  check('(de novo, lista grande esconde)', await compact());
  await page.evaluate(() => makeBig(80)); await page.waitForTimeout(300);
  check('abrir/trocar de curso traz a barra de volta', !(await compact()));

  console.log('# 5. horizontal e desktop nao mudam');
  await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(300);
  await scrollTo(100); await scrollTo(300);
  check('horizontal: barra nunca esconde', !(await compact()));
  const hz = await page.evaluate(() => ({ titulo: getComputedStyle(document.querySelector('.sidebar-title')).display, rot: getComputedStyle(document.getElementById('organize-label')).display }));
  check('horizontal: titulo e rotulos continuam', hz.titulo !== 'none' && hz.rot !== 'none', JSON.stringify(hz));
  await page.setViewportSize({ width: 1200, height: 800 }); await page.waitForTimeout(300);
  await scrollTo(100); await scrollTo(300);
  const dk = await page.evaluate(() => ({ titulo: getComputedStyle(document.querySelector('.sidebar-title')).display, rot: getComputedStyle(document.getElementById('organize-label')).display, comp: document.body.classList.contains('sb-compact') }));
  check('desktop: igual a antes (titulo, rotulos, barra sempre visivel)', dk.titulo !== 'none' && dk.rot !== 'none' && !dk.comp, JSON.stringify(dk));
  await page.setViewportSize({ width: 393, height: 780 });

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
