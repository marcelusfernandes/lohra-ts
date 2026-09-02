export interface DangerousCommand {
  readonly key: string;
  readonly description: string;
}

export type ApprovalChoice = "once" | "session" | "always" | "deny";
export type ApprovalCallback = (
  command: string,
  description: string,
  options: { readonly allowPermanent: true },
) => ApprovalChoice;

const patterns: readonly (DangerousCommand & { readonly pattern: RegExp })[] = [
  {
    key: "rm_rf",
    pattern: /\brm\s+(?:-{1,2}\S+\s+)*(?:-\w*r\w*|--recursive)\b/iu,
    description: "recursive delete (rm -r)",
  },
  {
    key: "fork_bomb",
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/iu,
    description: "shell fork bomb",
  },
  {
    key: "dd_disk",
    pattern: /\bdd\s+.*\b(if|of)=\/dev\//iu,
    description: "raw disk write (dd to /dev)",
  },
  {
    key: "redirect_device",
    pattern: />\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/iu,
    description: "redirect to a block device",
  },
  { key: "mkfs", pattern: /\bmkfs(\.\w+)?\b/iu, description: "filesystem format (mkfs)" },
  {
    key: "find_delete",
    pattern: /\bfind\b[^\n]*\s-delete\b/iu,
    description: "bulk delete via find -delete",
  },
  { key: "shred", pattern: /\bshred\b/iu, description: "secure file shredding (shred)" },
  {
    key: "chmod_perm",
    pattern: /\bchmod\s+(-[a-z]+\s+)*[0-7]*7[0-7]{2}\b/iu,
    description: "broad permission change (chmod ...7xx)",
  },
  {
    key: "chown_root",
    pattern: /\bchown\s+(-[a-z]+\s+)*root\b/iu,
    description: "change ownership to root",
  },
  {
    key: "pipe_to_shell",
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/iu,
    description: "download piped into a shell",
  },
  {
    key: "sql_drop",
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/iu,
    description: "destructive SQL (DROP)",
  },
  {
    key: "git_force_push",
    pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S+)/iu,
    description: "force push (rewrites history)",
  },
  { key: "sudo", pattern: /\bsudo\b/iu, description: "elevated privileges (sudo)" },
];

export function detectDangerousCommand(command: string): DangerousCommand | null {
  const found = patterns.find(({ pattern }) => pattern.test(command));
  return found === undefined ? null : { key: found.key, description: found.description };
}

export class ApprovalManager {
  readonly #sessionApproved = new Set<string>();
  #yolo = false;
  #callback: ApprovalCallback | null = null;

  setCallback(callback: ApprovalCallback | null): void {
    this.#callback = callback;
  }

  setYolo(enabled: boolean): void {
    this.#yolo = enabled;
  }

  reset(): void {
    this.#sessionApproved.clear();
  }

  require(command: string): boolean {
    const dangerous = detectDangerousCommand(command);
    if (dangerous === null) return true;
    if (this.#yolo || this.#sessionApproved.has(command)) return true;
    if (this.#callback === null) return false;
    let choice: ApprovalChoice;
    try {
      choice = this.#callback(command, dangerous.description, { allowPermanent: true });
    } catch {
      return false;
    }
    if (choice === "session" || choice === "always") {
      this.#sessionApproved.add(command);
      return true;
    }
    return choice === "once";
  }
}

export const approval = new ApprovalManager();
