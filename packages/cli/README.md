# @loomup/cli

Declare a Loomup project's tables, fields, types, defaults, and indexes in YAML.
Loomup derives and safely reconciles the database schema; application developers
do not write migration SQL.

```bash
npm install @loomup/client
npm install --save-dev @loomup/cli
npx loomup init
```

Platform authentication always uses `https://tryloomup.com`; the CLI does not
accept an authentication URL override. Login stores the platform session in a
local user-only credential file:

```bash
npx loomup auth login
npx loomup auth status
npx loomup auth logout
```

Login prints the workspaces available to the account. You can inspect or create
them again at any time, then provision a project and link the current package:

```bash
npx loomup workspaces list
npx loomup workspaces create --name "Acme"     # only when another workspace is needed
npx loomup projects create --name my-app --link
```

When the account has one workspace, project creation selects it automatically.
With several workspaces, an interactive terminal prompts for one; scripts must
pass `--workspace <workspace-id>`. Without `--link`, the CLI prints the exact
`loomup link` command to run next. `npx loomup projects list` lists projects from
all accessible workspaces; `--workspace` filters the result.

Logged-in project managers can configure native App Attest and Play Integrity
identities without editing the hosted manifest directly:

```bash
npx loomup app-integrity set-ios --project <project-id> --app-id ios_main \
  --team-id ABCDE12345 --bundle-id com.example.app --apple-app-id 1234567890

npx loomup app-integrity set-android --project <project-id> --app-id android_main \
  --package-name com.example.app --cloud-project-number 123456789012 \
  --certificate-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

npx loomup app-integrity put-google-credential --project <project-id> \
  --file ./google-play-integrity.json
npx loomup app-integrity set-mode --project <project-id> --mode audit
npx loomup app-integrity status --project <project-id>
```

Inside a package linked to `https://tryloomup.com`, `--project` is optional for
project-key and app-integrity commands. `--project` and `LOOMUP_PROJECT_ID`
remain available as explicit overrides.

Start in `audit` before enabling `enforce`. Use `--allow-development` only for
a separate development identity. These commands require `loomup auth login` or
`LOOMUP_PLATFORM_TOKEN`; workspace and project API keys cannot change the
mobile security policy. Credential contents are sent write-only and never
printed or persisted by the CLI.

Workspace API keys provide non-human control-plane automation without granting
direct access to project data. Create one in **Workspace API keys**, then use it
from CI to provision projects and issue project keys within its delegation
ceiling:

```bash
export LOOMUP_WORKSPACE_API_KEY="lbsk_…"

npx loomup projects create --workspace <workspace-id> --name my-app
npx loomup project-keys create \
  --project <project-id> \
  --name schema-deployer \
  --scope schema:plan \
  --scope schema:apply
```

Workspace API keys are intentionally workspace-scoped, so their project list
and create commands always require `--workspace` even when a package is linked.

`loomup init` creates documented `loomup.schema.yaml` and `loomup.access.ts`
starters and records their paths in `package.json#loomup`. It never overwrites
existing files. Linking a project also creates either starter when it is missing.

The YAML contains only data shape. The TypeScript access file selects a typed
application profile; Loomup infers relationship access for child rows and R2
objects, compiles the low-level rules internally, and enforces them server-side.
Developers do not maintain `exists(...)` expressions or per-table CRUD rules.

```bash
# Create a project API key with Schema · Apply in Loomup Studio.
export LOOMUP_API_KEY="loomup_sk_…"

npx loomup link \
  --url https://loomup.example.com \
  --project <project-id>

npx loomup migrate --plan
npx loomup migrate
```

`init`, `link`, and every successful `migrate` also generate a project-specific
TypeScript client at `.loomup/client.ts`. Regenerate it without touching the
remote database with `npx loomup generate`; use `npx loomup generate --check`
in CI to reject stale checked-in output. `package.json#loomup.output` changes
the default output path.

Realtime is disabled unless the schema declares a table explicitly:

```yaml
$realtime:
  tables: [issues, issue_comments]
```

Migration plans show realtime enable/disable changes. Unknown table names fail
before deployment, and the generated `RealtimeTable` type lets TypeScript
subscription helpers prevent subscriptions to undeclared tables.

```ts
import { createDb } from "./.loomup/client";

const db = createDb({ serviceKey: env.LOOMUP_API_KEY });
const issues = await db.issues.list({ where: { project_id: projectId } });
const issue = await db.issues.create({ project_id: projectId, title: "First issue" });
await db.issues.update(issue.id, { title: "Updated" });
await db.issues.delete(issue.id);
```

The generated module contains row, insert, and update types plus the linked
project gateway URL. Credentials are passed explicitly at runtime and are never
written into source or `package.json`. Override the gateway with the `url`
option when needed.

Destructive changes require `--allow-data-loss`. `LOOMUP_API_KEY` is preferred
for local and CI use; give it `schema:plan` or `schema:apply` only. An interactive
`LOOMUP_PLATFORM_TOKEN` also works. The CLI never writes either credential into
the project.

If the same credential also powers the application backend, choose Studio's
**Full backend** preset. Its `project:backend` capability includes schema
deployment and every Resource or operation added to the project later.
