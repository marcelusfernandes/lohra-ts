import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

export function windowsPowerShellCommand(environment: NodeJS.ProcessEnv): {
  executable: string;
  environment: NodeJS.ProcessEnv;
} {
  const systemRoot = Object.entries(environment).find(
    ([name]) => name.toLowerCase() === "systemroot",
  )?.[1];
  if (
    !systemRoot ||
    !/^[A-Za-z]:\\/.test(systemRoot) ||
    win32.normalize(systemRoot) !== systemRoot
  ) {
    throw new Error("Windows ACL mechanism requires an absolute SystemRoot");
  }
  const nativeRoot = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([name]) => name.toLowerCase() !== "psmodulepath"),
  );
  return {
    executable: win32.join(nativeRoot, "powershell.exe"),
    environment: { ...childEnvironment, PSModulePath: win32.join(nativeRoot, "Modules") },
  };
}

// The one volume refusal the callers may tell apart from a failed check.
const UNSUPPORTED_VOLUME = "Private destinations require a fixed NTFS volume";

// Fixed script. Requests arrive on stdin, one `action base64(path)` line each:
// paths travel as data, never as shell fragments. Every read goes through .NET
// (DriveInfo, File/Directory.GetAttributes and GetAccessControl) instead of
// cmdlets: a cmdlet autoloads its module, which costs tens of milliseconds per
// process and prints a progress record that reaches stderr as CLIXML, and
// ConvertFrom-Json alone costs about as much as the rest of the script. The one
// cmdlet left is Set-Acl in the protect branch, with progress silenced.
export const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Flag values of FileAttributes, PropagationFlags and FileSystemRights, as numbers:
# a type literal per use costs about 30 ms of every verification process.
$reparsePoint = 0x400
$directory = 0x10
$inheritOnly = 2
$fullControl = 0x1F01FF
function Read-Acl([string]$target) {
  if (([System.IO.File]::GetAttributes($target) -band $directory) -ne 0) {
    return [System.IO.Directory]::GetAccessControl($target)
  }
  return [System.IO.File]::GetAccessControl($target)
}
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $done = 0
  foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) {
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $fields = $line.Split([char]32)
  $request = @{
    action = $fields[0]
    path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($fields[1]))
  }
  try {
  $path = [string]$request.path
  if (@('volume', 'protect', 'verify') -notcontains $request.action) { throw 'Unknown ACL action' }
  if ($request.action -eq 'volume') {
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($path))
    if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') {
      throw '${UNSUPPORTED_VOLUME}'
    }
  } else {
    $cursor = $path
    while ($cursor -ne [System.IO.Path]::GetPathRoot($cursor)) {
      if (([System.IO.File]::GetAttributes($cursor) -band $reparsePoint) -ne 0) {
        throw 'Windows reparse point is not verifiable'
      }
      $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    }
    $acl = Read-Acl $path
    if ($request.action -eq 'protect') {
      # A process created by an elevated administrator owns what it creates as the
      # Administrators group; the policy requires the current user as owner.
      if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
        $acl.SetOwner($identity)
      }
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($rule in @($acl.Access)) { $acl.PurgeAccessRules($rule.IdentityReference) }
      if ($acl -is [System.Security.AccessControl.DirectorySecurity]) {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      } else {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
      }
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $path -AclObject $acl
      $acl = Read-Acl $path
    }
    if (-not $acl.AreAccessRulesProtected) { throw 'Inherited access rules remain enabled' }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $identity.Value) { throw 'Windows file owner differs from the current identity' }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -eq 0) { throw 'Windows DACL is empty or unavailable' }
    $ownerCanUpdate = $false
    foreach ($rule in $rules) {
      if ($rule.IsInherited) { throw 'Inherited access rule remains' }
      if ($rule.AccessControlType -ne 'Allow') {
        throw 'Deny access rule cannot be verified'
      }
      $sid = $rule.IdentityReference.Value
      if ($sid -ne $identity.Value -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544') {
        throw 'Windows DACL grants access to an unapproved identity'
      }
      if ($sid -eq $identity.Value -and
          ($rule.PropagationFlags -band $inheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band $fullControl) -eq $fullControl) {
        $ownerCanUpdate = $true
      }
    }
    if (-not $ownerCanUpdate) { throw 'Windows owner lacks full control' }
  }
  $done++
  } catch {
    throw "Windows ACL $($request.action) failed at $([string]$request.path): $($_.Exception.Message)"
  }
  }
  [Console]::Out.Write("OK $done")
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

export type WindowsAclRequest = Readonly<{
  action: "volume" | "protect" | "verify";
  path: string;
}>;

/** The volume is not one where a private destination can be protected. */
export class WindowsUnsupportedVolumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsUnsupportedVolumeError";
  }
}

export function aclBatchFailure(
  requests: readonly WindowsAclRequest[],
  status: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const message = `Windows ACL batch failed (exit ${String(status)}, signal ${String(signal)}): ${stderr.trim() || "unverified result"}`;
  const refusedVolume =
    requests.length === 1 &&
    requests[0]?.action === "volume" &&
    stderr.includes(UNSUPPORTED_VOLUME);
  return refusedVolume ? new WindowsUnsupportedVolumeError(message) : new Error(message);
}

const ACTIONS: ReadonlySet<string> = new Set(["volume", "protect", "verify"]);

/**
 * One process may run one action of any kind, or up to three verifications
 * optionally led by a volume check (the check that gates the first one). Never
 * a protect next to anything else, and never unbounded.
 */
export function assertAclBatch(requests: readonly WindowsAclRequest[]): void {
  const verifications = requests.slice(requests[0]?.action === "volume" ? 1 : 0);
  const shaped =
    requests.length >= 1 &&
    requests.length <= 3 &&
    requests.every(({ action }) => ACTIONS.has(action)) &&
    (requests.length === 1 || verifications.every(({ action }) => action === "verify"));
  if (!shaped) {
    throw new Error(
      "Windows ACL batch must contain one to three requests: one action, or verifications optionally led by a volume check",
    );
  }
}

/** The stdin the ACL script reads: one `action base64(path)` line per request. */
export function encodeAclRequests(requests: readonly WindowsAclRequest[]): string {
  return requests
    .map(({ action, path }) => `${action} ${Buffer.from(path, "utf8").toString("base64")}\n`)
    .join("");
}

export function runWindowsAclBatch(requests: readonly WindowsAclRequest[]): void {
  assertAclBatch(requests);
  const script = Buffer.from(ACL_SCRIPT, "utf16le").toString("base64");
  const command = windowsPowerShellCommand(process.env);
  const result = spawnSync(
    command.executable,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", script],
    {
      input: encodeAclRequests(requests),
      encoding: "utf8",
      env: command.environment,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error) throw new Error("Windows ACL mechanism failed", { cause: result.error });
  // The script counts what it ran: fewer than asked is an unverified result.
  if (result.status !== 0 || result.stdout !== `OK ${String(requests.length)}`) {
    throw aclBatchFailure(requests, result.status, result.signal, result.stderr);
  }
}

export function runWindowsAcl(action: WindowsAclRequest["action"], path: string): void {
  runWindowsAclBatch([{ action, path }]);
}
