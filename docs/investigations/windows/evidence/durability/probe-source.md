# Fontes integrais das sondas W5

Transcrição das 12 fontes `.mjs` temporárias efetivamente executadas. A única redação foi substituir o prefixo local `C:/Users/<usuário>/AppData/Local/Temp` por `C:/<TEMP>`; o código integral foi mantido sem outras alterações de conteúdo, inclusive a etiqueta `nodeVersion` imprecisa nos metadados do runner Node 20 (o executável efetivo consta no campo `command`). Para reproduzir, salve cada bloco com o nome indicado em um diretório temporário, substitua `C:/<TEMP>` pelo valor de `$env:TEMP.Replace('\', '/')` e execute como descrito em [replay.md](replay.md). Os SHA-256 das fontes originais sem redação constam no replay; o hash desta transcrição é naturalmente diferente.

## `lease-worker.mjs`

```text
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [repoRoot, dbPath, mode, runId] = process.argv.slice(2);
const { openStateDatabase } = await import(pathToFileURL(join(repoRoot, 'src/state/connection.ts')).href);
const { LockRepository } = await import(pathToFileURL(join(repoRoot, 'src/state/locks.ts')).href);
const { WorkflowRepository } = await import(pathToFileURL(join(repoRoot, 'src/state/workflow-repository.ts')).href);
const connection = openStateDatabase(dbPath);
const warnings = [];
const locks = new LockRepository(connection.database, warning => warnings.push(warning));
const runs = new WorkflowRepository(connection.database, warning => warnings.push(warning));
const holder = mode === 'hold' ? 'procA' : 'procB';
const now = mode === 'takeover' ? 1901 : 1001;
const fence = locks.acquireRunLease(runId, holder, mode === 'hold' ? 1000 : now, 900);
const stateFields = (status, at) => ({ name:'two-process-probe',owner:holder,status,
  pauseReason:null,pausePayloadJson:null,specJson:null,argsJson:null,tokenBudget:null,tainted:false,
  progressJson:null,auditSegmentId:null,updatedAt:at,fence,holder,now:at });
const initialWrite = fence === null ? null : runs.putRunState(runId,stateFields(mode === 'takeover' ? 'complete' : 'running',mode === 'hold' ? 1000 : now));
const print = value => process.stdout.write(JSON.stringify({pid:process.pid,mode,...value})+'\n');
print({phase:'ready',fence,initialWrite,warnings});
if (mode !== 'hold') { connection.close(); process.exit(0); }
const rl = createInterface({input:process.stdin});
rl.on('line', line => {
  if (line === 'stale') {
    const accepted = runs.putRunState(runId,stateFields('stale-complete',1901));
    const released = locks.releaseRunLeaseAtFence(runId,holder,fence);
    const row = runs.getRunState(runId);
    print({phase:'stale',accepted,released,rowStatus:row?.status,rowOwner:row?.owner,warnings});
    connection.close(); rl.close(); process.exit(0);
  }
});
```

## `read-run.mjs`

```text
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [repoRoot,dbPath,runId] = process.argv.slice(2);
const {openStateDatabase}=await import(pathToFileURL(join(repoRoot,'src/state/connection.ts')).href);
const connection=openStateDatabase(dbPath);
try {
  const db=connection.database;
  const state=db.prepare('SELECT status,pause_reason,progress_json FROM workflow_run_state WHERE run_id=?').get(runId);
  const cache=db.prepare('SELECT node_id,status FROM workflow_node_cache WHERE run_id=? ORDER BY node_id').all(runId);
  const spend=db.prepare('SELECT tokens_in,tokens_out FROM workflow_run_spend WHERE run_id=?').get(runId);
  const events=db.prepare('SELECT seq,event_type,segment_id,payload_json FROM workflow_audit_events WHERE run_id=? ORDER BY seq').all(runId)
    .map(x=>({seq:Number(x.seq),event_type:x.event_type,segment_id:x.segment_id,payload:JSON.parse(x.payload_json)}));
  process.stdout.write(JSON.stringify({pid:process.pid,state,cache,spend,events},(_key,value)=>typeof value==='bigint'?Number(value):value)+'\n');
} finally { connection.close(); }
```

