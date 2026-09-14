# Opportunity → Sales Order Sync — project context

Canonical reference for this project. If this document and the repository disagree, **the
repository wins** — read the file and then fix this document in the same PR.

Scope of this document: the SuiteScript in this repo and the NetSuite configuration it depends
on. It does not describe the wider NetSuite account.

---

## 0. Read this first

Five traps that will catch a new session before it touches anything.

1. **The two status lists are different lists.**
   `customlist_opp_sub_status_list` on the Opportunity and the Record Status custom record on
   the Sales Order share no IDs and no values. They are not two views of one list; they are two
   unrelated lists whose stored values happen to be small integers.

   Copying the raw value across therefore writes a number that means something else entirely. A
   low-numbered opportunity sub-status lands as a low-numbered Record Status — and the Record
   Statuses at the bottom of that list are warehouse instructions. *Release to Warehouse* is one
   of them. A single careless assignment tells the warehouse to ship.

   **Every transfer between the two goes through the mapping in section 4. Never copy the raw
   value, in either direction, under any circumstances.**

2. **Script IDs vs internal IDs.** See section 3. Committing an internal ID is the one mistake
   that breaks this repo across environments. The Record Status custom record's internal ID is
   recorded once, in section 10, as human reference while its script ID is confirmed. **That
   number must never appear in a script file.**

3. **`entitystatus` is partly managed by NetSuite itself.**
   Its field help in the account states that when an opportunity has estimates or sales orders,
   NetSuite updates the status to match the transaction's status. Saves will therefore happen
   that no person made, and this script will run on them. Anything that assumes a human was at
   the keyboard — or that the only writer of `entitystatus` is a user — is wrong.

4. **List fields return raw stored values, not display names.**
   Any comparison keyed on a list field must normalise first, or it will work for some records
   and silently fail for others. Do not compare against the text a user sees in the UI.

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
| _(populated from Phase 2)_ | | | | |

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
| Script IDs — `customrecord_*`, `custbody_*`, `custrecord_*`, `customlist_*`, `customscript_*`, `customdeploy_*` | Internal IDs — numeric record IDs, list option IDs, status IDs, custom form IDs, File Cabinet folder IDs |
| File Cabinet **paths** | File Cabinet folder **internal IDs** |
| Field and record script IDs | Account numbers, account-specific URLs |

Script IDs are chosen by the developer and are identical in both environments. Internal IDs are
assigned by NetSuite per account and differ between them.

**Everything variable in this feature lives outside the code.** Specifically:

| Variable | Where it lives |
|---|---|
| The qualifying `entitystatus` | Script parameter |
| The excluded Record Statuses | Script parameter |
| The sub-status → Record Status mapping | A multi-select field on the Record Status custom record — see section 4 |

Widening the gate, excluding another status, or adding a mapping row is therefore a field edit
in NetSuite, not a code change and not a deployment.

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
2. entitystatus is a qualifying status. Else exit.
3. Sub-status or delivery date changed since oldRecord (CREATE: proceed). Else exit.
4. Resolve the sub-status to a Record Status through the mapping.
   No mapping -> log and stop. Never write an unmapped value.
5. Find the sales orders linked to this opportunity.
6. For each, in its own try/catch:
     - read its current Record Status and ship date
     - skip if its status is in the excluded list
     - skip if nothing would actually change
     - submitFields
