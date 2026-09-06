// Issue #74: envelope de erro 422 próprio (não mais Pydantic/FastAPI-shaped)
// e remoção de /docs, /redoc, /docs/oauth2-redirect.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/server-request-validation.test.ts",
    "tests/gateway/http-routes.test.ts",
    "tests/server-http-app.test.ts",
    "tests/server-docs.test.ts",
    "tests/server-routes.test.ts",
  ],
} satisfies Declaracao;
