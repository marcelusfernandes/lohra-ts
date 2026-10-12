// Ficção local usada na medição #757; sem credenciais ou acesso a rede.
const fs = require("node:fs");
const started = Date.now();
fs.writeFileSync(
  "operation-started.json",
  JSON.stringify({ pid: process.pid, started, limitMs: 30000 }),
);
const pulse = setInterval(
  () =>
    fs.writeFileSync("operation-pulse.json", JSON.stringify({ pid: process.pid, at: Date.now() })),
  500,
);
setTimeout(() => {
  clearInterval(pulse);
  fs.writeFileSync(
    "operation-finished.json",
    JSON.stringify({ pid: process.pid, at: Date.now(), reason: "bounded-natural-completion" }),
  );
  console.log("Operacao limitada concluida");
}, 30000);
