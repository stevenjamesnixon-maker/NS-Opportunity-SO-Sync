# Opportunity → Sales Order Sync — project context

Canonical reference for this project. If this document and the repository disagree, **the
repository wins** — read the file and then fix this document in the same PR.

Scope of this document: the SuiteScript in this repo and the NetSuite configuration it depends
on. It does not describe the wider NetSuite account.

---

## 0. Read this first

Five traps that will catch a new session before it touches anything.

1. **The two status lists are different lists.**
   `customlist_opp_sub_status_list` on the Opportunity and the Record Status custom record
   `customrecord_fin_stat` on the Sales Order share no IDs and no values. They are not two views
   of one list; they are two unrelated lists whose stored values happen to be small integers.

   Copying the raw value across therefore writes a number that means something else entirely. A
   low-numbered opportunity sub-status lands as a low-numbered Record Status — and the Record
   Statuses at the bottom of that list are warehouse instructions. *Release to Warehouse* is one
   of them. A single careless assignment tells the warehouse to ship.

   **Every transfer between the two goes through the mapping in section 4. Never copy the raw
   value, in either direction, under any circumstances.**

2. **Script IDs vs internal IDs.** See section 3. Committing an internal ID is the one mistake
   that breaks this repo across environments. **There are no exceptions and no "human reference"
   tables** — statuses are named, never numbered, throughout this document.

3. **`entitystatus` is partly managed by NetSuite itself.**
   Its field help in the account states that when an opportunity has estimates or sales orders,
   NetSuite updates the status to match the transaction's status. Saves will therefore happen
   that no person made, and this script will run on them. Anything that assumes a human was at
   the keyboard — or that the only writer of `entitystatus` is a user — is wrong. This is also
   why the "only write when the value would actually change" rule in section 5 matters: it is
   what stops the opportunity and its orders trading saves.

4. **List fields return raw stored values, not display names.**
   Any comparison keyed on a list field must normalise first, or it will work for some records
   and silently fail for others. Do not compare against the text a user sees in the UI.

   > **This project compares IDs, not text, and that is correct here.**
   > `custbody_opportunity_sub_status` on the Opportunity and
   > `custrecord_fin_stat_opp_sub_status` on the Record Status record **both source
   > `customlist_opp_sub_status_list`**, so both store the same option internal IDs. The
   > comparison between them is ID-to-ID and needs no text normalisation at all.
   >
   > The sibling repo, NS-Work-Instructions-Setter, reads its priority field as **text** for the
   > opposite reason: nobody established whether that field was a native or a hand-built list, so
   > its option IDs could not be trusted across accounts. **Do not copy that care over to here.**
   > The two fields here are known to share one list, and reading them as text would introduce a
   > normalisation problem that does not currently exist.

5. **Field IDs are used exactly as they exist in the account, typos included.**
   If an ID has a missing letter or a doubled prefix, that is the ID. Never "correct" one — the
   corrected version does not exist and the failure is silent.

---

## 1. What this solves

Sales orders carry a status and an expected ship date that need to follow the opportunity they
belong to. A design job moves through its stages on the Opportunity; the sales orders raised
against that opportunity have to show the same stage and the same expected date, or the teams
reading the order — CAD, warehouse, customer advisors — are working from stale information.

Until now that was driven from a CAD Worklist custom record by `acs_ue_update_so.js`, which
watched the worklist record and pushed values out to the orders. **That record is being retired
and the script replaced entirely.** Nothing in this repo extends it, and the two must never run
side by side — see section 8, step 6.

The replacement is driven from the Opportunity instead: when a won opportunity is saved, its
sales orders are brought into step. The Opportunity is where the design stage actually changes,
so it is where the sync belongs.

---

## 2. Components and versions

> This table is **indicative**. Version tables drift. Read the `VERSION` constant and the JSDoc
> `@version` header in the file itself to confirm what is actually deployed.

| Component | Version | File | Purpose | Status |
|---|---|---|---|---|
| Shared config library | 1.0.0 | `lib/opsync_lib_config.js` | Every script ID in the project, the script parameters, and the only reads of `customrecord_fin_stat` | Not deployed |
| Opportunity user event | 1.0.0 | `opsync_ue_opportunity.js` | `afterSubmit` on Opportunity — syncs Record Status and ship date to the sales orders | Not deployed |

