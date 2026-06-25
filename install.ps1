# recube CLI installer (Windows) — "irm | iex" à la Anthropic.
#
#   irm https://recube.gg/install.ps1 | iex
#
# Télécharge le binaire standalone Windows depuis GitHub Releases (aucun Node
# requis), vérifie son SHA-256, l'installe dans %LOCALAPPDATA%\Programs\recube
# et l'ajoute au PATH utilisateur. Idempotent : ré-exécuter met à jour.
#
# Overrides (env) :
#   RECUBE_INSTALL_DIR   dossier cible (défaut: %LOCALAPPDATA%\Programs\recube)
#   RECUBE_VERSION       tag à installer (défaut: latest)
#   RECUBE_REPO          owner/repo (défaut: NationsGlory/RecubeCLI)

$ErrorActionPreference = 'Stop'

$Repo    = if ($env:RECUBE_REPO) { $env:RECUBE_REPO } else { 'NationsGlory/RecubeCLI' }
$Version = if ($env:RECUBE_VERSION) { $env:RECUBE_VERSION } else { 'latest' }
$Violet  = "$([char]27)[38;2;124;58;237m"; $Reset = "$([char]27)[0m"; $Dim = "$([char]27)[2m"

function Info($m) { Write-Host "$Dim*$Reset $m" }
function Ok($m)   { Write-Host "$([char]27)[32mok$Reset $m" }
function Die($m)  { Write-Host "$([char]27)[31mX$Reset $m" -ForegroundColor Red; exit 1 }

# ── arch ────────────────────────────────────────────────────────────────────
$arch = $env:PROCESSOR_ARCHITECTURE
switch ($arch) {
  'AMD64' { $Arch = 'x64' }
  'ARM64' { $Arch = 'arm64' }   # binaire arm64 si publié ; sinon fallback ci-dessous
  default { $Arch = 'x64' }
}
$Asset = "recube-windows-$Arch.exe"
Info "Plateforme détectée : windows-$Arch"

# ── URLs ────────────────────────────────────────────────────────────────────
if ($Version -eq 'latest') {
  $Base = "https://github.com/$Repo/releases/latest/download"
} else {
  $Base = "https://github.com/$Repo/releases/download/$Version"
}
$BinUrl = "$Base/$Asset"
$SumUrl = "$Base/$Asset.sha256"

