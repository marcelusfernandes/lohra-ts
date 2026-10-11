import { spawnSync } from "node:child_process";

// Fixed script: paths travel on stdin as JSON, never as shell fragments.
// Set-Acl/Get-Acl and DriveInfo are supported Windows PowerShell/.NET APIs.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $path = [string]$request.path
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($request.action -eq 'volume') {
    $drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($path))
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') {
      throw 'Private destinations require a fixed NTFS volume'
    }
  } else {
    $cursor = $path
    while ($cursor -ne [System.IO.Path]::GetPathRoot($cursor)) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Windows reparse point is not verifiable'
      }
      $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    }
    $acl = Get-Acl -LiteralPath $path
    if ($request.action -eq 'protect') {
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
      $acl = Get-Acl -LiteralPath $path
    }
    if (-not $acl.AreAccessRulesProtected) { throw 'Inherited access rules remain enabled' }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $identity.Value) { throw 'Windows file owner differs from the current identity' }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -eq 0) { throw 'Windows DACL is empty or unavailable' }
    $ownerCanUpdate = $false
    foreach ($rule in $rules) {
      if ($rule.IsInherited) { throw 'Inherited access rule remains' }
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
        throw 'Deny access rule cannot be verified'
      }
      $sid = $rule.IdentityReference.Value
      if ($sid -ne $identity.Value -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544') {
        throw 'Windows DACL grants access to an unapproved identity'
      }
      if ($sid -eq $identity.Value -and
          ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {
        $ownerCanUpdate = $true
      }
    }
    if (-not $ownerCanUpdate) { throw 'Windows owner lacks full control' }
  }
  [Console]::Out.Write('OK')
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

export function runWindowsAcl(action: "volume" | "protect" | "verify", path: string): void {
  const script = Buffer.from(ACL_SCRIPT, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", script],
    {
      input: JSON.stringify({ action, path }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error)
    throw new Error(`Windows ACL ${action} mechanism failed`, { cause: result.error });
  if (result.status !== 0 || result.stdout !== "OK") {
    throw new Error(
      `Windows ACL ${action} failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.stderr.trim() || "unverified result"}`,
    );
  }
}
