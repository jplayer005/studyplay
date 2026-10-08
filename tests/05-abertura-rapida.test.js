const { chromium } = require('playwright');
const { APP } = require('./helpers');
let fails=0; const check=(n,c,x)=>{ if(c) console.log('  OK  '+n); else { fails++; console.log('FALHA '+n+(x?' -> '+x:'')); } };
const MOCK = () => {
  window.__calls=[]; window.__listeners={};
  const rec=(name,ret)=>function(args){ window.__calls.push({name,args:args===undefined?null:JSON.parse(JSON.stringify(args))}); return Promise.resolve(ret===undefined?{}:ret); };
  const player={}; ['loadVideo','setPlaylist','appendPlaylist','seekToItem','show','hide','updateRect','resume','pause','seekTo','setSpeed','setVolume','enterPiP','enterFullscreen','exitFullscreen','enableTransparency','setSleepTimer','requestNotificationPermission','requestBatteryExemption','setMetadata','stop'].forEach(n=>player[n]=rec(n));
  player.getCurrentIndex=rec('getCurrentIndex',{index:0,position:0}); player.addListener=(ev,fn)=>{ window.__listeners[ev]=fn; return Promise.resolve({remove(){}}); };
  const folder={ saveTextFile:rec('saveTextFile'), openUrl:rec('openUrl'), pickFolder:rec('pickFolder'), listPersistedFolder:rec('listPersistedFolder') };
  window.Capacitor={isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{VideoPlayer:player,VideoFolder:folder,App:{addListener:()=>Promise.resolve({remove(){}}),minimizeApp:rec('minimizeApp')}}};
};
const files=(n,mods)=>{ const out=[]; for(let m=1;m<=mods;m++) for(let i=1;i<=n/mods;i++){ const rel=`Modulo ${String(m).padStart(2,'0')}/Aula ${m}.${i}.mp4`; out.push({name:rel.split('/').pop(),relativePath:rel,uri:'https://localhost/_saf_/?uri='+encodeURIComponent('c://'+rel),mimeType:'video/mp4',size:1}); } return out; };
(async()=>{
  const b=await chromium.launch({args:['--no-sandbox']}); const ctx=await b.newContext({viewport:{width:393,height:780},isMobile:true,hasTouch:true});
  await ctx.addInitScript(MOCK); const p=await ctx.newPage(); const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
  await p.route(/googleapis|gstatic|cdnjs|apis\.google|accounts\.google/,r=>r.abort()); await p.route(/_saf_/,r=>r.fulfill({status:206,body:''}));
  await p.goto(APP); await p.waitForTimeout(400);

  console.log('# fila nativa em partes (200 aulas)');
  await p.evaluate(f=>{ localStorage.clear(); return processNativeFiles(f,'Curso',false); }, files(200,10));
  await p.waitForTimeout(250);
  let c=await p.evaluate(()=>window.__calls);
  const sp=c.find(x=>x.name==='setPlaylist');
  check('1o envio traz so as primeiras 30 aulas', sp && sp.args.items.length===30, String(sp&&sp.args.items.length));
  await p.waitForTimeout(2500);
  c=await p.evaluate(()=>window.__calls);
  const ap=c.filter(x=>x.name==='appendPlaylist');
  check('o restante (170) entra em blocos de ate 150', ap.length===2 && ap[0].args.items.length===150 && ap[1].args.items.length===20, JSON.stringify(ap.map(a=>a.args.items.length)));
  check('fila JS completa (200 arquivos)', await p.evaluate(()=>_nativeQueue.length)===200);
  check('1o item e o 31o enviados na ordem certa', ap[0].args.items[0].title==='Aula 4.1' || /Aula/.test(ap[0].args.items[0].title), ap[0].args.items[0].title);

  console.log('# tocar aula ainda nao carregada na fila');
  await p.evaluate(f=>{ localStorage.clear(); window.__calls=[]; _nativeQueue=_nativeQueue.slice(0,30); _queueGen++; },0);
  await p.evaluate(()=>playLesson(120));
  await p.waitForTimeout(100);
  c=await p.evaluate(()=>window.__calls);
  check('nao tenta pular para item inexistente (seekToItem)', !c.some(x=>x.name==='seekToItem'));
  const sp2=c.find(x=>x.name==='setPlaylist');
  check('refaz a fila a partir da aula pedida', sp2 && sp2.args.items.length===30 && /Aula/.test(sp2.args.items[0].title));
  await p.waitForTimeout(2200);
  check('e completa o restante dela (80 aulas)', await p.evaluate(()=>_nativeQueue.length)===80, String(await p.evaluate(()=>_nativeQueue.length)));
  await p.evaluate(()=>{ window.__calls=[]; });
  await p.evaluate(()=>playLesson(150));
  c=await p.evaluate(()=>window.__calls);
  const sk=c.find(x=>x.name==='seekToItem');
  check('aula ja na fila: so pula (indice 30)', sk && sk.args.index===30 && !c.some(x=>x.name==='setPlaylist'), JSON.stringify(sk));

  console.log('# trocar de aula rapido invalida blocos pendentes');
  const inv=await p.evaluate(async()=>{ window.__calls=[]; _nativePlaylistMode=false; await playLesson(0); await playLesson(100); await new Promise(r=>setTimeout(r,2500)); return { q:_nativeQueue.length, appends:window.__calls.filter(x=>x.name==='appendPlaylist').length }; });
  check('fila final e a da ultima escolha (100 aulas)', inv.q===100, JSON.stringify(inv));

  console.log('# cache de duracoes');
  const d=await p.evaluate(async()=>{
    localStorage.removeItem(_durStoreKey()); Object.keys(lessonDurations).forEach(k=>delete lessonDurations[k]);
    applyDuration(lessons[3],125.4); applyDuration(lessons[7],60);
    await new Promise(r=>setTimeout(r,2800));
    return { saved: JSON.parse(localStorage.getItem(_durStoreKey())) };
  });
  check('duracoes lidas viram cache no aparelho', Object.keys(d.saved).length===2, JSON.stringify(d.saved));
  const rel=await p.evaluate(()=>{ Object.keys(lessonDurations).forEach(k=>delete lessonDurations[k]); _durKey=null; ensureDurationCache(); return { a:lessonDurations[3], b:lessonDurations[7] }; });
  check('cache restaura as duracoes sem ler arquivos', rel.a===125.4 && rel.b===60, JSON.stringify(rel));

  console.log('# leitura em segundo plano (mais proximas primeiro)');
  const w=await p.evaluate(async()=>{
    Object.keys(lessonDurations).forEach(k=>delete lessonDurations[k]); lessons.forEach(l=>delete l._noDur);
    const order=[]; const orig=window._readLessonMeta;
    window._readLessonMeta=function(l,thumb,meta,done){ order.push(l.idx); applyDuration(l,100+l.idx); setTimeout(done,1); };
    currentIdx=50; _metaQueue.length=0; _scheduleWarmup(10);
    await new Promise(r=>setTimeout(r,2500));
    window._readLessonMeta=orig;
    return { first:order.slice(0,5), n:order.length };
  });
  check('comeca pela aula atual e seus vizinhos', w.first[0]===50 && w.first.slice(1,3).every(i=>Math.abs(i-50)<=2), JSON.stringify(w.first));
  check('le varias aulas sozinho', w.n>=10, String(w.n));

  console.log('# sessao antiga (2.0) sem nomes repetidos reabre pelo cache');
  const mod=(names)=>({ treeUri:'t', rootName:'x', isModular:true, modulesCache:[{name:'M1',lessons:names.map(n=>({_uri:'u'+n,_native:true,name:n+'.mp4',size:1})),extras:[],subModules:[]}] });
  const lg=await p.evaluate(({m1,m2})=>({ ok:quickRestore(m1), upgraded:!!JSON.parse(localStorage.getItem('splay_native_session')).courseKey, dup:quickRestore(m2) }), {m1:mod(['A','B','C']), m2:mod(['A','A','C'])});
  check('sem repetidos: reabre rapido', lg.ok===true);
  check('e ja atualiza o cache para o formato novo', lg.upgraded===true);
  check('com nomes repetidos: faz a varredura (retorna false)', lg.dup===false);

  console.log('# painel de tempos');
  await p.evaluate(()=>localStorage.clear());
  const dg=await p.evaluate(async f=>{ await processNativeFiles(f,'Curso',false); openDiag(); return document.getElementById('modal-desc').textContent; }, files(60,3));
  console.log('   (texto do painel: '+JSON.stringify(dg)+')');
  check('mostra as etapas medidas', /desenhar a lista/.test(dg) && /fila nativa/.test(dg), dg);

  check('sem erros JS nao tratados', errors.length===0, errors.join(' | '));
  await b.close(); console.log(fails?`\n${fails} FALHA(S)`:'\nTODOS OS TESTES PASSARAM'); process.exit(fails?1:0);
})();