All paths are relative to `src/FileCabinet/SuiteScripts/OpportunitySOSync/`.

Versioning convention: semver. Each script carries a `VERSION` constant and a JSDoc `@version`
header, and the two are kept in step with each other and with this table.

---

## 3. Environments — environment-agnostic policy

**This repo represents no single environment.** The same files must deploy unchanged to Sandbox
and to Production.

That is only possible because of this distinction:

| Committable | Never committable |
|---|---|
| Script IDs — `customrecord_*`, `custbody_*`, `custrecord_*`, `customlist_*`, `customscript_*`, `customdeploy_*`, `custscript_*` | Internal IDs — numeric record IDs, list option IDs, status IDs, custom form IDs, File Cabinet folder IDs |
| File Cabinet **paths** | File Cabinet folder **internal IDs** |
| Field and record script IDs | Account numbers, account-specific URLs |

Script IDs are chosen by the developer and are identical in both environments. Internal IDs are
assigned by NetSuite per account and differ between them.

### The rule has no exceptions — not even "for reference"

An earlier draft of this document carried the status internal IDs in tables marked *human
reference only*. They have all been removed, and none may come back. The reasoning:

- **Those numbers differ by environment.** A number written here is true of at most one account.
- **A reference table is a trap.** Someone copies a value out of it into code, because it is
  right there and it looks authoritative. Or someone uses it to check Production against Sandbox
  and concludes the Production configuration is wrong when it is simply different.
- **Nothing needs them.** The script addresses the record type as `customrecord_fin_stat`; the
  mapping and the excluded list are configuration, read at runtime.

A rule with exceptions is a rule nobody can apply. **Statuses are referred to by name throughout
this document.** If you need a number, read it off the record in the account you are working in.

### Everything variable lives outside the code

| Variable | Where it lives |
|---|---|
| The qualifying `entitystatus` values | Script parameter `custscript_opsync_qualifying_statuses`, on the deployment |
| The excluded Record Statuses | Script parameter `custscript_opsync_excluded_statuses`, on the deployment |
| The sub-status → Record Status mapping | `custrecord_fin_stat_opp_sub_status`, a Multiple Select on each Record Status record |

Both parameters are set **on the deployment**, so Sandbox and Production carry their own values
and neither set of ids appears in code. Widening the gate, excluding another status, or adding a
mapping row is a field edit in NetSuite — not a code change and not a deployment.

Numeric internal IDs will legitimately appear in values built at runtime, because they were read
from a record or a parameter a moment earlier. That is fine. What must never happen is a numeric
ID appearing as a literal in a committed file.

---

## 4. Architecture — the agreed design

**Trigger:** `afterSubmit` on Opportunity.

**Not `beforeSubmit`.** The predecessor wrote to sales orders before its own record had
committed, so a failed save left the orders already changed and the opportunity unchanged — the
two then disagreed, and nothing in the log said why. `afterSubmit` runs only once the
opportunity is actually saved.

**Flow:**

```
1. Type is CREATE, EDIT or XEDIT. Never DELETE.
2. Read entitystatus from newRecord if present, otherwise from oldRecord.
3. entitystatus is a qualifying status. Else exit.
4. Sub-status or delivery date changed since oldRecord (CREATE: proceed). Else exit.
5. Resolve the sub-status to a Record Status through the mapping.
   No mapping -> log OPPSYNC_NO_MAPPING and stop. Never write an unmapped value.
6. Find the sales orders: salesorder, filtered on the native opportunity field, mainline is T.
7. For each, in its own try/catch:
     - read its current Record Status and ship date in one lookupFields
     - guard every array access on that result
     - skip if its current status is in the excluded list
     - skip if nothing would actually change
     - submitFields
8. Check remaining governance inside the loop; stop cleanly and log what was left undone.
9. Audit-log every update and every skip, with the reason.
```

**The whole thing is wrapped. A failure must never block the opportunity save.** One
unreachable sales order fails that order, logs `OPPSYNC_ORDER_FAILED`, and the loop continues —
hence the per-order try/catch at step 7 rather than one try/catch around the loop.

**The field transfers:**

| From (Opportunity) | To (Sales Order) | How |
|---|---|---|
| `custbody_opportunity_sub_status` | `custbody_finance_status` | Through the mapping |
| `custbody_opp_del_date` | `custbody_defaultshipdate` | Direct — both dates |

