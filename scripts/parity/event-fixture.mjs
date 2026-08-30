import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const profile = process.env.LOHRA_PARITY_PROFILE;
if (profile === undefined) {
  throw new Error("LOHRA_PARITY_PROFILE is required");
}
mkdirSync(profile, { recursive: true });
writeFileSync(
  join(profile, "events.jsonl"),
  '{"kind":"started","sequence":1}\n{"kind":"completed","sequence":2}\n',
);
process.stdout.write("events written\n");
