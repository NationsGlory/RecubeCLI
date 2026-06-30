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
   recube draft create --tenant nationsglory --channel beta
   # → un seul draft OUVERT par (tenant, channel) ; la version s'auto-incrémente
   ```
2. **L'humain met le token + tenant/channel en config du/des dépôt(s) de mod**
   (Settings → Secrets and variables → Actions) :
   - Secret   `RECUBE_TOKEN`  = `rcs_…` (token de service, lié au tenant)
   - Variable `RECUBE_TENANT`  = `nationsglory`
   - Variable `RECUBE_CHANNEL` = `beta`

   > **Pas d'ID de draft à gérer** : le CLI cible le draft OUVERT de
   > (tenant, channel) via l'endpoint `/drafts/current`. L'ID change à chaque
   > cycle de publication — fixer tenant+channel suffit.
3. **Chaque push sur `deploy` d'un mod ajoute son jar au draft** (workflow
   ci-dessous).
4. **L'humain review + publie** quand tout est prêt :
   ```bash
   recube draft diff       # vérifie ajoutés/remplacés/retirés
   recube draft publish -t nationsglory -c beta -n "changelog…"
   # -t/-c → fetch le draft en cours (pas besoin du draft.json local) ;
   # -r (reference) auto si omis ; puis promote (séparé) côté admin pour le go-live
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
export RECUBE_TENANT=nationsglory
export RECUBE_CHANNEL=beta

# Cible le draft OUVERT de nationsglory/beta (pas d'ID à fournir) :
recube draft add ./build/libs/my-mod.jar

# Ou un draft précis (rare) :
recube draft add ./build/libs/my-mod.jar --draft 019ee2xx-… --tenant nationsglory --channel beta
```

`RECUBE_TOKEN` court-circuite l'OAuth navigateur (prioritaire sur la session
stockée). Sans lui, le CLI reste en OAuth interactif pour les devs — rien ne
change.