**The link between them** is the **native `opportunity`** field on the Sales Order. **Not
`createdfrom`.** The search filters on it together with `mainline is T`, so each order comes back
once rather than once per line.

### The mapping

The mapping lives as **`custrecord_fin_stat_opp_sub_status`** on `customrecord_fin_stat` — a
Multiple Select sourcing `customlist_opp_sub_status_list`, labelled *"opportunity sub-statuses
that map here"*. Each Record Status declares which sub-statuses feed it.

This direction was chosen deliberately:

- Several sub-statuses can map to one Record Status without any duplication.
- The rule is visible by opening the Record Status record, rather than by reading code.
- Adding or repointing a mapping is data entry, not a deployment.

Because both the multi-select and the opportunity's sub-status field source the same list, the
lookup is a plain `anyof` filter on option IDs. See section 0, trap 4.

**Two active Record Status records matching one sub-status is a configuration error.**
`getMappedStatus()` returns `null` and logs `OPPSYNC_MAPPING_AMBIGUOUS` at error naming every
match. It does not pick one. A wrong status written silently is worse than no status written
loudly — the whole point of trap 1 in section 0.

**No match is not an error.** Most sub-statuses are deliberately unmapped; `getMappedStatus()`
returns `null` quietly and the caller stops.

Agreed mapping, seven rows, **by name**:

| Opportunity sub-status | Record Status |
|---|---|
| Awaiting Design Info | Awaiting Design Info |
| Design Required | CAD Required |
| Post Design Check | Post design check required |
| Design Complete | CAD Complete |
| Design Cancelled | Cancelled |
| Project on hold | On Hold |
| Redraw Required | Redraw Required |

> This mapping is **data, entered in NetSuite** on the Record Status records. The table records
> what was agreed; the account is authoritative. No internal IDs — see section 3.

---

## 5. Standing warnings and deliberate decisions

- **ES5 house style throughout** — `var`, `function`, `'use strict'`. Consistency with the
  sibling repo, not a limitation of SuiteScript 2.1. Do not modernise it.

- **`afterSubmit`, never `beforeSubmit`.** See section 4 for the failure it prevents.

- **`entitystatus` is read from `newRecord`, then `oldRecord`.**
  On XEDIT — inline edit — NetSuite populates `newRecord` with **only the fields that were
  edited**. A gate reading `entitystatus` straight off `newRecord` therefore sees an empty status
  on a perfectly valid inline edit, exits, and logs nothing: the feature looks dead rather than
  broken. `oldRecord` is complete on XEDIT, so it is the reliable source unless the status is
  itself what was edited, in which case `newRecord` carries it and wins. This will be
  "simplified" by someone who has not hit it. It is commented in the code for that reason.

- **The same fallback applies to the synced fields, but only on XEDIT.**
  Taking a value from a sparse `newRecord` and writing it to a sales order would push an empty
  value across and clear a ship date nobody touched. On CREATE and EDIT `newRecord` is complete,
  so an empty value there is a real clear by a real user and is respected — falling back would
  resurrect a value the user had just removed. See the limitation in section 6.

- **The opportunity drives the sales order's status through the design phase only.**
  Every mapped sub-status is design lifecycle. Sub-statuses before design (*In Negotiation*,
  *PE Info Gather*) and after it (*Partially Delivered*, *Delivery Complete*) are deliberately
  unmapped — the order's own process owns the status at those points, and the opportunity has no
  business overwriting it. An unmapped sub-status leaves the order untouched.
  **This is intentional. Do not "complete" the mapping.**

- **An ambiguous mapping writes nothing.** See section 4.

- **Only write when the value would actually change.** Three reasons, all load-bearing: it is
  cheaper on governance; it removes system-note churn on records people read; and it breaks any
  feedback loop between the order and the opportunity — see trap 3 in section 0, where NetSuite
  writes `entitystatus` off the back of a transaction save.

- **Date comparison is a trap, and it is what makes the rule above work.**
  `record.getValue()` on a date field returns a **Date object**. `search.lookupFields()` returns
  the same field as a **string** in the current user's date format. Comparing them directly is
  always unequal, so "only write when something changed" silently becomes "write every time" —
  which fills the orders with system notes and re-fires their own user events on every
  opportunity save. Both sides are rendered to a string in the user's date format by
  `asDateKey()` before any comparison, and that string is what `submitFields` receives back.

