const { chromium } = require('playwright');
const { APP } = require('./helpers');
const out = require('path').join(__dirname, 'out'); require('fs').mkdirSync(out, { recursive: true });   // capturas de tela (ignoradas pelo git)
let fails = 0;
const check = (n, c, x) => { if (c) console.log('  OK  ' + n); else { fails++; console.log('FALHA ' + n + (x ? ' -> ' + x : '')); } };

const SETUP = () => {
  localStorage.clear();
  const mk = (n, p) => ({ name: n, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
  modules = ['Modulo 1', 'Modulo 2', 'Modulo 3'].map((m, k) => ({ name: m, lessons: Array.from({ length: 6 }, (_, i) => mk('Aula ' + (i + 1) + '.mp4', k + '/' + i)), extras: [], subModules: [] }));
  _courseKey = null; isModular = true; document.body.classList.add('is-modular');
  done = new Set(); lessons = []; rebuildLessonsFromModules(); freezeCourseKey(); buildSortedLessons();
  collapsedModules = {}; renderModularPlaylist();
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];

  // ---------- celular vertical ----------
  const ctxP = await browser.newContext({ viewport: { width: 393, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctxP.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  await p.route(/googleapis|gstatic|apis\.google|accounts\.google/, r => r.abort());
  await p.goto(APP); await p.waitForTimeout(300);
  await p.evaluate(SETUP);

  console.log('# vertical: layout');
  const g = await p.evaluate(() => {
    const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { video: r('#video-wrapper'), controls: r('.controls-bar'), sidebar: r('#sidebar'), header: r('header'), vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth };
  });
  check('video acima da lista', g.video.bottom <= g.sidebar.top + 1, JSON.stringify(g));
  check('video 16:9', Math.abs(g.video.w / g.video.h - 16 / 9) < 0.05, `${g.video.w}x${g.video.h}`);
  check('sem rolagem horizontal', g.scrollW <= g.vw, `${g.scrollW}>${g.vw}`);
  const btns = await p.evaluate(() => [...document.querySelectorAll('.ctrl-row button, header button')].filter(b => b.offsetParent !== null).map(b => { const r = b.getBoundingClientRect(); return { id: b.id || b.title, w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), left: Math.round(r.left) }; }));
  check('nenhum botao ultrapassa a tela', btns.every(b => b.right <= 393 && b.left >= 0), JSON.stringify(btns.filter(b => b.right > 393 || b.left < 0)));
  check('botoes com area de toque >= 40px', btns.every(b => b.w >= 38 && b.h >= 38), JSON.stringify(btns.filter(b => b.w < 38 || b.h < 38)));

  console.log('# vertical: modo organizar');
  const handleHidden = await p.evaluate(() => getComputedStyle(document.querySelector('.module-drag-handle')).display === 'none');
  check('alca de arrastar oculta por padrao', handleHidden);
  await p.evaluate(() => toggleOrganizeMode());
  const handleShown = await p.evaluate(() => getComputedStyle(document.querySelector('.module-drag-handle')).display !== 'none');
  check('alca aparece no modo organizar', handleShown);
  check('botao vira "Concluir"', await p.evaluate(() => document.getElementById('organize-label').textContent) === 'Concluir');
  await p.screenshot({ path: out + '/f3-port-organizar.png' });
  await p.evaluate(() => toggleOrganizeMode());

  console.log('# configuracoes');
  await p.evaluate(() => openSettings());
  await p.waitForTimeout(150);
  const sw = await p.evaluate(() => ({ a90: document.getElementById('sw-auto90').classList.contains('on'), fs: document.getElementById('sw-autofs').classList.contains('on') }));
  check('padrao: 90% ligado, tela cheia ao girar desligada', sw.a90 === true && sw.fs === false, JSON.stringify(sw));
  await p.screenshot({ path: out + '/f3-port-config.png' });
  await p.click('#row-auto90');
  const after = await p.evaluate(() => ({ on: document.getElementById('sw-auto90').classList.contains('on'), stored: localStorage.getItem('splay_set_auto90'), v: _settings.auto90 }));
  check('toque desliga e salva a opcao', after.on === false && after.stored === '0' && after.v === false, JSON.stringify(after));
  // efeito real: com 90% desligado nao conclui sozinho
  const eff = await p.evaluate(() => {
    done = new Set(); currentIdx = 0;
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 95, configurable: true, writable: true });
    video.dispatchEvent(new Event('timeupdate'));
    const off = done.has(0);
    _settings.auto90 = true; video.dispatchEvent(new Event('timeupdate'));
    return { off, on: done.has(0) };
  });
  check('90% desligado: nao conclui sozinho', eff.off === false);
  check('90% ligado: conclui sozinho', eff.on === true);
  await p.evaluate(() => document.getElementById('settings-modal').classList.remove('active'));

  console.log('# tema claro');
  await p.evaluate(() => setTheme('light'));
  await p.screenshot({ path: out + '/f3-port-claro.png' });
  await ctxP.close();

  // ---------- celular horizontal ----------
  const ctxL = await browser.newContext({ viewport: { width: 851, height: 393 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const l = await ctxL.newPage();
  l.on('pageerror', e => errors.push(String(e)));
  await l.route(/googleapis|gstatic|apis\.google|accounts\.google/, r => r.abort());
  await l.goto(APP); await l.waitForTimeout(300);
  await l.evaluate(SETUP);
  console.log('# horizontal');
  const gl = await l.evaluate(() => { const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width), left: Math.round(b.left) }; }; return { hdr: getComputedStyle(document.querySelector('header')).display, video: r('#video-wrapper'), vh: innerHeight, side: r('#sidebar'), scrollW: document.documentElement.scrollWidth, vw: innerWidth }; });
  check('cabecalho oculto', gl.hdr === 'none');
  check('video usa mais de 60% da altura', gl.video.h / gl.vh > 0.6, `${gl.video.h}/${gl.vh}`);
  check('sem rolagem horizontal', gl.scrollW <= gl.vw);
  await l.click('#ctrl-sidebar-btn');
  check('botao de lista oculta a playlist', await l.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display) === 'none');
  const wide = await l.evaluate(() => document.getElementById('video-wrapper').getBoundingClientRect().width);
  check('video ocupa a largura toda sem a lista', wide > 800, String(wide));
  await l.click('#ctrl-sidebar-btn');
  check('botao de lista mostra de novo', await l.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display) !== 'none');
  await l.evaluate(() => toggleMoreMenu());
  const vis = await l.evaluate(() => [...document.querySelectorAll('.menu-land-only')].every(b => b.offsetParent !== null));
  check('menu mostra Abrir pasta/Notas/Estatisticas/Configuracoes', vis);
  await ctxL.close();

  // ---------- desktop ----------
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const d = await ctxD.newPage();
  d.on('pageerror', e => errors.push(String(e)));
  await d.route(/googleapis|gstatic|apis\.google|accounts\.google/, r => r.abort());
  await d.goto(APP); await d.waitForTimeout(300);
  await d.evaluate(SETUP);
  console.log('# desktop (nao pode regredir)');
  const gd = await d.evaluate(() => ({ hdr: getComputedStyle(document.querySelector('header')).display, side: document.getElementById('sidebar').getBoundingClientRect().width, landOnly: [...document.querySelectorAll('.menu-land-only')].some(b => b.offsetParent !== null), sbBtn: getComputedStyle(document.getElementById('ctrl-sidebar-btn')).display, scrollW: document.documentElement.scrollWidth, vw: innerWidth }));
  check('cabecalho visivel', gd.hdr !== 'none');
  check('playlist lateral ~340px', gd.side >= 330 && gd.side <= 350, String(gd.side));
  check('itens exclusivos da horizontal ficam ocultos', gd.landOnly === false && gd.sbBtn === 'none');
  await d.screenshot({ path: out + '/f3-desktop.png' });
  await ctxD.close();

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(fails ? 1 : 0);
})();
