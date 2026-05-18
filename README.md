# Recube CLI

CLI for Recube developers. Publish game builds (Minecraft tenants — NationsGlory,
Paladium, …) via the Recube launcher API, with OAuth authentication instead of
hand-passed bearer tokens.

```bash
npm install -g @recube/cli
recube login
recube publish
```

---

## Why

Until now, the official way to publish a build was to run
`RecubeGG/scripts/publish-version.mjs` with `RECUBE_TOKEN=ngi_…` pasted in your
shell. That meant :

- Personal Access Tokens shared via Slack / .env files
- No granular per-developer scopes
- No revocation per device
- No "who shipped what" audit

The CLI replaces that with an OAuth Authorization Code + PKCE flow (same model
as Claude Code, GitHub CLI, Stripe CLI). One `recube login` per machine, the
CLI handles refresh automatically, and a `recube logout` revokes everything.

## Installation

Requires **Node.js 20+**.

```bash
npm install -g @recube/cli
```

Verify :

```bash
recube --version
recube --help
```

## Quick start

```bash
# 1. Authenticate (opens your browser to recube.gg)
recube login

# 2. Publish — fully interactive
recube publish

# 3. Or in CI / scripted mode
recube publish \
  --tenant nationsglory \
  --channel stable \
  --version-tag 1.0.1 \
  --dir ./build \
  --note "Fix anti-cheat false positive" \
  --default-excludes \
  --yes
```

## Commands

### `recube login [--scope <scopes>] [--force]`

Opens a browser to `https://recube.gg/oauth/authorize`, captures the redirect
on a local `127.0.0.1` port, exchanges the code for tokens, and persists.

Tokens are stored :

- **macOS / Linux / Windows** : OS keychain via `keytar`, if installed
- **Fallback** : `~/.recube/credentials.json` with mode 0600

Default scopes : `launcher:publish profile:read`.

### `recube logout`

Clear local credentials and best-effort revoke server-side via
`/oauth/token/revoke`.

### `recube whoami`

Print the current identity (handle, email, scopes, token expiry).

### `recube publish`

Main command. Interactive prompts when args are missing :

| Flag | Description | Default |
|---|---|---|
| `-t, --tenant <slug>` | Tenant slug | prompt (or `tenant_default` from config) |
| `-c, --channel <name>` | Channel name | prompt |
| `-V, --version-tag <ver>` | Version tag | prompt |
| `-d, --dir <path>` | Bundle root | prompt |
| `-n, --note <text>` | Build note / changelog | `Build via CI` |
| `-r, --reference <text>` | Custom reference | `{tenant}-{version}-b{ts}` |
| `--concurrency <n>` | Parallel uploads | `8` |
| `--init-batch <n>` | Files per initiate batch (1..500) | `50` |
| `--default-excludes` | Apply Minecraft default exclude set | `false` |
| `--exclude <p...>` | Extra exclude patterns | `[]` |
| `--dry-run` | Show recap, skip API calls | `false` |
| `-y, --yes` | Skip the final confirmation | `false` |

The pipeline scans the directory, hashes each file (sha256), POSTs
`/launcher/{tenant}/{channel}/builds/initiate` in chunks of 50, uploads missing
blobs to R2 via presigned PUTs (8-way parallel), then POSTs
`/launcher/{tenant}/{channel}/builds/commit`.

### `recube channels list <tenant>`

List launcher channels visible to your account for the given tenant.

### `recube channels create <tenant>`

Interactive prompt to create a new channel (`name`, `label`, `description`,
`is_public`).

### `recube versions list <tenant> [-c <channel>]`

List published versions.

## Configuration

File : `~/.recube/config.json` (Windows: `%APPDATA%/Recube/config.json`).

```json
{
  "apiBase": "https://recube.gg/api/v1",
  "oauthBase": "https://recube.gg",
  "clientId": "recube-cli",
  "tenant": "nationsglory",
  "channel": "stable",
  "concurrency": 8,
  "initBatch": 50
}
```

Environment variable overrides :

| Env var | Overrides |
|---|---|
| `RECUBE_API_BASE` | `apiBase` |
| `RECUBE_OAUTH_BASE` | `oauthBase` |
| `RECUBE_CLI_CLIENT_ID` | `clientId` |
| `RECUBE_CLI_NO_KEYTAR=1` | Force file fallback storage |

## OAuth setup (administrators)

Before users can `recube login`, a public OAuth client must be registered
server-side on RecubeGG :

1. Sign in as admin on `https://recube.gg`
2. Open `/admin/oauth-apps`
3. Create a new app with :
   - **Name** : `Recube CLI`
   - **Type** : public client (no client secret — PKCE only)
   - **Redirect URIs** : `http://127.0.0.1:*/callback` (wildcard port)
   - **Scopes** : `launcher:publish`, `profile:read` at minimum
4. Note the generated `client_id` and either :
   - Update the default in `src/lib/config.ts` (recommended for distribution)
   - Or ship a `~/.recube/config.json` template with `clientId` set
   - Or have users export `RECUBE_CLI_CLIENT_ID=<id>`

Until that client is registered, `recube login` will fail at the authorize
step with the placeholder `client_id: recube-cli`.

## Troubleshooting

### `OAuth callback timeout (5 min)`

The browser never reached the `/callback` URL. Check that no firewall is
blocking the loopback port chosen by the CLI, or copy/paste the URL printed
in the terminal manually.

### `keytar` install warnings

`keytar` is an **optional** dependency. If `npm install` prints native build
errors, the CLI silently falls back to `~/.recube/credentials.json` (mode
0600). Set `RECUBE_CLI_NO_KEYTAR=1` to skip the load attempt entirely.

### `403` on `/launcher/{tenant}/{channel}/builds/initiate`

Your account needs the Recube permission `launcher.{tenant}.publish` (or
`admin`). Ask a Recube admin to grant it via `/admin/permissions/grants`.

### `Pas de channel pour <tenant>`

You first need a channel registered for that tenant. Either :

```bash
recube channels create <tenant>
```

Or use the admin UI at `/admin/games/<tenant>/channels` on `recube.gg`.

## Development

```bash
git clone https://github.com/NationsGlory/RecubeCLI.git
cd RecubeCLI
npm install
npm run dev -- --help    # run from source via tsx
npm run build            # tsc → dist/
npm test                 # vitest
```

## License

MIT — see [LICENSE](LICENSE).
