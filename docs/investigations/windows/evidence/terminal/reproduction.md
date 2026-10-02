# Fonte das sondas W3 para reprodução

Código transcrito das sondas temporárias de [W3](../../terminal.md), executadas fora do checkout no SHA `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`. Os fences preservam a fonte; ao reproduzir, grave cada bloco com o nome indicado em uma raiz temporária própria. Nenhum caminho pessoal, PID fixo, segredo ou saída bruta de terminal foi incorporado. `probe-tree.mjs` exige `parent.mjs` e `grandchild.mjs` na mesma raiz e só aplica `taskkill` aos PIDs que acabou de criar.

Comandos por Node, depois de `npm ci` no clone temporário de mesmo SHA e com os arquivos abaixo copiados para `$probeRoot`:

```powershell
$env:LOHRA_SOURCE_ROOT = $clone
$env:LOHRA_PROBE_ROOT = $probeRoot
& $node "$clone/node_modules/tsx/dist/cli.mjs" "$probeRoot/probe.mts"
& $node "$clone/node_modules/tsx/dist/cli.mjs" "$probeRoot/probe-policy.mts"
& $node "$probeRoot/probe-tree.mjs"
```

O `probe.mts` usa o módulo real de arquivo, terminal, aprovação e `node-pty`; `probe-policy.mts` usa `sandboxDispatch` com base sem efeitos para medir exclusivamente o filtro; `probe-tree.mjs` usa o addon PTY diretamente e **não** demonstra timeout da tool. Saídas esperadas/observadas e códigos de saída dos dois Nodes estão em [measurements.md](measurements.md).

## probe.mts

```text
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const source = process.env.LOHRA_SOURCE_ROOT;
const root = process.env.LOHRA_PROBE_ROOT;
if (!source || !root) throw new Error('missing probe environment');
const {readFileTool, writeFileTool, isUntrustedPath} = await import(pathToFileURL(path.join(source,'src/tools/filesystem.ts')).href);
const {terminalTool} = await import(pathToFileURL(path.join(source,'src/tools/terminal.ts')).href);
const {ApprovalManager} = await import(pathToFileURL(path.join(source,'src/tools/approval.ts')).href);
const requireFromSource = createRequire(path.join(source,'package.json'));
const pty = requireFromSource('node-pty');
const emit = (name, value) => console.log(JSON.stringify({name, node:process.version, ...value}));
const fileDir=path.join(root,'space ünicode');
fs.mkdirSync(fileDir,{recursive:true});
const target=path.join(fileDir,'café 😀.txt');
const content='linha α\r\nlinha β\nemoji 😀\r\n';
const written=JSON.parse(writeFileTool({path:target,content}));
const read=JSON.parse(readFileTool({path:target}));
const slash=JSON.parse(readFileTool({path:target.replaceAll('\\','/')}));
emit('file-unicode-space-eol',{writeOk:written.ok,bytes:written.bytes_written,expectedBytes:Buffer.byteLength(content),readOk:read.ok,contentEqual:read.data===content,slashEqual:slash.data===content,untrusted:read.untrusted===true,drive:path.parse(target).root});
try {const reserved=path.join(fileDir,'aux.txt'); const result=JSON.parse(writeFileTool({path:reserved,content:'RESERVED'})); emit('reserved-name',{ok:result.ok===true,error:result.error?.split(':')[0]??null,exists:fs.existsSync(reserved)});} catch(e){emit('reserved-name',{threw:e?.code??e?.name??String(e)});}
try {const long=path.join(fileDir,...Array.from({length:7},(_,i)=>`segment${i}-`+'x'.repeat(34)),'long.txt'); const result=JSON.parse(writeFileTool({path:long,content:'LONG'})); emit('long-path',{length:long.length,writeOk:result.ok===true,readEqual:fs.existsSync(long)&&fs.readFileSync(long,'utf8')==='LONG',error:result.error?.split(':')[0]??null});} catch(e){emit('long-path',{threw:e?.code??e?.name??String(e)});}
try {const outside=path.join(root,'outside.txt');fs.writeFileSync(outside,'OUTSIDE'); const link=path.join(fileDir,'link-out.txt');fs.symlinkSync(outside,link,'file');const result=JSON.parse(readFileTool({path:link}));emit('symlink',{created:true,contentEqual:result.data==='OUTSIDE',untrustedFromProject:result.untrusted===true,untrustedFromTempRoot:isUntrustedPath(link,fileDir)});} catch(e){emit('symlink',{created:false,code:e?.code??e?.name??String(e)});}
const approve=new ApprovalManager();
for (const [name,command,timeout] of [['stdout-stderr-exit','echo OUT & echo ERR 1>&2 & exit /b 7',5],['cwd-space','cd',5],['timeout','ping -n 8 127.0.0.1 >nul',0.5]]) {const started=Date.now(); const result=JSON.parse(await terminalTool({command,cwd:fileDir,timeout},{approvalManager:approve})); emit('terminal-'+name,{elapsedMs:Date.now()-started,ok:result.ok===true,exitCode:result.exit_code??null,stdout:(result.stdout??'').slice(0,160),stderr:(result.stderr??'').replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').slice(0,220),error:result.error??null});}
const denied=JSON.parse(await terminalTool({command:'sudo echo forbidden',cwd:fileDir},{approvalManager:approve}));emit('policy-denial',{refusal:denied.refusal??null,error:denied.error??null});
const direct=pty.spawn(process.env.ComSpec??'cmd.exe',['/d','/s','/c','echo PTY-DIRECT'],{cwd:fileDir,env:process.env,cols:80,rows:24,name:'xterm-256color'});let directOutput='';direct.onData(x=>directOutput+=x);const exit=await new Promise(resolve=>direct.onExit(resolve));emit('pty-direct',{pid:direct.pid,exitCode:exit.exitCode,marker:directOutput.includes('PTY-DIRECT')});
process.exit(0);

```

