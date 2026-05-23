# Changelog

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