- **Design Cancelled is a one-way door.** See section 6.

- **Guard every array access on a lookup result.** The predecessor script read
  `lookupFields(...).custbody_finance_status[0].value` with no guard. `lookupFields` returns an
  empty array for an empty list field, so `[0]` is `undefined` and `.value` throws. Every sales
  order with a blank Record Status broke it. Every such access in this project goes through
  `opsyncConfig.lookupValue()`, which checks length before indexing.

- **No caching in the config library.** The mapping is configuration that people edit in the UI,
  and a cache would risk resolving a sub-status against a mapping that was correct a moment ago.
  One search per qualifying save is trivial governance next to writing a stale status. Left out
  deliberately, not forgotten.

- **An empty script parameter is a configuration error, not a default.** It is logged at error
  and an empty array is returned. An empty qualifying list means the gate never opens, which
  fails safe.

- **`log.warn()` does not exist in SuiteScript.** Use `log.debug()`. Calling `log.warn()` throws.

- **`search.lookupFields()` fails on computed fields.** Use `record.load().getValue()` for
  anything derived, formula-based or summary.

- **Never write a raw sub-status value to `custbody_finance_status`.** Restated here because it
  is the failure mode this project most plausibly reintroduces during a "simplification". See
  trap 1 in section 0.

- **The predecessor is being replaced, not extended.** `acs_ue_update_so.js` and the CAD Worklist
  record it reads are on their way out. Do not import from it, copy its lookups, or leave its
  deployment enabled alongside this one.

---

## 6. Known issues and limitations

**The qualifying status may be too late.**

The sync is gated on `entitystatus` = *Won*, whose description in the account reads *"Invoice has
been issued and goods have been shipped."* If that description is accurate rather than stale, the
gate opens **after delivery** — long after the design statuses being synced have passed, and the
feature would do nothing useful in practice.

Steve has decided *Won* only, deliberately and knowingly. It is held in a script parameter, so
widening it is a field edit rather than a code change.

**If orders are not picking up their sub-status after go-live, this is the first thing to check.**

| Item | Detail |
|---|---|
| **Design Cancelled is a deliberate one-way door** | *Design Cancelled* maps to *Cancelled*, and *Cancelled* is in the excluded list. So this sync can move an order **to** Cancelled, and can never move it away again — the exclusion tests the order's current status, so a cancelled order is skipped from then on. **That is intended.** Un-cancelling an order should require a person looking at that order, not a status change on an opportunity that happens to cascade. **Do not "fix" it by removing Cancelled from the excluded list.** If it ever needs reversing it is a script parameter edit, not a code change. |
| **Clearing a date by inline edit does not propagate** | On XEDIT a field absent from `newRecord` is indistinguishable from a field cleared to empty. The script resolves the ambiguity in favour of *absent* and falls back to `oldRecord` — so inline-clearing the delivery date leaves the orders' ship dates as they were. The safe failure was chosen deliberately: the alternative silently wipes ship dates on every unrelated inline edit. Clearing the date on the **full form** works normally. |
| **Governance stops are silent to the user** | If an opportunity has enough sales orders to exhaust the user event's governance, the loop stops cleanly and logs `OPPSYNC_GOVERNANCE_STOP` naming the orders it did not reach. The user who saved the opportunity sees nothing. Re-saving picks up the rest. Not expected in practice — an opportunity has a handful of orders, not hundreds. |
| **The sync does not run for anyone who bypasses user events** | CSV import with *Run Server SuiteScript and Trigger Workflows* unticked, and any integration that suppresses user events, write the opportunity without this script running. The orders are then out of step until the opportunity is saved again. This is a NetSuite setting on each import, not something the script can detect or force. |

Add further entries as they are found, with the date and the script version they were observed on.

---

## 7. Audit log keys

Every `log.audit`, `log.error` and `log.debug` title begins `OPPSYNC_`, so the execution log can
be filtered on one string. Every title is built by `opsyncConfig.logKey()`, so the prefix cannot
drift between scripts.

