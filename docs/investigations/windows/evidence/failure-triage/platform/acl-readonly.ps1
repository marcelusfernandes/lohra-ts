param([Parameter(Mandatory = $true)][string]$LiteralFile)

$ErrorActionPreference = 'Stop'
$attributes = [System.IO.File]::GetAttributes($LiteralFile)
$acl = [System.IO.File]::GetAccessControl($LiteralFile)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($acl.Sddl)
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $digest = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
} finally {
    $sha.Dispose()
}
$readOnly = [bool]($attributes -band [System.IO.FileAttributes]::ReadOnly)
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$ruleCount = $rules.Count
$protected = $acl.AreAccessRulesProtected
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$aceParts = @()
foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    $principal = switch ($sid) {
        $ownerSid { 'OWNER'; break }
        'S-1-5-18' { 'SYSTEM'; break }
        'S-1-5-32-544' { 'ADMINISTRATORS'; break }
        'S-1-5-32-545' { 'USERS'; break }
        'S-1-5-11' { 'AUTHENTICATED_USERS'; break }
        'S-1-1-0' { 'EVERYONE'; break }
        default { 'OTHER'; break }
    }
    $aceParts += ('{{"principalClass":"{0}","type":"{1}","rights":"{2}","inherited":{3}}}' -f `
        $principal, $rule.AccessControlType, $rule.FileSystemRights, $rule.IsInherited.ToString().ToLowerInvariant())
}
$json = '{{"readOnlyAttribute":{0},"descriptorSha256":"{1}","accessRuleCount":{2},"accessRulesProtected":{3},"aces":[{4}]}}' -f `
    $readOnly.ToString().ToLowerInvariant(), $digest, $ruleCount, $protected.ToString().ToLowerInvariant(), ($aceParts -join ',')
[Console]::WriteLine($json)
