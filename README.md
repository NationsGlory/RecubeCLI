# Recube CLI

Outil en ligne de commande pour les développeurs Recube : publier des builds de
jeu (tenants NationsGlory, Paladium, …) via l'API du launcher, avec une
authentification OAuth — fini les tokens collés à la main.

## Installation

Binaire standalone, **aucun Node requis** :

```powershell
# Windows (PowerShell)
irm https://recube.gg/install.ps1 | iex
```

```bash
# Linux / macOS
curl -fsSL https://recube.gg/install | sh
```

Le script détecte ton OS, télécharge le binaire depuis les GitHub Releases,
vérifie le **checksum SHA-256 + la signature Recube**, puis l'ajoute à ton PATH.
Ré-exécuter le script = mise à jour.

> Alternative si tu as déjà Node 20+ : `npm install -g @nationsglory/cli`

## Premiers pas

```bash
recube login      # ouvre le navigateur (OAuth recube.gg) — une fois par machine
recube whoami     # vérifie ton identité
recube publish    # publie un build (assistant interactif)
```

## Commandes

| Commande | Rôle |
|---|---|
| `recube login` | S'authentifier (OAuth PKCE). `--scope "…"` pour des scopes précis, `--force` pour forcer un re-login. |
| `recube logout` | Effacer la session locale + révoquer les tokens. |
| `recube whoami` | Affiche qui tu es (handle, scopes, expiration). |
| `recube doctor` | Diagnostic : config, auth, connectivité à recube.gg. |
| `recube publish` | Publier un build de jeu. Interactif par défaut, ou tout en flags pour la CI. |
| `recube draft …` | Build mutable en staging : `create` / `add` / `rm` / `diff` / `publish` / `list`. |
| `recube channels list <tenant>` | Lister les channels (stable / beta / nightly). `create` pour en ajouter. |
| `recube versions list <tenant>` | Lister les versions publiées d'un tenant. |
| `recube core …` | Gérer recube-core (anti-cheat) : `publish` / `list`. |
| `recube completion bash` | Auto-complétion shell. |

Aide détaillée sur n'importe quelle commande : `recube <commande> --help`.

### Exemples

```bash
# Publier un build complet en stable
recube publish -t nationsglory -c stable -V 1.0.0 -d ./build -n "Fix anti-cheat"

# Préparer un draft (build mutable) sur beta, y déposer des fichiers, publier
recube draft create -t nationsglory -c beta -V 1.0.1
recube draft add ./mods/cool.jar
recube draft diff
recube draft publish

# Inspecter
recube channels list nationsglory
recube versions list nationsglory
```

## Authentification

- **Interactif** : `recube login` → flow OAuth Authorization Code + PKCE (même
  modèle que GitHub CLI / Stripe CLI). Le CLI rafraîchit le token tout seul ;
  `recube logout` révoque tout. Token stocké dans le trousseau de l'OS (ou
  `~/.recube/credentials.json` en 0600 à défaut).
- **CI / scripts** : exporte `RECUBE_TOKEN` (token de service) — aucun login
  navigateur. Les droits restent gouvernés par les scopes/perms du token côté
  serveur.

## Sécurité

Client OAuth **public** : PKCE, **aucun client_secret** embarqué. Rien de
sensible dans le binaire — un token ne peut que ce que ses scopes/perms
autorisent (vérifié côté serveur). Les binaires sont signés (clé Recube) et
l'installeur vérifie checksum + signature avant d'installer.
```
