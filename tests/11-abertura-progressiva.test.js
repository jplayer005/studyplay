// Abertura progressiva: curso novo comeca a tocar antes de a pasta inteira ser lida
const { chromium } = require('playwright');
const { APP, makeChecker, blockExternal } = require('./helpers');
const { check, finish } = makeChecker();

// Ponte nativa falsa: pickFolderOnly + scanFolder que emite os eventos com atrasos configuraveis
const MOCK = () => {
  window.__calls = []; window.__listeners = {}; window.__scanEv = {}; window.__t0 = performance.now();
  const rec = (name, ret) => function (args) { window.__calls.push({ name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)), t: performance.now() - window.__t0 }); return Promise.resolve(ret === undefined ? {} : ret); };
  const player = {};
  ['loadVideo', 'setPlaylist', 'appendPlaylist', 'seekToItem', 'show', 'hide', 'updateRect', 'resume', 'pause', 'seekTo', 'setSpeed', 'setVolume', 'enterPiP', 'enterFullscreen', 'exitFullscreen', 'enableTransparency', 'setSleepTimer', 'requestNotificationPermission', 'requestBatteryExemption', 'setMetadata', 'stop'].forEach(n => player[n] = rec(n));
  player.getCurrentIndex = rec('getCurrentIndex', { index: 0, position: 0 });
  player.addListener = (ev, fn) => { window.__listeners[ev] = fn; return Promise.resolve({ remove() {} }); };
  const folder = {
    saveTextFile: rec('saveTextFile'), openUrl: rec('openUrl'), pickFolder: rec('pickFolder'), listPersistedFolder: rec('listPersistedFolder'),
    pickFolderOnly: () => Promise.resolve({ treeUri: window.__plan.treeUri || 'content://curso', rootName: window.__plan.rootName || 'Curso Teste' }),
    cancelScan: rec('cancelScan'), checkFolder: rec('checkFolder', { ok: true }), releaseFolder: rec('releaseFolder'),
    addListener: (ev, fn) => { window.__scanEv[ev] = fn; return Promise.resolve({ remove() {} }); },
    // plano de varredura definido pelo teste: { flat, rootFiles, modules:[{name, files, delay}] }
    scanFolder: (a) => {
      window.__calls.push({ name: 'scanFolder', args: a, t: performance.now() - window.__t0 });
      const plan = window.__plan; let acc = 0;
      setTimeout(() => window.__scanEv.scanRoot({ scanId: a.scanId, rootName: plan.rootName || 'Curso Teste', rootFiles: plan.rootFiles || [], modules: plan.modules.map(m => m.name), flat: !!plan.flat }), 5);
      plan.modules.forEach((m, i) => {
        acc += m.delay || 0;
        setTimeout(() => { window.__calls.push({ name: 'EV_scanModule', args: { i }, t: performance.now() - window.__t0 }); window.__scanEv.scanModule({ scanId: a.scanId, index: i, name: m.name, files: m.files }); }, 10 + acc);
      });
      setTimeout(() => { window.__calls.push({ name: 'EV_scanDone', args: {}, t: performance.now() - window.__t0 }); window.__scanEv.scanDone({ scanId: a.scanId, totalFiles: plan.modules.reduce((n, m) => n + m.files.length, 0), scanMs: 1 }); }, 20 + acc);
      return Promise.resolve({});
    },
  };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { VideoPlayer: player, VideoFolder: folder, App: { addListener: () => Promise.resolve({ remove() {} }), minimizeApp: rec('minimizeApp') } } };
};