## `resume-audited.mjs`

```text
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [repo,db,home,runId,nowText]=process.argv.slice(2);
const load=async path=>await import(pathToFileURL(join(repo,path)).href);
const {openStateDatabase}=await load('src/state/connection.ts');
const {AuditRepository}=await load('src/state/audit-repository.ts');
const {AuditTrail}=await load('src/workflow/audit-trail.ts');
const {OrchestrationCore}=await load('src/orchestration/core.ts');
const {OrchestrationChildRuntime}=await load('src/workflow/orchestration-runtime.ts');
const {productionOwnershipStore}=await load('src/workflow/ownership-store.ts');
const {WorkflowService}=await load('src/workflow/service.ts');
const {completeResult,crossProcessSpec}=await load('tests/workers/workflow-cross-process-fixtures.ts');
const connection=openStateDatabase(db);
const auditTrail=new AuditTrail(new AuditRepository(connection.database));
const spawnCounts={};
const core=new OrchestrationCore({runChild:(_id,config)=>{spawnCounts[config.prompt]=(spawnCounts[config.prompt]??0)+1;return Promise.resolve(completeResult(`${config.prompt}-resumed`));},idSource:(()=>{let i=0;return()=>`resumed-${++i}`;})(),maxSubsessions:100,maxParallel:10,buildSubagentPrompt:()=> 'SYS'});
const service=new WorkflowService({runtime:new OrchestrationChildRuntime(core),store:productionOwnershipStore(connection.database,{now:()=>Number(nowText)}),auditTrail,homeRoot:home});
const started=service.start(crossProcessSpec(),{}, {resumeRunId:runId});
if('error' in started){process.stdout.write(JSON.stringify({error:started.error,spawnCounts})+'\n');await service.shutdown();connection.close();process.exit(1);}
const result=await service.status(runId,true);
await service.shutdown();connection.close();
process.stdout.write(JSON.stringify({result,spawnCounts})+'\n');
```

## `supervision-worker.mjs`

```text
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [repo,db,home,mode]=process.argv.slice(2);
const load=async path=>await import(pathToFileURL(join(repo,path)).href);
const {openStateDatabase}=await load('src/state/connection.ts');
const {AuditRepository}=await load('src/state/audit-repository.ts');
const {AuditTrail}=await load('src/workflow/audit-trail.ts');
const {OrchestrationCore}=await load('src/orchestration/core.ts');
const {OrchestrationChildRuntime}=await load('src/workflow/orchestration-runtime.ts');
const {productionOwnershipStore}=await load('src/workflow/ownership-store.ts');
const {WorkflowService}=await load('src/workflow/service.ts');
const connection=openStateDatabase(db);
const auditTrail=new AuditTrail(new AuditRepository(connection.database));
let readyResolve;const ready=new Promise(resolve=>readyResolve=resolve);
let drained=[];
const partial=status=>({status,output:status==='complete'?'steered output':'interrupted',tokensIn:3,tokensOut:1,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0,provider:'stub',model:'stub',errorKind:null,retryAfter:null,usageUncertain:true,partial:true});
const core=new OrchestrationCore({runChild:(subId,_config,_prompt,drain,signal,interrupts)=>new Promise(resolve=>{
  signal.addEventListener('abort',()=>resolve(partial('interrupted')),{once:true});
  interrupts?.arm(()=>{drained=drain();resolve(partial('complete'));});
  readyResolve(subId);
}),idSource:(()=>{let n=0;return()=>`leaf-${++n}`})(),maxSubsessions:10,maxParallel:1,buildSubagentPrompt:()=> 'SYS'});
const runtime=new OrchestrationChildRuntime(core);
const service=new WorkflowService({runtime,store:productionOwnershipStore(connection.database,{now:()=>1000}),auditTrail,homeRoot:home});
const started=service.start({meta:{name:`supervision-${mode}`},nodes:[{id:'leaf',type:'agent',prompt:'hold'}]},{});
if('error' in started)throw new Error(started.error);
const subId=await ready;
// The runner starts in a microtask; let WorkflowEngine register the returned
// sub_id in activeLeaves before cancelling this in-flight leaf.
await new Promise(resolve=>setImmediate(resolve));
let action;
if(mode==='cancel') action=await service.cancel(started.run_id);
else if(mode==='shutdown') {await service.shutdown('signal');action={shutdown:true};}
else if(mode==='steer') {action=core.steer(subId,'operator redirect');}
else throw new Error(`unknown mode ${mode}`);
const result=await service.status(started.run_id,true);
await service.shutdown();
const dbState=connection.database.prepare('SELECT status FROM workflow_run_state WHERE run_id=?').get(started.run_id);
const spend=connection.database.prepare('SELECT tokens_in,tokens_out FROM workflow_run_spend WHERE run_id=?').get(started.run_id);
const audit=connection.database.prepare('SELECT event_type,payload_json FROM workflow_audit_events WHERE run_id=? ORDER BY seq').all(started.run_id).map(x=>({event_type:x.event_type,payload:JSON.parse(x.payload_json)}));
connection.close();
process.stdout.write(JSON.stringify({pid:process.pid,mode,runId:started.run_id,subId,action,result,dbState,spend,drained,audit},(_key,value)=>typeof value==='bigint'?Number(value):value)+'\n');
```

