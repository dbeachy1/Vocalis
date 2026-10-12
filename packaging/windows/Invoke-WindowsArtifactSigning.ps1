# Signs and/or verifies Windows release files with Microsoft Azure Artifact Signing through SignTool.
# Each file's signer is checked as well as its signature (Vocalis design amendment 12). Keep this file ASCII
# (Windows PowerShell 5.1).
#
# No account detail, credential or tool path lives in this repository: build-installer.ps1 reads the three
# paths from the git-ignored packaging\windows\signing.local.json and passes them in. Inno Setup calls this
# script with -Action Sign to sign Setup and its uninstaller; build-installer.ps1 calls it with -Action Verify.
param(
    [Parameter(Mandatory)] [ValidateSet('Sign', 'Verify')] [string] $Action,
    [Parameter(Mandatory)] [string] $SignToolPath,
    [Parameter(Mandatory)] [string] $DlibPath,
    [Parameter(Mandatory)] [string] $MetadataPath,
    [Parameter(Mandatory)] [string[]] $Files,
    # The simple name (CN) the signing certificate must carry.
    [string] $ExpectedSigner = 'Douglas Beachy'
)

$ErrorActionPreference = 'Stop'
foreach ($path in @($SignToolPath, $DlibPath, $MetadataPath) + $Files) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required signing file is missing: $path" }
}

foreach ($file in $Files) {
    if ($Action -eq 'Sign') {
        $signArguments = @('sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com',
            '/td', 'SHA256', '/dlib', $DlibPath, '/dmdf', $MetadataPath, $file)
        $output = & $SignToolPath @signArguments 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "SignTool sign failed for '$file' with exit code $LASTEXITCODE. $output"
        }
    }

    $verifyArguments = @('verify', '/pa', '/all', '/tw', '/v', $file)
    $output = & $SignToolPath @verifyArguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "SignTool verify failed for '$file' with exit code $LASTEXITCODE. $output"
    }

    # The Authenticode signature must be valid, made by the expected signer, and carry a timestamp.
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid') { throw "Authenticode status of '$file' is $($signature.Status), not Valid." }
    $signer = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($signer -cne $ExpectedSigner) { throw "'$file' is signed by '$signer', not '$ExpectedSigner'." }
    if ($null -eq $signature.TimeStamperCertificate) { throw "'$file' has no timestamp countersignature." }
    Write-Output "Verified '$file': valid, signed by '$signer', timestamped."
}
