// Aulas de audio (mp3, m4a...): entram como aula, tocam e mostram o painel de audio
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
  const folder = { saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'), releaseFolder: rec('releaseFolder'), checkFolder: rec('checkFolder', { ok: true }), cancelScan: rec('cancelScan') };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
};
const nf = (rel, mime) => ({ name: rel.split('/').pop(), relativePath: rel, uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent('c://' + rel), mimeType: mime, size: 1 });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page); await page.route(/_saf_/, r => r.fulfill({ status: 206, body: '' }));
  await page.goto(APP); await page.waitForTimeout(500);

  console.log('# tipos de arquivo');
  const t = await page.evaluate(() => ({
    mp3: isMedia('Aula.mp3'), mp3up: isMedia('AULA.MP3'), m4a: isMedia('a.m4a'), flac: isMedia('a.flac'), ogg: isMedia('a.ogg'), mp4: isMedia('a.mp4'),
    txt: isMedia('a.txt'), pdf: isMedia('a.pdf'), mp3Content: isContent('a.mp3'), audio: isAudio('a.mp3'), videoNotAudio: !isAudio('a.mp4')
  }));
  check('mp3, m4a, flac, ogg e mp4 sao aulas (maiusculas tambem)', t.mp3 && t.mp3up && t.m4a && t.flac && t.ogg && t.mp4, JSON.stringify(t));
  check('txt e pdf nao sao aulas', !t.txt && !t.pdf);
  check('mp3 nao e mais "outro material"', !t.mp3Content);

  console.log('# abrir pasta com video + mp3 + m4a + pdf (APK)');
  const files = [
    nf('Mod 1/Aula 01.mp4', 'video/mp4'), nf('Mod 1/Aula 02.mp3', 'audio/mpeg'), nf('Mod 1/Material.pdf', 'application/pdf'),
    nf('Mod 2/Podcast 1.m4a', 'audio/mp4'), nf('Mod 2/Anotacoes.txt', 'text/plain'), nf('Mod 2/Aula 10.mp4', 'video/mp4'), nf('Mod 2/Aula 9.mp3', '')
  ];
  await page.evaluate(f => { localStorage.clear(); return processNativeFiles(f, 'Curso', false); }, files);
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    nomes: lessons.map(l => l.file.name), audio: lessons.map(l => lessonIsAudio(l)),
    extras: modules.flatMap(m => (m.extras || []).map(e => e.name)),
    thumbsAudio: document.querySelectorAll('.lesson-thumb.is-audio').length
  }));
  check('as 5 aulas (2 mp4, 2 mp3, 1 m4a) entram na lista', r.nomes.length === 5 && ['Aula 02.mp3', 'Podcast 1.m4a', 'Aula 9.mp3'].every(n => r.nomes.includes(n)), JSON.stringify(r.nomes));
  check('PDF continua como material e o mp3 NAO virou material', r.extras.includes('Material.pdf') && !r.extras.some(n => /mp3|m4a/.test(n)), JSON.stringify(r.extras));
  check('ordem natural dentro do modulo (Aula 9 antes de Aula 10)', r.nomes.indexOf('Aula 9.mp3') < r.nomes.indexOf('Aula 10.mp4'), JSON.stringify(r.nomes));
  check('itens de audio ganham icone de nota na lista', r.thumbsAudio === 3, String(r.thumbsAudio));
  check('no celular a lista continua alinhada (sem miniatura nos itens de audio)', await page.evaluate(() => [...document.querySelectorAll('.lesson-thumb.is-audio')].every(e => getComputedStyle(e).display === 'none')));

  console.log('# tocar aula de audio: painel de audio no lugar do video');
  const iAud = await page.evaluate(() => lessons.findIndex(l => lessonIsAudio(l)));
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(i => playLesson(i), iAud);
  await page.waitForTimeout(400);
  const a = await page.evaluate(() => {
    const art = document.getElementById('audio-art'), w = document.querySelector('.video-wrapper').getBoundingClientRect(), r = art.getBoundingClientRect();
    return { classe: document.body.classList.contains('audio-lesson'), disp: getComputedStyle(art).display, titulo: document.getElementById('audio-art-title').textContent, cobre: Math.abs(r.width - w.width) < 2 && Math.abs(r.height - w.height) < 2,
      pip: getComputedStyle(document.getElementById('pip-btn')).display, fs: getComputedStyle(document.getElementById('fs-btn')).display, fones: getComputedStyle(document.getElementById('audio-only-btn')).display, vazio: getComputedStyle(document.getElementById('empty-state')).display };
  });
  check('painel de audio aparece cobrindo a area do video, com o nome da aula', a.classe && a.disp === 'flex' && a.cobre && /Aula 02|Podcast|Aula 9/.test(a.titulo), JSON.stringify(a));
  check('PiP, tela cheia e fones escondidos (nao fazem sentido)', a.pip === 'none' && a.fs === 'none' && a.fones === 'none', JSON.stringify(a));
  const c = await page.evaluate(() => window.__calls.map(x => x.name));
  check('player de video nativo e escondido (sem tela preta por cima)', c.includes('hide') && c.lastIndexOf('hide') > (c.lastIndexOf('show') >= 0 ? c.lastIndexOf('show') : -1), JSON.stringify(c));
  check('a fila nativa e criada normalmente (o ExoPlayer toca mp3)', c.includes('setPlaylist') || c.includes('seekToItem'), JSON.stringify(c));

  console.log('# voltar para uma aula de video');
  const iVid = await page.evaluate(() => lessons.findIndex(l => !lessonIsAudio(l)));
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(i => playLesson(i), iVid);
  await page.waitForTimeout(500);
  const v = await page.evaluate(() => ({ classe: document.body.classList.contains('audio-lesson'), art: getComputedStyle(document.getElementById('audio-art')).display, pip: getComputedStyle(document.getElementById('pip-btn')).display }));
  check('painel some e os botoes voltam', !v.classe && v.art === 'none' && v.pip !== 'none', JSON.stringify(v));
  check('player de video e exibido de novo', (await page.evaluate(() => window.__calls.map(x => x.name))).includes('show'));

  console.log('# avanco automatico (trackChanged) para uma aula de audio');
  const q = await page.evaluate(() => _nativeQueue.map(f => f.name));
  const posAud = q.findIndex(n => /\.(mp3|m4a)$/.test(n));
  await page.evaluate(i => window.__listeners.trackChanged({ index: i, title: 'x', auto: true }), posAud);
  await page.waitForTimeout(300);
  check('painel de audio aparece quando a fila avanca sozinha', await page.evaluate(() => document.body.classList.contains('audio-lesson')), JSON.stringify(q));

  console.log('# cursos guardados com mp3 como anexo viram aulas');
  const m = await page.evaluate(() => {
    const f = (n, ex) => ({ _uri: 'u' + n, _native: true, name: n, size: 1, ...(ex ? {} : {}) });
    const sess = { treeUri: 't', rootName: 'x', isModular: true, courseKey: 'k_audio', savedAt: Date.now(),
      modulesCache: [{ name: 'M1', lessons: [f('Aula 1.mp4'), f('Aula 3.mp4')], extras: [{ name: 'Aula 2.mp3', file: f('Aula 2.mp3') }, { name: 'Guia.pdf', file: f('Guia.pdf') }], subModules: [] }] };
    const ok = quickRestore(sess);
    return { ok, nomes: lessons.map(l => l.file.name), extras: modules[0].extras.map(e => e.name), salvou: JSON.parse(localStorage.getItem('splay_native_session')).modulesCache[0].lessons.length };
  });
  check('mp3 do cache vira aula, na ordem (1, 2, 3), e o pdf fica como material', m.ok && JSON.stringify(m.nomes) === JSON.stringify(['Aula 1.mp4', 'Aula 2.mp3', 'Aula 3.mp4']) && JSON.stringify(m.extras) === '["Guia.pdf"]', JSON.stringify(m));
  check('o cache e regravado ja com o mp3 como aula', m.salvou === 3, String(m.salvou));

  console.log('# lista plana (so audios e videos soltos)');
  const fl = await page.evaluate(() => { const names = ['Faixa 2.mp3', 'Faixa 1.mp3', 'Video.mp4']; const fs = names.map(n => { const x = new File(['x'], n, { type: n.endsWith('mp3') ? 'audio/mpeg' : 'video/mp4' }); x._path = n; return x; }); loadFiles(fs, false, []); return lessons.map(l => l.name); });
  check('3 aulas, audios inclusos', fl.length === 3 && fl.includes('Faixa 1') && fl.includes('Faixa 2'), JSON.stringify(fl));

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
