---
name: dev-setup
description: Set up or repair a local UniMind development environment for this repository. Use when a developer needs first-time local setup, wants to restart or rerun UniMind onboarding, or needs Claude/Codex hook and MCP wiring plus Docker stack verification for this project.
---

# Dev Setup

Run the repo-owned setup script instead of hand-editing developer machines by hand.

## Workflow

1. Resolve the UniMind repo root.
- If the current working directory is the `unimind` repo root and contains `docker-compose.yml`, `package.json`, and `src/mcp/server.ts`, use it.
- Otherwise ask the user for the absolute path to their `unimind` checkout, then pass it with `--repo-root`.

2. Run the setup script with `npx` so a fresh machine can bootstrap before local `node_modules` exists.

```bash
npx --yes tsx scripts/dev-setup.ts
```

If you needed an explicit repo path:

```bash
npx --yes tsx /absolute/path/to/unimind/scripts/dev-setup.ts --repo-root /absolute/path/to/unimind
```

3. If the user says `restart the dev-setup` or reruns the skill, run the same command again.
- The script resumes from `.unimind/dev-setup-state.json` when an earlier run stopped mid-setup.
- After a successful run, rerunning acts as an audit-and-repair pass.

4. Do not manually edit `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/hooks.json`, or `~/.codex/config.toml` unless the script explicitly reports malformed config and asks for manual repair.

5. If the script stops on missing prerequisites, relay its next-step instructions to the user exactly.
- The script is the source of truth for what is missing and how to continue manually.

6. After the script finishes, summarize:
- which assistant targets were configured
- whether each UniMind hook/MCP entry was `added`, `updated`, `unchanged`, or `skipped`
- whether the Docker stack was already healthy or had to be repaired
- probe results for Helix, iii, worker, and dashboard
- that `iii console` can be run from any folder and opens `http://127.0.0.1:3113/`
