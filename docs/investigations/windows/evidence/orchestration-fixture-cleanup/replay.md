# Replay de #836

Comandos da medição, em clones descartáveis próprios no F:. `core.protectNTFS=false` contorna o clone NTFS do nome reservado `aux.ts`; não modifica o checkout principal. Para reproduzir o baseline após a publicação da branch, destacar os clones no SHA base, executar `npm ci` por ABI e só então copiar os dois arquivos candidatos. Os caminhos de runtimes são específicos desta máquina e podem ser substituídos por binários equivalentes.

```powershell
$base = 'F:\lohra-m25-836'
git -c core.protectNTFS=false clone --no-hardlinks --branch test/836-windows-orchestration-fixture-cleanup C:\Users\marce\Desktop\repositories\lohra-test-836 "$base\node20"
git -c core.protectNTFS=false clone --no-hardlinks --branch test/836-windows-orchestration-fixture-cleanup C:\Users\marce\Desktop\repositories\lohra-test-836 "$base\node22"
git -C "$base\node20" switch --detach bc8abacfa80df9c1325ec19d4def0a0dd180ddb1
git -C "$base\node22" switch --detach bc8abacfa80df9c1325ec19d4def0a0dd180ddb1
foreach ($v in @('20','22')) {
  & "$base\run.ps1" -Version $v -Label npm-ci ci
  & "$base\run.ps1" -Version $v -Label baseline test -- --maxWorkers=1 tests/orchestration-chat-wiring.test.ts
  Copy-Item tests\orchestration-chat-wiring.test.ts "$base\node$v\tests\orchestration-chat-wiring.test.ts"
  Copy-Item prova\windows-orchestration-fixture-cleanup.ts "$base\node$v\prova\windows-orchestration-fixture-cleanup.ts"
  & "$base\run.ps1" -Version $v -Label focal-green test -- --maxWorkers=1 tests/orchestration-chat-wiring.test.ts
  foreach ($step in @('build','typecheck','lint','format:check')) {
    $label = if ($step -eq 'format:check') { 'format' } else { $step }
    & "$base\run.ps1" -Version $v -Label $label run $step
  }
  & "$base\run.ps1" -Version $v -Label proof run prova -- windows-orchestration-fixture-cleanup
}
```

Para a sonda transitória, a fonte seguinte foi acrescentada ao fim de uma **cópia** do arquivo candidato somente nos clones F:, com `existsSync` adicionado ao import `node:fs` e `afterAll, vi` ao import `vitest`. `npm test -- --maxWorkers=1 tests/orchestration-chat-wiring.test.ts` termina exit 1 esperado e relata as causas; depois a cópia de cada clone foi substituída pelos bytes do candidato e conferida por SHA-256 antes dos gates. Oito casos originais passam junto das sondas, e o `afterAll` verifica ausência de root residual. Nenhuma dessas sondas foi adicionada ao diff da PR.

Fonte integral da sonda acrescentada:

```typescript
// Transient #836 fault probes; appended only in disposable ABI clones.
const probeRoots: string[] = [];
describe("fixture fault probes", () => {
  it("setup sentinel survives acquisition and teardown", () => {
    const spy = vi
      .spyOn(SessionRepository.prototype, "createSession")
      .mockImplementationOnce(() => {
        throw new Error("SETUP_SENTINEL");
      });
    try {
      expect(setupSessions).toThrowError("SETUP_SENTINEL");
      const fixture = fixtures.at(-1);
      if (fixture === undefined) throw new Error("missing setup fixture");
      probeRoots.push(fixture.root);
    } finally {
      spy.mockRestore();
    }
  });

  it("assertion sentinel remains the primary failure", () => {
    setupSessions();
    const fixture = fixtures.at(-1);
    if (fixture === undefined) throw new Error("missing assertion fixture");
    probeRoots.push(fixture.root);
    throw new Error("ASSERTION_SENTINEL");
  });

  it("cleanup sentinel is reported after actual close, before remove", () => {
    setupSessions();
    const fixture = fixtures.at(-1);
    if (fixture?.connection === undefined) throw new Error("missing cleanup connection");
    probeRoots.push(fixture.root);
    const originalClose = fixture.connection.close;
    Object.defineProperty(fixture.connection, "close", {
      configurable: true,
      value: () => {
        originalClose();
        throw new Error("CLEANUP_SENTINEL");
      },
    });
  });

  it("assertion and cleanup sentinels are both reported", () => {
    setupSessions();
    const fixture = fixtures.at(-1);
    if (fixture?.connection === undefined) throw new Error("missing combined connection");
    probeRoots.push(fixture.root);
    const originalClose = fixture.connection.close;
    Object.defineProperty(fixture.connection, "close", {
      configurable: true,
      value: () => {
        originalClose();
        throw new Error("SECONDARY_CLEANUP_SENTINEL");
      },
    });
    throw new Error("PRIMARY_ASSERTION_SENTINEL");
  });
  afterAll(() => {
    for (const root of probeRoots) expect(existsSync(root)).toBe(false);
  });
});
```