## `run-corpus.mjs`

```text
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = 'C:/<TEMP>/lohra-w705-agent/node22';
const repo = join(base, 'repo');
const nodeRoot = 'C:/<TEMP>/lohra-w701/node-v22.23.3-win-x64';
const node = join(nodeRoot, 'node.exe');
const out = join(base, 'results');
const profile = join(base, 'profile');
const scratch = join(base, 'scratch');
for (const path of [out, profile, scratch]) mkdirSync(path, { recursive: true });
const args = [join(repo, 'node_modules/vitest/vitest.mjs'), 'run',
  'tests/workflow-cross-process.test.ts',
  'tests/workflow-durability.test.ts',
  'tests/workflow-shutdown.test.ts',
  'tests/workflow-service-durability.test.ts',
  'tests/state-locks.test.ts',
  'tests/workflow-steer-tool.test.ts',
  'tests/orchestration-child-runner-abort.test.ts',
  '--maxWorkers=2'];
const env = { ...process.env,
  PATH: `${nodeRoot};${join(repo, 'node_modules/.bin')};${process.env.PATH ?? ''}`,
  HOME: profile, USERPROFILE: profile, TEMP: scratch, TMP: scratch,
  LOHRA_HOME: join(profile, 'lohra'), CODEX_HOME: join(profile, 'codex'),
  npm_config_cache: join(profile, 'npm-cache'), npm_config_prefix: join(profile, 'npm-prefix')
};
const stdoutPath = join(out, 'corpus.stdout.log');
const stderrPath = join(out, 'corpus.stderr.log');
const stdout = createWriteStream(stdoutPath);
const stderr = createWriteStream(stderrPath);
const startedAt = new Date();
const child = spawn(node, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout); child.stderr.pipe(stderr);
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }); }, 180000);
const result = await new Promise(resolve => { child.once('error', e => resolve({code:null,signal:null,error:String(e)})); child.once('close',(code,signal)=>resolve({code,signal})); });
clearTimeout(timer); stdout.end(); stderr.end();
const endedAt = new Date();
const meta = { nodeVersion:'v22.23.3', repo, command:[node,...args], timeoutMs:180000, timedOut, startedAtUtc:startedAt.toISOString(), endedAtUtc:endedAt.toISOString(), elapsedMs:endedAt-startedAt, ...result, stdoutPath, stderrPath };
writeFileSync(join(out,'corpus.json'), JSON.stringify(meta,null,2));
process.stdout.write(JSON.stringify(meta)+'\n');
```

