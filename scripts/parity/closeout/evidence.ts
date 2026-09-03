import { spawnSync } from "node:child_process";

export function evidenceTargetSha(project: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: project,
    encoding: "utf8",
  });
  const sha = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`EVIDENCE_TARGET_SHA:${result.stderr.trim()}`);
  }
  return sha;
}