# ── dossier cible + PATH ────────────────────────────────────────────────────
$DestDir = if ($env:RECUBE_INSTALL_DIR) { $env:RECUBE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\recube' }
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
$Dest = Join-Path $DestDir 'recube.exe'

# ── download ────────────────────────────────────────────────────────────────
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("recube-" + [guid]::NewGuid().ToString('N') + ".exe")
Info "Téléchargement de $Asset…"
try {
  Invoke-WebRequest -Uri $BinUrl -OutFile $Tmp -UseBasicParsing
} catch {
  Die "échec du téléchargement : $BinUrl"
}

# ── checksum SHA-256 (OBLIGATOIRE) ───────────────────────────────────────────
# Le .sha256 est toujours publié par la CI. Son absence = release anormale/
# altérée → on refuse (fail-closed), plus de skip silencieux.
#
# On télécharge le .sha256 dans un FICHIER puis on le lit (Get-Content), au lieu
# de lire `.Content` directement : GitHub sert l'asset en `application/octet-
# stream`, et sous PowerShell 7 `Invoke-WebRequest .Content` renvoie alors un
# `byte[]` (pas une string) → `.Trim()` lève « does not contain a method named
# 'Trim' », ce qui faisait échouer TOUTE installation sur PS7 (incident
# 2026-06-25). Le passage par fichier est string-safe sur PS 5.1 ET 7.
$SumTmp = "$Tmp.sha256"
try {
  Invoke-WebRequest -Uri $SumUrl -OutFile $SumTmp -UseBasicParsing
  $Expected = (((Get-Content -Raw $SumTmp).Trim()) -split '\s+')[0]
} catch {
  Remove-Item $Tmp, $SumTmp -Force -ErrorAction SilentlyContinue
  Die "checksum introuvable ($SumUrl) — release incomplète, installation refusée."
}
Remove-Item $SumTmp -Force -ErrorAction SilentlyContinue
if (-not $Expected) {
  Remove-Item $Tmp -Force -ErrorAction SilentlyContinue
  Die "checksum vide — installation refusée."
}
$Actual = (Get-FileHash -Algorithm SHA256 -Path $Tmp).Hash.ToLower()
if ($Actual -ne $Expected.ToLower()) {
  Remove-Item $Tmp -Force -ErrorAction SilentlyContinue
  Die "checksum invalide (attendu $Expected, obtenu $Actual) — binaire altéré."
}
Ok "Checksum SHA-256 vérifié."

# ── signature RSA (clé Recube épinglée) ──────────────────────────────────────
# Protège même contre une release GitHub compromise : sans la clé privée (en
# secret CI, jamais publiée) on ne peut pas re-signer un binaire altéré. La clé
# PUBLIQUE est épinglée ci-dessous — l'installeur vient de recube.gg (HTTPS,
# source de confiance), donc la pin est fiable. Signature PKCS#1 v1.5 SHA-256
# (= `openssl dgst -sha256 -sign`), vérifiée nativement par .NET (compat Windows
# PowerShell 5.1 + 7). Tant que la CI ne signe pas encore : .sig absent →
# avertissement (le checksum ci-dessus reste obligatoire).
$PubKeyXml = '<RSAKeyValue><Modulus>z8YFN+9/fMfOIQ9gVsj5V1tk5B56rPFC3v51fUIQPHXVQvVO0x4CIChTA2d9IcIQEA2XoSqkDNKd7fGgaUwu+HOVAX14Bpn2VtZzhaP69GHI/6yGEr2lmAk4YcKXDu67HWRCiWLeSKASD9nLlXN+qwi6KFJ8aqOd6lO2rOS4aqLnwpCC8azrJSGJHvMSnGf+7zE0/tQdiZGsKG2llGeUflLHDwdxJnN9gWyBHADJLrYoDDetrkXXnXyGHfIl7YLWblHTeOLgyL5dnAGdtb9u8lk302iIAsM9ER9SjUUz3BMXfh+ptdHbqZeHui7qaUWgqcoMDNmB6L5INg0K4m2EfiAlNgaygn/QbD/bzOXKbxr8B+jT1QQKIK4EKVVnzkfEarU84MSg5qMdVMQPpit8TtJRkjLEiSUeYwcsf0r8GDLm5aB0fgHjeoCZduVn802At7DXpEVllgdiJdYf97y9blGoqutrRs4TjHIL56UCFLm6o/OuQOeVU4XKRhBdGsWF</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>'
$SigUrl = "$Base/$Asset.sig"
$SigTmp = "$Tmp.sig"
$sigBytes = $null
try {
  Invoke-WebRequest -Uri $SigUrl -OutFile $SigTmp -UseBasicParsing
  $sigBytes = [System.IO.File]::ReadAllBytes($SigTmp)
} catch {
  $sigBytes = $null
}
if ($sigBytes -and $sigBytes.Length -gt 0) {
  $valid = $false
  try {
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    $rsa.FromXmlString($PubKeyXml)
    $valid = $rsa.VerifyData([System.IO.File]::ReadAllBytes($Tmp), 'SHA256', $sigBytes)
  } catch {
    $valid = $false
  }
  Remove-Item $SigTmp -Force -ErrorAction SilentlyContinue
  if (-not $valid) {
    Remove-Item $Tmp -Force -ErrorAction SilentlyContinue
    Die "signature RSA invalide — binaire non authentifié par Recube, installation refusée."
  }
  Ok "Signature Recube vérifiée."
} else {
  Remove-Item $SigTmp -Force -ErrorAction SilentlyContinue
  Info "(signature non publiée — vérification sautée ; checksum OK)"
}

# ── install ─────────────────────────────────────────────────────────────────
Move-Item -Force -Path $Tmp -Destination $Dest
Ok "recube installé dans $Dest"

# ── PATH utilisateur ────────────────────────────────────────────────────────
# Persiste dans le PATH User (registre) ET met à jour le PATH de CETTE session,
# pour que `recube` soit reconnu IMMÉDIATEMENT sans rouvrir le terminal.
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ([string]::IsNullOrEmpty($UserPath) -or ($UserPath -notlike "*$DestDir*")) {
  $newUserPath = if ([string]::IsNullOrEmpty($UserPath)) { $DestDir } else { "$UserPath;$DestDir" }
  [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
  Info "Ajouté au PATH utilisateur (persistant)."
}
if (($env:Path -split ';') -notcontains $DestDir) {
  $env:Path = "$env:Path;$DestDir"
}
Ok "Prêt : tape 'recube --help' (rouvre le terminal si non reconnu)."

Write-Host ''
Ok "Prêt. Lance : ${Violet}recube --help${Reset}"