// modulo com n aulas: relativePath "Modulo X/Aula X.i.mp4"
const mod = (nome, n, delay) => ({
  name: nome, delay,
  files: Array.from({ length: n }, (_, i) => {
    const rel = `${nome}/Aula ${nome.slice(-1)}.${String(i + 1).padStart(2, '0')}.mp4`;
    return { name: rel.split('/').pop(), relativePath: rel, uri: 'https://localhost/_saf_/?uri=' + encodeURIComponent('c://' + rel), mimeType: 'video/mp4', size: 1 };
  })
});

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await blockExternal(page); await page.route(/_saf_/, r => r.fulfill({ status: 206, body: '' }));
  await page.goto(APP); await page.waitForTimeout(400);
  const calls = () => page.evaluate(() => window.__calls);
  const run = async (plan, espera) => {
    await page.evaluate(p => { window.__plan = p; window.__calls.length = 0; window.__t0 = performance.now(); }, plan);
    await page.evaluate(() => pickAndLoadFolder(false));
    await page.waitForTimeout(espera);
  };

  console.log('# toca antes de a pasta terminar (modulo 2 demora 1,5 s)');
  await page.evaluate(() => localStorage.clear());
  await run({ modules: [mod('Modulo 1', 8, 0), mod('Modulo 2', 8, 1500), mod('Modulo 3', 8, 0)] }, 600);
  let c = await calls();
  let sp = c.find(x => x.name === 'setPlaylist');
  check('setPlaylist ja saiu com so o modulo 1', !!sp && sp.args.items.length === 8, JSON.stringify(sp && sp.args.items.length));
  check('antes de scanDone', !c.some(x => x.name === 'EV_scanDone'));
  check('lista mostra so o modulo 1 por enquanto', await page.evaluate(() => document.querySelectorAll('.module-header').length) === 1);
  check('aviso de carregamento visivel', await page.evaluate(() => !document.getElementById('scan-banner').hidden && /de 3 m/.test(document.getElementById('scan-banner-text').textContent)), await page.evaluate(() => document.getElementById('scan-banner-text').textContent));
  check('aula 1 tocando', await page.evaluate(() => currentIdx) === 0);
  await page.waitForTimeout(2800);
  c = await calls();
  const apItems = c.filter(x => x.name === 'appendPlaylist').reduce((n, x) => n + x.args.items.length, 0);
  check('fila nativa recebeu os outros modulos (16 aulas)', apItems === 16, String(apItems));
  check('fila JS completa (24)', await page.evaluate(() => _nativeQueue.length) === 24, String(await page.evaluate(() => _nativeQueue.length)));
  check('3 modulos na lista, 24 aulas', await page.evaluate(() => document.querySelectorAll('.module-header').length === 3 && lessons.length === 24));
  check('aviso some no fim', await page.evaluate(() => document.getElementById('scan-banner').hidden));
  const ordem = await page.evaluate(() => modules.map(m => m.name));
  check('ordem dos modulos preservada', JSON.stringify(ordem) === JSON.stringify(['Modulo 1', 'Modulo 2', 'Modulo 3']), JSON.stringify(ordem));
  check('curso gravado na sessao (reabrir sem varrer)', await page.evaluate(() => !!JSON.parse(localStorage.getItem('splay_native_session') || 'null')));

  console.log('# retoma aula do modulo 3: so toca quando o modulo 3 chega');
  await page.evaluate(() => { setDone(0, true); playLesson(18); saveToStorage(); });   // aula 18 = Modulo 3
  await page.waitForTimeout(300);
  const chave = await page.evaluate(() => _courseKey);
  await run({ modules: [mod('Modulo 1', 8, 0), mod('Modulo 2', 8, 600), mod('Modulo 3', 8, 600)] }, 300);
  c = await calls();
  check('nada tocou antes de o modulo 3 chegar', !c.some(x => x.name === 'setPlaylist'), JSON.stringify(c.map(x => x.name)));
  await page.waitForTimeout(1500);
  c = await calls();
  sp = c.find(x => x.name === 'setPlaylist');
  const evMod3 = c.find(x => x.name === 'EV_scanModule' && x.args.i === 2);
  check('toca depois do modulo 3', !!sp && sp.t >= evMod3.t, `${sp && sp.t} vs ${evMod3 && evMod3.t}`);
  check('mesma chave de curso', await page.evaluate(() => _courseKey) === chave);
  check('aula certa (indice 18) e concluida mantida', await page.evaluate(() => currentIdx === 18 && done.has(0)), String(await page.evaluate(() => currentIdx)));

  console.log('# evento atrasado de outra varredura e ignorado');
  const ign = await page.evaluate(() => {
    const n = lessons.length;
    window.__scanEv.scanModule({ scanId: 'scan_antigo', index: 9, name: 'Modulo 9', files: [{ name: 'x.mp4', relativePath: 'Modulo 9/x.mp4', uri: 'u', mimeType: 'video/mp4', size: 1 }] });
    return lessons.length === n;
  });
  check('modulo de scanId antigo nao entra no curso', ign);

  console.log('# nova varredura cancela a anterior');
  await page.evaluate(() => localStorage.clear());
  await run({ modules: [mod('Modulo 1', 6, 0), mod('Modulo 2', 6, 2000)] }, 400);
  await page.evaluate(() => { window.__plan = { modules: [mod2('Modulo 7', 6)] }; function mod2(n, k) { return { name: n, delay: 0, files: Array.from({ length: k }, (_, i) => ({ name: `Aula ${i + 1}.mp4`, relativePath: `${n}/Aula ${i + 1}.mp4`, uri: 'https://localhost/_saf_/?uri=' + n + i, mimeType: 'video/mp4', size: 1 })) }; } });
  await page.evaluate(() => pickAndLoadFolder(false));
  await page.waitForTimeout(2600);
  c = await calls();
  check('cancelScan chamado para a primeira', c.some(x => x.name === 'cancelScan'));
  const nomes = await page.evaluate(() => modules.map(m => m.name));
  check('curso final e so o da segunda varredura', JSON.stringify(nomes) === JSON.stringify(['Modulo 7']), JSON.stringify(nomes));

  console.log('# ordem personalizada de modulos aplicada no fim, sem perder progresso');
  await page.evaluate(() => localStorage.clear());
  await run({ modules: [mod('Modulo 1', 6, 0), mod('Modulo 2', 6, 0)] }, 600);
  await page.evaluate(() => { setDone(1, true); modules.reverse(); rebuildLessonsKeepingState(); saveModuleOrder(); saveToStorage(); });
  await run({ modules: [mod('Modulo 1', 6, 0), mod('Modulo 2', 6, 300)] }, 1200);
  const ord = await page.evaluate(() => ({ mods: modules.map(m => m.name), doneKeys: [...done].map(i => lessons[i].name) }));
  check('modulos na ordem salva (2 antes do 1)', ord.mods[0] === 'Modulo 2', JSON.stringify(ord.mods));
  check('aula concluida continua concluida', ord.doneKeys.length === 1 && /1\.02/.test(ord.doneKeys[0]), JSON.stringify(ord.doneKeys));

  console.log('# lista plana (videos na raiz) usa o caminho de sempre');
  await page.evaluate(() => localStorage.clear());
  const rootFiles = Array.from({ length: 5 }, (_, i) => ({ name: `Aula ${i + 1}.mp4`, relativePath: `Aula ${i + 1}.mp4`, uri: 'https://localhost/_saf_/?uri=r' + i, mimeType: 'video/mp4', size: 1 }));
  await run({ flat: true, rootFiles, modules: [mod('Extras', 3, 0)] }, 800);
  const flat = await page.evaluate(() => ({ n: lessons.length, modular: isModular, banner: document.getElementById('scan-banner').hidden }));
  check('8 aulas (5 da raiz + 3 da subpasta)', flat.n === 8, JSON.stringify(flat));
  check('aviso escondido', flat.banner);

  console.log('# identidade do curso');
  const h = await page.evaluate(() => ({ a: fnv1a36('Curso A'), b: fnv1a36('Curso B'), a2: fnv1a36('Curso A') }));
  check('hash estavel e diferente por pasta', h.a === h.a2 && h.a !== h.b && /^[0-9a-z]+$/.test(h.a), JSON.stringify(h));
  await page.evaluate(() => localStorage.clear());
  const mA = [mod('Modulo 1', 6, 0)];
  await run({ treeUri: 'content://A', rootName: 'Curso A', modules: mA }, 500);
  const DH = await page.evaluate(() => fnv1a36('Curso D'));
  const kA = await page.evaluate(() => _courseKey);
  await run({ treeUri: 'content://B', rootName: 'Curso B', modules: mA }, 500);
  const kB = await page.evaluate(() => _courseKey);
  check('mesmos nomes de aula em pastas diferentes: chaves diferentes', kA !== kB && kA.endsWith('_' + h.a) && kB.endsWith('_' + h.b), kA + ' | ' + kB);
  await run({ treeUri: 'content://A', rootName: 'Curso A', modules: mA }, 500);
  check('reabrir a mesma pasta mantem a chave', await page.evaluate(() => _courseKey) === kA);

  await page.evaluate(() => localStorage.clear());
  const antigo = await page.evaluate(() => { const names = Array.from({ length: 5 }, (_, i) => 'Aula 1.0' + (i + 1)); return LS_KEY + '_' + btoa(unescape(encodeURIComponent(names.join('|')))).slice(0, 20); });
  await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ done: ['Aula 1.02'], currentName: 'Aula 1.03' })), antigo);
  await run({ treeUri: 'content://C', rootName: 'Curso C', modules: mA }, 500);
  const adot = await page.evaluate(() => ({ key: _courseKey, done: [...done].map(i => lessons[i].name), cur: currentIdx }));
  check('progresso de antes desta versao e adotado', adot.key === antigo && adot.done.join() === 'Aula 1.02' && adot.cur === 2, JSON.stringify(adot));
  await run({ treeUri: 'content://D', rootName: 'Curso D', modules: mA }, 500);
  const outro = await page.evaluate(() => _courseKey);
  check('outra pasta com os mesmos nomes NAO herda esse progresso', outro !== antigo && outro.endsWith('_' + (DH)), outro);

  console.log('# erro de varredura');
  await page.evaluate(() => { window.__plan = { modules: [] }; });
  await page.evaluate(() => { window.Capacitor.Plugins.VideoFolder.scanFolder = () => Promise.reject(new Error('falhou')); });
  await page.evaluate(() => pickAndLoadFolder(false));
  await page.waitForTimeout(300);
  check('aviso escondido apos erro', await page.evaluate(() => document.getElementById('scan-banner').hidden));
  check('mostra mensagem de erro', await page.evaluate(() => /Erro ao ler a pasta/.test(document.querySelector('.toast, #toast')?.textContent || document.body.innerText)));

  check('sem erros JS nao tratados', errors.length === 0, errors.join(' | '));
  await finish(browser)();
})();
