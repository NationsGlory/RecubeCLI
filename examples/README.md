# CI mods → draft recube (token de service)

Comment un dépôt de mod ajoute automatiquement son jar à un build recube, sans
OAuth navigateur, via un **token de service** (`rcs_…`, scope `launcher:draft`,
**add-only**).

## Le modèle

Le token de service ne peut **que déposer des fichiers** (`recube draft add`)
dans un draft **déjà ouvert**. Il ne peut PAS créer, publier, promouvoir, ni
même lire un draft. Donc le cycle est :

1. **Un humain ouvre le draft** (review-able sur le web, ou en CLI) :
   ```bash
   recube login --scope "launcher:draft launcher:publish openid profile"
   recube draft create --tenant nationsglory --channel beta --version-tag 1.0.18
   # → affiche l'id du draft (ex 019ee2xx-…)
   ```
2. **L'humain met l'id + le token en config du/des dépôt(s) de mod** (Settings →
   Secrets and variables → Actions) :
   - Secret  `RECUBE_TOKEN`   = `rcs_…` (token de service, lié au tenant)
   - Variable `RECUBE_DRAFT_ID` = l'id du draft
   - Variable `RECUBE_TENANT`   = `nationsglory`
   - Variable `RECUBE_CHANNEL`  = `beta`
3. **Chaque push de mod ajoute son jar au draft** (workflow ci-dessous).
4. **L'humain review + publie** quand tout est prêt :
   ```bash
   recube draft diff       # vérifie added/replaced/removed
   recube draft publish -r "build-1.0.18" -n "changelog…"
   # puis promote (séparé) côté admin pour le go-live
   ```

> Le CI ne franchit jamais l'étape review : `create`/`publish`/`promote`
> exigent une connexion utilisateur. Le token de service est volontairement
> add-only.

## Mettre en place dans un dépôt de mod

Copie [`mod-ci.yml`](./mod-ci.yml) dans `.github/workflows/` de ton dépôt de
mod, ajuste le build (Gradle/Maven) et le glob du jar, puis configure les
secrets/variables ci-dessus.

L'action réutilisable
[`NationsGlory/RecubeCLI/.github/actions/recube-draft-add`](../.github/actions/recube-draft-add/action.yml)
installe le CLI (`install.sh`, sans Node) et lance
`recube draft add` en mode token de service.

## En local / script (sans l'action)

```bash
export RECUBE_TOKEN=rcs_…
export RECUBE_DRAFT_ID=019ee2xx-…
export RECUBE_TENANT=nationsglory
export RECUBE_CHANNEL=beta

recube draft add ./build/libs/my-mod.jar
```

`RECUBE_TOKEN` court-circuite l'OAuth navigateur (prioritaire sur la session
stockée). Sans lui, le CLI reste en OAuth interactif pour les devs — rien ne
change.