## `run-lease-probe.mjs`

```text
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base='C:/<TEMP>/lohra-w705-agent/node22';
const repo=join(base,'repo');
const nodeRoot='C:/<TEMP>/lohra-w701/node-v22.23.3-win-x64';
const node=join(nodeRoot,'node.exe');
const tsx=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href;
const worker='C:/<TEMP>/lohra-w705-agent/lease-worker.mjs';
const root=mkdtempSync(join(base,'scratch/lease-'));
const db=join(root,'state.db');
const runId='native-lease-probe';
const out=join(base,'results'); mkdirSync(out,{recursive:true});
const profile=join(base,'profile'); mkdirSync(profile,{recursive:true});
const env={...process.env,PATH:`${nodeRoot};${join(repo,'node_modules/.bin')};${process.env.PATH??''}`,HOME:profile,USERPROFILE:profile,TEMP:root,TMP:root,LOHRA_HOME:join(profile,'lohra'),CODEX_HOME:join(profile,'codex')};
const args=mode=>['--import',tsx,worker,repo,db,mode,runId];
const startedAtUtc=new Date().toISOString();
const a=spawn(node,args('hold'),{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let aOutput='',aError=''; a.stdout.on('data',chunk=>aOutput+=chunk);a.stderr.on('data',chunk=>aError+=chunk);
const ready=await Promise.race([new Promise((resolve,reject)=>{a.stdout.on('data',()=>{const line=aOutput.split(/\r?\n/).find(x=>x.includes('"phase":"ready"'));if(line)resolve(JSON.parse(line));});a.once('error',reject);}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_READY_TIMEOUT')),10000))]);
const call=mode=>{const x=spawnSync(node,args(mode),{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:10000});return {mode,pid:x.pid,code:x.status,signal:x.signal,error:x.error?.message??null,stdout:x.stdout?.trim()??'',stderr:x.stderr?.trim()??''};};
let busy,takeover,stale,exit;
try {
  busy=call('busy');
  takeover=call('takeover');
  a.stdin.write('stale\n');
  stale=await Promise.race([new Promise(resolve=>a.stdout.on('data',()=>{const line=aOutput.split(/\r?\n/).find(x=>x.includes('"phase":"stale"'));if(line)resolve(JSON.parse(line));})),new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_STALE_TIMEOUT')),10000))]);
  exit=await Promise.race([new Promise(resolve=>a.once('close',(code,signal)=>resolve({code,signal}))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_EXIT_TIMEOUT')),10000))]);
} finally {
  if (a.exitCode===null && a.pid) spawnSync('taskkill.exe',['/PID',String(a.pid),'/T','/F'],{windowsHide:true,timeout:15000});
}
const result={startedAtUtc,endedAtUtc:new Date().toISOString(),repo,db,runId,commandA:[node,...args('hold')],commandB:[node,...args('busy')],commandTakeover:[node,...args('takeover')],ready,busy,takeover,stale,exit,aError};
writeFileSync(join(out,'lease-probe.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify(result)+'\n');
```

## `run-crash-probe.mjs`

