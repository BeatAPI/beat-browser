# Release BeatBrowser

The npm package and unpacked Chrome extension belong to the same version.
Publication is distinct from a successful pack check or a GitHub push.

## Prepare

1. Fetch origin and inspect the working tree. Preserve unrelated local edits.
2. Review the final source, README, upstream credits and package file list.
3. Keep `package.json`, package-lock root version and extension manifest version
   in sync when incrementing a release.
4. Run `npm ci`, `npm test`, `npm run check:syntax`, `npm run check:security`,
   `npm run check:package` and `npm run build:extension`.
5. Inspect the staged diff for credentials and browser/customer data. Never
   commit runtime logs, traces, profile data or private site notes.

The package check builds a tarball, installs it in a temporary directory, checks
documentation/media/runtime files, exercises a fake-home install, and checks
Normal-mode MCP tool discovery. It never configures the maintainer's agents.

## First publication

`npm whoami --registry=https://registry.npmjs.org` must succeed for an account
with permission to publish under `@beatapi`. Complete npm login/2FA in the npm
UI, not in chat. A registry 404 means the package is not publicly available.

Scoped public packages need `--access public`; `publishConfig` also fixes the
registry and public access. Publish the reviewed package from its release
checkout or an already inspected tarball:

```bash
npm publish --access public
```

If npm requests 2FA or account verification, the account owner completes it.
Report an authentication failure as a blocked publication, not a release.

## Subsequent GitHub Actions releases

Configure an npm trusted publisher for organization `BeatAPI`, repository
`beat-browser`, workflow file `publish.yml`. Setting `id-token: write` in
GitHub alone does not establish that trust relationship. The package workflow
runs on a `v*` tag or manual dispatch, checks the package and publishes publicly.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

## Verify delivery

- Confirm `npm view @beatapi/beat-browser version dist.tarball` on the official
  registry and install the exact released version in a clean prefix.
- Verify CLI startup, extension folder and MCP tool discovery from that install.
- On a fresh Chrome profile, load that installed extension, then run doctor and
  a read-only task. CLI installation alone does not prove extension connection.
- Record the source SHA, publish mechanism/result and live-browser test separately.
- Only then report the release publicly and update any release announcement.

The extension ZIP is a separate artifact. Building it does not publish it to the
Chrome Web Store. Do not advertise a store listing until it is actually verified.
