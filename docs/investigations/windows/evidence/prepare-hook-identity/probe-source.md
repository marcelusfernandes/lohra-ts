# Sonda de alias local

Código executado separadamente com Node 20.20.2 e 22.23.2. Define-se TEMP/TMP para uma pasta exclusiva em F: antes da invocação. A junction é interna ao diretório criado; nenhuma política 8.3 global muda. Os resultados abaixo omitem os sufixos aleatórios dos diretórios.

```javascript
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = mkdtempSync(join(tmpdir(), "lohra-hook-alias-"));
const target = join(root, "long path");
const alias = join(root, "alias");
mkdirSync(target);
writeFileSync(join(target, "pre-push"), "same bytes");
symlinkSync(target, alias, "junction");
const a = join(target, "pre-push"),
  b = join(alias, "pre-push");
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    root,
    plainEqual: resolve(a) === resolve(b),
    canonicalA: realpathSync.native(a),
    canonicalB: realpathSync.native(b),
    canonicalEqual: realpathSync.native(a) === realpathSync.native(b),
    conventionalEqual: realpathSync(a) === realpathSync(b),
    devEqual: statSync(a).dev === statSync(b).dev,
    inoEqual: statSync(a).ino === statSync(b).ino,
  }),
);
```

| Node |
esolve igual |
ealpathSync.native igual | stat.dev igual | stat.ino igual |
| --- | --- | --- | --- | --- |
| 20.20.2 | false | true | true | true |
| 22.23.2 | false | true | true | true |