```text
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base='C:/<TEMP>/lohra-w705-agent/node22';
const repo=join(base,'repo');
const nodeRoot='C:/<TEMP>/lohra-w701/node-v22.23.3-win-x64';
const node=join(nodeRoot,'node.exe');
const tsx=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href;
const root=mkdtempSync(join(base,'scratch/crash-'));
const db=join(root,'state.db');
const out=join(base,'results');mkdirSync(out,{recursive:true});
const profile=join(base,'profile');mkdirSync(profile,{recursive:true});
const env={...process.env,PATH:`${nodeRoot};${join(repo,'node_modules/.bin')};${process.env.PATH??''}`,HOME:profile,USERPROFILE:profile,TEMP:root,TMP:root,LOHRA_HOME:join(profile,'lohra'),CODEX_HOME:join(profile,'codex')};
const launch=join(repo,'tests/workers/workflow-launch-worker.ts');
const resume='C:/<TEMP>/lohra-w705-agent/resume-audited.mjs';
const read='C:/<TEMP>/lohra-w705-agent/read-run.mjs';
const argsA=['--import',tsx,launch,db,join(root,'home-a'),'1000'];
const a=spawn(node,argsA,{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let aOutput='',aError='';a.stdout.on('data',c=>aOutput+=c);a.stderr.on('data',c=>aError+=c);
const startedAtUtc=new Date().toISOString();
function call(args){const x=spawnSync(node,args,{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:15000});return {command:[node,...args],pid:x.pid,code:x.status,signal:x.signal,error:x.error?.message??null,stdout:x.stdout?.trim()??'',stderr:x.stderr?.trim()??''};}
let runId,before,crashed,afterCrash,resumed,afterResume;
try {
  await Promise.race([new Promise((resolve,reject)=>{a.stdout.on('data',()=>{if(aOutput.includes('READY')&&aOutput.includes('RUN_ID '))resolve();});a.once('error',reject);a.once('close',(code,signal)=>reject(new Error(`A_EXITED_EARLY ${code} ${signal} ${aError}`)));}),new Promise((_,reject)=>setTimeout(()=>reject(new Error(`A_READY_TIMEOUT ${aOutput} ${aError}`)),10000))]);
  runId=/RUN_ID (\S+)/.exec(aOutput)?.[1];if(!runId)throw new Error('NO_RUN_ID');
  const readArgs=['--import',tsx,read,repo,db,runId];
  before=call(readArgs);
  const closed=new Promise(resolve=>a.once('close',(code,signal)=>resolve({code,signal})));
  a.kill('SIGKILL');
  crashed=await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_KILL_TIMEOUT')),5000))]);
  afterCrash=call(readArgs);
  resumed=call(['--import',tsx,resume,repo,db,join(root,'home-c'),runId,'1901']);
  afterResume=call(readArgs);
} finally {
  if(a.exitCode===null&&a.pid)spawnSync('taskkill.exe',['/PID',String(a.pid),'/T','/F'],{windowsHide:true,timeout:15000});
}
const result={startedAtUtc,endedAtUtc:new Date().toISOString(),root,runId,commandA:[node,...argsA],aPid:a.pid,aOutput:aOutput.trim(),aError:aError.trim(),before,crashed,afterCrash,resumed,afterResume};
writeFileSync(join(out,'crash-probe.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify({runId,aPid:a.pid,beforeCode:before.code,crashed,resumeCode:resumed.code,afterCode:afterResume.code,output:resumed.stdout})+'\n');
```

## `run-supervision-probe.mjs`

```text
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const base='C:/<TEMP>/lohra-w705-agent/node22';
const repo=join(base,'repo');
const nodeRoot='C:/<TEMP>/lohra-w701/node-v22.23.3-win-x64';
const node=join(nodeRoot,'node.exe');
const tsx=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href;
const worker='C:/<TEMP>/lohra-w705-agent/supervision-worker.mjs';
const out=join(base,'results');mkdirSync(out,{recursive:true});
const profile=join(base,'profile');mkdirSync(profile,{recursive:true});
const cases=[];
for(const mode of ['cancel','steer','shutdown']){
  const root=mkdtempSync(join(base,`scratch/${mode}-`));
  const env={...process.env,PATH:`${nodeRoot};${join(repo,'node_modules/.bin')};${process.env.PATH??''}`,HOME:profile,USERPROFILE:profile,TEMP:root,TMP:root,LOHRA_HOME:join(profile,'lohra'),CODEX_HOME:join(profile,'codex')};
  const args=['--import',tsx,worker,repo,join(root,'state.db'),join(root,'home'),mode];
  const start=Date.now();
  const x=spawnSync(node,args,{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:15000});
  const parsed=x.status===0?JSON.parse(x.stdout.trim().split(/\r?\n/).at(-1)):null;
  const check=parsed?.pid?spawnSync('tasklist.exe',['/FI',`PID eq ${parsed.pid}`,'/FO','CSV','/NH'],{windowsHide:true,encoding:'utf8',timeout:5000}):null;
  cases.push({mode,command:[node,...args],elapsedMs:Date.now()-start,exitCode:x.status,signal:x.signal,error:x.error?.message??null,stderr:x.stderr?.trim()??'',result:parsed,residualProcess:check?.stdout?.includes(`"${parsed.pid}"`)??null,tasklistOutput:check?.stdout?.trim()??null});
}
const result={startedAtUtc:new Date().toISOString(),cases};
writeFileSync(join(out,'supervision-probe.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify(result)+'\n');
```

