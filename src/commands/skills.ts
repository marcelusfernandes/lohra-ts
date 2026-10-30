export interface SkillsCommandIo {
  readonly environment: Readonly<Record<string, string>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}
export function runSkills(_argv: readonly string[], _io: SkillsCommandIo): number {
  throw new Error("not implemented: runSkills");
}