| Key | Level | Meaning | What to do if it fires |
|---|---|---|---|
| `OPPSYNC_ORDER_UPDATED` | audit | A sales order's Record Status, ship date, or both were written. Names the order, the opportunity and the before/after of each value. Normal operation. | Nothing. Use it to confirm the sync reached the orders you expected. |
| `OPPSYNC_ORDER_SKIPPED` | audit | The order was left alone because its **current** Record Status is in the excluded list. Names the status. Normal operation. | Nothing, normally. If an order should have been updated, check the excluded statuses parameter on the deployment. |
| `OPPSYNC_ORDER_UNCHANGED` | debug | The order already matched the opportunity, so nothing was written — no `submitFields` and no system note. Normal, and the common case on a re-save. | Nothing. Its **absence** on a repeat save is the signal that the change-detection guard has broken — see the date trap in section 5. |
| `OPPSYNC_NO_MAPPING` | audit | The opportunity's sub-status resolves to no single active Record Status. **No order was touched.** Expected for every sub-status outside the design phase. | Normally nothing — most sub-statuses are deliberately unmapped (section 5). Investigate only if the sub-status *should* be mapped: check `custrecord_fin_stat_opp_sub_status` on the intended Record Status record, and look for `OPPSYNC_MAPPING_AMBIGUOUS` just above it. |
| `OPPSYNC_MAPPING_AMBIGUOUS` | error | Two or more **active** Record Status records claim the same opportunity sub-status. Names the sub-status and every match. Nothing was written and no guess was made. | Open the named records and remove the sub-status from all but one. Until then, every opportunity at that sub-status leaves its orders untouched. |
| `OPPSYNC_ORDER_FAILED` | error | One sales order threw while being read or written. **The remaining orders were still processed.** | Read the logged error against the named order. Usually a locked or deleted order, or a permission problem on the executing role. |
| `OPPSYNC_GOVERNANCE_STOP` | error | The loop stopped with governance running low, naming how many orders were done and which were not reached. | Re-save the opportunity to pick up the rest. If it recurs, the opportunity has more orders than this design anticipated — see section 6. |
| `OPPSYNC_PARAMETER_MISSING` | error | A script parameter is unset, unreadable, or held no usable ids. Names the parameter. An empty qualifying list means **the gate never opens** — the feature is inert. | Populate the parameter on the deployment **in this account**; the values differ by environment. See section 8. |
| `OPPSYNC_FAILED` | error | The entry point threw outside the per-order loop. **The opportunity still saved**; its orders may be out of step. | Read the logged error. Nothing in this feature may ever block an opportunity save, so a failure here is always silent to the user. |

> **Reserved — no script raises these.** Kept so a future session grepping for them finds this
> note rather than hunting for a missing logger.
>
> | Key | Why it does not exist |
> |---|---|
> | `OPPSYNC_NO_ORDERS` | An opportunity with no sales orders is the ordinary case, not an event. The script exits quietly. Logging it would bury the real entries. |
> | `OPPSYNC_STATUS_RAW_COPY` | Specified during design as a tripwire for a raw status copy. There is no such code path to trip it — the mapping is the only route to `custbody_finance_status`. Kept as a name so nobody adds the path in order to add the log. |

Log the **raw value** alongside every one of these, so a mismatch is visible in the execution log
rather than silently doing nothing — particularly for anything that fell through the mapping.

---

## 8. Deployment sequence

Deployment is **manual File Cabinet upload**. There is no SDF project and no automated deploy.
**Steve deploys. Claude never deploys.**

1. **Upload `lib/opsync_lib_config.js` to the File Cabinet first.** The entry point imports it by
   relative path and fails *at load time* if it is absent — the failure looks like a broken
   script record, not a missing file.
2. Upload `opsync_ue_opportunity.js`. It must sit in the **same folder** as `lib/`, with the
   library beneath it — the import is a relative path.
3. Create or update the script record and deployment:

   | Script | Script ID | Deployment | Applies to |
   |---|---|---|---|
   | `opsync_ue_opportunity.js` | `customscript_opsync_ue_opportunity` | `customdeploy_opsync_ue_opportunity` | Opportunity. `afterSubmit` only |
   | `lib/opsync_lib_config.js` | — | **None.** Shared AMD module — File Cabinet upload only. Creating a script record for it is wrong | — |

