// Medicao de velocidade de abertura (rodar a mao: node bench-abertura.js [saida.json])
// Simula CPU 4x mais lenta e um curso de 850 aulas em 12 modulos, com a ponte nativa falsa.
// Mede: reabrir pelo cache (quickRestore ate o playLesson ter enviado a fila) e o tempo total.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { APP } = require('./helpers');

const MOCK = () => {
  window.__calls = []; window.__listeners = {};
  const rec = (name, ret) => function (args) { window.__calls.push({ name, t: performance.now() }); return Promise.resolve(ret === undefined ? {} : ret); };
  const player = {};
  ['loadVideo', 'setPlaylist', 'appendPlaylist', 'seekToItem', 'show', 'hide', 'updateRect', 'resume', 'pause', 'seekTo', 'setSpeed', 'setVolume', 'enterPiP', 'enterFullscreen', 'exitFullscreen', 'enableTransparency', 'setSleepTimer', 'requestNotificationPermission', 'requestBatteryExemption', 'setMetadata', 'stop'].forEach(n => player[n] = rec(n));
  player.getCurrentIndex = rec('getCurrentIndex', { index: 0, position: 0 });
  player.addListener = (ev, fn) => { window.__listeners[ev] = fn; return Promise.resolve({ remove() {} }); };
  const folder = { saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder') };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
};

function sessao(total, mods) {
  const por = Math.floor(total / mods);
  return {
    treeUri: 'content://bench', rootName: 'Curso Bench', isModular: true, courseKey: 'bench_key', savedAt: Date.now(),
    modulesCache: Array.from({ length: mods }, (_, m) => ({
      name: 'Modulo ' + String(m + 1).padStart(2, '0'),
      lessons: Array.from({ length: por }, (_, i) => ({ _uri: `https://localhost/_saf_/?uri=m${m}a${i}`, name: `Aula ${m + 1}.${String(i + 1).padStart(3, '0')}.mp4`, size: 1, _path: `Modulo ${m + 1}/a${i}.mp4` })),
      extras: [], subModules: []
    }))
  };
}

(async () => {
  const saida = process.argv[2] || path.join(__dirname, 'out', 'bench-base.json');
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  const p = await ctx.newPage();
  await p.route(/googleapis|gstatic|cdnjs|apis\.google|accounts\.google/, r => r.abort());
  await p.route(/_saf_/, r => r.fulfill({ status: 206, body: '' }));
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.goto(APP);
  await p.waitForTimeout(500);

  const sess = sessao(850, 12);
  const runs = [];
  const AQUECIMENTO = 3, MEDIDAS = 7;
  for (let i = 0; i < AQUECIMENTO + MEDIDAS; i++) {
    const r = await p.evaluate(async (s) => {
      localStorage.clear();
      window.__calls.length = 0;
      const t0 = performance.now();
      const ok = quickRestore(s);
      const sync = performance.now() - t0;
      await new Promise(res => setTimeout(res, 50));
      const sp = window.__calls.find(c => c.name === 'setPlaylist');
      return { ok, syncMs: sync, ateFilaMs: sp ? sp.t - t0 : null, aulas: lessons.length, itens: document.querySelectorAll('.lesson-item').length };
    }, sess);
    if (i >= AQUECIMENTO) runs.push(r);
  }
  const sorted = k => runs.map(r => r[k]).filter(v => v != null).sort((a, c) => a - c);
  const med = k => { const s = sorted(k); return s[Math.floor(s.length / 2)]; };
  const res = {
    cpu: '4x', aulas: runs[0].aulas, itensDesenhados: runs[0].itens,
    reabrirSegundos: +(med('syncMs') / 1000).toFixed(3),
    ateFilaNativaSegundos: med('ateFilaMs') != null ? +(med('ateFilaMs') / 1000).toFixed(3) : null,
    variacaoSegundos: +((sorted('syncMs').slice(-1)[0] - sorted('syncMs')[0]) / 1000).toFixed(3),
    execucoes: runs.map(r => +(r.syncMs / 1000).toFixed(3))
  };
  // 5 cursos guardados: trocar de curso (ler do banco + gravar o atual + reabrir) e abrir o Meus cursos
  const bib = await p.evaluate(async (s) => {
    localStorage.clear();
    await CourseLibrary._run(['courses', 'summaries'], 'readwrite', tx => { tx.objectStore('courses').clear(); return tx.objectStore('summaries').clear(); });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      resetCourseState();
      const cp = JSON.parse(JSON.stringify(s));
      modules = cp.modulesCache.map(m => ({ name: m.name, lessons: m.lessons.map(f => ({ ...f })), extras: [], subModules: [] }));
      isModular = true; rebuildLessonsFromModules(); _courseIdentity = { treeUri: 'content://c' + i, rootName: 'Curso ' + i }; freezeCourseKey(); _courseIdentity = null; buildSortedLessons();
      saveNativeSessionCache('content://c' + i, 'Curso ' + i);
      ids.push(_courseKey);
    }
    await new Promise(r => setTimeout(r, 1500));
    const trocas = [];
    for (let i = 0; i < 6; i++) {
      const alvo = ids[i % 4];
      const t0 = performance.now();
      await openCourseById(alvo);
      trocas.push(performance.now() - t0);
    }
    const t1 = performance.now();
    const lista = await CourseLibrary.listSummaries();
    return { trocas, listaMs: performance.now() - t1, n: lista.length };
  }, sess);
  const tr = bib.trocas.slice(2).sort((a, c) => a - c);
  res.trocarCursoSegundos = +(tr[Math.floor(tr.length / 2)] / 1000).toFixed(3);
  res.listarMeusCursosSegundos = +(bib.listaMs / 1000).toFixed(3);
  res.cursosGuardados = bib.n;
  console.log(JSON.stringify(res, null, 2));
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, JSON.stringify(res, null, 2));
  await b.close();
})();
