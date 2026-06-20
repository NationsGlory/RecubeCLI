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

# ── checksum ────────────────────────────────────────────────────────────────
try {
  $Expected = (Invoke-WebRequest -Uri $SumUrl -UseBasicParsing).Content.Trim().Split(' ')[0]
  if ($Expected) {
    $Actual = (Get-FileHash -Algorithm SHA256 -Path $Tmp).Hash.ToLower()
    if ($Actual -ne $Expected.ToLower()) {
      Remove-Item $Tmp -Force -ErrorAction SilentlyContinue
      Die "checksum invalide (attendu $Expected, obtenu $Actual)."
    }
    Ok "Checksum SHA-256 vérifié."
  }
} catch {
  Info "(checksum non publié — vérification sautée)"
}

# ── install ─────────────────────────────────────────────────────────────────
Move-Item -Force -Path $Tmp -Destination $Dest
Ok "recube installé dans $Dest"

# ── PATH utilisateur ────────────────────────────────────────────────────────
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath -notlike "*$DestDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$UserPath;$DestDir", 'User')
  Info "Ajouté au PATH utilisateur (rouvre ton terminal pour qu'il prenne effet)."
}

Write-Host ''
Ok "Prêt. Lance : ${Violet}recube --help${Reset}"