4. **Define the two script parameters on the script record, and set their values on the
   deployment:**

   | Label | ID | Type | What goes in it |
   |---|---|---|---|
   | Qualifying Opportunity Statuses | `custscript_opsync_qualifying_statuses` | Free-Form Text | A comma-separated list of the `entitystatus` internal IDs that open the gate, **as they are in this account**. Currently *Won* alone. |
   | Excluded Record Statuses | `custscript_opsync_excluded_statuses` | Free-Form Text | A comma-separated list of the Record Status internal IDs that must never be overwritten — the statuses whose orders belong to the warehouse and finance processes, **plus Cancelled**. |

   **Both must be populated at deployment time, in each environment separately.** Their values
   are internal IDs and therefore **differ between Sandbox and Production** — read them off the
   records in the account you are deploying to. They are not in this repository and must not be
   put in it (section 3). An unset parameter logs `OPPSYNC_PARAMETER_MISSING` at error; an unset
   qualifying list closes the gate completely and the feature does nothing at all.

5. Confirm `custrecord_fin_stat_opp_sub_status` exists on `customrecord_fin_stat` and is
   populated on the Record Status records **in the target account**, per the mapping in section
   4. It is data, so it does not travel with the code. Check no sub-status appears on two active
   records — that is the `OPPSYNC_MAPPING_AMBIGUOUS` case.
6. **Disable the old `acs_ue_update_so.js` deployment.** The two must not both run. Two writers
   of `custbody_finance_status` means an ordering question nobody can answer from the logs.

Shared AMD modules need no script record and no deployment record — a File Cabinet upload is
sufficient. But **all files must sit in the same folder tree**, because the imports are relative
paths. The repo layout under `src/FileCabinet/` mirrors the File Cabinet exactly for this reason.

---

## 9. Testing

Manual, in Sandbox. There is no test framework in this repo and SuiteScript cannot be
meaningfully executed outside NetSuite. Mechanical checks only before commit — `node --check`,
headers, versions, and greps for forbidden patterns.

Grep the execution log for `OPPSYNC_` after every scenario. Watch the sales order's **system
notes** as well as its field values: a scenario that should write nothing and does is a pass on
screen and a failure in the notes.

| # | Scenario | Expected |
|---|---|---|
| 1 | Qualifying opportunity, mapped sub-status changed, **one** sales order in an ordinary status | Order's Record Status and ship date **updated**. `OPPSYNC_ORDER_UPDATED` names both before/after values |
| 2 | The same, with **several** sales orders | **Every** order updated, one `OPPSYNC_ORDER_UPDATED` each |
| 3 | An order with an **empty Record Status** | **No throw.** Order updated, the log showing `(empty)` as the previous value. This is the predecessor's crash — see section 5 |
| 4 | An order **already in an excluded status** | Order **skipped**, `OPPSYNC_ORDER_SKIPPED` naming the status. Any other orders on the same opportunity **still processed** |
| 5 | An **unmapped** sub-status (e.g. *In Negotiation*) | **Nothing written to any order.** `OPPSYNC_NO_MAPPING` at audit. Stops before the orders are searched |
| 6 | Save again with **nothing relevant changed** | Exits before the mapping. **No `submitFields`, no system note on any order.** Check the order's system notes, not just its values |
| 7 | Re-save where the values already match (e.g. a different field edited) | `OPPSYNC_ORDER_UNCHANGED` at debug; no write |
| 8 | **Inline edit the sub-status** on the opportunity list view | Sync runs normally and the orders update. This is the XEDIT path — see section 5. A silent no-op here means the sparse-`newRecord` rule has been broken |
| 9 | **Inline edit something unrelated** (e.g. the memo) | Exits at the change check. Nothing written, nothing logged |
| 10 | A **non-qualifying** opportunity, mapped sub-status changed | Exits at the gate. Nothing written |
| 11 | A qualifying opportunity with **no sales orders** | Clean exit, no error, no log noise |
| 12 | Change **only the delivery date** | Ship date updated on every order, Record Status write **suppressed as unchanged** |
| 13 | **Create** a qualifying opportunity with a mapped sub-status and an existing order | Proceeds without an `oldRecord`; order updated |
| 14 | Temporarily put one sub-status on **two active** Record Status records, then save | **Nothing written.** `OPPSYNC_MAPPING_AMBIGUOUS` at error naming both. **Revert the configuration afterwards** |
| 15 | Clear the **Excluded Record Statuses** parameter and save | `OPPSYNC_PARAMETER_MISSING` at error. **Revert afterwards** |
| 16 | Clear the **Qualifying Opportunity Statuses** parameter and save | `OPPSYNC_PARAMETER_MISSING` at error and **nothing runs** — the gate fails shut. **Revert afterwards** |
| 17 | Move an opportunity to **Design Cancelled**, then to another mapped sub-status | The order goes to *Cancelled* and then **stays there** — skipped from that point on. This is the one-way door in section 6, not a bug |
| 18 | **Delete** an opportunity | Nothing runs |

