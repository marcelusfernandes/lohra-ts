import { AuditRepository } from "../../../src/state/audit-repository.js";
import { openStateDatabase } from "../../../src/state/connection.js";

const [databasePath, runId, rawCount] = process.argv.slice(2);
if (databasePath === undefined || runId === undefined || rawCount === undefined) process.exit(2);
const connection = openStateDatabase(databasePath);
try {
  const repository = new AuditRepository(connection.database, { maxEventsPerRun: 1000 });
  for (let index = 0; index < Number(rawCount); index += 1)
    repository.append(runId, { event_type: "process.append", payload: { attempt: index } });
} finally {
  connection.close();
}
