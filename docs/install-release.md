# Install and release hardening

Planning notation: `M5-PACKAGING-RELEASE-HARDENING`
Milestone: `M5: Packaging and release hardening`

## Install modes

Use a checkout for development:

```bash
npm install
npm run build
npm link
codex-archiver --help
codex-archiver serve
```

Use a packed tarball for release candidate checks without publishing:

```bash
npm pack
npm install -g ./codex-archiver-0.1.0.tgz
codex-archiver --version
codex-archiver serve
```

## Package artifact contract

The npm package is intentionally allowlisted. It includes:

- compiled runtime JavaScript under `dist/`
- the top-level `web/` assets served by `codex-archiver serve`
- `README.md`
- `LICENSE`
- user-facing docs for install/release, search index, visibility diagnostics, and restore planning

It excludes:

- TypeScript source files
- compiled test files
- GitHub workflow files
- local worktrees
- package smoke-test scripts
- package lockfile
- PR review/remediation process notes

## Release validation

Run the local release gate before handing off any release candidate:

```bash
npm run check
npm test
npm run package:smoke
```

`npm run package:smoke` creates a real tarball in a temporary directory, installs that tarball into a temporary consumer project, verifies the installed `codex-archiver` bin, checks `--help` and `--version`, launches `codex-archiver serve` from the installed package, fetches the browser shell and stylesheet, and checks the packed file list.

GitHub Actions runs the same package smoke command after typecheck and tests.

## Safety boundaries

Publishing to npm is not automated and this project does not store or require an npm publish token.

Packaged installs preserve the product safety model:

- the first screen is the actual local thread browser
- archived threads and UI-hidden threads remain separate states
- derived search/cache state stays under `~/.cache/codex-archiver`
- `~/.codex` remains the source of truth
- restore apply and confirmed undo remain explicit, confirmation-gated, backup-backed mutation paths
