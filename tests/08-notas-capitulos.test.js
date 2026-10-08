// Notas, capítulos, revisão e histórico ligados à aula pela CHAVE (nomes repetidos entre módulos)
const { chromium } = require('playwright');
const { APP, makeChecker, blockExternal } = require('./helpers');
const { check, finish } = makeChecker();

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page);
  await page.goto(APP); await page.waitForTimeout(300);

  await page.evaluate(() => {
    localStorage.clear();
    const mk = (n, p) => ({ name: n, _uri: 'u' + p, _native: true, size: 1, _path: p });
    modules = [
      { name: 'Modulo A', lessons: [mk('Aula 1.mp4', 'A/Aula 1.mp4'), mk('Aula 2.mp4', 'A/Aula 2.mp4')], extras: [], subModules: [] },
      { name: 'Modulo B', lessons: [mk('Aula 1.mp4', 'B/Aula 1.mp4')], extras: [], subModules: [] },
    ];
    _courseKey = null; isModular = true; done = new Set(); lessons = [];
    rebuildLessonsFromModules(); freezeCourseKey(); buildSortedLessons();
    // "video" falso: duracao e posicao controladas pelo teste
    Object.defineProperty(video, 'src', { get: () => 'x', set: () => {}, configurable: true });
    Object.defineProperty(video, 'duration', { get: () => 100, configurable: true });
    let t = 0; Object.defineProperty(video, 'currentTime', { get: () => t, set: v => { t = v; }, configurable: true });
    window.prompt = () => 'Cap';
    window.__md = null; window.saveTextFile = async (f, m, text) => { window.__md = text; return true; };
    notes = []; chapters = [];
  });

  console.log('# criar nota e capitulo em cada "Aula 1"');
  const a = await page.evaluate(() => {
    const ta = document.getElementById('note-textarea');
    currentIdx = 0; video.currentTime = 10; noteTimestamp = 10; ta.value = 'nota do A'; addNote(false); addChapterAtCurrent();
    currentIdx = 2; video.currentTime = 20; noteTimestamp = 20; ta.value = 'nota do B'; addNote(false); addChapterAtCurrent();
    return { notes: notes.map(n => [n.lessonKey, n.module]), chapters: chapters.map(c => [c.lessonKey, c.module]) };
  });
  check('notas guardam a chave com o caminho', a.notes[0][0].includes('A/Aula 1') && a.notes[1][0].includes('B/Aula 1'), JSON.stringify(a.notes));
  check('notas guardam o modulo', a.notes[0][1] === 'Modulo A' && a.notes[1][1] === 'Modulo B');
  check('capitulos guardam a chave', a.chapters[0][0].includes('A/Aula 1') && a.chapters[1][0].includes('B/Aula 1'));

  console.log('# cada aula mostra so as suas marcacoes');
  const m = await page.evaluate(() => {
    const out = {};
    currentIdx = 0; renderChapterMarkers(); out.markersA = document.querySelectorAll('.chapter-marker').length;
    currentIdx = 2; renderChapterMarkers(); out.markersB = document.querySelectorAll('.chapter-marker').length;
    currentIdx = 1; renderChapterMarkers(); out.markersOther = document.querySelectorAll('.chapter-marker').length;
    out.nextName = (() => { currentIdx = 0; return `Capítulo ${chapters.filter(itemBelongsToCurrent).length + 1}`; })();
    return out;
  });
  check('Aula 1 do Modulo A: 1 capitulo (nao 2)', m.markersA === 1, String(m.markersA));
  check('Aula 1 do Modulo B: 1 capitulo', m.markersB === 1, String(m.markersB));
  check('outra aula: nenhum', m.markersOther === 0);
  check('numeracao do proximo capitulo conta so a aula atual', m.nextName === 'Capítulo 2', m.nextName);

  console.log('# pular para a nota');
  const j = await page.evaluate(() => {
    playLesson = async i => { currentIdx = i; };     // so registra o destino
    const nB = notes.find(n => n.text === 'nota do B'); jumpToNote(nB.id);
    const idxB = currentIdx;
    currentIdx = 1; const nA = notes.find(n => n.text === 'nota do A'); jumpToNote(nA.id);
    return { idxB, idxA: currentIdx };
  });
  check('nota do Modulo B leva a aula 2 (Modulo B), nao a aula 0', j.idxB === 2, String(j.idxB));
  check('nota do Modulo A leva a aula 0', j.idxA === 0, String(j.idxA));

  console.log('# etiqueta mostra o modulo so quando o nome se repete');
  const t = await page.evaluate(() => ({
    dup: lessonTagText(notes[1]),
    unique: lessonTagText({ lessonName: 'Aula 2', module: 'Modulo A' }),
  }));
  check('nome repetido: "Aula 1 · Modulo B"', t.dup === 'Aula 1 · Modulo B', t.dup);
  check('nome unico: so o nome', t.unique === 'Aula 2', t.unique);

  console.log('# exportar notas');
  const md = await page.evaluate(() => { exportNotes(); return window.__md; });
  await page.waitForTimeout(100);
  const md2 = await page.evaluate(() => window.__md);
  check('duas secoes separadas para as duas "Aula 1"', /## Aula 1 · Modulo A/.test(md2) && /## Aula 1 · Modulo B/.test(md2), md2);
  check('cada nota na secao certa', md2.indexOf('nota do A') < md2.indexOf('## Aula 1 · Modulo B') && md2.indexOf('nota do B') > md2.indexOf('## Aula 1 · Modulo B'));

  console.log('# modo revisao');
  const r = await page.evaluate(() => { buildReviewItems(); return reviewItems.map(i => i.lessonIdx + ':' + i.type); });
  check('itens ordenados pela aula certa (0,0,2,2)', JSON.stringify(r.map(x => x.split(':')[0])) === '["0","0","2","2"]', JSON.stringify(r));

  console.log('# historico de estudo');
  const h = await page.evaluate(() => {
    studyHistory = []; historySessionLesson = 2; historySessionStart = Date.now(); historySessionSec = 30; closeHistorySession();
    const e = studyHistory[0]; let went = -1; playLesson = async i => { went = i; };
    jumpToHistoryEntry(e.id);
    return { key: e.lessonKey, went };
  });
  check('historico guarda a chave', /B\/Aula 1/.test(h.key), h.key);
  check('clicar no historico abre a aula do Modulo B', h.went === 2, String(h.went));

  console.log('# dados antigos (so o nome) continuam funcionando');
  const l = await page.evaluate(() => {
    const legacyNote = { id: 'old', lessonName: 'Aula 2', ts: 5, tsLabel: '0:05', text: 'antiga', createdAt: 1 };       // sem chave
    const plainKey = { id: 'old2', lessonName: 'Aula 1', lessonKey: 'Aula 1', ts: 5, tsLabel: '0:05', text: 'chave antiga', createdAt: 1 }; // nome era unico antes
    return { a: lessonIdxOfItem(legacyNote), b: lessonIdxOfItem(plainKey) };
  });
  check('nota antiga sem chave acha a aula pelo nome', l.a === 1, String(l.a));
  check('chave que mudou (nome passou a repetir) cai no 1o nome igual', l.b === 0, String(l.b));

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
