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
   > `custbody_opportunity_sub_status` on the Opportunity stores an option internal ID from
   > `customlist_opp_sub_status_list`, and the keys of the `custscript_opsync_status_map`
   > parameter are those same IDs. The comparison is ID-to-ID and needs no text normalisation
   > at all — the parameter is parsed as text, but what it *holds* is IDs on both sides of
   > every pair, and the parser rejects anything that is not a whole number.
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
| Shared config library | 1.4.0 | `lib/opsync_lib_config.js` | Every script ID in the project, and the three script parameters — including the status mapping | Not deployed |
| Opportunity user event | 1.3.1 | `opsync_ue_opportunity.js` | `afterSubmit` on Opportunity — syncs Record Status, ship date and delivery readiness to the sales orders | Not deployed |

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
| The sub-status → Record Status mapping | Script parameter `custscript_opsync_status_map`, on the deployment |

All three parameters are set **on the deployment**, so Sandbox and Production carry their own
values and no internal id appears in code. Widening the gate, excluding another status, or
adding a mapping row is a field edit in NetSuite — not a code change and not a deployment.

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
4. NO "has the sub-status changed" exit. Every save of a qualifying opportunity proceeds.
5. Resolve the sub-status through the mapping. No mapping -> log OPPSYNC_NO_MAPPING and
   carry on; the Record Status is simply not written. Never write an unmapped value.
6. Find the sales orders: salesorder, filtered on the native opportunity field, mainline is T.
7. For each, in its own try/catch:
     - read its current Record Status and ship date in one lookupFields
     - guard every array access on that result
     - skip if its current status is in the excluded list
     - skip if nothing would actually change
     - submitFields
8. Evaluate delivery readiness against the status THIS SAVE decided, unless that status is
   itself excluded — then leave both readiness fields untouched.
