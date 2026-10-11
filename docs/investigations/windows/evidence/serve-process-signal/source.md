# Fonte do projetor de #804

O script externo lê somente os JSONs brutos Vitest preservados em F:, concilia as contagens e publica campos sanitizados sem stack nem caminho pessoal. A fonte abaixo corresponde byte a byte à execução.

<!-- prettier-ignore -->
```js
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [rawDir, outputDir] = process.argv.slice(2);
if (!rawDir || !outputDir) throw new Error('usage: pack-evidence.mjs RAW_DIR OUTPUT_DIR');
const read = (path) => readFileSync(path);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (name, data) => writeFileSync(join(outputDir, name), JSON.stringify(data, null, 2) + '\n');
const project = (raw) => {
  const report = JSON.parse(raw.toString('utf8'));
  const assertions = report.testResults.flatMap((file) => file.assertionResults);
  const counts = {
    total: assertions.length,
    passed: assertions.filter((item) => item.status === 'passed').length,
    failed: assertions.filter((item) => item.status === 'failed').length,
    pending: assertions.filter((item) => item.status === 'pending').length,
  };
  if (counts.total !== report.numTotalTests || counts.passed !== report.numPassedTests ||
      counts.failed !== report.numFailedTests || counts.pending !== report.numPendingTests) {
    throw new Error('reporter count mismatch');
  }
  return {
    counts,
    tests: assertions.map((item) => ({
      name: item.fullName,
      status: item.status,
      primary: item.failureMessages[0]?.split(/\r?\n/, 1)[0] ?? null,
      secondaryCount: Math.max(0, item.failureMessages.length - 1),
    })),
  };
};

for (const label of ['node20', 'node22']) {
  const base = read(join(rawDir, `base-${label}.json`));
  const proofDir = label === 'node20'
    ? 'F:/lohra-804/clones/node20/.prova/windows-serve-process-signal'
    : 'F:/lohra-804/clones/node22/.prova/windows-serve-process-signal';
  const candidate = read(join(proofDir, 'vitest.json'));
  const summary = JSON.parse(read(join(proofDir, 'resumo.json')).toString('utf8'));
  if (!summary.ok || summary.total !== 3 || summary.falhas.length !== 0) throw new Error(`${label} proof mismatch`);
  write(`before-after-${label}.json`, {
    schema: 1,
    node: label === 'node20' ? '20.20.2' : '22.23.2',
    base: {
      sha: 'ee6db18070b13a8c973edee622d07cccaed88ea8', exit: 1,
      rawReporterSha256: hash(base), rawLogSha256: hash(read(join(rawDir, `base-${label}.log`))),
      ...project(base),
    },
    candidate: {
      codeSha: '7aa3b8e2cbcbe5714999ebb2b60b1e3858805df1',
      exit: 0, proof: { ok: summary.ok, total: summary.total, failed: summary.falhas.length },
      rawReporterSha256: hash(candidate),
      rawLogSha256: hash(read(join(rawDir, `candidate-prova-${label}-final.log`))),
      ...project(candidate),
    },
  });
}
const red = read(join(rawDir, 'red-node22.json'));
write('red-checkpoint.json', {
  schema: 1, sha: '90b5c023265d940ced7701e830f1902ebfdd9045',
  node: '22.23.2', typecheckExit: 0, focalExit: 1, rawReporterSha256: hash(red), ...project(red),
});
```
