# Submitting to the DSH plugin market

The market in DSH (Settings → Plugins → 市场 / “Discover”) reads **index documents**
listed in the `plugin-market` row's `indexes`. The default one is the community
catalog maintained by [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):

```
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

Being listed there is what makes the plugin discoverable — no SDK, no review of
binaries, just one YAML entry in that repository.

## Three places show text, and they are not the same file

This is the part that trips people up: changing the description in this repository
does **not** change the market card.

| Where the text appears | What actually feeds it | Where to change it |
|---|---|---|
| Market card in Discover | `data/plugins/VergilYe__dsh-auto-continue.yml` **in the catalog repo** | PR to `awesome-dsh-plugin/awesome-dsh-plugin` |
| Plugin detail page — title & one-line summary | `locale/*.json` → `meta.description` in **this** repo | here, then `npm publish` |
| Plugin detail page — long description | `meta.detail` file, or the **README** when none is declared | `README.md` here, then `npm publish` |

`market/VergilYe__dsh-auto-continue.yml` in this repo is a **staging copy** of the
catalog entry. Nothing reads it; it exists so the submission is reviewable and
versioned next to the code. Updating it has no runtime effect.

DSH has no separate “release notes” / changelog concept for plugins: the detail page
is `meta.description` plus a document (or README). So “update notes” means updating
those, and bumping the version so the installed copy picks them up.

### The detail page reads the installed package

The detail page for an installed bundle reads that bundle's own files, not npm and not
GitHub. With a `link:` install it tracks the working tree immediately; with a registry
install you must publish a new version and upgrade for the text to change.

## The submission

One file: `data/plugins/VergilYe__dsh-auto-continue.yml` (in the **catalog** repo).

Current content — capability-first, per `contributing.md` (`description.en` must be a
single line ending with a period):

```yaml
url: https://github.com/VergilYe/dsh-auto-continue
name: VergilYe/dsh-auto-continue
category: session
description:
  en: 'Retries provider overload (429/529 overloaded_error, GLM code 1305) every 10 seconds with no attempt ceiling after DSH''s own retries run out, instead of failing the turn; turns a silently truncated reply into an in-step retry; and requires a done/ask block so a plan-only reply cannot close the turn.'
  zh: '上游过载（429/529 overloaded_error、GLM 错误码 1305）在 DSH 自带重试耗尽后每 10 秒无限重连，不判死这一轮；静默截断的回复在同一请求步内自动重发；并要求 done/ask 收尾声明，让只写计划的回复关不掉这一轮。'
```

- The filename is `<owner>__<repo>.yml`.
- `category: session` — the plugin acts on turn lifecycle. (`workflow` would also be
  defensible; maintainers re-file without bouncing the PR.)
- The description contains `: `, so it **must** be quoted. A single quote inside an
  English string is escaped by doubling it (`DSH''s`).
- CI checks: `description.en` present, non-empty, **one line**, ends with a period.
  No length cap is enforced, but the card truncates — lead with the capability.

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
| PR | [awesome-dsh-plugin#11521](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11521) — **merged** by fkysly on 2026-11-05 01:04 (+08) |
| Upstream entry | `data/plugins/VergilYe__dsh-auto-continue.yml` exists on `main` |
| npm | **`@vergilye/dsh-auto-continue@2.1.0`** published 2026-11-24 (was 2.0.0) |
| Market listing | live for 2.0.0; 2.1.0 appears after the next nightly catalog rebuild |
| Blocking | none |

### 2.1.0 publish record

Published 2026-11-24 by `vergilye <342365289@qq.com>`:

- Tarball: 8 files, 33.8 kB packed / 99.7 kB unpacked
- `shasum`: `481f292a92c34d9ae747c690152fd89420cf0420`
- `integrity`: `sha512-qtjICWSSJ6HGdnW7/dy8i2rtDahrFwTzAtTEBbXFsUcpTasSHX9Xos3Eyp0nlcf1hM+ELJTZKy9a5P+8z1XYEg==`

`npm publish` printed its success banner while the registry still answered
`E404` for about a minute, then `dist-tags.latest` flipped to `2.1.0`. That is
npm's normal post-publish processing, not a failure — poll the registry rather
than trusting the first read after publishing.

The published tarball was downloaded back (`npm pack`) and checked before being
trusted: `classifyOverload`, `FATAL_CODES`, `OVERLOAD_POLICY_KEY` and the
`overloadReconnect: true` / `overloadRetryIntervalMs: 10_000` defaults are all
present, and the real-cordis check passes against the unpacked tarball (5
provider retries, then 15 unbounded reconnects, retry numbers 1–15).

### Publishing a future version

On a machine with an npm token in `~/.npmrc`
(`//registry.npmjs.org/:_authToken=…`, written by `npm login`):

```
npm publish --access public
```

The market index only lists versions npm actually carries, so a new version
becomes installable from the market after both the publish and the next nightly
catalog rebuild. Note that the token lives in plain text in `~/.npmrc`; the
2.0.0 credential went missing from this machine at some point and had to be
re-authorised, so prefer a short-lived granular token scoped to this package.

### Why the npm package was the last blocker

A merged entry alone does not put a plugin in the market. `scripts/lib/market-index.mjs`
in the catalog repository states the rule:

> What can be listed: an entry needs an npm package, an exact version, and that version's
> publish time. The GitHub-only half of the list cannot be expressed yet.

So the index skips entries without npm (`skipped.noNpm`), and every one of the 4,381
entries in the published index carries a non-empty `versions`. The same-day merges
`TLEWA/dsh-if` and `TLEWA/dsh-better-choice` were missing from the index for exactly this
reason.

The bare name `dsh-auto-continue` is owned by an unrelated package (`spix18`), so this
ships as `@vergilye/dsh-auto-continue`. `probe-npm.mjs` accepts a package only when its
`repository` field points back at the same GitHub repo, which this one does.

### After a rename, reinstall the local bundle

The loader row name follows the package name, so a profile that still has the old
`link:dsh-auto-continue` install will not resolve on its next start:

```
plugin_manager  action: remove_bundle   target: @vergilye/dsh-auto-continue
plugin_manager  action: install_bundle  target: F:\SoftWare\DeepseekHarness\本地工作区\plugins\dsh-auto-continue
```

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
5. ~~Open a PR titled `Add VergilYe/dsh-auto-continue`~~ — done: #11521, merged 2026-11-05.
6. ~~Publish the package to npm~~ — done: `@vergilye/dsh-auto-continue@2.0.0`.
7. Waiting on the next nightly catalog rebuild (2026-11-06 10:23 +08). It regenerates the
   index from `data/plugins/*.yml` plus the npm probe, publishes it to npm, and the CDN
   copy follows.

## After listing

Users can then find it under Settings → Plugins → 市场 and install it with one click:

```
dsh plugin --profile web add @vergilye/dsh-auto-continue
```
