const { chromium } = require('playwright');
const { APP } = require('./helpers');
let fails = 0;
const check = (n, c, x) => { if (c) console.log('  OK  ' + n); else { fails++; console.log('FALHA ' + n + (x ? ' -> ' + x : '')); } };

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await ctx.newPage();
  const errors = [], reqs = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => reqs.push(r.url()));
  await page.route(/googleapis|cdnjs|gstatic|apis\.google|accounts\.google/, r => { reqs.push('BLOQUEADO ' + r.request().url()); r.abort(); });
  await page.goto(APP);
  await page.waitForTimeout(400);

  console.log('# recursos externos');
  check('nenhuma requisicao a Google Fonts/cdnjs no carregamento', !reqs.some(u => /fonts\.googleapis|cdnjs/.test(u)), reqs.filter(u => /google|cdnjs/.test(u)).join(','));
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + f.weight); });
  check('fontes Sora e JetBrains Mono locais carregadas', fonts.some(f => /Sora/.test(f)) && fonts.some(f => /JetBrains/.test(f)), JSON.stringify(fonts));
  check('biblioteca XLSX nao carregada no inicio', await page.evaluate(() => typeof window.XLSX === 'undefined'));
  await page.evaluate(() => loadXlsxLib());
  check('XLSX carrega sob demanda', await page.evaluate(() => typeof window.XLSX !== 'undefined' && typeof XLSX.read === 'function'));

  console.log('# leitura preguicosa de duracao (300 aulas)');
  const r = await page.evaluate(async () => {
    localStorage.clear();
    const mk = (n, p) => ({ name: n, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
    const lessonsA = Array.from({ length: 300 }, (_, i) => mk('Aula ' + String(i + 1).padStart(3, '0') + '.mp4', 'A/' + i));
    modules = [{ name: 'Curso', lessons: lessonsA, extras: [], subModules: [] }];
    _courseKey = null; isModular = true; document.body.classList.add('is-modular');
    done = new Set(); lessons = []; rebuildLessonsFromModules(); freezeCourseKey(); buildSortedLessons();
    collapsedModules['Curso'] = false;
    const before = document.querySelectorAll('video').length;
    renderModularPlaylist();
    await new Promise(r => setTimeout(r, 600));
    const total = document.querySelectorAll('.lesson-item').length;
    const videosAfter = document.querySelectorAll('video').length;   // inclui o #main-video
    return { before, total, videosAfter, active: _metaActive, queue: _metaQueue.length };
  });
  check('300 itens renderizados', r.total === 300, String(r.total));
  check('poucos <video> criados (antes seriam 300)', r.videosAfter <= 70, `videos=${r.videosAfter}`);
  check('no maximo 4 leituras simultaneas', r.active <= 4, String(r.active));

  console.log('# busca com atraso');
  const s = await page.evaluate(async () => {
    let calls = 0; const orig = window.filterLessons; window.filterLessons = function () { calls++; return orig.apply(this, arguments); };
    const inp = document.getElementById('search-input');
    ['A', 'Au', 'Aul', 'Aula 01'].forEach(v => { inp.value = v; inp.dispatchEvent(new Event('input')); });
    await new Promise(r => setTimeout(r, 400));
    window.filterLessons = orig;
    return { calls, shown: document.querySelectorAll('.lesson-item').length };
  });
  check('4 digitacoes rapidas = 1 busca so', s.calls === 1, String(s.calls));
  check('resultado da busca correto (Aula 01x)', s.shown >= 1 && s.shown <= 11, String(s.shown));

  console.log('# erros');
  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(fails ? 1 : 0);
})();