9. Fold readiness into the SAME submitFields. One read and one write per order.
10. Check remaining governance inside the loop; stop cleanly and log what was left undone.
11. Audit-log every update and every skip, with the reason, plus one summary per opportunity.
```

### Delivery readiness

Two **independent** gates, driven by two checkboxes on the Quote Type record that the order's
`custbody_quote_type` points at. An order is ready only when **both** pass, and **neither
checkbox short-circuits the other** — a quote type with both ticked still has its certificates
checked, it simply skips the design check.

| Gate | Checkbox | When ticked | When not ticked |
|---|---|---|---|
| Design | `custrecord_qt_no_design_required` — *"Can ship without design"* | Passes with no check | The status this save decided must be in `getDesignOkStatuses()`, else **Design not complete** |
| Certificates | `custrecord_qt_requires_installer_certs` — *"Requires installer certificates"* | All five checks below | Passes with no check |

The certificate checks, in the order their reasons are joined:

Three conditions plus DNO, evaluated **independently**, each with a legacy path:

| # | Condition | Satisfied by | Failure reason |
|---|---|---|---|
| 1 | Subcontract | `custbody_installer_subcontract_receive` **or** `custbodysubcontract_received_legacy` | `Subcontract agreement not received` |
| 2 | Installer qualification | `custbody_installer_qual_logged_legacy`, **else** the customer's qualification expiry | `Installer not set on opportunity` / `Installer qualification certificate missing` / `… expired` |
| 3 | Public Liability | `custbody_installer_pl_logged_legacy`, **else** the customer's PL expiry | `Installer not set on opportunity` / `Public Liability certificate missing` / `… expired` |
| 4 | DNO | `custbody38` in `getDnoOkValues()` — blank or absent fails. **No legacy path exists** | `Awaiting DNO` |

**`Installer not set on opportunity` is de-duplicated.** Conditions 2 and 3 raise it
independently, and one missing installer is one problem to fix — saying so twice reads as two.

**It is no longer a standalone check.** It is reached only when a modern path is actually
needed: an order satisfied entirely by legacy evidence does not need an installer at all.

### Legacy evidence fields

Three fields carry evidence recorded under the **old process**, before installers were logged as
customer records. On those opportunities `custbody_installer_ns` may be blank while the evidence
itself is present — so without these the modern path has nothing to read and every linked order
is held for an installer that was verified years ago.

**They are on the OPPORTUNITY, not the sales order.** Phase 3a assumed the sales order and was
wrong; the reads moved in 3c. They are read **once per save** from the record being saved — no
`lookupFields`, and not per order.

| Field | Satisfies |
|---|---|
| `custbodysubcontract_received_legacy` — **note: no underscore after `custbody`** | Subcontract |
| `custbody_installer_qual_logged_legacy` | Installer qualification |
| `custbody_installer_pl_logged_legacy` | Public Liability |

**Because they are opportunity-level, legacy evidence satisfies the certificate gate for EVERY
sales order linked to that opportunity — including any order added later.** That is intended, not
a leak: the flags record that the work was verified under the old process, and the opportunity is
the unit that process operated on. Do not later read it as a bug and scope it per order.

#### The presence test

**The field types are not confirmed** — they may be checkbox, date or text — so the test has to
be correct for all three. `isLegacyPresent()` treats **boolean `false`, `''`, `null` and
`undefined`** as absent, plus the strings `'F'` and `'false'` in case a checkbox reaches it by a
path that stringifies it.

> **An unticked checkbox arrives as boolean `false`, and `String(false)` is the five-character
> string `"false"`.** A presence test written as `!isEmpty(value)` or `value !== ''` therefore
> reads an unticked box as **present** — silently handing every legacy opportunity a free pass on
> its certificates, in the direction that ships goods rather than holding them. This is why the
> legacy fields do not use `isEmpty()`.

**Legacy is a PRESENCE test and nothing more.** Non-blank means satisfied — a ticked checkbox,
any date, any text. **There is no expiry comparison on a legacy field**: the flag records that
the evidence was verified under the old process, not when it runs out. A blank legacy field means
nothing at all and fails nothing on its own; it simply leaves the modern path to answer.

**It is an OR, not an AND.** An order whose legacy flag is set is satisfied even when the modern
certificate on the customer record has expired. That is deliberate — there is nothing to
re-check.

**Do not "improve" these by parsing them as dates and checking expiry.** The values are whatever
the old process happened to record, and a failed parse would turn a satisfied legacy order into a
held one.

**An order satisfied entirely by legacy fields costs no customer lookup.** The per-opportunity
lookup is skipped when the installer is blank, which is exactly the legacy case.

**A blank quote type behaves as neither checkbox ticked** — the design gate applies, the
certificate gate does not. That is the conservative reading: an order with no quote type still
has to have its design finished.

**The certificate dates are read from the CUSTOMER record**, not the opportunity. The equivalent
opportunity fields are unstored sourced fields and cannot be read by a search, so the script goes
to the customer that `custbody_installer_ns` points at. Which two fields those are is held in
script parameters, because it has to be configurable per account.

**"On or after today" passes** — a certificate expiring today is still valid. See section 5.

**The whole thing is wrapped. A failure must never block the opportunity save.** One
unreachable sales order fails that order, logs `OPPSYNC_ORDER_FAILED`, and the loop continues —
hence the per-order try/catch at step 7 rather than one try/catch around the loop.

**The field transfers:**

| From (Opportunity) | To (Sales Order) | How |
|---|---|---|
| `custbody_opportunity_sub_status` | `custbody_finance_status` | Through the mapping |
| `custbody_opp_del_date` | `custbody_defaultshipdate` | Direct — both dates |
| *(derived — see below)* | `custbody_ready_for_delivery` | Two gates on the Quote Type record |
| *(derived — see below)* | `custbody_delivery_hold_reason` | The failed gates, joined with `; ` |

### The decided status

One definition, used by the exclusion test, the design gate and the status write alike:

> **decided status** = the mapped status when `getMappedStatus()` returns one,
> otherwise **the sales order's own current status**.

When the sub-status maps to nothing:

- `custbody_finance_status` is **not written** — the order keeps the status it has.
- The **ship date is still written** on its own comparison. It is a direct copy from the
  opportunity and the status map has never governed it.
- The orders **are** searched and readiness **is** evaluated, each against its own current
  status.
- Every exclusion rule applies first and unchanged. An order at an excluded **entry** status is
  skipped entirely; and because the decided status equals the current status on an unmapped
  save, the second exclusion test cannot fire independently — the entry check has already
  caught it.

**Why readiness must not depend on the mapping:** the map governs status *propagation*, not
whether an order is fit to ship. A won opportunity at *Partially Delivered* or *Delivery
Complete* is unmapped by design, and can still carry a linked order that has not shipped —
one opportunity may have several orders. Gating readiness on whether a sub-status happens to
appear in `custscript_opsync_status_map` would leave those orders stale forever.

**The link between them** is the **native `opportunity`** field on the Sales Order. **Not
`createdfrom`.** The search filters on it together with `mainline is T`, so each order comes back
once rather than once per line.

### The mapping

The mapping is a **script parameter**, `custscript_opsync_status_map`, set on the deployment.
**It is not held on a record** — a custom record field was specified first and deliberately
abandoned. See section 5 for why, so that nobody re-adds the field later believing its absence
was an oversight.

**Format:** comma-separated `subStatusId:recordStatusId` pairs.

```
<subStatusId>:<recordStatusId>,<subStatusId>:<recordStatusId>, …
```

Both sides are internal IDs, so **the real value differs by environment** and is read off the
records in whichever account is being deployed to. It is not written down here — see section 3.

The parser is deliberately forgiving about shape and unforgiving about meaning:

| Input | Behaviour |
|---|---|
| Whitespace around any element | Trimmed. Someone will paste with spaces |
| An empty entry | Ignored, so a trailing comma is harmless |
| A pair that will not parse — no colon, or either side not a whole number | Logged as `OPPSYNC_MAP_INVALID_ENTRY` at error and **skipped**. The remaining pairs still apply: one typo must not disable the whole feature |
| The **same sub-status twice** | Logged as `OPPSYNC_MAP_AMBIGUOUS` at error and **that key is dropped entirely** — not the first, not the last. Other keys are unaffected |
| Empty, or nothing usable after parsing | A configuration error. Logged and **fails closed**, exactly like the other two parameters |

**The dropped-duplicate rule carries over unchanged from the record-based design**, and so does
its reasoning: there is no way to tell which of two conflicting rows was meant, writing a wrong
status onto a sales order is the failure this design exists to prevent, and writing nothing is
recoverable. A wrong status written silently is worse than no status written loudly — the whole
point of trap 1 in section 0.

**No match is not an error.** Most sub-statuses are deliberately unmapped; `getMappedStatus()`
returns `null` quietly and the caller stops.

**The parsed mapping is logged once per save** as `OPPSYNC_MAP_PARSED` at debug, one line of
`key -> value` pairs. With the deployment's Log Level on Debug, a typo can then be spotted by eye
in the execution log rather than inferred from an order that did not sync.

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

> This mapping is **data, held in the `custscript_opsync_status_map` parameter** on the
> deployment. The table records what was agreed, by name; the parameter holds the equivalent
> pairs of internal IDs and is set **per environment**. No internal IDs here — see section 3.

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

- **The mapping is a script parameter, not a custom record field — and that was a reversal.**
  The original design put the mapping on `customrecord_fin_stat` as a Multiple Select called
  `custrecord_fin_stat_opp_sub_status`. Sandbox testing reached `getMappedStatus()` and failed
  with `SSS_INVALID_SRCH_FILTER`: the field did not exist. **It is not going to.**

  The record approach was carried across from the sibling repo's Work Instruction configurator,
  where each row holds four attributes — a form, an assignee, a priority and an offset — and a
  record plainly earns its place. Here a row is **a single pair of IDs**. That does not justify a
  custom record field, seven rows to populate in every environment, and a search on every save.

  The parameter keeps environment-specific values out of the repository just as well, needs no
  new NetSuite object at all, and costs a string split instead of a query.

  **This was reconsidered after the record approach had been specified and written.** It is not
  an oversight and the field is not missing — do not add it, and do not "restore" the search.

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
  `asDateKey()` before any comparison.

- **The comparison key is never written. The Date is never compared.** This is the other half of
  the trap, and it bites in the opposite direction.

  `asDateKey()` produces a **localised** string. This is a UK account on `dd/mm/yyyy`, so the key
  for 5 September is `05/09/2026`. Hand that to `submitFields` and anything in the chain that
  reads it as `mm/dd` stores **9 May** instead. The failure is silent — no error, no log, just a
  ship date that moved four months — and it is only possible when the **day of the month is
  below 13**, because `13/09` and above cannot be read as a month. So it survives a test run on
  the 14th and fails on the 5th.

  The value written is therefore the **original `Date` object** that `record.getValue()`
  returned, via `asDateForWrite()`. NetSuite takes a `Date` natively: no formatting, no locale,
  nothing to parse, nothing to mis-parse.

  The two forms are deliberately separate variables:

  > **The string is a comparison key only and must never be written.
  > The Date is written and must never be compared.**

  They look redundant side by side and they are not. **Do not tidy them back into one
  variable** — the merged version passes every test run after the 13th of the month.

- **Design Cancelled is a one-way door**, and readiness freezes with it. See section 6.

- **Six of the seven parameters throw when unset. One does not. The rule is not importance —
  it is what EMPTY MEANS.**

  Ask of each parameter: if it is empty, does the script do *less*, or does it do *more*?

  | Parameter | Empty means | Behaviour |
  |---|---|---|
  | `custscript_opsync_qualifying_statuses` | No opportunity qualifies. The gate never opens, nothing is written | **Fails closed** — logs at error, returns `[]` |
  | `custscript_opsync_excluded_statuses` | **Nothing is excluded** — the script writes over orders at Release to Warehouse, Cancelled and Design Cancelled | **Fails open → throws** |
  | `custscript_opsync_status_map` | Nothing resolves, so no order is touched | Fails closed — logs at error, returns `null` |
  | `custscript_opsync_design_ok_statuses` | **No status satisfies the design gate** — every order stamped *"not ready, Design not complete"*, including ready ones | **Fails open → throws** |
  | `custscript_opsync_dno_ok_values` | **Every certificate-gated order reports *Awaiting DNO*** | **Fails open → throws** |
  | `custscript_opsync_cust_qual_field` | **Certificates cannot be read at all**, so they read as missing and every gated order is held | **Fails open → throws** |
  | `custscript_opsync_cust_pl_field` | As above | **Fails open → throws** |

  The excluded list is the one that matters most and the one most easily got wrong, because it
  reads like a safety mechanism and an empty safety mechanism looks harmless. It is not: an empty
  exclusion list does not protect nothing *by default*, it protects nothing *at all*, and the
  orders it stops protecting are precisely the ones the parameter exists for. A warehouse
  instruction written over a delivered order is not recoverable by re-saving.

  Every throwing parameter is resolved **before the sales order loop begins**, so a missing one
  cannot leave some orders written and the rest not. The throw is caught by the entry point's
  outer handler and logged as `OPPSYNC_FAILED`; the opportunity still saves.

  **When adding a parameter, apply the same test.** If empty removes a restriction, it throws.

- **Date ordering is numeric, not string.** `asDateKey()` is for equality only. Its output is a
  localised `dd/mm/yyyy` string, and comparing those with `<` or `>` orders them alphabetically —
  `05/12/2026` sorts before `06/01/2026` though it is a year later. Certificate expiry therefore
  goes through `asDayNumber()`, which builds a plain `YYYYMMDD` number from the date parts. Date
  parts also discard any time component, so **a certificate expiring today is valid** rather than
  failing on a stray timestamp — the case that would appear to work for every other date.

- **A failed lookup holds the order rather than shipping it.** An unreadable quote type is
  treated as design-required; an unreadable installer leaves both certificate dates blank, so
  they read as missing. Both directions are chosen so a lookup failure can never let an order
  through the gate it was supposed to be held by.

- **Readiness is evaluated against the status this save decided**, not the status the order had
  on entry. The design gate asks "will this order be far enough along once this save lands", not
  "was it before".

- **There is no "has the sub-status changed" short-circuit, and it must not come back.**
  Phase 2 exited early when neither the sub-status nor the delivery date had moved since
  `oldRecord`. That was correct while those two fields were the only inputs: if neither changed,
  nothing downstream could have changed either.

  Readiness broke that assumption. It depends on the installer, the two certificate dates on the
  installer's **customer** record, the subcontract date, `custbody38`, the quote type and the
  legacy evidence fields — **none of which the sub-status knows anything about**. The symptom was
  precise: editing a won opportunity to populate the installer left every linked sales order
  untouched, with nothing in the log to say why.

  Every save of a qualifying opportunity now evaluates readiness. **The optimisation did not go
  away, it moved down a level** — `syncSalesOrder()` compares each value against what the order
  already holds, leaves the unchanged ones out of the `submitFields` call, and makes no call at
  all for an order with nothing to change. That value comparison is also what keeps the feedback
  loop in section 0 trap 3 broken; the early exit was never what protected it.

  The cost is real and accepted: every save of a won opportunity now runs the order search and
  one `lookupFields` per order, where before an unchanged sub-status cost nothing.

- **Legacy evidence is an OR, not an AND**, carries no expiry, and lives on the **opportunity**.
  See section 4 — including why its presence test is not `isEmpty()`, and why satisfying every
  linked order is intended rather than a leak.

- **An unmapped sub-status no longer stops the save, and must not again.**
  Until 1.3.0 `getMappedStatus()` returning `null` returned before the orders were even
  searched. It was the second of two short-circuits with the same symptom as the Phase 3a
  defect: a won opportunity at an unmapped sub-status never had its readiness refreshed, and
  nothing in the log said so.

  The fix is the single **decided status** definition in section 4 rather than a special case:
  where there is no mapping, each order's own current status is what the design gate tests,
  because nothing is going to change it on this save.

  Two short-circuits, one lesson: **a guard that asks "did the thing Phase 2 cared about
  change?" is wrong the moment a new input arrives.** Filter at the value level, where the
  comparison is against what the record actually holds.

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
| **…and readiness freezes at that moment** | The save that writes an excluded status is the **last one that will ever touch that order**. Readiness is deliberately not evaluated on that save: the status and ship date are written, and `custbody_ready_for_delivery` and `custbody_delivery_hold_reason` are left exactly as they were — not set to `false`, not given a reason, not included in the write at all. An excluded status means the order is past the delivery gate or is dead, so readiness is not applicable, and "not ready" on a delivered order is not merely stale, it is wrong. **A stale `true` on a cancelled or delivered order is therefore expected behaviour, not a bug.** Nothing will clear it, because nothing should. |
| **Clearing a date by inline edit does not propagate** | On XEDIT a field absent from `newRecord` is indistinguishable from a field cleared to empty. The script resolves the ambiguity in favour of *absent* and falls back to `oldRecord` — so inline-clearing the delivery date leaves the orders' ship dates as they were. The safe failure was chosen deliberately: the alternative silently wipes ship dates on every unrelated inline edit. Clearing the date on the **full form** works normally. |
| **Governance stops are silent to the user** | If an opportunity has enough sales orders to exhaust the user event's governance, the loop stops cleanly and logs `OPPSYNC_GOVERNANCE_STOP` naming the orders it did not reach. The user who saved the opportunity sees nothing. Re-saving picks up the rest. Not expected in practice — an opportunity has a handful of orders, not hundreds. |
| **Two script IDs are auto-assigned and must be confirmed per account** | `customrecord16` (the Quote Type record) and `custbody38` (the DNO status) are **script IDs**, not internal IDs — NetSuite names an object `customrecordN` / `custbodyN` when the developer does not choose an id, so they are committable. But unlike a hand-chosen id they carry no guarantee of being the same in another account: they are only stable if the object travelled between accounts rather than being built separately in each. **Confirm both in Sandbox and Production before go-live.** A wrong one fails silently — `custbody38` reads as blank, which the DNO check reports as *Awaiting DNO* on every order. |
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
| `OPPSYNC_NO_MAPPING` | audit | The opportunity's sub-status resolves to no Record Status, so **no Record Status is written**. The orders are still searched and **readiness is still evaluated** against each order's own current status. Expected for every sub-status outside the design phase. | Normally nothing — most sub-statuses are deliberately unmapped (section 5). Investigate only if the sub-status *should* be mapped: read `OPPSYNC_MAP_PARSED` to see what the parameter actually resolved to, and look for `OPPSYNC_MAP_AMBIGUOUS` or `OPPSYNC_MAP_INVALID_ENTRY` just above it. |
| `OPPSYNC_MAP_AMBIGUOUS` | error | The **same sub-status appears more than once** in `custscript_opsync_status_map`. That key was dropped **entirely** — not resolved to the first or the last — so it now maps to nothing and its orders are left alone. Other keys are unaffected. | Remove the duplicate on the deployment. Until then, every opportunity at that sub-status leaves its orders untouched. |
| `OPPSYNC_MAP_INVALID_ENTRY` | error | One entry in `custscript_opsync_status_map` is not a `subStatusId:recordStatusId` pair of whole numbers. Names the offending text. **That entry was skipped and the rest of the mapping still applies** — one typo does not disable the feature. | Correct the named entry on the deployment. Any sub-status it was meant to carry currently resolves to nothing. |
| `OPPSYNC_MAP_PARSED` | debug | The mapping as actually parsed, one line of `key -> value` pairs. Normal operation. | Nothing. With Log Level on Debug this is how a typo is spotted by eye rather than inferred from an order that did not sync. |
| `OPPSYNC_ORDER_FAILED` | error | One sales order threw while being read or written. **The remaining orders were still processed.** | Read the logged error against the named order. Usually a locked or deleted order, or a permission problem on the executing role. |
| `OPPSYNC_GOVERNANCE_STOP` | error | The loop stopped with governance running low, naming how many orders were done and which were not reached. | Re-save the opportunity to pick up the rest. If it recurs, the opportunity has more orders than this design anticipated — see section 6. |
| `OPPSYNC_READINESS` | debug | One line per sales order: order, quote type, decided status, ready true/false, the reason, **and which path satisfied each certificate condition** — `modern`, `legacy`, `no installer` or `fail`. Normal operation. | Nothing. This is the first place to look when an order's readiness is not what was expected. **The paths are the only record of why an order with a blank installer is ready to ship** — when a legacy order surfaces in a year and nobody remembers these fields exist, this line is the explanation. |
| `OPPSYNC_READINESS_NOT_APPLICABLE` | debug | The status this save wrote is in the excluded list, so readiness was **not evaluated** and both fields were left as they were. Normal operation. | Nothing. Note the readiness values shown are now frozen — see section 6. |
| `OPPSYNC_QUOTE_TYPE_UNREADABLE` | error | A quote type record could not be read. Treated as **design-required, certificates not required** — the strictest reading of the design gate. | Check the quote type record exists and the executing role can read it. Until then those orders are gated on design. |
| `OPPSYNC_INSTALLER_UNREADABLE` | error | The installer customer record could not be read for the two certificate fields. **Both certificates read as missing**, so the order is held. | Check the customer record and the two field ids in the parameters. The held order is the safe outcome, not the bug. |
| `OPPSYNC_SYNC_SUMMARY` | audit | One line per opportunity: how many orders were updated, unchanged and skipped, and the status written. Normal operation. | Nothing. Use it to read the log at the level of "what did this save do". |
| `OPPSYNC_PARAMETER_MISSING` | error | A script parameter is unset, unreadable, or held nothing usable. Names the parameter. For the **qualifying** list and the **mapping** it is logged only and the script exits harmlessly. For the other five — **excluded statuses** and the four readiness parameters — it is also **thrown**, so the save is abandoned before any sales order is written. See the table in section 5 for why the two behaviours differ. | Populate the parameter on the deployment **in this account**; the values differ by environment. See section 8. |
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

4. **Define the seven script parameters on the script record, and set their values on the
   deployment:**

   | Label | ID | Type | What goes in it |
   |---|---|---|---|
   | Qualifying Opportunity Statuses | `custscript_opsync_qualifying_statuses` | Free-Form Text | A comma-separated list of the `entitystatus` internal IDs that open the gate, **as they are in this account**. Currently *Won* alone. |
   | Excluded Record Statuses | `custscript_opsync_excluded_statuses` | Free-Form Text | A comma-separated list of the Record Status internal IDs that must never be overwritten — the statuses whose orders belong to the warehouse and finance processes, **plus Cancelled**. **Required — the script throws without it**, because an empty list would protect nothing rather than protecting everything. |
   | Status Map | `custscript_opsync_status_map` | Free-Form Text | The mapping from section 4, as comma-separated `subStatusId:recordStatusId` pairs — seven of them, **using the internal IDs as they are in this account**. Read `OPPSYNC_MAP_PARSED` in the execution log after the first save to confirm it parsed as intended. |
   | Design OK Statuses | `custscript_opsync_design_ok_statuses` | Free-Form Text | Comma-separated Record Status IDs at which the design is far enough along to ship. **Required — the script throws without it.** |
   | DNO OK Values | `custscript_opsync_dno_ok_values` | Free-Form Text | Comma-separated `custbody38` values that satisfy the DNO check. Blank on the order always fails. **Required.** |
   | Customer Qualification Field | `custscript_opsync_cust_qual_field` | Free-Form Text | The **script ID** of the installer qualification expiry date field on the **customer** record. A parameter, not a constant, because the opportunity's equivalent is an unstored sourced field that cannot be searched. **Required.** |
   | Customer PL Field | `custscript_opsync_cust_pl_field` | Free-Form Text | The **script ID** of the Public Liability expiry date field on the customer record. As above. **Required.** |

   **All seven must be populated at deployment time, in each environment separately.** Their values
   are internal IDs and therefore **differ between Sandbox and Production** — read them off the
   records in the account you are deploying to. They are not in this repository and must not be
   put in it (section 3). An unset parameter logs `OPPSYNC_PARAMETER_MISSING` at error; an unset
   qualifying list closes the gate completely, and an unset mapping means nothing resolves —
   either way the feature does nothing at all.

5. Confirm the mapping parameter's seven pairs are right **for this account** — no sub-status
   appearing twice (that is the `OPPSYNC_MAP_AMBIGUOUS` case) and no typos (that is
   `OPPSYNC_MAP_INVALID_ENTRY`). There is **no field to create on `customrecord_fin_stat`** and
   no data to populate on the Record Status records; see section 5.
6. Confirm the three **legacy evidence fields** exist on the **opportunity** with exactly these
   IDs — `custbodysubcontract_received_legacy` (**no underscore after `custbody`**),
   `custbody_installer_qual_logged_legacy`, `custbody_installer_pl_logged_legacy`. A wrong ID
   reads as blank, which silently removes the legacy path and holds every legacy order.
7. **Disable the old `acs_ue_update_so.js` deployment.** The two must not both run. Two writers
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
| 14 | Put the **same sub-status twice** in the mapping parameter, then save an opportunity at that sub-status | **Nothing written for that sub-status.** `OPPSYNC_MAP_AMBIGUOUS` at error. Confirm in `OPPSYNC_MAP_PARSED` that the key is absent entirely — not resolved to the first or last. **Revert afterwards** |
| 15 | Clear the **Excluded Record Statuses** parameter and save | `OPPSYNC_PARAMETER_MISSING` at error. **Revert afterwards** |
| 16 | Clear the **Qualifying Opportunity Statuses** parameter and save | `OPPSYNC_PARAMETER_MISSING` at error and **nothing runs** — the gate fails shut. **Revert afterwards** |
| 17 | Move an opportunity to **Design Cancelled**, then to another mapped sub-status | The order goes to *Cancelled* and then **stays there** — skipped from that point on. This is the one-way door in section 6, not a bug |
| 18 | **Delete** an opportunity | Nothing runs |
| 19 | Set the delivery date to a day of the month **below 13** — e.g. **5 September** — and sync | The order's expected ship date reads **5 September**, not 9 May. This is the only case where a `dd/mm` vs `mm/dd` mis-parse is visible; a date of the 14th or later cannot show it. **Run this one deliberately** — see section 5 |
| 20 | The same date again on a second save | `OPPSYNC_ORDER_UNCHANGED` at debug, no write. Confirms the comparison key still matches after a round trip through the record |
| 21 | Put a **malformed pair** in the mapping parameter — e.g. `banana` or a missing colon — alongside the good ones, then sync a **mapped** sub-status | `OPPSYNC_MAP_INVALID_ENTRY` at error naming the offending text, **and the order still updates**. One typo must not disable the feature. **Revert afterwards** |
| 22 | The same, but sync the sub-status the **malformed** entry was meant to carry | That sub-status resolves to nothing: `OPPSYNC_NO_MAPPING`, no order touched |
| 23 | Paste the mapping **with spaces around the pairs** and a **trailing comma** | Parses normally. `OPPSYNC_MAP_PARSED` shows the full mapping, no error lines |
| 24 | Clear the **mapping** parameter entirely and save | `OPPSYNC_PARAMETER_MISSING` at error, **nothing resolves, no order touched** — fails closed like the other two. **Revert afterwards** |
| 25 | Read `OPPSYNC_MAP_PARSED` after the first save in a fresh environment | The line matches the seven rows in section 4, translated to that account's IDs. **Do this once per environment at deployment** — it is the cheapest possible check on a hand-typed parameter |

### Delivery readiness

| # | Scenario | Expected |
|---|---|---|
| 26 | Design-required quote type, status in the design-ok list | **Ready**, hold reason blank |
| 27 | Design-required quote type, status not in the design-ok list | Not ready, `Design not complete` |
| 28 | *"Can ship without design"* ticked, certificates not required | **Ready regardless of status** |
| 29 | Blank quote type, status in the design-ok list | **Ready** |
| 30 | Blank quote type, status not in the design-ok list | Not ready, `Design not complete` |
| 31 | Certificates-required quote type, every condition passes | **Ready** |
| 32 | Certificates required, PL expiry **yesterday** | Not ready, `Public Liability certificate expired` |
| 33 | Certificates required, PL expiry **today** | **Ready.** On or after today passes — see section 5 |
| 34 | Certificates required, qualification expiry **blank** | Not ready, `Installer qualification certificate missing` |
| 35 | Certificates required, `custbody38` blank | Not ready, `Awaiting DNO` |
| 36 | Certificates required, design incomplete **and** DNO blank | Not ready, both reasons joined with `; ` |
| 37 | Certificates required, **installer blank** on the opportunity | Not ready, `Installer not set on opportunity` — and **not** two extra expiry reasons |
| 38 | Opportunity with 3 orders, one at an excluded **entry** status | That one untouched; the other two evaluated |
| 39 | The same opportunity saved twice with no change | **Zero `submitFields` calls** on the second save. Check the orders' system notes |
| 40 | Any of the four readiness parameters unset | `OPPSYNC_PARAMETER_MISSING` at error, **no partial writes** — no order is written at all |
| 45 | **`custscript_opsync_excluded_statuses` unset**, on an opportunity with several orders including one at an excluded status | `OPPSYNC_PARAMETER_MISSING` at error and `OPPSYNC_FAILED`. **No write to any linked sales order** — the protected orders are untouched rather than overwritten. Contrast with scenario 46. **Revert afterwards** |
| 46 | **`custscript_opsync_qualifying_statuses`** unset | `OPPSYNC_PARAMETER_MISSING` at error, **no `OPPSYNC_FAILED`**, nothing written. The gate simply never opens — this one fails closed and does *not* throw. See section 5 |
| 41 | **Both** checkboxes ticked, status not design-ok, certificates all valid | **Ready** — design skipped, certificates pass. Neither checkbox short-circuits the other |
| 42 | **Both** checkboxes ticked, status not design-ok, PL expired | Not ready, **PL reason only** — no design reason |
| 43 | Non-excluded entry status, sub-status maps it **onto an excluded status** | Status and ship date written; **both readiness fields untouched** at whatever they held. `OPPSYNC_READINESS_NOT_APPLICABLE` at debug |
| 44 | Status and ship date both unchanged, but a certificate has expired since the last save | **The write still happens**, carrying only the two readiness fields |
| 47 | Won opportunity, **sub-status unchanged**, installer added | Readiness **re-evaluated and written**. This is the Phase 3a defect — a no-op here means the short-circuit is back |
| 48 | Won opportunity, sub-status unchanged, **nothing** else changed | Evaluated, **no writes**. `OPPSYNC_ORDER_UNCHANGED` at debug |
| 49 | Installer **blank**, all three legacy fields populated, design ok, DNO ok | **Ready**, blank reason — and **no customer lookup performed**. Check `paths=…legacy` in `OPPSYNC_READINESS` |
| 50 | Installer blank, **only the PL legacy** field populated | Not ready. `Installer not set on opportunity` **exactly once**, not twice |
| 51 | Installer set with valid certificates, legacy fields **also** populated | **Ready.** Legacy is redundant here, not conflicting |
| 52 | Installer set, qualification **expired**, qual legacy field populated | **Ready** — legacy wins. It is an OR, not an AND |
| 53 | Legacy subcontract populated, modern subcontract blank, all else ok | **Ready** |
| 54 | All legacy fields populated but `custbody38` blank | Not ready, `Awaiting DNO`. **There is no legacy path for DNO** |
| 55 | Won opportunity at an **unmapped** sub-status, installer added, order at a non-excluded, non-design-ok status | Readiness **evaluated and written**. `custbody_finance_status` **not written** |
| 56 | Won opportunity at an unmapped sub-status, order at an **excluded** status | **Skipped entirely**, nothing written — the entry exclusion catches it |
| 57 | Unmapped sub-status, order at a **design-ok** status, all certificate conditions pass | **Ready written, status untouched** |
| 58 | Unmapped sub-status, nothing materially changed | Evaluated, **zero writes** |
| 59 | Unmapped sub-status, **delivery date changed** | **Ship date written**, status not. The ship date is independent of the map — see section 4 |
| 60 | Opportunity with **two** linked orders, qualification and PL legacy flags set **on the opportunity**, both orders design-ok and DNO ok | **Both orders ready**, and **zero customer lookups**. One opportunity-level flag satisfies every linked order — see section 4 |
| 61 | A legacy flag present as an **unticked checkbox** (boolean `false`) | Treated as **NOT present**; falls through to the modern path. Check `paths=…modern` in `OPPSYNC_READINESS`, not `legacy`. **This is the test that catches the `String(false)` trap** |
| 62 | The same, with the installer also blank | Falls through to `Installer not set on opportunity` — proving the fall-through is real rather than a silent pass |
| 63 | A legacy flag present as a **ticked checkbox** (boolean `true`) | Treated as present. `paths=…legacy` |

Extend this table as scenarios are found. **Revert any configuration changed for a test.**

---

## 10. Open items

### Confirmed NetSuite IDs

Script IDs only — **no internal IDs**, here or anywhere else in this document. See section 3.

| Item | Script ID | Type | Confirmed by | Date |
|---|---|---|---|---|
| Record Status custom record | `customrecord_fin_stat` | Custom record | Steve | 2026-09-14 |
| Opportunity: design sub-status | `custbody_opportunity_sub_status` | List → `customlist_opp_sub_status_list` | Steve | 2026-09-14 |
| Opportunity: delivery date | `custbody_opp_del_date` | Date | Steve | 2026-09-14 |
| Sales Order: Record Status | `custbody_finance_status` | List/Record → `customrecord_fin_stat` | Steve | 2026-09-14 |
| Sales Order: expected ship date | `custbody_defaultshipdate` | Date | Steve | 2026-09-14 |
| Sales Order → Opportunity link | `opportunity` | **Native** field — not `createdfrom` | Steve | 2026-09-14 |
| Sales Order: ready for delivery | `custbody_ready_for_delivery` | Checkbox, Inline Text on forms | Steve | 2026-09-15 |
| Sales Order: delivery hold reason | `custbody_delivery_hold_reason` | Long text, Inline Text on forms | Steve | 2026-09-15 |
| Sales Order: quote type | `custbody_quote_type` | List/Record → Quote Type record | Steve | 2026-09-15 |
| Sales Order: subcontract received | `custbody_installer_subcontract_receive` | — | Steve | 2026-09-15 |
| Sales Order: DNO status | `custbody38` | **Auto-assigned** script ID — see section 6 | Steve | 2026-09-15 |
| **Opportunity**: legacy subcontract | `custbodysubcontract_received_legacy` | **No underscore after `custbody`** — see §0 trap 5. Type unconfirmed | Steve | 2026-09-15 |
| **Opportunity**: legacy qualification logged | `custbody_installer_qual_logged_legacy` | Presence test only. Type unconfirmed | Steve | 2026-09-15 |
| **Opportunity**: legacy PL logged | `custbody_installer_pl_logged_legacy` | Presence test only. Type unconfirmed | Steve | 2026-09-15 |
| Opportunity: installer | `custbody_installer_ns` | List/Record → Customer | Steve | 2026-09-15 |
| Quote Type record | `customrecord16` | **Auto-assigned** script ID — see section 6 | Steve | 2026-09-15 |
| Quote Type: can ship without design | `custrecord_qt_no_design_required` | Checkbox | Steve | 2026-09-15 |
| Quote Type: requires installer certificates | `custrecord_qt_requires_installer_certs` | Checkbox | Steve | 2026-09-15 |

### Closed questions

| # | Question | Resolution | Closed |
|---|---|---|---|
| 1 | Is *Redraw Required* in or out of the excluded list? | **Out.** An order sitting at Redraw Required should be moved on when the opportunity says so. | 2026-09-14 |
| 2 | Is the excluded list a list of **current** statuses, not of targets? | **Current statuses.** Which makes *Design Cancelled → Cancelled* a one-way door — deliberately. See section 6. | 2026-09-14 |
| 3 | Which field links a Sales Order to its Opportunity? | The **native `opportunity`** field. **Not `createdfrom`.** | 2026-09-14 |
| 4 | Where does the mapping live, and is comparison by ID or by text? | **Superseded — see question 6.** Comparison is **ID-to-ID** either way. See section 0, trap 4. | 2026-09-14 |
| 5 | How should XEDIT's sparse `newRecord` be handled? | Read `newRecord` first, fall back to `oldRecord`. See section 5. | 2026-09-14 |
| 6 | Should the mapping be a field on `customrecord_fin_stat`? | **No, and the field will not be created.** It is the script parameter `custscript_opsync_status_map`. The record approach was specified, written, and abandoned after Sandbox testing — a single pair of IDs does not justify a custom record. See section 5. | 2026-09-14 |
| — | Should the status internal IDs stay in this document as human reference? | **No.** Every one removed, and the rule now has no exceptions. See section 3. | 2026-09-14 |

### Open questions

| # | Question | Status |
|---|---|---|
| 0 | What TYPE are the three legacy evidence fields — checkbox, date or text? | **Open, and the code does not need the answer.** `isLegacyPresent()` is correct for all three. Worth confirming anyway: if any is a checkbox, §9 scenario 61 is the one that must pass. |
| 1 | Should `custbody_cad_worklist` on existing sales orders be **cleared** when the worklist record retires, or left as history? | **Open.** Clearing is a one-off data job, not something this feature does. Leaving it means a field pointing at a retired record. Nothing in this repo reads or writes it. |
| 2 | Is the *Won* gate early enough to be useful? | **Open, and knowingly accepted.** See section 6. It is a parameter, so widening it needs no code. |

### NetSuite configuration tasks for Steve

Not code. These are account changes the scripts assume have been made.

| # | Task | Why it matters |
|---|---|---|
| 1 | Define **seven** script parameters on the script record and set their values on the deployment, **in each environment** | Section 8, step 4. This now includes the mapping itself. An unset qualifying list or an unset mapping makes the feature completely inert, and the only sign is one error line in the log. |
| 2 | Disable the `acs_ue_update_so.js` deployment when this one goes live | Section 8, step 6. Two writers of `custbody_finance_status`. |
| 3 | Create the two checkboxes on the Quote Type record and tick them per quote type | Section 4. Until they exist every quote type reads as "design required, certificates not required" — orders will be gated on design alone. |
| 4 | Set `custbody_ready_for_delivery` and `custbody_delivery_hold_reason` to **Inline Text** on all sales order forms | The script owns both fields. If users can edit them, their edits are silently overwritten on the next opportunity save. |
| 5 | Confirm `customrecord16` and `custbody38` are those exact script IDs in **both** environments | Section 6. Auto-assigned ids carry no cross-account guarantee, and a wrong `custbody38` reads as blank — every order then reports *Awaiting DNO*. |
| 6 | Check `OPPSYNC_MAP_PARSED` in the log after the first save in each environment | Section 9, scenario 25. A hand-typed parameter of seven ID pairs is the most likely thing to be wrong, and this is the only place it becomes visible. |
