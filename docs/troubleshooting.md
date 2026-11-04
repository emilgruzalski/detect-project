# Troubleshooting

## Where did a value come from?

Every `*-source` output (`version-source`, `language-version-source`) names the file — and field — a value was read from.

With [step debug logging](https://docs.github.com/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging) enabled (`ACTIONS_STEP_DEBUG` = `true`, or *Re-run jobs → Enable debug logging*), the log also shows, for every resolved value, which sources were tried before it and had nothing:

```
[apps/api] node version: "1.4.0" from .release-please-manifest.json (nothing in: package.json:version)
[apps/api] node runtime: "22" from ../../.nvmrc
```

The prefix is the inspected directory relative to the workspace root, so `discover` runs can be told apart.