## probe-policy.mts

```text
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const source=process.env.LOHRA_SOURCE_ROOT;
const root=process.env.LOHRA_PROBE_ROOT;
if(!source||!root)throw new Error('missing env');
const {sandboxDispatch}=await import(pathToFileURL(path.join(source,'src/workflow/sandbox.ts')).href);
const {createChildDispatch}=await import(pathToFileURL(path.join(source,'src/tools/child.ts')).href);
const working=path.join(root,'working');
fs.mkdirSync(working,{recursive:true});
const inside=path.join(working,'inside.txt');
const outside=path.join(root,'outside.txt');
fs.writeFileSync(inside,'inside');fs.writeFileSync(outside,'outside');
const fake=(name,args)=>'BASE:'+name;
const policy={fsAllow:[],egressAllow:[]};
const filter=sandboxDispatch(fake,{workingRoot:working,policy,tainted:false});
const result={node:process.version,inside:filter('read_file',{path:inside}),outside:filter('read_file',{path:outside}),root:filter('read_file',{path:working}),terminal:filter('terminal',{command:'echo SAFE'}),webFetch:filter('web_fetch',{url:'http://127.0.0.1'}),webSearch:filter('web_search',{query:'safe'})};
const child=createChildDispatch(async (name,args)=>'BASE:'+name);
result.childTerminal=await child('terminal',{command:'echo SAFE'});
result.childDanger=await child('terminal',{command:'sudo echo SAFE'});
console.log(JSON.stringify(result));
process.exit(0);

```

## probe-tree.mjs

```text
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const root=process.env.LOHRA_PROBE_ROOT;
const source=process.env.LOHRA_SOURCE_ROOT;
const node=process.execPath;
if (!root||!source) throw new Error('missing env');
const pty=createRequire(path.join(source,'package.json'))('node-pty');
const child=pty.spawn(node,[path.join(root,'parent.mjs'),root],{cwd:root,env:process.env,cols:80,rows:24,name:'xterm-256color'});
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<50;i++){if(fs.existsSync(path.join(root,'parent.pid'))&&fs.existsSync(path.join(root,'grandchild.pid')))break;await delay(100)}
const parent=Number(fs.readFileSync(path.join(root,'parent.pid'),'utf8'));
const grandchild=Number(fs.readFileSync(path.join(root,'grandchild.pid'),'utf8'));
const alive=(pid)=>{try{process.kill(pid,0);return true}catch{return false}};
const before={parent:alive(parent),grandchild:alive(grandchild)};
child.kill();
await delay(1000);
const after={parent:alive(parent),grandchild:alive(grandchild)};
for(const pid of [grandchild,parent])if(alive(pid))spawnSync('taskkill',['/PID',String(pid),'/F','/T'],{stdio:'ignore'});
console.log(JSON.stringify({node:process.version,ptyPid:child.pid,parentPid:parent,grandchildPid:grandchild,before,after,cleaned:{parent:!alive(parent),grandchild:!alive(grandchild)}}));
process.exit(0);

```

## parent.mjs

```text
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=process.argv[2];
fs.writeFileSync(path.join(root,'parent.pid'),String(process.pid));
spawn(process.execPath,[path.join(root,'grandchild.mjs'),path.join(root,'grandchild.pid')],{stdio:'ignore'});
setInterval(()=>{},1000);

```

## grandchild.mjs

```text
import fs from 'node:fs';
fs.writeFileSync(process.argv[2],String(process.pid));
setInterval(()=>{},1000);

```
