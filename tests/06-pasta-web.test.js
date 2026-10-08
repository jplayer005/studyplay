// Caminho WEB (showDirectoryPicker): pasta com modulos, nomes repetidos, reordenar e reabrir
const { chromium } = require('playwright');
const { APP } = require('./helpers');
let fails=0; const check=(n,c,x)=>{ if(c) console.log('  OK  '+n); else { fails++; console.log('FALHA '+n+(x?' -> '+x:'')); } };
const BUILD = () => {
  const F = (n) => ({ kind:'file', name:n, getFile: async()=> new File([new Uint8Array(20)], n, {type: n.endsWith('.pdf')?'application/pdf':'video/mp4'}) });
  const D = (n, kids) => ({ kind:'directory', name:n, values: async function*(){ for(const k of kids) yield k; } });
  window.__tree = () => D('Curso Web', [
    D('Modulo 1', [F('Aula 1.mp4'), F('Aula 2.mp4'), F('Apostila.pdf')]),
    D('Modulo 2', [F('Aula 1.mp4'), F('Aula 2.mp4')]),
    D('Modulo 10', [F('Aula 1.mp4')]),
  ]);
};
(async()=>{
  const b=await chromium.launch({args:['--no-sandbox']}); const ctx=await b.newContext({viewport:{width:1200,height:800}});
  const p=await ctx.newPage(); const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
  await p.route(/googleapis|gstatic|apis\.google|accounts\.google/,r=>r.abort());
  await p.goto(APP); await p.waitForTimeout(300);
  await p.evaluate(BUILD);

  console.log('# abrir pasta (web)');
  await p.evaluate(()=>{ localStorage.clear(); return processDirectory(window.__tree(), false); });
  await p.waitForTimeout(400);
  const a=await p.evaluate(()=>({ isMod:isModular, mods:modules.map(m=>m.name), n:lessons.length, keys:lessons.map(l=>l.key), extras:modules.map(m=>(m.extras||[]).length), items:document.querySelectorAll('.lesson-item').length, key:_courseKey }));
  check('3 modulos em ordem natural (1, 2, 10)', JSON.stringify(a.mods)==='["Modulo 1","Modulo 2","Modulo 10"]', JSON.stringify(a.mods));
  check('5 aulas', a.n===5, String(a.n));
  check('chaves unicas apesar dos nomes repetidos', new Set(a.keys).size===5, JSON.stringify(a.keys));
  check('PDF do Modulo 1 entrou como material', a.extras[0]===1, JSON.stringify(a.extras));
  check('5 itens na lista', a.items===5, String(a.items));
  check('chave do curso congelada', !!a.key);

  console.log('# progresso por modulo + reordenar + reabrir');
  const r=await p.evaluate(async()=>{
    setDone(lessons.findIndex(l=>l.key.includes('Aula 2')&&l.module==='Modulo 2'), true, true);   // conclui Aula 2 do Modulo 2
    saveToStorage();
    const before=[...done].map(i=>lessons[i].module+'/'+lessons[i].name);
    // reordena: Modulo 10 vai para o inicio e salva a ordem
    const m=modules.pop(); modules.unshift(m); rebuildLessonsKeepingState(); saveModuleOrder(); saveToStorage();
    const keyAfterReorder=_courseKey;
    const afterReorder=[...done].map(i=>lessons[i].module+'/'+lessons[i].name);
    // "reabre": mesma pasta de novo
    _courseKey=null; done=new Set(); lessons=[]; modules=[];
    await processDirectory(window.__tree(), false);
    const after=[...done].map(i=>lessons[i].module+'/'+lessons[i].name);
    return { before, after, afterReorder, keyAfterReorder, keyNow:_courseKey, order:modules.map(m=>m.name) };
  });
  check('depois de reordenar, a MESMA aula continua concluida', JSON.stringify(r.afterReorder)==='["Modulo 2/Aula 2"]', JSON.stringify(r.afterReorder));
  check('concluida: so a Aula 2 do Modulo 2', JSON.stringify(r.before)==='["Modulo 2/Aula 2"]', JSON.stringify(r.before));
  check('chave nao mudou ao reordenar nem ao reabrir', r.keyAfterReorder===r.keyNow, r.keyAfterReorder+' vs '+r.keyNow);
  check('progresso volta igual ao reabrir a pasta', JSON.stringify(r.after)===JSON.stringify(r.before), JSON.stringify(r.after));
  check('ordem escolhida volta (Modulo 10 primeiro)', r.order[0]==='Modulo 10', JSON.stringify(r.order));

  console.log('# acrescentar modulo (merge)');
  const m=await p.evaluate(async()=>{
    const extra = { kind:'directory', name:'Modulo Extra', values: async function*(){ yield { kind:'file', name:'Aula 1.mp4', getFile: async()=> new File([new Uint8Array(9)],'Aula 1.mp4',{type:'video/mp4'}) }; } };
    const doneBefore=[...done].map(i=>lessons[i].module+'/'+lessons[i].name);
    await processDirectory(extra, true);
    return { n:lessons.length, doneBefore, doneAfter:[...done].map(i=>lessons[i].module+'/'+lessons[i].name), mods:modules.map(x=>x.name), keys:new Set(lessons.map(l=>l.key)).size };
  });
  check('6 aulas apos acrescentar', m.n===6, String(m.n));
  check('progresso anterior mantido apos acrescentar', JSON.stringify(m.doneAfter)===JSON.stringify(m.doneBefore), JSON.stringify(m.doneAfter));
  check('chaves continuam unicas', m.keys===6);
  check('sem erros JS nao tratados', errors.length===0, errors.join(' | '));
  await b.close(); console.log(fails?`\n${fails} FALHA(S)`:'\nTODOS OS TESTES PASSARAM'); process.exit(fails?1:0);
})();