Extend this table as scenarios are found. **Revert any configuration changed for a test.**

---

## 10. Open items

### Confirmed NetSuite IDs

Script IDs only — **no internal IDs**, here or anywhere else in this document. See section 3.

| Item | Script ID | Type | Confirmed by | Date |
|---|---|---|---|---|
| Record Status custom record | `customrecord_fin_stat` | Custom record | Steve | 2026-09-14 |
| Record Status: mapped sub-statuses | `custrecord_fin_stat_opp_sub_status` | Multiple Select → `customlist_opp_sub_status_list` | Steve | 2026-09-14 |
| Opportunity: design sub-status | `custbody_opportunity_sub_status` | List → `customlist_opp_sub_status_list` | Steve | 2026-09-14 |
| Opportunity: delivery date | `custbody_opp_del_date` | Date | Steve | 2026-09-14 |
| Sales Order: Record Status | `custbody_finance_status` | List/Record → `customrecord_fin_stat` | Steve | 2026-09-14 |
| Sales Order: expected ship date | `custbody_defaultshipdate` | Date | Steve | 2026-09-14 |
| Sales Order → Opportunity link | `opportunity` | **Native** field — not `createdfrom` | Steve | 2026-09-14 |

### Closed questions

| # | Question | Resolution | Closed |
|---|---|---|---|
| 1 | Is *Redraw Required* in or out of the excluded list? | **Out.** An order sitting at Redraw Required should be moved on when the opportunity says so. | 2026-09-14 |
| 2 | Is the excluded list a list of **current** statuses, not of targets? | **Current statuses.** Which makes *Design Cancelled → Cancelled* a one-way door — deliberately. See section 6. | 2026-09-14 |
| 3 | Which field links a Sales Order to its Opportunity? | The **native `opportunity`** field. **Not `createdfrom`.** | 2026-09-14 |
| 4 | Where does the mapping live, and is comparison by ID or by text? | `custrecord_fin_stat_opp_sub_status`, a Multiple Select on `customrecord_fin_stat`. Comparison is **ID-to-ID** — both fields source the same list. See section 0, trap 4. | 2026-09-14 |
| 5 | How should XEDIT's sparse `newRecord` be handled? | Read `newRecord` first, fall back to `oldRecord`. See section 5. | 2026-09-14 |
| — | Should the status internal IDs stay in this document as human reference? | **No.** Every one removed, and the rule now has no exceptions. See section 3. | 2026-09-14 |

### Open questions

| # | Question | Status |
|---|---|---|
| 1 | Should `custbody_cad_worklist` on existing sales orders be **cleared** when the worklist record retires, or left as history? | **Open.** Clearing is a one-off data job, not something this feature does. Leaving it means a field pointing at a retired record. Nothing in this repo reads or writes it. |
| 2 | Is the *Won* gate early enough to be useful? | **Open, and knowingly accepted.** See section 6. It is a parameter, so widening it needs no code. |

### NetSuite configuration tasks for Steve

Not code. These are account changes the scripts assume have been made.

| # | Task | Why it matters |
|---|---|---|
| 1 | Create `custrecord_fin_stat_opp_sub_status` on `customrecord_fin_stat` and populate the seven mapping rows | Without it the sync resolves nothing and stops at `OPPSYNC_NO_MAPPING` on every opportunity. Section 4. |
| 2 | Define both script parameters on the script record and set their values on the deployment, **in each environment** | Section 8, step 4. An unset qualifying list makes the feature completely inert, and the only sign is one error line in the log. |
| 3 | Disable the `acs_ue_update_so.js` deployment when this one goes live | Section 8, step 6. Two writers of `custbody_finance_status`. |
| 4 | Confirm no sub-status appears on two active Record Status records | Section 4 — it is the `OPPSYNC_MAPPING_AMBIGUOUS` case, and it leaves orders untouched. |
