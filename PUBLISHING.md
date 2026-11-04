# Submitting to the DSH plugin market

The market in DSH (Settings → Plugins → 市场 / “Discover”) reads **index documents**
listed in the `plugin-market` row's `indexes`. The default one is the community
catalog maintained by [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):

```
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

Being listed there is what makes the plugin discoverable — no SDK, no review of
binaries, just one YAML entry in that repository.

## The submission

One file: `data/plugins/VergilYe__dsh-auto-continue.yml`

```yaml
url: https://github.com/VergilYe/dsh-auto-continue
name: VergilYe/dsh-auto-continue
category: session
description:
  en: 'Keeps a turn from closing on an unfinished reply: a stream guard turns silent truncation into an in-step retry, and a completion protocol asks the model to declare how each turn ended.'
  zh: '避免轮次停在「话没说完」或「只写了下一步计划」上关闭：把静默截断的流转成同一步内可重试的失败，并要求模型在每轮结束时声明收尾方式。'
```

- The filename is `<owner>__<repo>.yml`.
- `category: session` — the plugin acts on turn lifecycle. (`workflow` would also be
  defensible; maintainers re-file without bouncing the PR.)
- The description contains `: `, so it **must** be quoted.

## Requirements, checked by CI

| Requirement | Status here |
|---|---|
| `package.json` declares `dsh.bundle.patch` | ✅ `{"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}` |
| `cordis.patch.yml` exists next to it | ✅ |
| Real, working code (not a placeholder) | ✅ 48 KB host plugin, 63 unit tests |
| Repository at least 1 day old | ✅ created 2026-11-03, gate re-ran 2026-11-04 and passed |
| Repo carries the `dsh-plugin` topic | ✅ added |
| Description accurate, no marketing language | ✅ describes exactly what the code does |

Also recommended by the guide, and satisfied here:

- **No build step** — pure ESM, zero dependencies, so installing from source needs no
  `allowBuilds` approval.
- No `@deepseek-ai/*` runtime dependencies at all, so no prerelease peer-range trap.

## Status

| Item | State |
|---|---|
| PR | [awesome-dsh-plugin#11521](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11521) — open, both checks green, `mergeable_state: clean` |
| Blocking | nothing on our side; waiting for a maintainer to read the repo and merge |
| After merge | catalog regenerates from `data/plugins/*.yml` on `main`, CDN copy follows |

## Why this is not a duplicate

Three entries already recover an interrupted turn: `HsiangNianian/dsh-auto-continue`,
`baosfeng/my-dsh-plugins#dsh-task-reliability`, `haochi72/dsh-auto-continue-429`. All three
act **after** the reply ends — they decide it looks unfinished and queue another `继续`.

This plugin works one layer earlier, which is what makes two shapes reachable:

| Shape | Why the after-the-fact entries miss it | What this does |
|---|---|---|
| Cut stream with a valid `stopReason: "stop"` | nothing looks wrong to a text heuristic; the reply reads as complete | rewrites the stream into a retryable error so the retry happens **inside the same step** |
| `stopReason: "stop"` with an **empty body** (answer went into the reasoning channel) | there is no text to judge | same in-step retry; the turn never reaches "ended" |

Plus a protocol layer: the model declares its ending with a fenced `done`/`ask` block that
must be the last thing in the message, so the decision is deterministic instead of a
phrasing guess.

## Steps

1. ~~Add the `dsh-plugin` topic~~ — done.
2. ~~Wait until the repository is at least one day old~~ — done (gate passed 2026-11-04).
3. ~~Fork `awesome-dsh-plugin/awesome-dsh-plugin`~~ — done (`VergilYe/awesome-dsh-plugin`).
4. ~~Add `data/plugins/VergilYe__dsh-auto-continue.yml`~~ — done.
5. ~~Open a PR titled `Add VergilYe/dsh-auto-continue`~~ — done: #11521.
6. Waiting on a maintainer to read the repo and merge. The catalog is regenerated from
   `data/plugins/*.yml` on `main`, and the CDN copy follows shortly after.

## After listing

Users can then find it under Settings → Plugins → 市场 and install it with one click.
Publishing to npm additionally lets the market install a prebuilt package, but it is
not required: this bundle has no install scripts, so source installation works as is.
