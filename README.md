# codex-archiver

A local browser and restoration tool for old, archived, hidden, and hard-to-find Codex Desktop threads.

## Status

Early scaffold. The current implementation is read-only: it scans local Codex storage and serves a browser UI, but it does not restore or mutate threads yet.

## Usage

```bash
npm install
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:8976
```

The first screen shows summary badges for total threads, total projects, and viewable threads, followed by separate filters for thread names, content previews, project paths, and restoration status.

## CLI

```bash
npm run scan
```

The scanner reads:

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`

Use a non-default Codex home with:

```bash
node dist/cli.js serve --codex-home /path/to/.codex
node dist/cli.js scan --codex-home /path/to/.codex
```

## Safety

This first version is intentionally read-only. Restore planning and backup-backed mutation will be added in later PRs.
