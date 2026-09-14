# NS Opportunity → Sales Order Sync

SuiteScript 2.1 for the NetSuite feature that keeps a sales order's Record Status and expected
ship date in step with the opportunity it belongs to. When a won opportunity is saved, its sales
orders are brought into line — the design sub-status is translated through a mapping held in
NetSuite, and the delivery date is copied across.

It replaces `acs_ue_update_so.js`, which drove the same updates from a CAD Worklist custom record
that is being retired. The two must never run at the same time.

## Canonical reference

**[`docs/context.md`](docs/context.md) is the single source of truth for this project.** Read it
before changing anything. It records the design constraints, the NetSuite traps that shaped them,
the audit log keys, the deployment sequence and the open items.

If this README and `docs/context.md` disagree, the context document wins. If either disagrees with
the code, the code wins — and the document gets fixed in the same PR.

## Layout

```
src/FileCabinet/SuiteScripts/OpportunitySOSync/
    lib/                 shared modules — uploaded, but no script record needed
docs/context.md          canonical project context
```

The `src/FileCabinet/...` path mirrors the NetSuite File Cabinet exactly. There is no SDF project;
the path exists so that a reader can tell where each file belongs in the File Cabinet without
asking, and because the relative imports between scripts only resolve if the tree is preserved.

## Conventions

Script file names carry the entry-point type, so it shows up in PR file lists:

| Pattern | Example |
|---|---|
| `opsync_ue_<purpose>.js` | `opsync_ue_opportunity_sync.js` |
| `lib/opsync_lib_<purpose>.js` | `lib/opsync_lib_config.js` |

Script records use `customscript_opsync_<type>_<purpose>` and deployments
`customdeploy_opsync_<type>_<purpose>`.

Every `log.audit`, `log.error` and `log.debug` title begins `OPPSYNC_` — one string to grep the
execution log for.

Each script carries a `VERSION` constant and a matching JSDoc `@version` header. Semver.

## Deployment

**Manual File Cabinet upload. Steve deploys — nobody else, and no automated deploy exists.**
Upload the shared library first; every other script fails at load time without it. Full sequence
in [`docs/context.md` §8](docs/context.md), including disabling the old `acs_ue_update_so.js`
deployment.

## Three rules for contributors

1. **Never commit internal IDs.** Numeric record IDs, list option IDs, status IDs and custom form
   IDs differ between Sandbox and Production. They belong in script parameters or on NetSuite
   records, never in code. Script IDs — `customrecord_*`, `custbody_*`, `customscript_*` and the
   rest — are stable across environments and are fine to commit. The distinction is set out in
   [`docs/context.md` §3](docs/context.md).

2. **Never copy a status value across raw.** The opportunity sub-status list and the Sales Order
   Record Status record are unrelated lists. Every transfer goes through the mapping. This is
   trap 1 in [`docs/context.md` §0](docs/context.md) and it is the most damaging mistake available
   in this codebase.

3. **Never merge without Steve's explicit instruction.** Work goes on a branch with a PR and
   waits. Steve merges; Steve deploys.