## `run-corpus-node20.mjs`

```text
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = 'C:/<TEMP>/lohra-w705-agent/node20';
const repo = join(base, 'repo');
const nodeRoot = 'C:/<TEMP>/lohra-w701/node-v20.20.2-win-x64';
const node = join(nodeRoot, 'node.exe');
const out = join(base, 'results');
const profile = join(base, 'profile');
const scratch = join(base, 'scratch');
for (const path of [out, profile, scratch]) mkdirSync(path, { recursive: true });
const args = [join(repo, 'node_modules/vitest/vitest.mjs'), 'run',
  'tests/workflow-cross-process.test.ts',
  'tests/workflow-durability.test.ts',
  'tests/workflow-shutdown.test.ts',
  'tests/workflow-service-durability.test.ts',
  'tests/state-locks.test.ts',
  'tests/workflow-steer-tool.test.ts',
  'tests/orchestration-child-runner-abort.test.ts',
  '--maxWorkers=2'];
const env = { ...process.env,
  PATH: `${nodeRoot};${join(repo, 'node_modules/.bin')};${process.env.PATH ?? ''}`,
  HOME: profile, USERPROFILE: profile, TEMP: scratch, TMP: scratch,
  LOHRA_HOME: join(profile, 'lohra'), CODEX_HOME: join(profile, 'codex'),
  npm_config_cache: join(profile, 'npm-cache'), npm_config_prefix: join(profile, 'npm-prefix')
};
const stdoutPath = join(out, 'corpus.stdout.log');
const stderrPath = join(out, 'corpus.stderr.log');
const stdout = createWriteStream(stdoutPath);
const stderr = createWriteStream(stderrPath);
const startedAt = new Date();
const child = spawn(node, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout); child.stderr.pipe(stderr);
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }); }, 180000);
const result = await new Promise(resolve => { child.once('error', e => resolve({code:null,signal:null,error:String(e)})); child.once('close',(code,signal)=>resolve({code,signal})); });
clearTimeout(timer); stdout.end(); stderr.end();
const endedAt = new Date();
const meta = { nodeVersion:'v22.23.3', repo, command:[node,...args], timeoutMs:180000, timedOut, startedAtUtc:startedAt.toISOString(), endedAtUtc:endedAt.toISOString(), elapsedMs:endedAt-startedAt, ...result, stdoutPath, stderrPath };
writeFileSync(join(out,'corpus.json'), JSON.stringify(meta,null,2));
process.stdout.write(JSON.stringify(meta)+'\n');
```

## `run-lease-probe-node20.mjs`

