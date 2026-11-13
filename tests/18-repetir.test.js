// Botao de repetir: desligado -> 1 vez -> sem parar (infinito). No APK quem repete e o player nativo.
const { chromium } = require('playwright');
const { APP, makeChecker, blockExternal } = require('./helpers');
const { check, finish } = makeChecker();

const mock = (comRepeatNativo) => `(${(nativo) => {
  window.__calls = []; window.__listeners = {}; window.__repeatKind = 0;
  const rec = (name, ret) => function (args) { window.__calls.push({ name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); return Promise.resolve(ret === undefined ? {} : ret); };
  const player = {};
  ['loadVideo', 'setPlaylist', 'appendPlaylist', 'seekToItem', 'show', 'hide', 'updateRect', 'resume', 'pause', 'seekTo', 'setSpeed', 'setVolume', 'enterPiP', 'enterFullscreen', 'exitFullscreen', 'enableTransparency', 'setSleepTimer', 'requestNotificationPermission', 'requestBatteryExemption', 'setMetadata', 'stop'].forEach(n => player[n] = rec(n));
  player.getCurrentIndex = rec('getCurrentIndex', { index: 0, position: 0 });
  player.addListener = (ev, fn) => { window.__listeners[ev] = fn; return Promise.resolve({ remove() {} }); };
  if (nativo) {
    player.setRepeat = (a) => { window.__calls.push({ name: 'setRepeat', args: a }); window.__repeatKind = a.kind; return Promise.resolve({}); };
    player.getRepeat = () => Promise.resolve({ kind: window.__repeatKind });
  }
  const folder = { saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'), checkFolder: rec('checkFolder', { ok: true }) };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
}})(${comRepeatNativo})`;
const nf = (rel) => ({ name: rel.split('/').pop(), relativePath: rel, uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent('c://' + rel), mimeType: 'audio/mpeg', size: 1 });
const faixas = [1, 2, 3, 4].map(i => nf(`Album/Faixa ${i}.mp3`));

async function abrir(browser, nativo) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(mock(nativo));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page); await page.route(/_saf_/, r => r.fulfill({ status: 206, body: '' }));
  await page.goto(APP); await page.waitForTimeout(500);
  await page.evaluate(f => { localStorage.clear(); return processNativeFiles(f, 'Album', false); }, faixas);
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const botao = page => page.evaluate(() => { const b = document.getElementById('loop-btn'); return { estado: _loopLesson, data: b.dataset.loop, infinito: /18\.178 8c5\.096/.test(b.innerHTML), badge: getComputedStyle(b.querySelector('.loop-count-badge')).display !== 'none', verde: b.classList.contains('active-ctrl-green'), ambar: b.classList.contains('active-ctrl'), titulo: b.title }; });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('# APK novo: o player nativo repete (funciona com a tela apagada)');
  let { ctx, page, errors } = await abrir(browser, true);
  let b = await botao(page);
  check('comeca desligado, com o icone normal', b.estado === 0 && !b.infinito && !b.badge && !b.verde && !b.ambar, JSON.stringify(b));
  await page.click('#loop-btn'); b = await botao(page);
  check('1o toque: repetir 1 vez (ambar, "1x")', b.estado === 1 && b.ambar && b.badge && !b.infinito, JSON.stringify(b));
  await page.click('#loop-btn'); b = await botao(page);
  check('2o toque: repetir sem parar, com o simbolo de infinito (verde)', b.estado === 2 && b.verde && b.infinito && !b.badge && /sem parar/.test(b.titulo), JSON.stringify(b));
  let c = await page.evaluate(() => window.__calls.filter(x => x.name === 'setRepeat').map(x => x.args.kind));
  check('cada toque avisa o player nativo (1, depois 2)', JSON.stringify(c) === '[1,2]', JSON.stringify(c));

  // com a repeticao no nativo, o JS nao precisa (nem deve) "mandar voltar"
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => window.__listeners.trackChanged({ index: 0, title: 'Faixa 1', auto: false }));   // o nativo recomecou a mesma faixa
  await page.waitForTimeout(200);
  const rep = await page.evaluate(() => ({ cur: currentIdx, seeks: window.__calls.filter(x => x.name === 'seekToItem').length, estado: _loopLesson }));
  check('a faixa recomeca e continua a mesma, sem comando extra do app', rep.cur === 0 && rep.seeks === 0 && rep.estado === 2, JSON.stringify(rep));

  await page.click('#loop-btn'); b = await botao(page);
  check('3o toque: desligado de novo, icone normal', b.estado === 0 && !b.infinito && !b.verde && !b.ambar, JSON.stringify(b));
  c = await page.evaluate(() => window.__calls.filter(x => x.name === 'setRepeat').map(x => x.args.kind));
  check('avisa o nativo para parar de repetir', c[c.length - 1] === 0, JSON.stringify(c));

  // repetir 1 vez: o servico desliga sozinho depois de repetir e avisa o app
  await page.click('#loop-btn');
  await page.evaluate(() => window.__listeners.repeatChanged({ kind: 0 }));
  b = await botao(page);
  check('"repetir 1 vez" volta para desligado quando o servico avisa que ja repetiu', b.estado === 0 && !b.ambar && !b.badge, JSON.stringify(b));

  // servico vivo com repeticao ligada (app reaberto / volta do segundo plano)
  await page.evaluate(() => { window.__repeatKind = 2; Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(400);
  b = await botao(page);
  check('ao voltar para o app o botao mostra o modo que o servico esta usando (infinito)', b.estado === 2 && b.infinito, JSON.stringify(b));
  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await ctx.close();

  console.log('# APK antigo (sem repeticao nativa): continua com o comportamento de antes');
  ({ ctx, page, errors } = await abrir(browser, false));
  await page.click('#loop-btn'); await page.click('#loop-btn');
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => window.__listeners.trackChanged({ index: 1, title: 'Faixa 2', auto: true }));
  await page.waitForTimeout(200);
  const ant = await page.evaluate(() => ({ cur: currentIdx, seek: window.__calls.find(x => x.name === 'seekToItem') }));
  check('o app manda voltar para a faixa atual quando a seguinte comeca', ant.cur === 0 && ant.seek && ant.seek.args.index === 0, JSON.stringify(ant));
  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await ctx.close();

  console.log('# versao web: repete pelo evento de fim da faixa');
  ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  page = await ctx.newPage(); errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page);
  await page.goto(APP); await page.waitForTimeout(400);
  await page.evaluate(() => { const fs = ['Faixa 1.mp3', 'Faixa 2.mp3'].map(n => { const x = new File(['x'], n, { type: 'audio/mpeg' }); x._path = n; return x; }); loadFiles(fs, false, []); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { toggleLoop(); toggleLoop(); video.dispatchEvent(new Event('ended')); });
  await page.waitForTimeout(1200);
  check('sem parar: ao terminar, fica na mesma faixa', await page.evaluate(() => currentIdx) === 0);
  await page.evaluate(() => { toggleLoop(); video.dispatchEvent(new Event('ended')); });
  await page.waitForTimeout(1300);
  check('desligado: ao terminar, vai para a proxima', await page.evaluate(() => currentIdx) === 1);
  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
