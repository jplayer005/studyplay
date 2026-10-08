// Simula o APK: window.Capacitor falso que registra as chamadas nativas
const { chromium } = require('playwright');
const { APP } = require('./helpers');
let fails = 0;
const check = (n, c, x) => { if (c) console.log('  OK  ' + n); else { fails++; console.log('FALHA ' + n + (x ? ' -> ' + x : '')); } };

const MOCK = () => {
  window.__calls = []; window.__listeners = {}; window.__appListeners = {};
  const rec = (plugin, name, ret) => function (args) { window.__calls.push({ plugin, name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); return typeof ret === 'function' ? ret(args) : Promise.resolve(ret === undefined ? {} : ret); };
  const player = {};
  ['loadVideo', 'setPlaylist', 'seekToItem', 'show', 'hide', 'updateRect', 'resume', 'pause', 'seekTo', 'setSpeed', 'setVolume', 'enterPiP', 'enterFullscreen', 'exitFullscreen', 'enableTransparency', 'setSleepTimer', 'requestNotificationPermission', 'requestBatteryExemption', 'setMetadata', 'stop'].forEach(n => player[n] = rec('VideoPlayer', n));
  player.getCurrentIndex = rec('VideoPlayer', 'getCurrentIndex', { index: 0, position: 0 });
  player.addListener = (ev, fn) => { window.__listeners[ev] = fn; return Promise.resolve({ remove() { } }); };
  window.__saveReject = false; window.__openUrlReject = false;
  const folder = {
    saveTextFile: rec('VideoFolder', 'saveTextFile', a => window.__saveReject ? Promise.reject(new Error('cancelled')) : Promise.resolve({ uri: 'content://x' })),
    openUrl: rec('VideoFolder', 'openUrl', a => (window.__openUrlReject && a.url.startsWith('market')) ? Promise.reject(new Error('no_handler')) : Promise.resolve({})),
    pickFolder: rec('VideoFolder', 'pickFolder', {}),
    listPersistedFolder: rec('VideoFolder', 'listPersistedFolder', {}),
  };
  const app = { addListener: (ev, fn) => { window.__appListeners[ev] = fn; return Promise.resolve({ remove() { } }); }, minimizeApp: rec('App', 'minimizeApp') };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: app } };
};