```text
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base='C:/<TEMP>/lohra-w705-agent/node20';
const repo=join(base,'repo');
const nodeRoot='C:/<TEMP>/lohra-w701/node-v20.20.2-win-x64';
const node=join(nodeRoot,'node.exe');
const tsx=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href;
const worker='C:/<TEMP>/lohra-w705-agent/lease-worker.mjs';
const root=mkdtempSync(join(base,'scratch/lease-'));
const db=join(root,'state.db');
const runId='native-lease-probe';
const out=join(base,'results'); mkdirSync(out,{recursive:true});
const profile=join(base,'profile'); mkdirSync(profile,{recursive:true});
const env={...process.env,PATH:`${nodeRoot};${join(repo,'node_modules/.bin')};${process.env.PATH??''}`,HOME:profile,USERPROFILE:profile,TEMP:root,TMP:root,LOHRA_HOME:join(profile,'lohra'),CODEX_HOME:join(profile,'codex')};
const args=mode=>['--import',tsx,worker,repo,db,mode,runId];
const startedAtUtc=new Date().toISOString();
const a=spawn(node,args('hold'),{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let aOutput='',aError=''; a.stdout.on('data',chunk=>aOutput+=chunk);a.stderr.on('data',chunk=>aError+=chunk);
const ready=await Promise.race([new Promise((resolve,reject)=>{a.stdout.on('data',()=>{const line=aOutput.split(/\r?\n/).find(x=>x.includes('"phase":"ready"'));if(line)resolve(JSON.parse(line));});a.once('error',reject);}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_READY_TIMEOUT')),10000))]);
const call=mode=>{const x=spawnSync(node,args(mode),{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:10000});return {mode,pid:x.pid,code:x.status,signal:x.signal,error:x.error?.message??null,stdout:x.stdout?.trim()??'',stderr:x.stderr?.trim()??''};};
let busy,takeover,stale,exit;
try {
  busy=call('busy');
  takeover=call('takeover');
  a.stdin.write('stale\n');
  stale=await Promise.race([new Promise(resolve=>a.stdout.on('data',()=>{const line=aOutput.split(/\r?\n/).find(x=>x.includes('"phase":"stale"'));if(line)resolve(JSON.parse(line));})),new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_STALE_TIMEOUT')),10000))]);
  exit=await Promise.race([new Promise(resolve=>a.once('close',(code,signal)=>resolve({code,signal}))),new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_EXIT_TIMEOUT')),10000))]);
} finally {
  if (a.exitCode===null && a.pid) spawnSync('taskkill.exe',['/PID',String(a.pid),'/T','/F'],{windowsHide:true,timeout:15000});
}
const result={startedAtUtc,endedAtUtc:new Date().toISOString(),repo,db,runId,commandA:[node,...args('hold')],commandB:[node,...args('busy')],commandTakeover:[node,...args('takeover')],ready,busy,takeover,stale,exit,aError};
writeFileSync(join(out,'lease-probe.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify(result)+'\n');
```

## `run-crash-probe-node20.mjs`

