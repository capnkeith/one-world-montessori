# OWM

One World Montessori's versioned MCP/CLI tools framework over Google
Workspace. See [SPEC.md](SPEC.md) for the full architecture write-up —
this file is just the quick start.

## Quick start

```
npm install
npm test                # run every tool's internal tests
npm run doctor           # health-check the install
npm run mcp               # MCP stdio server (point Claude Desktop/Code at this)
npm run http               # local HTTP server on 127.0.0.1:39390
```

Sample app (talks to the HTTP server, no Claude/MCP access required):

```
sample-app\launch.bat
```

See who else is online and pass arbitrary data between peers (the
`channel` tool — presence is per-process until a real shared backend
is wired in, see SPEC.md):

```
node src/cli.js call channel '{"action":"announce"}'
node src/cli.js call channel '{"action":"list"}'
node src/cli.js call channel '{"action":"send","to":"broadcast","payload":{"note":"hi"}}'
node src/cli.js call channel '{"action":"receive"}'
```

Browse real Google Drive, read-only (the `drive` tool — see SPEC.md
for the full OAuth setup story; first run needs a one-time browser
consent, then it's silent):

```
node src/cli.js call drive '{"action":"setup","clientJsonPath":"<path to downloaded client_secret json>"}'
node src/cli.js call drive '{"action":"browse","folderId":"root"}'
node src/cli.js call drive '{"action":"search","query":"budget"}'
```

Staged blue-green install/update (stages, tests in isolation, only
promotes on green):

```
node bootstrap/install.js <git-url-or-local-path> [branch]
```

## Layout

```
src/core/     Tool, ToolSet, SecretStore, Profile — the versioned framework itself
src/tools/    Individual tools (doctor, echo, channel, drive — more real Google Workspace tools land here)
src/server/   MCP stdio server + local HTTP server (both wrap the same ToolSet)
src/cli.js    CLI front end (same ToolSet again)
bootstrap/    The staged install/update mechanism
sample-app/   Minimal HTML/JS front end with no Claude/MCP dependency
test/         node:test suite (internal + real-world-fixture tests)
```