7. Audit-log every update and every skip, with the reason.
```

**The whole thing is wrapped. A failure must never block the opportunity save.** One
unreachable sales order fails that order, logs, and the loop continues — hence the per-order
try/catch at step 6 rather than one try/catch around the loop.

**The field transfers:**

| From (Opportunity) | To (Sales Order) | How |
|---|---|---|
| `custbody_opportunity_sub_status` | `custbody_finance_status` | Through the mapping |
| `custbody_opp_del_date` | `custbody_defaultshipdate` | Direct — both dates |

### The mapping

The mapping lives as a **multi-select field on the Record Status custom record**: *"opportunity
sub-statuses that map here"*. Each Record Status declares which sub-statuses feed it.

This direction was chosen deliberately:

- Several sub-statuses can map to one Record Status without any duplication.
- The rule is visible by opening the Record Status record, rather than by reading code.
- Adding or repointing a mapping is data entry, not a deployment.

**Two Record Status records matching one sub-status is a configuration error.** Log it and leave
the order alone rather than guessing. A wrong status written silently is worse than no status
written loudly — the whole point of trap 1 in section 0.

Agreed mapping, seven rows:

| Opportunity sub-status | Record Status |
|---|---|
| Awaiting Design Info | 17 Awaiting Design Info |
| Design Required | 31 CAD Required |
| Post Design Check | 32 Post design check required |
| Design Complete | 37 CAD Complete |
| Design Cancelled | 40 Cancelled |
| Project on hold | 16 On Hold |
| Redraw Required | 45 Redraw Required |

> **Internal IDs are shown here for human reference only.** They are configuration data, entered
> in NetSuite on the Record Status records. They must not appear in any script file.

---

## 5. Standing warnings and deliberate decisions

- **The opportunity drives the sales order's status through the design phase only.**
  Every mapped sub-status is design lifecycle. Sub-statuses before design (*In Negotiation*,
  *PE Info Gather*) and after it (*Partially Delivered*, *Delivery Complete*) are deliberately
  unmapped — the order's own process owns the status at those points, and the opportunity has no
  business overwriting it. An unmapped sub-status leaves the order untouched.
  **This is intentional. Do not "complete" the mapping.**

- **Only write when the value would actually change.** Three reasons, all of them load-bearing:
  it is cheaper on governance; it removes system-note churn on records people read; and it
  breaks any feedback loop between the order and the opportunity — see trap 3 in section 0, where
  NetSuite writes `entitystatus` off the back of a transaction save.

- **Guard every array access on a lookup result.** The predecessor script read
  `lookupFields(...).custbody_finance_status[0].value` with no guard. `lookupFields` returns an
  empty array for an empty list field, so `[0]` is `undefined` and `.value` throws. Every sales
  order with a blank Record Status broke it. Check length before indexing, every time.

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
| **XEDIT gives a sparse `newRecord`** | On inline edit NetSuite populates only the changed fields. A gate reading `entitystatus` or the sub-status straight off `newRecord` may therefore see an empty value on a perfectly valid inline edit. Raised in Phase 1 while agreeing the flow; the handling is Phase 2's to settle and record here. |
| **A mapped target may itself be excluded** | *Design Cancelled* maps to the *Cancelled* Record Status, and that same status appears in the excluded list — compare the mapping table in section 4 with the excluded list in section 10. The exclusion tests the order's **current** status, not the target, so the sync will write *Cancelled* onto an eligible order and will then never move that order again. Believed to be the intent — cancelled is terminal — but it means the transfer is one-way and cannot be undone by this script. Raised as item 2 in section 10. |

Add further entries as they are found, with the date and the script version they were observed on.

---

## 7. Audit log keys

Every `log.audit`, `log.error` and `log.debug` title begins `OPPSYNC_`, so the execution log can
be filtered on one string.

| Key | Meaning | What to do if it fires |
|---|---|---|
| _(populated as the scripts are written)_ | | |

Log the **raw value** alongside every one of these, so a mismatch is visible in the execution log
rather than silently doing nothing — particularly for anything that fell through the mapping.

---

## 8. Deployment sequence

Deployment is **manual File Cabinet upload**. There is no SDF project and no automated deploy.
**Steve deploys. Claude never deploys.**

1. **Upload the shared library first** — every other script imports it by relative path and they
   all fail *at load time* if it is absent. The failure looks like a broken script record, not a
   missing file.
2. Upload the entry point. It must sit in the same folder as the library's parent, with `lib/`
   beneath it — the imports are relative paths.
3. Create or update the script records and deployments in the NetSuite UI.
4. Set the script parameters — the qualifying status and the excluded Record Statuses.
5. Confirm the mapping multi-select is populated on the Record Status records **in the target
   account**. It is data, so it does not travel with the code.
6. **Disable the old `acs_ue_update_so.js` deployment.** The two must not both run. Two writers
   of `custbody_finance_status` means an ordering question nobody can answer from the logs.

Shared AMD modules need no script record and no deployment record — a File Cabinet upload is
sufficient. But **all files must sit in the same folder tree**, because the imports are relative
paths. The repo layout under `src/FileCabinet/` mirrors the File Cabinet exactly for this reason.

---

## 9. Testing

Manual, in Sandbox. There is no test framework in this repo and SuiteScript cannot be
meaningfully executed outside NetSuite. Mechanical checks only before commit — syntax, headers,
versions, and greps for forbidden patterns.

Grep the execution log for `OPPSYNC_` after every scenario.

| # | Scenario | Expected |
|---|---|---|
| 1 | Won opportunity, mapped sub-status changed, one order in an ordinary status | Order's Record Status and ship date **updated**. Update audit-logged |
| 2 | **An order with an empty Record Status** | No throw. Order updated, the empty current value logged rather than indexed into. See section 5 |
| 3 | **An opportunity with several sales orders** | **Every** order processed. One failure does not stop the others |
| 4 | **An unmapped sub-status** (e.g. *In Negotiation*) | **Nothing written.** Logged and stopped before the orders are touched |
| 5 | **An order already in an excluded status** | Order **skipped**, skip reason logged. Other orders on the same opportunity still processed |
| 6 | **A save where nothing relevant changed** | Exits at step 3. **No `submitFields` at all** — check the order's system notes are clean |
| 7 | Sub-status unchanged, delivery date changed | Sync runs. Ship date updated, status write suppressed as unchanged |
| 8 | Opportunity not in the qualifying status | Exits at step 2. Nothing written |
| 9 | Two Record Status records claiming the same sub-status | **Nothing written.** Configuration error logged naming both |
| 10 | Opportunity with no sales orders | Clean exit, no error |
| 11 | Delete an opportunity | Nothing runs |

Extend this table as scenarios are found. Revert any configuration changed for a test.

---

## 10. Open items

### NetSuite IDs to confirm before Phase 2

Script IDs only — **no internal IDs in this table**, except the one human-reference note against
the Record Status record, which is there precisely because its script ID is what is missing.

| Item | Script ID | Confirmed by | Date |
|---|---|---|---|
| Record Status custom record — internal ID is 174; the `customrecord_...` ID is what is needed | | | |
| Sales Order → Opportunity link field — believed to be the native `opportunity` field | | | |
| Opportunity sub-status field | `custbody_opportunity_sub_status` | | |
| Opportunity delivery date field | `custbody_opp_del_date` | | |
| Sales Order Record Status field | `custbody_finance_status` | | |
| Sales Order expected ship date field | `custbody_defaultshipdate` | | |
| Mapping multi-select, to be created on the Record Status record | _to be chosen_ | | |

The four `custbody_*` IDs above are written as believed. **Confirm each against the account
before any script reads it** — see trap 5 in section 0: an ID is used exactly as it exists,
typos included, and a wrong one fails silently.

### Confirmed already

| Item | Value |
|---|---|
| Qualifying status | `entitystatus` = 13 (*Won*) |
| Excluded Record Statuses | 2, 3, 7, 8, 9, 13, 16, 19, 40, 42, 43 |
| Orders per opportunity | One opportunity may have **several** sales orders |

> Internal IDs above are human reference. Both lists live in **script parameters**, not in code —
> see section 3.

### Open questions

| # | Question | Status |
|---|---|---|
| 1 | Is Record Status **45 (Redraw Required)** in or out of the excluded list? | **Open.** It is a mapping target (section 4) and is *not* currently in the excluded list, so an order sitting at 45 would be moved on by a later sub-status change. Confirm that is wanted. |
| 2 | Should `custbody_cad_worklist` on existing sales orders be **cleared** when the worklist record retires, or left as history? | **Open.** Clearing is a one-off data job, not something this feature does. Leaving it means a field pointing at a retired record. |

### Raised in Phase 1, for Steve

| # | Item | Why it matters |
|---|---|---|
| 1 | Confirm the *Won* gate against the design timeline | Section 6. If *Won* really means shipped, the feature is correct and inert. |
| 2 | Confirm the excluded list is a list of **current** statuses, not of targets | Section 6 — *Design Cancelled* maps to a status that is itself in the excluded list. |
| 3 | Create the mapping multi-select on the Record Status record and populate the seven rows | Section 4. Without it the sync has nothing to resolve and will stop at step 4 on every opportunity. |