```text
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base='C:/<TEMP>/lohra-w705-agent/node20';
const repo=join(base,'repo');
const nodeRoot='C:/<TEMP>/lohra-w701/node-v20.20.2-win-x64';
const node=join(nodeRoot,'node.exe');
const tsx=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href;
const root=mkdtempSync(join(base,'scratch/crash-'));
const db=join(root,'state.db');
const out=join(base,'results');mkdirSync(out,{recursive:true});
const profile=join(base,'profile');mkdirSync(profile,{recursive:true});
const env={...process.env,PATH:`${nodeRoot};${join(repo,'node_modules/.bin')};${process.env.PATH??''}`,HOME:profile,USERPROFILE:profile,TEMP:root,TMP:root,LOHRA_HOME:join(profile,'lohra'),CODEX_HOME:join(profile,'codex')};
const launch=join(repo,'tests/workers/workflow-launch-worker.ts');
const resume='C:/<TEMP>/lohra-w705-agent/resume-audited.mjs';
const read='C:/<TEMP>/lohra-w705-agent/read-run.mjs';
const argsA=['--import',tsx,launch,db,join(root,'home-a'),'1000'];
const a=spawn(node,argsA,{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let aOutput='',aError='';a.stdout.on('data',c=>aOutput+=c);a.stderr.on('data',c=>aError+=c);
const startedAtUtc=new Date().toISOString();
function call(args){const x=spawnSync(node,args,{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:15000});return {command:[node,...args],pid:x.pid,code:x.status,signal:x.signal,error:x.error?.message??null,stdout:x.stdout?.trim()??'',stderr:x.stderr?.trim()??''};}
let runId,before,crashed,afterCrash,resumed,afterResume;
try {
  await Promise.race([new Promise((resolve,reject)=>{a.stdout.on('data',()=>{if(aOutput.includes('READY')&&aOutput.includes('RUN_ID '))resolve();});a.once('error',reject);a.once('close',(code,signal)=>reject(new Error(`A_EXITED_EARLY ${code} ${signal} ${aError}`)));}),new Promise((_,reject)=>setTimeout(()=>reject(new Error(`A_READY_TIMEOUT ${aOutput} ${aError}`)),10000))]);
  runId=/RUN_ID (\S+)/.exec(aOutput)?.[1];if(!runId)throw new Error('NO_RUN_ID');
  const readArgs=['--import',tsx,read,repo,db,runId];
  before=call(readArgs);
  const closed=new Promise(resolve=>a.once('close',(code,signal)=>resolve({code,signal})));
  a.kill('SIGKILL');
  crashed=await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('A_KILL_TIMEOUT')),5000))]);
  afterCrash=call(readArgs);
  resumed=call(['--import',tsx,resume,repo,db,join(root,'home-c'),runId,'1901']);
  afterResume=call(readArgs);
} finally {
  if(a.exitCode===null&&a.pid)spawnSync('taskkill.exe',['/PID',String(a.pid),'/T','/F'],{windowsHide:true,timeout:15000});
}
const result={startedAtUtc,endedAtUtc:new Date().toISOString(),root,runId,commandA:[node,...argsA],aPid:a.pid,aOutput:aOutput.trim(),aError:aError.trim(),before,crashed,afterCrash,resumed,afterResume};
writeFileSync(join(out,'crash-probe.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify({runId,aPid:a.pid,beforeCode:before.code,crashed,resumeCode:resumed.code,afterCode:afterResume.code,output:resumed.stdout})+'\n');
```

## `run-supervision-probe-node20.mjs`

```text
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const base='C:/<TEMP>/lohra-w705-agent/node20';
const repo=join(base,'repo');
const nodeRoot='C:/<TEMP>/lohra-w701/node-v20.20.2-win-x64';
const node=join(nodeRoot,'node.exe');
const tsx=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href;
const worker='C:/<TEMP>/lohra-w705-agent/supervision-worker.mjs';
const out=join(base,'results');mkdirSync(out,{recursive:true});
const profile=join(base,'profile');mkdirSync(profile,{recursive:true});
const cases=[];
for(const mode of ['cancel','steer','shutdown']){
  const root=mkdtempSync(join(base,`scratch/${mode}-`));
  const env={...process.env,PATH:`${nodeRoot};${join(repo,'node_modules/.bin')};${process.env.PATH??''}`,HOME:profile,USERPROFILE:profile,TEMP:root,TMP:root,LOHRA_HOME:join(profile,'lohra'),CODEX_HOME:join(profile,'codex')};
  const args=['--import',tsx,worker,repo,join(root,'state.db'),join(root,'home'),mode];
  const start=Date.now();
  const x=spawnSync(node,args,{cwd:repo,env,windowsHide:true,encoding:'utf8',timeout:15000});
  const parsed=x.status===0?JSON.parse(x.stdout.trim().split(/\r?\n/).at(-1)):null;
  const check=parsed?.pid?spawnSync('tasklist.exe',['/FI',`PID eq ${parsed.pid}`,'/FO','CSV','/NH'],{windowsHide:true,encoding:'utf8',timeout:5000}):null;
  cases.push({mode,command:[node,...args],elapsedMs:Date.now()-start,exitCode:x.status,signal:x.signal,error:x.error?.message??null,stderr:x.stderr?.trim()??'',result:parsed,residualProcess:check?.stdout?.includes(`"${parsed.pid}"`)??null,tasklistOutput:check?.stdout?.trim()??null});
}
const result={startedAtUtc:new Date().toISOString(),cases};
writeFileSync(join(out,'supervision-probe.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify(result)+'\n');
```