Fonte integral do runner Windows `run.ps1`:

```powershell
param(
  [Parameter(Mandatory = $true)][ValidateSet('20', '22')][string]$Version,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs
)

$ErrorActionPreference = 'Stop'
$base = 'F:\lohra-m25-836'
$cwd = Join-Path $base ('node' + $Version)
$isolation = Join-Path $base ('isolation-' + $Version)
foreach ($name in @('home', 'lohra', 'codex', 'cache', 'prefix', 'temp')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $isolation $name) | Out-Null
}
$env:HOME = Join-Path $isolation 'home'
$env:USERPROFILE = $env:HOME
$env:LOHRA_HOME = Join-Path $isolation 'lohra'
$env:CODEX_HOME = Join-Path $isolation 'codex'
$env:npm_config_cache = Join-Path $isolation 'cache'
$env:npm_config_prefix = Join-Path $isolation 'prefix'
$env:TEMP = Join-Path $isolation 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:LEFTHOOK = '0'
if ($Version -eq '20') {
  $node = 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node.exe'
  $npm = 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node_modules\npm\bin\npm-cli.js'
} else {
  $node = 'C:\Program Files\nodejs\node.exe'
  $npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
}
$env:PATH = (Split-Path $node) + ';' + $env:PATH
Push-Location $cwd
try {
  & $node $npm @NpmArgs *> (Join-Path $base ($Label + '-' + $Version + '.log'))
  $result = $LASTEXITCODE
  Write-Output "$Label`t$Version`t$result"
  exit $result
} finally {
  Pop-Location
}


```

No Linux, um bundle do SHA `9981aadfe67d2ffafa692fcc42566d027761cae6` foi clonado em `/work/lohra836` e a fonte abaixo executada no container `lohra-m25-linux-20261009` como usuário `node`. O controle negativo é `SKIP` test-only esperado; o vermelho nativo e a sonda acima são a evidência discriminante.

```sh
#!/bin/sh
set -eu
cd /work/lohra836
mkdir -p /tmp/lohra836-evidence /tmp/lohra836-isolation/home /tmp/lohra836-isolation/lohra /tmp/lohra836-isolation/codex /tmp/lohra836-isolation/cache /tmp/lohra836-isolation/prefix /tmp/lohra836-isolation/temp
export HOME=/tmp/lohra836-isolation/home USERPROFILE=/tmp/lohra836-isolation/home LOHRA_HOME=/tmp/lohra836-isolation/lohra CODEX_HOME=/tmp/lohra836-isolation/codex
export npm_config_cache=/tmp/lohra836-isolation/cache npm_config_prefix=/tmp/lohra836-isolation/prefix TMPDIR=/tmp/lohra836-isolation/temp TMP=/tmp/lohra836-isolation/temp TEMP=/tmp/lohra836-isolation/temp
run() {
  name="$1"; shift
  printf '%s start\n' "$name"
  set +e
  "$@" > "/tmp/lohra836-evidence/$name.log" 2>&1
  code="$?"
  set -e
  printf '%s\t%s\n' "$name" "$code" | tee -a /tmp/lohra836-evidence/results.tsv
  if [ "$code" -ne 0 ]; then tail -n 25 "/tmp/lohra836-evidence/$name.log"; exit "$code"; fi
}
git rev-parse HEAD > /tmp/lohra836-evidence/head.txt
run npm-ci npm ci
run build npm run build
run typecheck npm run typecheck
run lint npm run lint
run format npm run format:check
run test npm test -- --maxWorkers=1
run prova npm run prova -- windows-orchestration-fixture-cleanup
run negative npm run ci:controle-negativo -- --base bc8abacfa80df9c1325ec19d4def0a0dd180ddb1 --head 9981aadfe67d2ffafa692fcc42566d027761cae6 --branch test/836-windows-orchestration-fixture-cleanup
git status --short > /tmp/lohra836-evidence/status.txt

```