const files = (rel) => rel.map(r => ({ name: r.split('/').pop(), relativePath: r, uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent(r), mimeType: r.endsWith('.pdf') ? 'application/pdf' : 'video/mp4', size: 10 }));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route(/googleapis|gstatic|apis\.google|accounts\.google/, r => r.abort());
  await page.goto(APP); await page.waitForTimeout(400);

  const calls = () => page.evaluate(() => window.__calls);
  const clear = () => page.evaluate(() => { window.__calls = []; });

  console.log('# abrir curso (APK)');
  await page.evaluate(files => processNativeFiles(files, 'Curso X', false), files(['Mod A/Aula 1.mp4', 'Mod A/Aula 2.mp4', 'Mod A/Material.pdf', 'Mod B/Aula 1.mp4', 'Mod B/Aula 2.mp4']));
  await page.waitForTimeout(300);
  let c = await calls();
  const pl = c.find(x => x.name === 'setPlaylist');
  check('playlist nativa criada com 4 aulas', pl && pl.args.items.length === 4, JSON.stringify(pl && pl.args.items.map(i => i.title)));
  check('notificacao mostra o NOME DO MODULO (artist)', pl && pl.args.items[0].artist === 'Mod A' && pl.args.items[2].artist === 'Mod B', JSON.stringify(pl && pl.args.items.map(i => i.artist)));
  check('permissao de notificacao pedida na 1a reproducao', c.filter(x => x.name === 'requestNotificationPermission').length === 1);
  await page.evaluate(() => { _nativePlaylistMode = true; playLesson(1); });
  c = await calls();
  check('permissao de notificacao NAO e pedida de novo', c.filter(x => x.name === 'requestNotificationPermission').length === 1);

  console.log('# avanco automatico em segundo plano');
  const t1 = await page.evaluate(() => {
    currentIdx = 0; _nativeQueue = lessons.map(l => l.file); done = new Set();
    window.__listeners.trackChanged({ index: 1, title: 'x', auto: true });
    const afterAuto = [...done];
    window.__listeners.trackChanged({ index: 2, title: 'y', auto: false });   // "proxima" manual
    return { afterAuto, afterManual: [...done], cur: currentIdx };
  });
  check('auto: aula anterior concluida', JSON.stringify(t1.afterAuto) === '[0]', JSON.stringify(t1));
  check('manual (proxima): NAO marca a anterior', JSON.stringify(t1.afterManual) === '[0]');
  check('indice atual acompanha o player', t1.cur === 2);

  console.log('# timer de sono nativo');
  await clear();
  await page.evaluate(() => setSleepTimer(15));
  c = await calls();
  const st = c.find(x => x.name === 'setSleepTimer');
  check('timer enviado ao servico nativo (15 min)', st && st.args.minutes === 15, JSON.stringify(c.map(x => x.name)));
  await page.evaluate(() => window.__listeners.sleepTimerFired({}));
  check('ao disparar mostra o aviso', await page.evaluate(() => document.getElementById('modal-overlay').classList.contains('active') && /pausada/.test(document.getElementById('modal-desc').textContent)));
  await page.evaluate(() => closeModal());
  await clear(); await page.evaluate(() => { setSleepTimer(30); clearSleepTimer(); });
  c = await calls();
  check('cancelar envia minutes=0', c.filter(x => x.name === 'setSleepTimer').map(x => x.args.minutes).join(',') === '30,0', JSON.stringify(c));

  console.log('# exportar notas / progresso');
  await clear();
  await page.evaluate(() => { notes = [{ id: 'n1', lessonName: 'Aula 1', ts: 5, tsLabel: '0:05', text: 'teste', createdAt: 1 }]; exportNotes(); });
  await page.waitForTimeout(150);
  c = await calls();
  const sv = c.find(x => x.name === 'saveTextFile');
  check('notas vao para o seletor nativo (.md)', sv && /^notas_videoaulas_\d{4}-\d{2}-\d{2}\.md$/.test(sv.args.filename) && sv.args.content.includes('teste'), JSON.stringify(sv && sv.args.filename));
  check('toast de sucesso', await page.evaluate(() => /exportadas/.test(document.getElementById('toast').textContent)));
  await page.evaluate(() => { window.__saveReject = true; document.getElementById('toast').textContent = ''; exportNotes(); });
  await page.waitForTimeout(150);
  check('cancelar o seletor NAO mostra sucesso', await page.evaluate(() => !/exportadas/.test(document.getElementById('toast').textContent)));
  await page.evaluate(() => { window.__saveReject = false; exportProgress(); });
  await page.waitForTimeout(150);
  c = await calls();
  check('progresso exportado como .json', c.some(x => x.name === 'saveTextFile' && /\.json$/.test(x.args.filename) && x.args.mime === 'application/json'));

  console.log('# links externos');
  await clear();
  await page.evaluate(() => rateApp({ preventDefault() { } }));
  await page.waitForTimeout(100);
  c = await calls();
  check('Avaliar abre market://', c.some(x => x.name === 'openUrl' && x.args.url === 'market://details?id=com.jcorelabs.studyplay'));
  await clear();
  await page.evaluate(() => { window.__openUrlReject = true; return rateApp({ preventDefault() { } }); });
  await page.waitForTimeout(150);
  c = await calls();
  check('sem Play Store: cai no link https', c.some(x => x.name === 'openUrl' && x.args.url.startsWith('https://play.google.com')));

  console.log('# botao Voltar');
  for (const id of ['stats-modal', 'progress-modal', 'theme-modal', 'shortcuts-modal']) {
    const closed = await page.evaluate(id => { document.getElementById(id).classList.add('active'); window.__appListeners.backButton({}); return !document.getElementById(id).classList.contains('active'); }, id);
    check('Voltar fecha ' + id, closed);
  }
  const dbl = await page.evaluate(() => { window.__calls = []; window.__appListeners.backButton({}); const first = window.__calls.length; window.__appListeners.backButton({}); return { first, after: window.__calls.filter(x => x.name === 'minimizeApp').length }; });
  check('sem nada aberto: 1o toque avisa, 2o minimiza', dbl.first === 0 && dbl.after === 1, JSON.stringify(dbl));

  console.log('# modo audio e bateria');
  await clear();
  await page.evaluate(() => toggleAudioOnly());
  await page.waitForTimeout(900);
  const m1 = await page.evaluate(() => ({ open: document.getElementById('modal-overlay').classList.contains('active'), title: document.getElementById('modal-title').textContent }));
  check('1a vez: explica antes de pedir', m1.open && /tela desligada/i.test(m1.title), JSON.stringify(m1));
  c = await calls();
  check('nada pedido antes de o usuario aceitar', !c.some(x => x.name === 'requestBatteryExemption'));
  await page.evaluate(() => document.querySelector('#modal-actions .modal-btn.primary').click());
  c = await calls();
  check('ao aceitar, pede a isencao de bateria', c.some(x => x.name === 'requestBatteryExemption'));
  await page.evaluate(() => { toggleAudioOnly(); toggleAudioOnly(); });
  await page.waitForTimeout(900);
  check('2a vez: nao pergunta de novo', await page.evaluate(() => !document.getElementById('modal-overlay').classList.contains('active')));

  console.log('# reordenar modulos com a fila nativa ativa');
  const ro = await page.evaluate(() => {
    // fila criada com Mod A (2 aulas) + Mod B (2 aulas); toca a aula 0 (Mod A / Aula 1)
    _nativePlaylistMode = true; currentIdx = 0; done = new Set(); favorites = new Set([1]); lessonTimes[1] = 77;
    _nativeQueue = lessons.map(l => l.file);
    const fileB1 = lessons[2].file;                       // Mod B / Aula 1
    // usuario arrasta Mod B para o inicio
    const m = modules.pop(); modules.unshift(m); rebuildLessonsKeepingState();
    const nameAt = i => lessons[i].module + '/' + lessons[i].name;
    const out = { order: lessons.map(l => l.module + '/' + l.name) };
    out.cur = nameAt(currentIdx);
    out.fav = [...favorites].map(nameAt);
    out.time = Object.keys(lessonTimes).filter(k => lessonTimes[k] > 0).map(k => nameAt(+k) + '=' + lessonTimes[k]);
    // o ExoPlayer avanca sozinho para o item 2 da fila antiga = Mod B / Aula 1
    window.__listeners.trackChanged({ index: 2, title: 'x', auto: true });
    out.afterTrack = nameAt(currentIdx);
    out.doneAfterAuto = [...done].map(nameAt);
    return out;
  });
  check('aula atual segue a mesma aula depois de reordenar', ro.cur === 'Mod A/Aula 1', ro.cur);
  check('favorita segue a mesma aula (Mod A/Aula 2)', JSON.stringify(ro.fav) === '["Mod A/Aula 2"]', JSON.stringify(ro.fav));
  check('posicao salva segue a mesma aula', JSON.stringify(ro.time) === '["Mod A/Aula 2=77"]', JSON.stringify(ro.time));
  check('fila nativa antiga ainda aponta a aula certa', ro.afterTrack === 'Mod B/Aula 1', ro.afterTrack);
  check('so a aula que terminou foi concluida', JSON.stringify(ro.doneAfterAuto) === '["Mod A/Aula 1"]', JSON.stringify(ro.doneAfterAuto));

  console.log('# restaurar sessao depois de reabrir o app');
  await page.evaluate(() => {
    // reordena modulos e conclui uma aula; salva tudo
    done = new Set(); currentIdx = 3; setDone(3, true, true);
    saveModuleOrder();
    saveNativeSessionCache('content://tree/x', 'Curso X');
    saveToStorage();
  });
  const sess = await page.evaluate(() => JSON.parse(localStorage.getItem('splay_native_session')));
  check('cache guarda a chave do curso', !!sess.courseKey);
  check('cache guarda o PDF (extras do modulo)', JSON.stringify(sess).includes('Material.pdf'));
  await page.reload(); await page.waitForTimeout(500);
  const askOpen = await page.evaluate(() => document.getElementById('modal-overlay').classList.contains('active') && /Curso anterior/.test(document.getElementById('modal-title').textContent));
  check('ao reabrir, oferece continuar o curso', askOpen);
  await page.evaluate(() => document.querySelector('#modal-actions .modal-btn.primary').click());
  await page.waitForTimeout(400);
  const rs = await page.evaluate(() => ({ n: lessons.length, order: modules.map(m => m.name), doneNames: [...done].map(i => lessons[i].key), pdf: modules.some(m => (m.extras || []).some(e => e.name === 'Material.pdf')) }));
  check('4 aulas restauradas', rs.n === 4, JSON.stringify(rs));
  check('ordem reordenada preservada (Mod B primeiro)', rs.order[0] === 'Mod B', JSON.stringify(rs.order));
  check('progresso preservado apos reordenar + reabrir', rs.doneNames.length === 1, JSON.stringify(rs.doneNames));
  check('PDF restaurado', rs.pdf);

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(fails ? 1 : 0);
})();
