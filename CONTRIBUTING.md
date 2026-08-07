# Contributing

Thanks for considering a contribution.

## Development

```bash
git clone https://github.com/YOUR_USER/codex-wechat.git
cd codex-wechat
npm install
npm run typecheck
npx tsx scripts/probe-codex.ts   # requires local `codex login`
```

- Node.js **≥ 22**
- Do not commit `config.yaml`, WeChat credentials, or `state.json`
- Keep PRs focused; prefer small, reviewable changes

## Security and release checks

Changes to paths, agent networking, packaging, or deployment must verify the
real runtime boundary: include a symlink-escape test, build the project, inspect
the packed npm file list, and smoke-test the built `codex-wechat init` command.
Never publish a package that omits a `postinstall` script dependency, defaults
cwd to the user's home, exposes a non-loopback plaintext agent implicitly, runs
the agent as root, or accepts a placeholder token.

## Codex model RPC compatibility

When upgrading Codex CLI, verify model operations against a real
`codex app-server --stdio` process in addition to unit tests:

- `config/read` returns the current `model` and `model_reasoning_effort`.
- `model/list` returns IDs and `supportedReasoningEfforts`.
- `config/value/write` is called with `keyPath`, `value`, and
  `mergeStrategy: "replace"`. Current Codex builds reject the request when
  `mergeStrategy` is omitted.
- Perform the write smoke test by writing the current values back, then read
  them again and assert they are unchanged.
- Regenerate the experimental app-server schema and verify `thread/start` and
  `thread/resume` still accept `sandbox: "read-only"` plus
  `approvalPolicy: "on-request"`. Verify
  `item/permissions/requestApproval` responses return the requested
  `permissions` with `scope: "turn"`, not a generic decision string.

Run `npm test`, `npm run typecheck`, and `npm run build` after the probe.

## Pull requests

1. Describe the problem and the approach.
2. Note the Codex CLI version you tested (`codex --version`).
3. Ensure `npm run typecheck` passes.
4. Avoid drive-by refactors unrelated to the change.

## Scope notes

This project intentionally stays small: **one daemon per machine**, WeChat-only by default, single-user bind. Large features (multi-tenant gateway, extra IM channels, desktop UI) should be discussed in an issue first.
