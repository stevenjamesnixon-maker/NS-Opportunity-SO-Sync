# NS Opportunity → Sales Order Sync

SuiteScript 2.1 for the NetSuite feature that keeps a sales order's Record Status and expected
ship date in step with the opportunity it belongs to. When a won opportunity is saved, its sales
orders are brought into line — the design sub-status is translated through a mapping held in
NetSuite, and the delivery date is copied across.

It replaces `acs_ue_update_so.js`, which drove the same updates from a CAD Worklist custom record
that is being retired. The two must never run at the same time.

The repo also carries a second, separate feature: **Design Instruction**. The CAD Worklist record,
`customrecord_cad_worklist`, is repurposed as a Design Instruction — one row per design or redraw,
a child of the opportunity. A row is created when the opportunity's sub-status moves to a creating
value — by hand, or with the Request Design / Request Redraw buttons on the opportunity — and
completing it (entering its completed date) moves the opportunity on to *Post Design Check*. It has its own config module, its own parameters and its own `DSI_` log prefix, shares only
the value-shape module with the sync, and modifies none of the sync's files. See
[`docs/context.md` §11](docs/context.md).

## Canonical reference

**[`docs/context.md`](docs/context.md) is the single source of truth for this project.** Read it
before changing anything. It records the design constraints, the NetSuite traps that shaped them,
the audit log keys, the deployment sequence and the open items.

If this README and `docs/context.md` disagree, the context document wins. If either disagrees with
the code, the code wins — and the document gets fixed in the same PR.

## Layout

```
src/FileCabinet/SuiteScripts/OpportunitySOSync/
    opsync_ue_opportunity.js         sync — afterSubmit on Opportunity
    opsync_ue_salesorder.js          sync — afterSubmit on Sales Order
    dsi_ue_opportunity.js            Design Instruction — buttons (beforeLoad), creates rows (afterSubmit)
    dsi_cs_opportunity.js            Design Instruction — the buttons' client script; no script record
    dsi_ue_design_instruction.js     Design Instruction — gate and completion, on the row
    lib/                             shared modules — uploaded, but no script record needed
        opsync_lib_config.js         sync configuration
        opsync_lib_values.js         value-shape layer — used by both features
        opsync_lib_readiness.js      delivery readiness
        dsi_lib_config.js            Design Instruction configuration
docs/context.md                      canonical project context
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
execution log for. The Design Instruction scripts use `DSI_` instead, so the two features filter apart.

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
