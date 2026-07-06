# Changelog

## 0.7.5 — 2026-07-06

### Changes

- **`recube promote -b <val>` accepte un tag de version** : si `<val>` n'est pas
  un build_id (UUID 36), il est traité comme un tag de version (ex `1.0.60`),
  résolu en build_id via le listing des versions du tenant/channel, puis promu.
  Un UUID reste utilisé tel quel (comportement inchangé). Fini les 404 opaques
  quand on passait un tag (route 404) ou un id de draft (build_not_found).
- **Messages d'erreur clairs** : tag introuvable donne « version <val>
  introuvable sur {tenant}/{channel} (voir recube versions list) » ; version
  sans build promotable a un message dédié ; UUID de draft (404 build_not_found)
  donne « cet id ressemble à un draft, pas à un build ; promeus par tag ou
  build_id ».
- **`--tag <tag>`** : alias explicite de `-b` forçant le traitement « tag »
  (`-b` conservé pour la compat, auto-détection UUID/tag). Nommé `--tag` et non
  `--version` : ce dernier entre en collision avec le flag version global de
  commander (`-v, --version`), qui l'intercepterait avant le parse.
- **`recube versions list`** affiche désormais une colonne `build_id` (la valeur
  à passer à `recube promote`).
- **`recube core publish` — même classe de bug corrigée** : son option
  `--version` collisionnait aussi avec le flag global commander (`core publish
  --version X` imprimait la version du CLI et sortait en no-op silencieux = une
  release CI cassée qui paraît réussie). Renommée `-V, --version-tag` (même
  convention que `merge` / `draft create`) ; `-V` court inchangé.

## 0.4.1 — 2026-06-30

### Changes

- **Help redesign — same visual language everywhere** : every `--help` page now
  renders like the `recube` home screen — a brand box header (logo + tagline +
  auth status), bulleted sections in brand violet (Usage / Arguments /
  Commandes / Options / Exemples), and a Docs footer. Replaces commander's plain
  layout, applied to every command and subcommand via a custom `formatHelp`.
  Previously the subcommand help showed the raw ASCII banner (or no header on
  older installs); now it matches the home screen consistently.

## 0.4.0 — 2026-06-30

CLI ergonomics pass on the draft flow + help consistency.

### Changes

- **`draft create` `-V, --version-tag` is now optional** : the version
  auto-increments server-side (next patch of the channel) by default, so you no
  longer need to pass it. Provide `-V` only to override for a minor/major bump
  (validated `>` the online version). The created draft returns the effective
  assigned version.
- **`draft publish` can resolve the open draft from `--tenant`/`--channel`** :
  pass `-t <tenant> -c <channel>` to fetch the in-progress (status `open`) draft
  of that pair server-side — no local `.recube/draft.json` nor draft id needed.
  Clear message when no draft is open. Without `-t`/`-c`, it falls back to the
  local current draft as before.
- **`draft publish` flags `-r`/`-n` are now optional** : `--reference`
  auto-defaults to `{tenant}-{channel}-{version}-b{ts}` (parity with `publish`),
  `--note` is generated when omitted (a warning nudges toward an explicit
  changelog via `-n`).
- **Help header is ISO across all commands** : the brand banner now shows on
  every subcommand `--help`, not only the top-level, via the root program's
  inherited `beforeAll` help text.

## 0.2.1 — 2026-06-11

Hotfix release driven by the 1.0.5 NationsGlory anti-cheat republish operation —
the sibling RecubeCore auto-detect was attaching the jar at the wrong path,
silently triggering `missing_recube_core` refusals on the backend.

### Bug fixes

- **Auto-detect path mismatch (critical)** : the sibling RecubeCore jar was
  attached as `mods/recube-core.jar`, but the backend `BuildPipeline` expects
  the agent jar at the **root** of the bundle (`recube-core.jar`, exact equality
  match — cf. `RecubeGG BuildPipeline.php:619`). All auto-detect publishes on
  channels that enforce the recube-core check were being silently refused with
  `missing_recube_core`. Now attached at root.
- **Dry-run récap shows real includes** : the recap block was built *before*
  the auto-detect prompt resolved, so `includes` always rendered as `none`
  even after the user accepted. Moved recap construction after include
  resolution.

### Features

- **`publish -i / --include <spec...>`** : repeatable flag to manually attach
  a file to the bundle without copying it into the dir first. Spec format :
  `<source>:<target>` (colon-separated) or just `<source>` (target = basename).
  Example : `-i ../RecubeCore/build/libs/recube-core-0.4.0-SNAPSHOT.jar:recube-core.jar`.
  Windows drive letters (`C:\…`) are detected and not parsed as a separator.

### UX

- **`missing_recube_core` error rendering** : when the backend returns
  `{ok:false, error:'missing_recube_core', message:'…'}`, the CLI now surfaces
  the channel name and prints the exact `-i` syntax + sibling-repo fallback
  hint, instead of dumping the raw response body.
- **`doctor --dir`** : now reports the root `recube-core.jar` separately from
  the legacy `mods/recube-core.jar` location ; the latter is flagged with a
  warning since it does NOT satisfy the backend enforcement.

## 0.2.0 — 2026-05-23

### Bug fixes

- **`versions list`** : ne dit plus "Aucune version" silencieusement pour les users non-admin. Cascade :
  1. tente `/v1/admin/games/{slug}/versions` (admin scope)
  2. fallback sur `/v1/games/{slug}/branches/{branch}/versions` (public, si exposé)
  3. ultime fallback : synthèse depuis `/v1/games/{slug}/branches` (1 ligne par channel avec `latest_version`)
- Message clair `admin scope denied` quand le user n'a pas les droits.

### Features

- **`publish --runtime-config <file>`** : envoie `runtime_config` (main_class, jvm_args, java_version, …) au commit pour figer les JVM args sur cette version (vs. inherit silencieux).
- **`.recube/runtime.json` auto-detect** : convention à la racine du build dir, lu automatiquement si présent ; le flag override le fichier auto.
- **`recube doctor`** : diagnose env user (Node, version CLI vs npm, auth, network recube.gg, tenants accessibles, build dir scan). Flag `--json` pour CI.
- **Auto-detect RecubeCore jar voisin** : si un repo `RecubeCore` est trouvé à proximité (jusqu'à 3 dirs au-dessus), propose d'inclure `build/libs/recube-core-*.jar` (le plus récent) comme `mods/recube-core.jar`. Désactivable via `--no-recube-core`.

### QoL

- Progress UI publish : KB/s + ETA secondes à chaque upload.
- Mapping erreurs lisibles :
  - 401 → "token expiré, relance `recube login`"
  - 403 → "scope manquant, demande `launcher.{tenant}.publish`"
  - 422 → liste des champs en échec (Laravel validation errors)
  - 413 → "fichier trop gros pour R2"
  - network → "recube.gg inaccessible, check `recube doctor`"

### Exemple `.recube/runtime.json`

```json
{
  "main_class": "Start",
  "client_jar": "NGClient.jar",
  "java_version": 21,
  "java_vendor": "temurin",
  "java_min_version": "21.0.0",
  "jvm_args": [
    "-Xmx2G",
    "-Xms512M",
    "-XX:+UseG1GC",
    "--add-opens=java.base/java.lang=ALL-UNNAMED"
  ]
}
```

## 0.1.0 — 2026-05-16

Initial release. OAuth PKCE auth, `publish` interactive pipeline, `channels` + `versions` commands.
