// Abre cada tela do cabecalho e confere que aparece conteudo e que nao ha erro de JS.
// (Um erro de digitacao em renderStatsModal fez o botao Estatisticas nao abrir nada e nenhum teste percebeu.)
const { chromium } = require('playwright');
const { APP, makeChecker, blockExternal } = require('./helpers');
const { check, finish } = makeChecker();

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [nome, vp] of [['celular vertical', { width: 393, height: 780 }], ['desktop', { width: 1200, height: 800 }]]) {
    console.log('# ' + nome);
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 600, hasTouch: vp.width < 600 });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await blockExternal(page);
    await page.goto(APP); await page.waitForTimeout(400);
    // curso pequeno com um pouco de historico de estudo
    await page.evaluate(() => {
      localStorage.clear();
      const mk = (n) => ({ name: n, _uri: 'https://localhost/_saf_/?uri=' + n, _native: false, size: 1, _path: 'M/' + n });
      modules = [{ name: 'M', lessons: ['A 1.mp4', 'A 2.mp4', 'A 3.mp4'].map(mk), extras: [], subModules: [] }];
      isModular = true; lessons = []; rebuildLessonsFromModules(); freezeCourseKey(); buildSortedLessons(); renderModularPlaylist();
      done = new Set([0]); updateDoneCount();
      const k = localDate(); studyStats.totalWatchedSec = 5400; studyStats.dailySec = { [k]: 1800 };
    });
    // Estatisticas pelo botao do cabecalho
    await page.click('button[title^="Estat"]');
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({
      ativo: document.getElementById('stats-modal').classList.contains('active'),
      cards: document.querySelectorAll('#stats-pane-stats .stat-card').length,
      barras: document.querySelectorAll('#stats-pane-stats [style*="border-radius:3px 3px 0 0"]').length,
      texto: document.getElementById('stats-content').innerText
    }));
    check('Estatisticas abre', st.ativo);
    check('4 cartoes (total, hoje, progresso, sequencia)', st.cards === 4, String(st.cards));
    check('grafico dos ultimos 7 dias com 7 barras', st.barras === 7, String(st.barras));
    check('mostra o progresso (1 de 3 aulas) e o tempo de hoje', /1 de 3/.test(st.texto) && /30:00|0:30:00|30:0/.test(st.texto), st.texto.replace(/\s+/g, ' ').slice(0, 160));
    await page.evaluate(() => switchStatsTab('history'));
    check('aba Historico abre', await page.evaluate(() => document.getElementById('stats-pane-history').classList.contains('active-pane')));
    await page.evaluate(() => document.getElementById('stats-modal').classList.remove('active'));
    // as outras telas do cabecalho
    for (const [rotulo, fn, id] of [['Configuracoes', 'openSettings', 'settings-modal'], ['Progresso', 'openProgressModal', 'progress-modal'], ['Atalhos/Tema', 'openThemeModal', 'theme-modal']]) {
      const existe = await page.evaluate(f => typeof window[f] === 'function', fn);
      if (!existe) continue;
      await page.evaluate(f => window[f](), fn); await page.waitForTimeout(150);
      check(rotulo + ' abre', await page.evaluate(i => document.getElementById(i).classList.contains('active'), id));
      await page.evaluate(i => document.getElementById(i).classList.remove('active'), id);
    }
    check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  await finish(browser)();
})();
