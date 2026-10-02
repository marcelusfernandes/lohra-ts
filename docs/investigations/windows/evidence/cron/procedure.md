# W6 — sonda temporária e reprodução

A fonte abaixo foi executada fora do checkout em `TEMP/lohra-w706-20261002/cron-probe.mjs`.
É transcrita aqui apenas para reproduzir a medição; não integra o produto.
`LOHRA_CRON_MODULE_ROOT` aponta para o clone buildado do SHA fixado. Cada modo
recebe um diretório exclusivo sob a raiz temporária. O runner PowerShell usou
`$ErrorActionPreference='Stop'` e `GetFullPath` para confirmar que `$scenarioDir`
estava sob `$probeRoot` antes da criação. `LOHRA_HOME`, `CODEX_HOME`, `HOME` e
`USERPROFILE` foram definidos sob a mesma raiz.

Comando Windows: `<node.exe> <TEMP>/lohra-w706-20261002/cron-probe.mjs
<single|failure|race|shutdown|tick-error|crash> <scenarioDir>`.
No controle Linux, a mesma fonte foi copiada para `/tmp/w706-cron-probe.mjs`;
o comando `docker exec` com homes temporários está em `linux-control.txt`.

Fonte exata da sonda:

```text
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [mode, home] = process.argv.slice(2);
const root = process.env.LOHRA_CRON_MODULE_ROOT;
if (!root || !mode || !home) throw new Error('arguments missing');
const { CronStore } = await import(pathToFileURL(join(root, 'dist/cron/store.js')).href);
const { tick, runSchedulerLoop } = await import(pathToFileURL(join(root, 'dist/cron/scheduler.js')).href);
const { CronTool } = await import(pathToFileURL(join(root, 'dist/cron/tool.js')).href);
const store = new CronStore(home);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (mode === 'single' || mode === 'failure') {
  const job = store.add({name:'probe', prompt:'stub', type:'once', value:100});
  const diagnostics = [];
  const result = await tick(store, async () => { if (mode === 'failure') throw new Error('STUB_SENTINEL'); }, {now:100, diagnostics:x=>diagnostics.push(x)});
  const listed = JSON.parse(new CronTool(store).handle({action:'list'}));
  console.log(JSON.stringify({mode, result, lastRunAt:store.get(job.id)?.last_run_at, diagnostics, toolHasSentinel:JSON.stringify(listed).includes('STUB_SENTINEL'), toolHasLastRunAt:JSON.stringify(listed).includes('last_run_at')}));
} else if (mode === 'worker') {
  writeFileSync(join(home, `ready-${process.pid}`), 'ready');
  while (!existsSync(join(home, 'go'))) await sleep(5);
  const result = await tick(store, async job => { appendFileSync(join(home, 'runs.txt'), `${process.pid},${Date.now()},${job.id}\n`); await sleep(500); }, {now:100});
  console.log(JSON.stringify({pid:process.pid, result}));
} else if (mode === 'race') {
  const job = store.add({name:'race', prompt:'stub', type:'once', value:100});
  const children = [0,1].map(() => spawn(process.execPath, [process.argv[1], 'worker', home], {env:process.env, stdio:['ignore','pipe','pipe']}));
  while (children.some(c => !existsSync(join(home, `ready-${c.pid}`)))) await sleep(5);
  writeFileSync(join(home, 'go'), 'go');
  const out = await Promise.all(children.map(c => new Promise(resolve => { let stdout='',stderr=''; c.stdout.on('data',x=>stdout+=x); c.stderr.on('data',x=>stderr+=x); c.on('exit',code=>resolve({pid:c.pid, code, stdout:stdout.trim(), stderr:stderr.trim()})); })));
  const runs = readFileSync(join(home,'runs.txt'),'utf8').trim().split('\n').filter(Boolean);
  console.log(JSON.stringify({workerResults:out, runCount:runs.length, distinctPids:new Set(runs.map(x=>x.split(',')[0])).size, lastRunAt:store.get(job.id)?.last_run_at}));
} else if (mode === 'lockholder') {
  mkdirSync(join(home,'cron','jobs.json.lock'));
  console.log('READY');
  setInterval(()=>{},1000);
} else if (mode === 'crash') {
  mkdirSync(join(home,'cron'),{recursive:true});
  const child=spawn(process.execPath,[process.argv[1],'lockholder',home],{env:process.env,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',x=>x.toString().includes('READY')?resolve():reject(new Error('no READY')));child.once('error',reject)});
  child.kill('SIGKILL');
  await new Promise(resolve=>child.once('exit',resolve));
  const lock=join(home,'cron','jobs.json.lock');
  const start=Date.now();let error='';try{store.list()}catch(e){error=e.message}
  const elapsedMs=Date.now()-start;const lockPersisted=existsSync(lock);
  rmdirSync(lock);
  const after=store.list();
  console.log(JSON.stringify({childPid:child.pid, elapsedMs, error:error.replaceAll(home,'<HOME>'), lockPersisted, afterManualRemoval:after.length}));
} else if (mode === 'shutdown') {
  store.add({name:'loop',prompt:'stub',type:'once',value:100});
  let stopped=false, calls=0, waits=0;
  await runSchedulerLoop({store,runJob:async()=>{calls++},stop:{isSet:()=>stopped},now:()=>100,wait:async()=>{waits++;stopped=true}});
  console.log(JSON.stringify({calls,waits,stopped}));
} else if (mode === 'tick-error') {
  let listCalls=0, waits=0, diagnostics=[];let stopped=false;
  const fakeStore={list(){listCalls++; if(listCalls===1)return [];throw new Error('TICK_SENTINEL')}};
  await runSchedulerLoop({store:fakeStore,runJob:async()=>{},stop:{isSet:()=>stopped},now:()=>100,wait:async()=>{waits++;stopped=true},diagnostics:x=>diagnostics.push(x)});
  console.log(JSON.stringify({listCalls,waits,diagnostics,returnedNormally:true}));
}
```
