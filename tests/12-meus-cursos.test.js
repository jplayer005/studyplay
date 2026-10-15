// Tela Meus cursos: selo no cabecalho, painel, trocar, remover e botao Voltar
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
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: (ev, fn) => { if (ev === 'backButton') window.__back = fn; return Promise.resolve({ remove() {} }); }, minimizeApp: rec('minimizeApp') } } };
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  await ctx.addInitScript(() => {
    window.makeCourse = (nome, uri, prefixo, n) => {
      resetCourseState();
      const mk = (nm, p) => ({ name: nm, _uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(p), _native: true, size: 1, _path: p });
      modules = [{ name: 'Modulo ' + prefixo, lessons: Array.from({ length: n }, (_, i) => mk(`${prefixo} ${i + 1}.mp4`, `${nome}/${prefixo} ${i + 1}.mp4`)), extras: [], subModules: [] }];
      isModular = true; rebuildLessonsFromModules(); _courseIdentity = { treeUri: uri, rootName: nome }; freezeCourseKey(); _courseIdentity = null; buildSortedLessons();
      saveNativeSessionCache(uri, nome);
      return _courseKey;
    };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page);
  await page.goto(APP); await page.waitForTimeout(500);

  const ks = await page.evaluate(async () => {
    localStorage.clear();
    await CourseLibrary._run(['courses', 'summaries'], 'readwrite', tx => { tx.objectStore('courses').clear(); return tx.objectStore('summaries').clear(); });
    CourseLibrary.uriToId = new Map(); CourseLibrary.ids = new Set();
    const a = makeCourse('Curso de Eletrica Industrial Avancada Parte Um', 'content://A', 'Eletrica', 8);
    await new Promise(r => setTimeout(r, 300));
    done = new Set([0, 1, 2, 3]); currentIdx = 4; saveToStorage();
    await persistCurrentCourse(); await new Promise(r => setTimeout(r, 300));
    const b = makeCourse('Curso B', 'content://B', 'Logica', 5);
    await new Promise(r => setTimeout(r, 300));
    done = new Set([0]); currentIdx = 1; saveToStorage();
    await persistCurrentCourse(); await new Promise(r => setTimeout(r, 300));
    const sa = await CourseLibrary.getSummary(a), sb = await CourseLibrary.getSummary(b);
    sa.lastOpenedAt = Date.now() - 86400000; await CourseLibrary.putSummary(sa);       // A foi usado ontem
    sb.lastOpenedAt = Date.now(); await CourseLibrary.putSummary(sb);
    return { a, b };
  });

  console.log('# selo do cabecalho');
  const chip = await page.evaluate(() => { const n = document.getElementById('cc-name'); const b = document.getElementById('progress-badge'); const r = b.getBoundingClientRect(); return { nome: n.textContent, visivel: !n.hidden, botao: b.classList.contains('is-button'), cabe: r.right <= innerWidth && r.width > 0 }; });
  check('selo mostra o nome do curso aberto e e botao', chip.nome === 'Curso B' && chip.visivel && chip.botao, JSON.stringify(chip));
  check('selo cabe na tela do celular', chip.cabe);

  console.log('# painel Meus cursos');
  const t0 = Date.now();
  await page.evaluate(() => document.getElementById('progress-badge').click());
  await page.waitForFunction(() => document.querySelectorAll('#courses-list .course-item').length === 2, null, { timeout: 2000 });
  const dt = Date.now() - t0;
  check('lista aparece em menos de 0,3 s (navegador sem celular)', dt < 300, dt + ' ms');
  const itens = await page.evaluate(() => [...document.querySelectorAll('#courses-list .course-item')].map(i => ({ nome: i.querySelector('.course-name').textContent, sub: i.querySelector('.course-sub').textContent, meta: i.querySelector('.course-meta').textContent, atual: i.classList.contains('current'), larg: i.querySelector('.course-bar-fill').style.width })));
  check('ordem: o mais recente primeiro (B, depois A)', /^Curso B/.test(itens[0].nome) && /^Curso de Eletrica/.test(itens[1].nome), JSON.stringify(itens.map(i => i.nome)));
  check('curso aberto marcado como Estudando', itens[0].atual && /Estudando/.test(itens[0].nome) && !itens[1].atual);
  check('mostra modulo e aula atual', /Modulo Logica · Logica 2/.test(itens[0].sub) && /Modulo Eletrica · Eletrica 5/.test(itens[1].sub), JSON.stringify(itens.map(i => i.sub)));
  check('progresso feitas/total e %', /1\/5 · 20%/.test(itens[0].meta) && /4\/8 · 50%/.test(itens[1].meta) && itens[1].larg === '50%', JSON.stringify(itens.map(i => i.meta)));
  check('ultimo acesso: Hoje e Ontem', /Hoje/.test(itens[0].meta) && /Ontem/.test(itens[1].meta));
  const caixa = await page.evaluate(() => { const b = document.querySelector('.courses-box').getBoundingClientRect(); return { baixo: Math.abs(b.bottom - innerHeight) < 2, cabe: b.left >= 0 && b.right <= innerWidth, alto: b.height <= innerHeight }; });
  check('no celular sobe da base e cabe na tela', caixa.baixo && caixa.cabe && caixa.alto, JSON.stringify(caixa));
  const nomeLongo = await page.evaluate(() => { const el = document.querySelectorAll('#courses-list .course-name')[1]; return el.clientHeight <= parseFloat(getComputedStyle(el).fontSize) * 1.6 * 2 + 2; });
  check('nome longo limitado a 2 linhas', nomeLongo);

  console.log('# trocar tocando no curso');
  await page.evaluate(() => document.querySelectorAll('#courses-list .course-main')[1].click());
  await page.waitForTimeout(500);
  const tr = await page.evaluate(k => ({ key: _courseKey === k, painel: document.getElementById('courses-modal').classList.contains('active'), chip: document.getElementById('cc-name').textContent, cur: currentIdx }), ks.a);
  check('trocou para A, fechou o painel e atualizou o selo', tr.key && !tr.painel && /^Curso de Eletrica/.test(tr.chip) && tr.cur === 4, JSON.stringify(tr));

  console.log('# botao Voltar do Android fecha o painel');
  await page.evaluate(() => openMyCourses()); await page.waitForTimeout(200);
  await page.evaluate(() => window.__back());
  check('voltar fecha Meus cursos', !(await page.evaluate(() => document.getElementById('courses-modal').classList.contains('active'))));

  console.log('# remover da lista com confirmacao');
  await page.evaluate(() => openMyCourses()); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelectorAll('#courses-list .course-more')[1].click());     // B (nao e o aberto)
  let conf = await page.evaluate(() => ({ titulo: document.getElementById('modal-title').textContent, desc: document.getElementById('modal-desc').textContent, btns: [...document.querySelectorAll('#modal-actions .modal-btn')].map(b => b.textContent), painel: document.getElementById('courses-modal').classList.contains('active') }));
  check('pede confirmacao e explica que o progresso fica guardado', /Remover/.test(conf.titulo) && /progresso, as notas e os cap/.test(conf.desc) && conf.btns.includes('Cancelar') && !conf.painel, JSON.stringify(conf));
  await page.evaluate(() => [...document.querySelectorAll('#modal-actions .modal-btn')].find(b => b.textContent === 'Cancelar').click());
  await page.waitForTimeout(300);
  check('cancelar volta para a lista, com os 2 cursos', await page.evaluate(() => document.getElementById('courses-modal').classList.contains('active') && document.querySelectorAll('#courses-list .course-item').length === 2));
  await page.evaluate(() => document.querySelectorAll('#courses-list .course-more')[1].click());
  await page.evaluate(() => [...document.querySelectorAll('#modal-actions .modal-btn')].find(b => b.textContent === 'Remover da lista').click());
  await page.waitForTimeout(600);
  const rem = await page.evaluate(() => ({ n: document.querySelectorAll('#courses-list .course-item').length, painel: document.getElementById('courses-modal').classList.contains('active') }));
  check('B removido, lista com 1 curso e painel reaberto', rem.n === 1 && rem.painel, JSON.stringify(rem));
  check('progresso de B continua no aparelho', await page.evaluate(k => !!localStorage.getItem(k), ks.b));
  await page.evaluate(() => closeMyCourses());

  console.log('# lista vazia');
  await page.evaluate(async () => { for (const s of await CourseLibrary.listSummaries()) await removeCourse(s.id); openMyCourses(); });
  await page.waitForTimeout(300);
  check('mensagem de lista vazia', await page.evaluate(() => /Nenhum curso/.test(document.getElementById('courses-list').textContent)));
  check('selo sem nome quando nao ha curso', await page.evaluate(() => document.getElementById('cc-name').hidden));
  await page.evaluate(() => closeMyCourses());

  console.log('# nada vaza da tela em celulares estreitos');
  for (const w of [320, 360, 393]) {
    await page.setViewportSize({ width: w, height: 740 }); await page.waitForTimeout(250);
    const v = await page.evaluate(() => {
      const itens = [...document.querySelectorAll('header > *')].filter(e => getComputedStyle(e).display !== 'none');
      const maxRight = Math.max(...itens.map(e => e.getBoundingClientRect().right));
      return { maxRight: Math.round(maxRight), iw: innerWidth, sw: document.documentElement.scrollWidth, folder: document.getElementById('btn-load') ? Math.round(document.getElementById('btn-load').getBoundingClientRect().right) : null };
    });
    check(`${w}px: cabecalho inteiro dentro da tela (botao de pasta visivel)`, v.maxRight <= v.iw && v.sw <= v.iw && (v.folder === null || v.folder <= v.iw), JSON.stringify(v));
  }
  await page.evaluate(async k => { await openCourseById(k); }, ks.a).catch(() => {});
  const cs = await page.evaluate(() => { const b = document.getElementById('course-switch'); const r = b.getBoundingClientRect(); return { visivel: getComputedStyle(b).display !== 'none', cabe: r.left >= 0 && r.right <= innerWidth, nome: document.getElementById('course-switch-name').textContent }; });
  check('botao Meus cursos / Trocar visivel na lista de aulas', cs.visivel && cs.cabe, JSON.stringify(cs));
  await page.evaluate(() => { makeCourse('Curso Novo Longo Para Testar', 'content://Z', 'Aula', 6); updateCourseChip(); openFolder(); });
  const dg = await page.evaluate(() => [...document.querySelectorAll('#modal-actions .modal-btn')].map(b => { const r = b.getBoundingClientRect(), c = document.querySelector('#modal-overlay .modal-box, #modal-overlay > div').getBoundingClientRect(); return { ok: b.scrollHeight <= b.clientHeight + 1 && r.left >= c.left - 1 && r.right <= c.right + 1 }; }));
  check('botoes do dialogo Abrir pasta cabem (texto nao estoura)', dg.length === 3 && dg.every(x => x.ok), JSON.stringify(dg));
  await page.evaluate(() => closeModal());
  await page.setViewportSize({ width: 393, height: 780 });

  console.log('# nome longo desliza no botao Trocar');
  await page.evaluate(() => { makeCourse('Curso Completo de Eletrica Industrial Avancada Parte Um e Dois', 'content://L', 'Aula', 6); updateCourseChip(); });
  await page.waitForTimeout(400);
  const mq = await page.evaluate(() => { const b = document.getElementById('course-switch-name'); return { liga: b.classList.contains('marquee'), dist: parseFloat(b.style.getPropertyValue('--cs-dist')), anim: getComputedStyle(document.getElementById('course-switch-name-in')).animationName }; });
  check('nome maior que o botao: liga o deslizamento ate o fim do nome', mq.liga && mq.dist < -20 && mq.anim === 'cs-scroll', JSON.stringify(mq));
  await page.evaluate(() => { makeCourse('Curso B', 'content://B2', 'Aula', 6); updateCourseChip(); });
  await page.waitForTimeout(300);
  check('nome curto: parado', await page.evaluate(() => !document.getElementById('course-switch-name').classList.contains('marquee')));

  console.log('# celular na horizontal: item no menu ⋮');
  await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(300);
  const land = await page.evaluate(() => { const b = document.getElementById('menu-courses-btn'); return { exibe: getComputedStyle(b).display !== 'none', cabecalho: getComputedStyle(document.querySelector('header')).display }; });
  check('item Meus cursos existe no menu na horizontal', land.exibe, JSON.stringify(land));
  await page.evaluate(() => openMyCourses()); await page.waitForTimeout(300);
  const caixaH = await page.evaluate(() => { const b = document.querySelector('.courses-box').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight + 1 && b.right <= innerWidth; });
  check('painel cabe na horizontal', caixaH);
  await page.evaluate(() => closeMyCourses());
  await page.setViewportSize({ width: 393, height: 780 });
  const vert = await page.evaluate(() => getComputedStyle(document.getElementById('menu-courses-btn')).display);
  check('na vertical o item do menu fica oculto (ha o selo)', vert === 'none', vert);

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
