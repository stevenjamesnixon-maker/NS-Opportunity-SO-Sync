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

6. **`custbody_` tells you nothing about which record a field is on.**
   It means "transaction body field" — nothing more. It does not say which transaction types the
   field applies to, and **a field that does not apply to the record you ask returns BLANK
   rather than erroring.**

   Four fields in this project were assumed to be on the sales order from the prefix alone and
   were all on the **opportunity**: `custbody38` and the three legacy evidence flags. Each one
   failed the same way — a legitimate-looking "not satisfied" verdict, no error, nothing in the
   log. `custbody38` cost a full Sandbox cycle and an investigation that first chased the wrong
   cause entirely.

   > **A field ID in a brief is not usable until its record has been confirmed from the field
   > definition's *Applies To*. A brief that names a field without naming its record should be
   > sent back.**

   Confirmed records for every field this script touches are in section 10.

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
| Shared config library | 1.10.0 | `lib/opsync_lib_config.js` | Every script ID in the project, and the nine script parameters — including the status mapping | Production — confirmed by the client 22 Sep 2026 |
| Shared value library | 1.0.0 | `lib/opsync_lib_values.js` | The value-shape layer — one definition of what a select, a date or a presence flag *means*, whichever API returned it | Production — confirmed by the client 22 Sep 2026 |
| Shared readiness library | 1.0.0 | `lib/opsync_lib_readiness.js` | **The one definition of delivery readiness.** Both user events call it; neither has a copy | Production — confirmed by the client 22 Sep 2026 |
| Opportunity user event | 1.8.2 | `opsync_ue_opportunity.js` | `afterSubmit` on Opportunity — syncs Record Status, ship date and delivery readiness to the sales orders | Production — confirmed by the client 22 Sep 2026 |
| Sales order user event | 1.0.0 | `opsync_ue_salesorder.js` | `afterSubmit` on Sales Order — re-evaluates readiness for that one order. Writes the two readiness fields and **nothing else** | Production, deployment status **Testing** — confirmed by the client 22 Sep 2026 |
| Design Instruction config library | 1.3.0 | `lib/dsi_lib_config.js` | Every script ID and parameter of the Design Instruction feature. **Separate from `opsync_lib_config.js`** — see section 11. Also loaded by the client script | Not deployed |
| Design Instruction opportunity user event | 1.2.0 | `dsi_ue_opportunity.js` | `beforeLoad` on Opportunity — the two buttons; `afterSubmit` — creates a Design Instruction row when the sub-status moves to a creating value | Not deployed |
| Design Instruction opportunity client script | 1.1.0 | `dsi_cs_opportunity.js` | Request Design / Request Redraw — confirm, write the sub-status, land on the redraw row. **Attached by `beforeLoad`; no script record, no deployment** | Not deployed |
| Design Instruction row user event | 1.2.0 | `dsi_ue_design_instruction.js` | `beforeSubmit` and `afterSubmit` on `customrecord_cad_worklist` — design start stamp, completion gate, completion write-back to the opportunity | Not deployed |

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

**The certificate gate is this script's definition of a heat pump project.** Every rule that
applies only to heat pumps lives inside it and needs no field of its own to decide what a heat
pump is. `custbody_value_proposition` is deliberately **not** consulted: the physical product
decides these rules, not the commercial package, and a second definition of "heat pump" in the
same rule would be free to disagree with the first.

The certificate checks, in the order their reasons are joined:

Three conditions with a legacy path, plus DNO and the BUS voucher which have none — all
evaluated **independently**:

| # | Condition | Satisfied by | Failure reason |
|---|---|---|---|
| 1 | Subcontract | `custbody_installer_subcontract_receive` **or** `custbodysubcontract_received_legacy` — **both** through the presence test | `Subcontract agreement not received` |
| 2 | Installer qualification | `custbody_installer_qual_logged_legacy`, **else** the customer's qualification expiry | `Installer not set on opportunity` / `Installer qualification certificate missing` / `… expired` |
| 3 | Public Liability | `custbody_installer_pl_logged_legacy`, **else** the customer's PL expiry | `Installer not set on opportunity` / `Public Liability certificate missing` / `… expired` |
| 4 | DNO | `custbody38` **on the opportunity** in `getDnoOkValues()` — blank or absent fails. **No legacy path exists** | `Awaiting DNO` |
| 5 | BUS voucher | `custbody_bus_project_rhi_intended` = `getBusNoValue()` (condition does not apply), **else** `custbody_voucher_approval_date` non-blank. **No legacy path exists** | `BUS intention not confirmed` / `Awaiting BUS voucher application` / `Awaiting BUS voucher approval` — **at most one** |

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

**The DNO status is opportunity-level too.** `custbody38` is on the opportunity — the sales
order has no DNO field at all — so it is read once per save and applies to every linked order.
That is correct: the DNO notification is a property of the installation, not of an individual
order.

**Because they are opportunity-level, legacy evidence satisfies the certificate gate for EVERY
sales order linked to that opportunity — including any order added later.** That is intended, not
a leak: the flags record that the work was verified under the old process, and the opportunity is
the unit that process operated on. Do not later read it as a bug and scope it per order.

### The BUS voucher condition

Heat pump orders must not be shippable until the Boiler Upgrade Scheme voucher has been approved,
where the project is intended for BUS. Both fields are **on the OPPORTUNITY** and are read once
per save through `effectiveValue()`, alongside the DNO status and the legacy flags — never per
order.

| Field | Script ID | Type |
|---|---|---|
| Voucher approval date | `custbody_voucher_approval_date` | **Date — confirmed.** Tested with `isPresent()`, not `isEmpty()` |
| Voucher **application** date | `custbody_application_date` | **Date — confirmed.** Tested with `isPresent()`, not `isEmpty()` |
| Intended for BUS | `custbody_bus_project_rhi_intended` | List → `customlist92` (*YesNo*) |

The rule, evaluated inside the certificate gate and **only** there:

1. `custbody_bus_project_rhi_intended` equals `getBusNoValue()` → **the condition does not
   apply**, passes with no check.
2. Otherwise `custbody_voucher_approval_date` is not blank → **passes**.
3. Otherwise the intention is **blank** → not ready, `BUS intention not confirmed`.
4. Otherwise `custbody_application_date` is **blank** → not ready,
   `Awaiting BUS voucher application`.
5. Otherwise → not ready, `Awaiting BUS voucher approval`.

**The three failure reasons are actioned by three different people**, which is the whole reason
they are separate:

| Reason | What it means | Who acts |
|---|---|---|
| `BUS intention not confirmed` | Nobody has recorded whether this project is for BUS | Whoever owns the opportunity — it may make the condition moot |
| `Awaiting BUS voucher application` | Intended for BUS, nobody has applied yet | Whoever submits applications — this is a job, not a wait |
| `Awaiting BUS voucher approval` | Applied, waiting on the scheme | Nobody here. A genuine wait, and nothing to chase |

**At most one BUS reason ever appears in the hold string.** It is one `if/else` chain, not four
independent tests. Two BUS reasons at once would read as two problems where there is one — do
not refactor it into separate `if`s.

**The intention question takes precedence over the application question.** A blank intention
reports `BUS intention not confirmed` whether or not an application date exists: an application
recorded against an unrecorded intention is still an unanswered question, and answering it may
make the whole condition moot.

**The application date is only ever consulted once the approval date is known to be blank**, so
it can never contradict an approval.

**All three are confirmed on the Opportunity from their field definitions' Applies To**, which
for `custbody_application_date` is what makes the read above the right one. A field that does
not apply to the record being asked returns **blank** rather than erroring, and blank is not
inert here: it would rewrite every `Awaiting BUS voucher approval` as `Awaiting BUS voucher
application` — a genuine wait reported as somebody's job, with nothing logged. §9 scenario 70
is the regression test, and the only thing that would notice if the field were moved. See
section 0, trap 6.

**Blank is deliberately treated as "intended" and holds the order.** A project that should have
claimed a voucher and shipped without one cannot claim it retrospectively, so the safe direction
is to hold and ask.

**The failure reasons are deliberately different and must not be merged.** See the table above.

**There is no legacy path, and there is no legacy field to build one from.** The BUS scheme
postdates the old process entirely; the three legacy flags say nothing about a voucher and must
not be wired in here.

**The empty-parameter guard is load-bearing.** `getBusNoValue()` returns `''` when unset, and a
blank intention normalises to `''` too. A bare equality test would match the two and switch the
condition **off** for every order — turning a parameter that is supposed to fail closed into one
that ships goods. The comparison therefore requires a non-empty parameter first. See section 5.

#### The presence test

**`isPresent()` is the project's presence test.** It is used wherever "is this field filled in"
decides whether an order ships — the three legacy flags, `custbody_voucher_approval_date` and
`custbody_installer_subcontract_receive`.

> It was called `isLegacyPresent()` until 1.5.3, and the rename is not cosmetic. By then it
> served a confirmed Date and a `lookupFields` value as well as the legacy flags, so a reader
> meeting `isLegacyPresent(voucherDate)` had to go and check whether they were looking at a bug.
> **A helper whose name has to be explained away in a comment is the same defect as `custbody_`
> meaning only "transaction body field"** — see section 0, trap 6 — in a cheaper place.

**The legacy field types are not confirmed** — they may be checkbox, date or text — so the test
has to be correct for all three. `isPresent()` treats **boolean `false`, `''`, `null` and
`undefined`** as absent, plus the strings `'F'` and `'false'` in case a checkbox reaches it by a
path that stringifies it. It is also correct for a date, which is why a confirmed Date uses it.

> **Use it even when the type is confirmed.** `isEmpty()` would be correct for
> `custbody_voucher_approval_date` today. It would stop being correct the moment somebody
> changes that field to a checkbox in the UI, and nothing in the script would notice — the
> failure is silent and in the ship-the-goods direction. **Close the class, not the instance.**
>
> **There is no longer any exception.** `custbody_installer_subcontract_receive` was the last
> `!isEmpty()` test of this kind and moved across in 1.5.2. If a new presence-gates-shipping
> test appears on `!isEmpty()`, that is the defect — not the field it happens to be reading.

**It works on a `lookupFields` result as well as on a record, and the subcontract field is the
proof.** That field is read through `lookupValue()`, which stringifies, so an unticked checkbox
arrives as the five-character string `"false"` rather than as boolean `false` — precisely the
shape `!isEmpty()` reads as **present**. The test rejects `'false'` and `'F'` by name for that
case, so both shapes are covered.

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
| `custbody_opp_del_date` | `custbody_defaultshipdate` | Direct — both dates, **unless the decided status suppresses it** (below) |
| *(derived — see below)* | `custbody_ready_for_delivery` | Two gates on the Quote Type record |
| *(derived — see below)* | `custbody_delivery_hold_reason` | The failed gates, joined with `; ` |

### Readiness is evaluated by TWO scripts

Until 1.8.0 readiness was evaluated only in the opportunity's `afterSubmit`, so it only
refreshed when somebody saved the **opportunity**. Once design is complete people work on the
**sales order** — the subcontract date, the quote type, the finance status — and nothing saves
the opportunity, so nothing re-evaluated. The two readiness fields went stale exactly when the
order was in active use, and a stale *ready* ships goods.

`opsync_ue_salesorder.js` closes that. `afterSubmit` on the Sales Order, in order:

1. Recursion guard — **change detection only**, see section 5.
2. **No linked opportunity → skip.** No context to evaluate from.
3. **Record Status in `getExcludedStatuses()` → skip.** The *same* list the opportunity script
   uses — see below.
4. Build the opportunity context: **one** `lookupFields` on the linked opportunity, then one on
   the installer's customer record, **skipped entirely when the installer is blank**.
5. Read the quote type's two checkboxes.
6. Evaluate, compare with what the order holds, `submitFields` **only if something changed**.
7. Log one line per save either way.

**It writes two fields and only two** — `custbody_ready_for_delivery` and
`custbody_delivery_hold_reason`. The Record Status and the expected ship date stay
opportunity-driven. Adding a third field to that write is how the two scripts start fighting
over one record.

**The order's own fields come from `newRecord` through `effectiveValue()`**, the same XEDIT-aware
fallback the opportunity script uses. An inline edit gives a sparse `newRecord` where an
untouched field reads as *empty* rather than as *unchanged* — reading the quote type straight off
it would see a blank quote type, skip the certificate gate, and mark a held order ready.

#### One rule, two callers

The evaluation moved into `lib/opsync_lib_readiness.js` and **neither script has a copy**.

> **If the two callers ever disagree about an order, the result is worse than either answer on
> its own.** Each writes its verdict over the other's, on a record people are reading, with
> nothing logged to say they differ. One shared module is the only defence. Do not inline "just
> this one check" into either entry point.

`evaluate(oppContext, orderFacts)` **takes a context, not a record**, and never loads a record or
runs a search — the callers fetch, it decides. That is what lets one rule serve a caller reading
off the record being saved and a caller reading through `lookupFields`, which return the same
field in different shapes: a select is a plain id one way and an array of `{value,text}` the
other; a date is a `Date` one way and a localised string the other. Every value is normalised
through `lib/opsync_lib_values.js`, which accepts both.

#### The excluded list is reused, deliberately

The sales order script tests `getExcludedStatuses()` — **not** a second definition based on the
native transaction status. That list already means *"past the delivery gate or dead"*, and
*Release to Warehouse* is already in it.

**Two definitions of done are two answers to one question.** A second one would drift from the
first, and the drift would show up as an order the opportunity thinks is live and the sales
order thinks is finished.

#### ⚠️ Six parameters exist twice, under DIFFERENT NAMES

**A script parameter is a custom field, and custom field IDs are unique across the NetSuite
account.** A second script consuming the same configuration therefore **cannot** reuse the first
script's parameter IDs — NetSuite rejects them as already in use. This was tried in the account
and refused. It is not a theory, and it is the reason for everything in this section.

So the six the readiness evaluation needs exist twice, with **different prefixes**:

| Purpose | `customscript_opsync_ue_opportunity` | `customscript_opsync_ue_salesorder` |
|---|---|---|
| Excluded statuses | `custscript_opsync_excluded_statuses` | `custscript_sosync_excluded_statuses` |
| Design OK statuses | `custscript_opsync_design_ok_statuses` | `custscript_sosync_design_ok_statuses` |
| DNO OK values | `custscript_opsync_dno_ok_values` | `custscript_sosync_dno_ok_values` |
| Customer qualification field | `custscript_opsync_cust_qual_field` | `custscript_sosync_cust_qual_field` |
| Customer PL field | `custscript_opsync_cust_pl_field` | `custscript_sosync_cust_pl_field` |
| BUS "No" value | `custscript_opsync_bus_no_value` | `custscript_sosync_bus_no_value` |

Three exist **only** on the opportunity script, because only it uses them:
`custscript_opsync_qualifying_statuses`, `custscript_opsync_status_map` and
`custscript_opsync_no_shipdate_statuses`.

**The Design Instruction feature has one pair of its own**, under the same constraint and with the
same risk — see section 11:

| Purpose | `customscript_dsi_ue_opportunity` | `customscript_dsi_ue_design_instruction` |
|---|---|---|
| Completion sub-status (*Post Design Check*) | `custscript_dsi_complete_status` | `custscript_dsirow_complete_status` |

The row script **writes** its value to the opportunity on completion; the opportunity script
reads its copy only for the overlap check. If the two diverge, that check tests the wrong value.

> **The differing prefix makes the duplication risk worse than a plain copy would be.**
> `custscript_opsync_design_ok_statuses` and `custscript_sosync_design_ok_statuses` are meant to
> hold the **same value**, and nobody comparing two deployments side by side will spot that.
> They do not sort together, they do not grep together, and **nothing in NetSuite relates them**.
>
> If they diverge the two scripts disagree about whether an order is ready — and disagree
> **silently**, each overwriting the other on the next save of its own record. There is no log
> line for "the two scripts hold different parameter values", because neither can see the
> other's. Scenario 98 exists to show the failure mode once, deliberately.

#### How the library resolves them

`opsync_lib_config.js` holds an explicit map keyed by script ID — `SCRIPT_PARAMETERS` — naming
each script's parameters. Every accessor names a **logical key** (`DESIGN_OK_STATUSES`), and
`resolveParameterId()` turns that into the real ID for
`runtime.getCurrentScript().id`. Accessor names and return values are unchanged, so neither user
event needed rewriting.

**The map is explicit on purpose. There is no derivation and no fallback:**

- a **derivation** from the script id — swapping `opsync` for `sosync` — is magic that breaks
  silently the day a third script arrives with a different prefix;
- a **fallback** — try one ID, then the other — masks a misconfiguration by reading the **wrong
  script's value**, which is the worst possible outcome for two parameter sets whose entire job
  is to agree.

A new script means a new row in that map. That is the intended cost.

| Failure | Behaviour |
|---|---|
| The executing script is **not in the map** | **Throws once**, naming the script id and saying to add its row. A configuration error, not a data state — failing closed would produce six confusing failures instead of one clear one |
| An accessor is called for a parameter its script **does not define** — `getMappedStatus()` from the sales order script | **Throws**, naming both the accessor and the script. Not "empty": empty would look like an unset parameter and be "fixed" on a deployment where the field does not exist |

Per-parameter failure modes are unchanged — six throw when missing, three fail closed.

**This duplication was chosen deliberately over a shared configuration record**, and the
trade-off was weighed rather than defaulted into:

| | Duplicated parameters (chosen) | A shared config record |
|---|---|---|
| Environment-specific values stay out of the repo | Yes | Yes |
| New NetSuite object to create in each account | None | One custom record, plus rows |
| Cost per evaluation | A parameter read | **A search on every save of every order** |
| Failure mode | Two values drift apart | One value, but a search that can fail or be slow |
| Precedent in this project | The status map moved **off** a record and onto a parameter for exactly these reasons — section 5 | — |

The deciding factor is the third row. The sales order script runs on **every save of every sales
order**, which is far more often than the opportunity script runs, and a configuration search on
that path is a cost paid forever to avoid a copy-paste that happens twice. The risk is real and
is why it is flagged here, in the config library and in the deployment checklist — but a search
per save is a worse permanent trade than a checklist item.

### Suppressing the ship date by status

Once a job reaches design complete the delivery date is managed **on the sales order**. The
opportunity must stop overwriting it at that point.

`custscript_opsync_no_shipdate_statuses` holds the `custbody_finance_status` ids for which the
ship-date write is suppressed — *Design Complete* and *Redraw Required* in this account. When the
order's **decided status** is in that list:

- `custbody_defaultshipdate` is **not written**;
- everything else happens **exactly as before** — the Record Status write, and the full readiness
  evaluation including `custbody_ready_for_delivery` and `custbody_delivery_hold_reason`.

#### Do NOT solve this with the excluded list

> **"Just add those statuses to `custscript_opsync_excluded_statuses`" is the obvious answer and
> it is wrong.** It is written here because someone will suggest it again.
>
> The excluded list **skips the order entirely** — no status write, no ship date, and **no
> readiness evaluation**. That is the whole point of it, and it is precisely wrong here:
>
> - **Design Complete is the status where readiness matters most.** It is the point at which an
>   order is a candidate to ship, and the gates decide whether it may.
> - **Redraw Required is where readiness must DROP to not-ready.** An order that was ready and
>   goes back for redraw has to stop being ready, and only an evaluation can do that.
>
> Excluding either would **silently disable the delivery readiness feature for exactly the orders
> it exists for** — and silently, because a skipped order logs `OPPSYNC_ORDER_SKIPPED` at audit
> and looks like normal operation.
>
> The two parameters are not interchangeable and must never be conflated: **the excluded list
> skips the ORDER, this list suppresses ONE FIELD.**

#### Why the decided status, not the entry status

The test is on the **decided status** — the mapped status if there is one, otherwise the order's
own current status. So **the save that moves an order INTO Design Complete already stops syncing
the date**, on that same save.

That is deliberate: the boundary is the order *reaching the stage*, not the save after it.

**The alternative was to test the status on ENTRY**, which would allow one final sync — the date
as it stood when the order arrived at design complete would be copied across, and only subsequent
saves would be suppressed. It is recorded here so the choice is visible rather than looking like
an oversight.

It was rejected because that final write is the one most likely to be wrong: the save that moves
an order to Design Complete is exactly when the sales order side starts owning the date, and a
last copy from the opportunity would land on top of a value somebody may already have set. "One
more sync" is also not a rule anyone can hold in their head — *"the opportunity stops writing the
date once the order reaches this status"* is.

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

- **Six of the nine parameters throw when unset. Three do not. The rule is not importance —
  it is what EMPTY MEANS.**

  Ask of each parameter: if it is empty, does the script do *less*, or does it do *more*?

  > **Count the table against the code before trusting this sentence.** It read *"six of the
  > seven throw, one does not"* from the day it was written and was wrong then too — the status
  > map has never thrown. Corrected in 1.6.1. This table is the authoritative record of which
  > parameter fails which way, and it is consulted precisely when somebody is deciding how a
  > **new** parameter should behave, so a wrong count here propagates into the next one added.

  | Parameter | Empty means | Behaviour |
  |---|---|---|
  | `custscript_opsync_qualifying_statuses` | No opportunity qualifies. The gate never opens, nothing is written | **Fails closed** — logs at error, returns `[]` |
  | `custscript_opsync_excluded_statuses` | **Nothing is excluded** — the script writes over orders at Release to Warehouse, Cancelled and Design Cancelled | **Fails open → throws** |
  | `custscript_opsync_status_map` | Nothing resolves, so **no Record Status is written to any order** | **Fails closed** — logs at error, returns `null` |
  | `custscript_opsync_design_ok_statuses` | **No status satisfies the design gate** — every order stamped *"not ready, Design not complete"*, including ready ones | **Fails open → throws** |
  | `custscript_opsync_dno_ok_values` | **Every certificate-gated order reports *Awaiting DNO*** | **Fails open → throws** |
  | `custscript_opsync_cust_qual_field` | **Certificates cannot be read at all**, so they read as missing and every gated order is held | **Fails open → throws** |
  | `custscript_opsync_cust_pl_field` | As above | **Fails open → throws** |
  | `custscript_opsync_bus_no_value` | **No** value is recognised as *not intended for BUS*, so the BUS condition applies to everything — orders are held, never shipped | **Fails closed** — logs at error, returns `''` |
  | `custscript_opsync_no_shipdate_statuses` | **No status suppresses the ship date**, so the opportunity goes back to overwriting delivery dates on orders that own them — the defect the parameter exists to fix, restored in full | **Fails open → throws** |

  Three fail closed — `custscript_opsync_qualifying_statuses`, `custscript_opsync_status_map`
  and `custscript_opsync_bus_no_value`. Six throw. The status map is the one most often
  miscounted, because *"nothing resolves"* sounds like a failure rather than a safe one: an
  unmapped save still evaluates readiness against each order's **own** current status — see
  *the decided status* in section 4 — but it writes no status anywhere, which is the test.

  The excluded list is the one that matters most and the one most easily got wrong, because it
  reads like a safety mechanism and an empty safety mechanism looks harmless. It is not: an empty
  exclusion list does not protect nothing *by default*, it protects nothing *at all*, and the
  orders it stops protecting are precisely the ones the parameter exists for. A warehouse
  instruction written over a delivered order is not recoverable by re-saving.

  Every throwing parameter is resolved **before the sales order loop begins**, so a missing one
  cannot leave some orders written and the rest not. The throw is caught by the entry point's
  outer handler and logged as `OPPSYNC_FAILED`; the opportunity still saves.

  **When adding a parameter, apply the same test.** If empty removes a restriction, it throws.

  `custscript_opsync_no_shipdate_statuses` is the worked example in the other direction, and
  the argument against throwing is worth recording because it is a reasonable one. A throw
  abandons the status sync and the readiness evaluation as well, and the harm from an empty list
  is a **wrong date** rather than **goods shipped** — so why not log and carry on?

  Because that is exactly the trade `custscript_opsync_excluded_statuses` and
  `custscript_opsync_design_ok_statuses` already make, and it was weighed and accepted for them:
  doing nothing is recoverable and says so in the log; writing confidently wrong data is neither.
  A wrong ship date is not cheap either — the previous value is gone from the field, on every
  order of the opportunity, and the people who own those dates are not reading the execution log.

  Softening it here would also replace one rule with two — *"empty that removes a restriction
  throws, unless the damage is only a date"* — and the next person adding a parameter would have
  to guess which test applied. **One rule, no exceptions.**

  The cost is real and it is a **deployment ordering** problem: uploading the new script before
  the parameter exists makes the whole sync inert. See section 8.

  `custscript_opsync_bus_no_value` is the worked example. It *sounds* required — without it the
  BUS condition cannot tell a "No" from anything else — but empty makes the script do **more**,
  not less: the condition applies to every certificate-gated order and the worst case is an order
  held until somebody reads the log. Throwing would abandon the whole sync, status and ship date
  included, over a parameter whose absence is already safe. So it logs at error and returns `''`.

  **Its empty return has to be handled at the comparison, and is.** A blank intention normalises
  to `''` as well, so `evaluateReadiness()` checks the parameter is non-empty *before* comparing.
  Without that guard the fail-closed parameter would fail wide open on every order.

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

- **Selects are normalised with `asSelectId()`, never `String()`.**
  `search.lookupFields` returns a select as an **array** of `{value, text}`; `record.getValue`
  returns the same field as a plain **id string**. A value that moves between the two APIs —
  as `custbody38` did — changes shape without changing meaning, and `String([{value:'1'}])` is
  `'[object Object]'`, which is in no parameter list. The comparison then fails as a legitimate
  "not acceptable" rather than as an error: nothing logged, nothing thrown.

  `asSelectId()` accepts an array, a `{value}` object, a string, a number or empty. **It is not
  a substitute for knowing which record a field is on** — no normaliser can fix a field that
  returns blank because it does not apply to the record being asked. See trap 6.

- **The certificate gate is the definition of a heat pump project, and there must be only one.**
  `custrecord_qt_requires_installer_certs` already decides it, so the BUS voucher condition lives
  inside that gate rather than testing a field of its own. Do not introduce
  `custbody_value_proposition` to "confirm" it: the physical product decides these rules, not the
  commercial package, and two definitions of "heat pump" in the same rule are free to disagree.

- **The BUS voucher has no legacy path and cannot acquire one.** The scheme postdates the old
  process, so no legacy BUS field exists. Setting all three legacy flags does not satisfy it.

- **Script parameter IDs are unique across the ACCOUNT, so two scripts cannot share a
  parameter — and this was discovered the hard way.**

  A script parameter is a custom field. Custom field IDs are account-unique, so
  `customscript_opsync_ue_salesorder` could not be given `custscript_opsync_design_ok_statuses`:
  NetSuite refused it as already in use. The six shared parameters therefore exist twice, under
  `opsync_` and `sosync_` prefixes — see section 4 for the pairing table and the risk that
  creates.

  **This is a constraint, not a design choice**, and it is recorded here so nobody spends the
  afternoon again trying to make one parameter serve both scripts. The consequence for the code
  is `SCRIPT_PARAMETERS` in `opsync_lib_config.js`: an explicit map of script id → its parameter
  IDs, resolved at call time. **Never derive one script's IDs from another's, and never fall
  back from one to the other** — a derivation breaks silently when a third script arrives with a
  different prefix, and a fallback reads the wrong script's value, which is the one outcome
  worse than failing.

- **There is NO supported API that identifies a save triggered by another user event, and the
  recursion guard is change detection alone.**

  The opportunity script writes to sales orders with `record.submitFields`, which fires
  `opsync_ue_salesorder.js`. The obvious guard would be to detect that nesting and return. It
  cannot be done:

  | Candidate | Verdict |
  |---|---|
  | `runtime.executionContext` | **Does not distinguish it.** It reports the origin of the whole **request**, not the immediate trigger of the current script. A user event fired by another user event's `submitFields` during a UI save still reads `USERINTERFACE`. The `USEREVENT` context type exists for records generated in the backend, not for nesting. |
  | `record.submitFields`'s `disableTriggers` | **Undocumented.** It is not in Oracle's SuiteScript 2.x reference for `submitFields`, which documents `enableSourcing` and `ignoreMandatoryFields` only. Building the recursion guarantee on undocumented behaviour that would fail *silently* is exactly what this project does not do. |
  | A module-level "I am writing" flag | Does not survive across script executions — the two user events are separate executions. |

  **So the guard is change detection and nothing else**, and it is sound: the opportunity script
  has just written the readiness values, the sales order script evaluates the same context
  through the same module, the verdict compares equal, and no `submitFields` happens. The chain
  is **bounded at depth two** even when a write *is* warranted — the sales order script's own
  write fires it again, which finds nothing to change and stops.

  **It is single-layered and is deliberately named as one.** A second layer that did not
  actually work would be worse than knowing there is one, because it would be trusted.

  This also means the value-level comparison is now load-bearing in a second way. It was already
  what keeps the feedback loop in section 0 trap 3 broken; it is now the only thing terminating
  the opportunity → order → order chain. **Do not replace it with an early exit.**

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

> The Design Instruction scripts use **`DSI_`** instead, built by `dsiConfig.logKey()`, so the two
> features filter apart. Their keys are listed in section 11, not in the table below.

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
| `OPPSYNC_READINESS` | debug | One line per sales order: order, quote type, decided status, ready true/false, the reason, **which path satisfied each certificate condition** — `modern`, `legacy`, `no installer` or `fail` — **and the raw `custbody38` value, what it normalised to, and the acceptable set**. Normal operation. | Nothing. This is the first place to look when an order's readiness is not what was expected. **The paths are the only record of why an order with a blank installer is ready to ship** — when a legacy order surfaces in a year and nobody remembers these fields exist, this line is the explanation. The `dnoRaw=… -> … dnoOk=…` fragment exists because the DNO check once failed for a whole Sandbox cycle with no error and no clue; it shows the value, the normalised id and the parameter side by side. |
| `OPPSYNC_SHIPDATE_SUPPRESSED` | debug | The ship date **would** have been written but was not, because the order's decided Record Status is in `custscript_opsync_no_shipdate_statuses`. Names the status, the value left in place and the value not written. The status and readiness were still evaluated and written as normal. Normal operation. | Nothing. **This log exists because the alternative is invisible** — a ship date silently not updating looks identical on the record to one that did not need updating. It is raised only when a write would otherwise have happened. |
| `OPPSYNC_READINESS_NOT_APPLICABLE` | debug | The status this save wrote is in the excluded list, so readiness was **not evaluated** and both fields were left as they were. Normal operation. | Nothing. Note the readiness values shown are now frozen — see section 6. |
| `OPPSYNC_QUOTE_TYPE_UNREADABLE` | error | A quote type record could not be read. Treated as **design-required, certificates not required** — the strictest reading of the design gate. | Check the quote type record exists and the executing role can read it. Until then those orders are gated on design. |
| `OPPSYNC_INSTALLER_UNREADABLE` | error | The installer customer record could not be read for the two certificate fields. **Both certificates read as missing**, so the order is held. | Check the customer record and the two field ids in the parameters. The held order is the safe outcome, not the bug. |
| `OPPSYNC_SYNC_SUMMARY` | audit | One line per opportunity: how many orders were updated, unchanged and skipped, and the status written. Normal operation. | Nothing. Use it to read the log at the level of "what did this save do". |
| `OPPSYNC_PARAMETER_MISSING` | error | A script parameter is unset, unreadable, or held nothing usable. Names the parameter. For the **qualifying** list and the **mapping** it is logged only and the script exits harmlessly. For the other six — **excluded statuses**, the four readiness parameters and the **no-ship-date statuses** — it is also **thrown**, so the save is abandoned before any sales order is written. See the table in section 5 for why the two behaviours differ. | Populate the parameter on the deployment **in this account**; the values differ by environment. See section 8. |
| `OPPSYNC_SO_READINESS` | debug | **Sales order script.** One line per save of a sales order, written **whether or not anything changed**: order, opportunity, quote type, status, ready, reason, the certificate paths, and `written=true/false`. Normal operation. | Nothing. It exists because **a readiness value that did not change looks identical on the record to one that was never evaluated** — this line is the difference. |
| `OPPSYNC_SO_READINESS_UPDATED` | audit | **Sales order script.** Readiness changed on the order's own save and was written. Names the before/after. Normal operation. | Nothing. This is the feature working — readiness refreshing without anyone touching the opportunity. |
| `OPPSYNC_SO_SKIPPED` | debug | **Sales order script.** The order's Record Status is in the excluded list, so readiness is not applicable and nothing was evaluated or written. | Nothing. Same meaning as `OPPSYNC_ORDER_SKIPPED` on the opportunity side, and the **same** parameter — there is deliberately not a second definition of "done". |
| `OPPSYNC_SO_NO_OPPORTUNITY` | debug | **Sales order script.** The order has no linked opportunity, so there is no context to evaluate readiness from. | Nothing. An order raised outside this process is not this script's business. If an order that *should* be linked shows this, check the native `opportunity` field — **not** `createdfrom`. |
| `OPPSYNC_SO_FAILED` | error | **Sales order script.** Its entry point threw. **The sales order still saved**; its readiness fields may be out of step. | Read the logged error. Nothing in this feature may ever block a save, so a failure here is silent to the user. |
| `OPPSYNC_SCRIPT_NOT_MAPPED` | error + **throws** | The executing script is not listed in `SCRIPT_PARAMETERS` in `opsync_lib_config.js`, so none of its parameter IDs can be resolved. Names the script id. | Add that script's row to the map, with its **own** parameter IDs — they cannot be shared with another script. Do not derive them and do not fall back to another script's. See section 4. |
| `OPPSYNC_PARAMETER_NOT_ON_SCRIPT` | error + **throws** | An accessor was called for a parameter the executing script does not define — e.g. `getMappedStatus()` reached from the sales order script. Names both the accessor and the script, and lists what that script does define. | A coding error, not a configuration one: the accessor is being called from a script the parameter was never meant for. **Do not "fix" it on the deployment** — the field does not exist there. |
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

1. **Upload the three `lib/` modules to the File Cabinet first**, in this order — each imports
   the one before it by relative path and fails *at load time* if it is absent, and the failure
   looks like a broken script record rather than a missing file:

   1. `lib/opsync_lib_config.js`
   2. `lib/opsync_lib_values.js`
   3. `lib/opsync_lib_readiness.js` — imports `opsync_lib_values`

2. Upload **both** entry points, `opsync_ue_opportunity.js` and `opsync_ue_salesorder.js`. They
   must sit in the **same folder** as `lib/`, with the libraries beneath them — the imports are
   relative paths.
3. Create or update the script record and deployment:

   | Script | Script ID | Deployment | Applies to |
   |---|---|---|---|
   | `opsync_ue_opportunity.js` | `customscript_opsync_ue_opportunity` | `customdeploy_opsync_ue_opportunity` | Opportunity. `afterSubmit` only |
   | `opsync_ue_salesorder.js` | `customscript_opsync_ue_salesorder` | `customdeploy_opsync_ue_salesorder` | **Sales Order. `afterSubmit` only** |
   | `lib/opsync_lib_config.js` | — | **None.** Shared AMD module — File Cabinet upload only. Creating a script record for it is wrong | — |
   | `lib/opsync_lib_values.js` | — | **None.** As above | — |
   | `lib/opsync_lib_readiness.js` | — | **None.** As above | — |

4. **Define the nine script parameters on the script record, and set their values on the
   deployment — BEFORE uploading the scripts that read them.** Six of the nine throw when unset
   (section 5), and a script uploaded ahead of its parameters is inert on every qualifying save:

   | Label | ID | Type | What goes in it |
   |---|---|---|---|
   | Qualifying Opportunity Statuses | `custscript_opsync_qualifying_statuses` | Free-Form Text | A comma-separated list of the `entitystatus` internal IDs that open the gate, **as they are in this account**. Currently *Won* alone. |
   | Excluded Record Statuses | `custscript_opsync_excluded_statuses` | Free-Form Text | A comma-separated list of the Record Status internal IDs that must never be overwritten — the statuses whose orders belong to the warehouse and finance processes, **plus Cancelled**. **Required — the script throws without it**, because an empty list would protect nothing rather than protecting everything. |
   | Status Map | `custscript_opsync_status_map` | Free-Form Text | The mapping from section 4, as comma-separated `subStatusId:recordStatusId` pairs — seven of them, **using the internal IDs as they are in this account**. Read `OPPSYNC_MAP_PARSED` in the execution log after the first save to confirm it parsed as intended. |
   | Design OK Statuses | `custscript_opsync_design_ok_statuses` | Free-Form Text | Comma-separated Record Status IDs at which the design is far enough along to ship. **Required — the script throws without it.** |
   | DNO OK Values | `custscript_opsync_dno_ok_values` | Free-Form Text | Comma-separated `custbody38` values that satisfy the DNO check. Blank on the order always fails. **Required.** |
   | Customer Qualification Field | `custscript_opsync_cust_qual_field` | Free-Form Text | The **script ID** of the installer qualification expiry date field on the **customer** record. A parameter, not a constant, because the opportunity's equivalent is an unstored sourced field that cannot be searched. **Required.** |
   | Customer PL Field | `custscript_opsync_cust_pl_field` | Free-Form Text | The **script ID** of the Public Liability expiry date field on the customer record. As above. **Required.** |
   | BUS "No" Value | `custscript_opsync_bus_no_value` | Free-Form Text | The single `customlist92` option internal ID meaning **not intended for BUS**. **Not required — does not throw.** Unset, no value is recognised as *No*, so every heat pump order is held for a voucher: safe, but everything stops. |
   | No Ship Date Statuses | `custscript_opsync_no_shipdate_statuses` | Free-Form Text | Comma-separated Record Status internal IDs for which the **expected ship date is not written** — *Design Complete* and *Redraw Required*. The order keeps its own delivery date from that point. **Required — the script throws without it**, because an empty list suppresses nothing and the opportunity goes straight back to overwriting dates it should not. **Not the excluded list** — see section 4. |

   **Then define SIX more on `customscript_opsync_ue_salesorder`, under `sosync_` names**, each
   holding the **same value** as its `opsync_` twin:

   | On the sales order script | Must equal |
   |---|---|
   | `custscript_sosync_excluded_statuses` | `custscript_opsync_excluded_statuses` |
   | `custscript_sosync_design_ok_statuses` | `custscript_opsync_design_ok_statuses` |
   | `custscript_sosync_dno_ok_values` | `custscript_opsync_dno_ok_values` |
   | `custscript_sosync_cust_qual_field` | `custscript_opsync_cust_qual_field` |
   | `custscript_sosync_cust_pl_field` | `custscript_opsync_cust_pl_field` |
   | `custscript_sosync_bus_no_value` | `custscript_opsync_bus_no_value` |

   **The IDs differ because they have to.** A script parameter is a custom field and custom
   field IDs are account-unique, so the sales order script cannot reuse the opportunity
   script's — NetSuite rejects them as already in use. See section 4.

   ⚠️ **The differing prefix is what makes this dangerous.** The two columns above are meant to
   hold identical values and nothing in NetSuite says so. **Re-check both whenever either is
   changed** — if they diverge the scripts disagree about readiness and overwrite each other,
   silently.

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
6. Confirm `custbody38` and the three **legacy evidence fields** exist on the **OPPORTUNITY** —
   not the sales order — and confirm each field's *Applies To* before trusting any ID in a brief
   (section 0, trap 6). The legacy IDs are — `custbodysubcontract_received_legacy` (**no underscore after `custbody`**),
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
| 64 | `custbody38` = an acceptable value **on the opportunity**, all else passing | **Ready**, blank reason. Check `dnoRaw=… -> …` in `OPPSYNC_READINESS` matches the parameter |
| 65 | `custbody38` = a value outside the acceptable set | Not ready, `Awaiting DNO` |
| 66 | `custbody38` blank | Not ready, `Awaiting DNO`. `dnoRaw` shows `(blank)` |
| 67 | Multi-order opportunity, `custbody38` acceptable | The DNO condition passes for **every** linked order from **one** read |
| 68 | A select value arriving as `[{value:'2'}]` rather than `'2'` | Both tolerated — `asSelectId()` normalises either. `[]` reads as blank |

### BUS voucher

"Heat pump" below means a quote type with `custrecord_qt_requires_installer_certs` ticked — the
certificate gate is the definition. Check `busNo=`, `rhiRaw=… -> …` and `voucherDate=` in
`OPPSYNC_READINESS` on every one of these.

| # | Scenario | Expected |
|---|---|---|
| 69 | Heat pump, RHI = *Yes*, voucher date present, all else passing | **Ready**, blank reason |
| 70 | Heat pump, RHI = *Yes*, voucher date **blank**, application date **present** | Not ready, `Awaiting BUS voucher approval`. **Also the standing regression test for `custbody_application_date` being on the opportunity** — if it reports *application* instead, the field is reading blank because it has been moved. Confirmed 2026-09-15, so this now guards a known-good fact rather than probing an open one; a moved field fails silently and nothing else would notice. See closed question 7 |
| 71 | Heat pump, RHI = *No*, voucher date blank, all else passing | **Ready** — the condition does not apply |
| 72 | Heat pump, RHI **blank**, voucher date blank | Not ready, `BUS intention not confirmed`. A different reason from 70 on purpose — a missing answer, not a wait |
| 73 | Heat pump, RHI blank, voucher date **present** | **Ready** — an approved voucher answers the question regardless |
| 74 | Heat emitter / UFH quote type (certificates **not** required), RHI blank, voucher blank | **Ready** — the certificate gate does not run, so BUS is never reached |
| 75 | Heat pump, design incomplete **and** voucher missing | Not ready, `Design not complete; Awaiting BUS voucher approval` — BUS is appended after DNO, and the design reason still comes first |
| 76 | All three legacy flags set, RHI = *Yes*, voucher blank | **Not ready.** Legacy does not satisfy BUS — there is no legacy path and no legacy BUS field |
| 78 | Heat pump, RHI = *Yes*, voucher date blank, application date **blank** | Not ready, `Awaiting BUS voucher application` |
| 79 | Heat pump, RHI **blank**, voucher date blank, application date **present** | Not ready, `BUS intention not confirmed` — the intention question still takes precedence, and **only one** BUS reason appears |
| 80 | Heat pump, RHI = *No*, voucher date blank, application date blank | **Ready.** The condition does not apply, so **no BUS reason of either kind** |
| 77 | Clear `custscript_opsync_bus_no_value` and save a heat pump order at RHI = *No* | `OPPSYNC_PARAMETER_MISSING` at **error**, **no `OPPSYNC_FAILED`**, and the order is **held** — `Awaiting BUS voucher approval`. Empty applies the condition to everything; it does not throw. **Revert afterwards** |

### Ship-date suppression by status

Populate `custscript_opsync_no_shipdate_statuses` with the *Design Complete* and *Redraw
Required* Record Status ids first. Watch the order's **system notes** as well as its fields —
scenario 84 is a "nothing written" test and only the notes prove it.

| # | Scenario | Expected |
|---|---|---|
| 81 | Order at a **suppressed** status, opportunity delivery date changed | **Ship date NOT written.** Status and readiness **still written**. `OPPSYNC_SHIPDATE_SUPPRESSED` at debug naming the status |
| 82 | Order at a **non-suppressed** status, delivery date changed | Ship date written, exactly as before. No suppression log |
| 83 | A save that **moves** an order into a suppressed status, delivery date differs | **Ship date NOT written on that save** — the test is on the *decided* status, so the boundary is the order reaching the stage, not the save after it. See section 4 |
| 84 | Order at a suppressed status, **nothing else changed** | **No writes at all.** `OPPSYNC_ORDER_UNCHANGED` at debug, no `submitFields`, no system note. Suppression must not manufacture a write, and must not manufacture a log either — 81's line should **not** appear |
| 85 | Order at a suppressed status that is **also at an excluded entry status** | **Skipped entirely**, `OPPSYNC_ORDER_SKIPPED`, as now. The exclusion is tested first and nothing else runs |
| 86 | `custscript_opsync_no_shipdate_statuses` **empty** | `OPPSYNC_PARAMETER_MISSING` at error **and** `OPPSYNC_FAILED`. **No write to any linked sales order.** It throws — see section 5. **Revert afterwards** |
| 87 | Readiness at **Design Complete** with the parameter populated | Readiness **evaluated and written** normally. This is the scenario the excluded list would have broken |
| 88 | Order **ready**, then moved to **Redraw Required** | Readiness **drops to not-ready** and the hold reason is written, while the ship date is suppressed. The second scenario the excluded list would have broken |

### Readiness on sales order save

Requires `customscript_opsync_ue_salesorder` deployed and its **six** parameters populated to
match the opportunity script's. Grep for `OPPSYNC_SO_` after every one of these.

| # | Scenario | Expected |
|---|---|---|
| 89 | Order at an **excluded** status, saved | **Skipped, no write.** `OPPSYNC_SO_SKIPPED` naming the status. Uses the *same* excluded list as the opportunity script — there is deliberately no second definition |
| 90 | Order with **no linked opportunity**, saved | **Skipped, no write.** `OPPSYNC_SO_NO_OPPORTUNITY`. Check the native `opportunity` field, not `createdfrom` |
| 91 | Order at a design-ok status, **subcontract date added**, all else valid | **Becomes ready**, hold reason cleared. `OPPSYNC_SO_READINESS_UPDATED`. This is the whole point of the feature — nobody touched the opportunity |
| 92 | The same order, **subcontract date cleared** | **Becomes not ready**, `Subcontract agreement not received` |
| 93 | Quote type changed from **UFH to heat pump** | The certificate gate now applies — readiness re-evaluated against all five conditions, not just design |
| 94 | Order saved with **nothing relevant changed** | **Evaluated, no write.** `OPPSYNC_SO_READINESS` with `written=false`; no `submitFields`, no system note. Check the system notes, not just the fields |
| 95 | **Save the opportunity**, which writes to the order | The sales order script fires, finds nothing to change, **writes nothing, no loop.** `OPPSYNC_SO_READINESS` with `written=false` immediately after `OPPSYNC_ORDER_UPDATED`. **This is the recursion test — run it deliberately**, and confirm the execution log does not repeat |
| 96 | Installer **blank** on the opportunity, order saved | **No customer lookup performed.** `paths=…legacy` or `no installer` in `OPPSYNC_SO_READINESS` |
| 97 | Any of the **six** sales-order-side parameters missing | Same behaviour as on the opportunity script — five throw and log `OPPSYNC_SO_FAILED`, `bus_no_value` fails closed. The **order still saves**. **Revert afterwards** |
| 98 | The six parameters set to **different values** on the two script records — e.g. an extra design-ok status on one | The two scripts **disagree** and each overwrites the other on the next save of its own record. **There is no log line for this.** Run it once to see the failure mode, then put them back. This is the cost of the duplication in section 4 |
| 105 | **Inline edit** a field on the sales order list view | Evaluated normally. This is the XEDIT path — a sparse `newRecord` must not read an untouched quote type as blank and skip the certificate gate |
| 106 | **Full opportunity-side regression** — every scenario from 1 to 88 | **Unchanged.** The 1.8.0 refactor moved the evaluation into `lib/opsync_lib_readiness.js` and must not have altered a single verdict. Any scenario here that needs amending means the refactor changed something it should not have |

### Per-script parameter resolution

| # | Scenario | Expected |
|---|---|---|
| 99 | Save an **opportunity** and read the execution log | Every parameter read resolves a **`custscript_opsync_*`** ID. Confirm in `OPPSYNC_MAP_PARSED` and, if a parameter is unset, in the ID named by `OPPSYNC_PARAMETER_MISSING` |
| 100 | Save a **sales order** and read the execution log | Every parameter read resolves a **`custscript_sosync_*`** ID. **Never** an `opsync_` one — there is deliberately no fallback |
| 101 | Deploy the library to a script **not in `SCRIPT_PARAMETERS`** and save its record | **Throws once**, `OPPSYNC_SCRIPT_NOT_MAPPED` naming the script id. One clear error, not six confusing ones. **Revert afterwards** |
| 102 | Reach `getMappedStatus()` from the **sales order** script | **Throws**, `OPPSYNC_PARAMETER_NOT_ON_SCRIPT` naming both the accessor and the script. It must **not** return empty — empty would look like an unset parameter and be "fixed" on a deployment where the field does not exist |
| 103 | **Full opportunity regression** — every scenario 1 to 88 | **Unchanged.** Accessor names and return values did not change, so nothing on this side should move |
| 104 | **Full sales order regression** — scenarios 89 to 98 | **Unchanged**, now reading the `sosync_` IDs |

### Design Instruction

Requires `customscript_dsi_ue_opportunity` and `customscript_dsi_ue_design_instruction` deployed
with their ten parameters populated, and `dsi_cs_opportunity.js` uploaded beside them — see
section 11. Grep the execution log for `DSI_` as well as `OPPSYNC_` after every one of these.

| # | Scenario | Expected |
|---|---|---|
| 107 | Opportunity at *Awaiting Design Info*, view | **Request Design** visible; Request Redraw not |
| 108 | Opportunity at *Design Complete*, view | **Request Redraw** visible; Request Design not |
| 109 | Any other sub-status, view | Neither button |
| 110 | Press **Request Design**, confirm | Sub-status = *Design Required*; page reloads; one row as in 112. The sync's own `OPPSYNC_` lines appear **only if the opportunity is at a qualifying `entitystatus`** — its gate exits silently otherwise |
| 111 | Press **Request Redraw**, confirm | Sub-status = *Redraw Required*; one row, type *Redraw*; the browser lands on **that** row in edit mode |
| 112 | Set sub-status to *Design Required* by hand in edit mode | **One** row: type *New design*, on the 2026 form, name per section 11, customer / sales rep / project engineer / urgent copied from the opportunity. `DSI_ROW_CREATED` at audit naming the row, type and name. **The row appears on the opportunity's Design Instruction sublist** — that is the sourced-field check |
| 113 | **Inline-edit** (XEDIT) the sub-status to *Design Required*, on an opportunity with **priority design ticked** and all three name fields populated | Row created with **every** copied field populated and **urgent copied correctly — ticked**. The same holds for every button press, which is also XEDIT. Since 1.2.0 the copied values come from one `lookupFields` of the stored opportunity, not the sparse `newRecord` — an unticked urgent box here means that has regressed |
| 114 | Set sub-status *Design Required* → *Design Complete* → *Design Required* | **Two** rows. There is no duplicate guard, by design |
| 115 | Set sub-status to a non-creating value | No row. `DSI_NO_CREATE` at debug with both values |
| 116 | `custscript_dsi_create_map` empty | No row; `DSI_PARAMETER_MISSING` at error; **no** `DSI_CREATE_FAILED`; the opportunity saves normally. **Revert afterwards** |
| 117 | `custscript_dsi_form_id` empty | No row; `DSI_PARAMETER_MISSING` **and** `DSI_CREATE_FAILED` at error; the opportunity saves normally. **Revert afterwards** |
| 118 | Set the map so a key equals the complete status, then move a sub-status to a creating value | No row; `DSI_CONFIG_OVERLAP` at error. **Every** creation is refused while the map overlaps. **Revert afterwards**. See also 134 |
| 119 | Opportunity with all three name fields blank | Name = `<tranid> · <type>`. **Also confirm on any populated opportunity that the three parts read as their display text** — select or text alike, since 1.2.0 reads whichever shape `lookupFields` returns |
| 120 | Name fields long enough to exceed the cap | Name truncated to `NAME_MAX_LENGTH`; save succeeds. **If the save fails, the cap is wrong** — it is unverified |
| 121 | On a row, set **CAD completed by**, save | `custrecord_cad_design_start` = **today** as the user sees it; nothing written to the opportunity. Run once before 08:00 UK time to catch a server-time-zone date. Since 1.2.0 the stamp watches CAD completed by, not `custrecord_cad_designer` |
| 122 | Enter completed date with **CAD completed by blank** | Save **blocked** with *"To complete this design instruction, enter who completed it (CAD completed by)."* `DSI_INCOMPLETE` at audit, naming `designer` as missing |
| 123 | Enter completed date with **CAD completed by set**, **area blank**, **notes blank** | Save succeeds and the opportunity is **moved on** — `DSI_ROW_COMPLETED`. Area and notes are not required since 24 Sep 2026 |
| 124 | Complete a *New design* row properly | Opportunity sub-status = *Post Design Check*; priority design **unticked**; `DSI_ROW_COMPLETED` at audit; **then the sync's `OPPSYNC_` lines for that opportunity**, and — for a Won opportunity whose map carries *Post Design Check* — the sales orders updated. This is the **confirming test** that a user event's write to the opportunity fires the opportunity's user events. Scenario 95 is the precedent: the same cross-record firing, already passed in this account |
| 125 | Complete a *Redraw* row properly | Identical to 124 |
| 126 | Set type to *Cancelled*, then enter completed date | No gate, nothing written to the opportunity; `DSI_CANCELLED_IGNORED` at audit |
| 127 | Clear a completed date on a completed row and save | Nothing happens — no gate, no write, no log |
| 128 | `custscript_dsirow_complete_status` empty, complete a row | Row saves; `DSI_PARAMETER_MISSING` at error; opportunity untouched; **no** `DSI_COMPLETE_FAILED`. **Revert afterwards** |
| 129 | Row UE deployment set to a role without Opportunity edit | Completion logs `DSI_COMPLETE_FAILED` with a permission error — which is why execute-as matters. **Revert afterwards** |
| 130 | **Full regression** — every scenario from 1 to 106 | **Unchanged.** No sync file was modified |
| 131 | **Create** a new opportunity directly at *Design Required* | Row created, and its name begins with the **real opportunity number**. **Closed by design in 1.2.0**: `tranid` is read by `lookupFields` from the opportunity as stored, after it has saved, so it cannot be blank or *To Be Generated*. Kept as a regression check |
| 132 | A button's **target** parameter empty — e.g. `custscript_dsi_btn_design_target` — then view an opportunity at that button's status | **That button is absent**; the page displays normally; `DSI_PARAMETER_MISSING` at **debug**, not error. **Revert afterwards** |
| 133 | A button's target set to a sub-status that is **not a key** of `custscript_dsi_create_map`, view, then press it | Button **shown**; `DSI_CONFIG_MISMATCH` at error on view; pressing it **still writes** the status, and no row is created. **Revert afterwards** |
| 134 | `custscript_dsi_complete_status` empty, then move a sub-status to a creating value | **No row**; `DSI_PARAMETER_MISSING` and `DSI_CREATE_FAILED` at error; the opportunity saves normally. **Revert afterwards** |
| 135 | Complete a row whose type is *New design* while `custscript_dsirow_cancelled_type` is **empty** | Gate applies and the completion **writes** — no type is treated as cancelled. `DSI_PARAMETER_MISSING` at error. A configuration error now the value is known. **Revert afterwards** |
| 136 | View an opportunity at *Design Complete* with `custscript_dsi_redraw_type` **empty**, press Request Redraw | Status written and row created, but the user is **told the row could not be found** and the page reloads — no redirect. `DSI_PARAMETER_MISSING` at error on view. **Revert afterwards** |

Extend this table as scenarios are found. **Revert any configuration changed for a test.**

---

## 10. Open items

### Confirmed NetSuite IDs — every field, its record, and how it is reached

Script IDs only — **no internal IDs**, here or anywhere else in this document. See section 3.

**The record column is the point of this table.** Four fields in this project were assumed onto
the wrong record from the `custbody_` prefix alone. See section 0, trap 6.

#### Read from the OPPORTUNITY — `record.getValue()` on the record being saved

No lookup, no search. All go through `effectiveValue()`, so a sparse XEDIT `newRecord` falls
back to `oldRecord` instead of reading a populated field as blank.

| Field | Script ID | Type | Normalised by |
|---|---|---|---|
| Status | `entitystatus` | Select | `asSelectId()` |
| Design sub-status | `custbody_opportunity_sub_status` | List → `customlist_opp_sub_status_list` | `asSelectId()` |
| Delivery date | `custbody_opp_del_date` | Date | `asDateKey()` / `asDateForWrite()` |
| Installer | `custbody_installer_ns` | List/Record → Customer | `asSelectId()` |
| **DNO status** | `custbody38` | List → `customlist_dnonotreclist`. **Auto-assigned script ID** | `asSelectId()` |
| Legacy subcontract | `custbodysubcontract_received_legacy` | **Unconfirmed** — no underscore after `custbody` | `isPresent()` |
| Legacy qualification | `custbody_installer_qual_logged_legacy` | **Unconfirmed** | `isPresent()` |
| Legacy PL | `custbody_installer_pl_logged_legacy` | **Unconfirmed** | `isPresent()` |
| **Voucher approval date** | `custbody_voucher_approval_date` | **Date — confirmed** | `isPresent()` — presence only, never parsed |
| **Voucher application date** | `custbody_application_date` | **Date — confirmed** | `isPresent()` — presence only, never parsed |
| **Intended for BUS** | `custbody_bus_project_rhi_intended` | **List → `customlist92` (*YesNo*) — confirmed** | `asSelectId()` |

#### Read from the SALES ORDER — one `search.lookupFields` per order

| Field | Script ID | Type | Shape returned | Read by |
|---|---|---|---|---|
| Record Status | `custbody_finance_status` | List/Record → `customrecord_fin_stat` | **array** | `lookupValue()` |
| Expected ship date | `custbody_defaultshipdate` | Date | string | `lookupValue()` → `asDateKey()` |
| Ready for delivery | `custbody_ready_for_delivery` | Checkbox | boolean | `isTicked()` |
| Delivery hold reason | `custbody_delivery_hold_reason` | Long text | string | `lookupValue()` |
| Quote type | `custbody_quote_type` | List/Record → Quote Type | **array** | `lookupValue()` |
| Subcontract received | `custbody_installer_subcontract_receive` | **Unconfirmed**, and no longer load-bearing — see below | string | `lookupValue()` + `isPresent()` |

> ✅ **`custbody_installer_subcontract_receive`'s type is still not confirmed, and it no longer
> matters.** It was tested with `!isEmpty()`, which would have read an **unticked checkbox as
> satisfying the subcontract condition**: `lookupFields` returns boolean `false` for unticked,
> `lookupValue()` stringifies it to `"false"`, and `isEmpty("false")` is `false`. It failed open,
> in the ship-the-goods direction, and logged nothing. **Closed in 1.5.2** — it goes through the
> presence test like the legacy flags and the voucher date, which rejects `'false'` and `'F'` by
> name for exactly that shape. It is a date today, so nothing changed in behaviour; what changed
> is that the answer stopped being needed.

#### Written to the SALES ORDER — one `record.submitFields` per order

| Field | Script ID | Written as |
|---|---|---|
| Record Status | `custbody_finance_status` | The mapped id — only when the mapping produced one |
| Expected ship date | `custbody_defaultshipdate` | The original `Date` object, never the comparison key |
| Ready for delivery | `custbody_ready_for_delivery` | boolean |
| Delivery hold reason | `custbody_delivery_hold_reason` | string, `''` when ready |

#### Read from the QUOTE TYPE record — one `search.lookupFields`, cached per save

| Field | Script ID | Type | Shape | Read by |
|---|---|---|---|---|
| Can ship without design | `custrecord_qt_no_design_required` | Checkbox | boolean | `isTicked()` |
| Requires installer certificates | `custrecord_qt_requires_installer_certs` | Checkbox | boolean | `isTicked()` |

Record type: `customrecord16` — **auto-assigned script ID**, see section 6.

#### Read from the CUSTOMER record — one `search.lookupFields` per opportunity

Skipped entirely when the installer is blank.

| Field | Script ID | Type | Shape | Read by |
|---|---|---|---|---|
| Qualification expiry | from `custscript_opsync_cust_qual_field` | **Date** | string | `lookupValue()` → `parseLookupDate()` |
| Public Liability expiry | from `custscript_opsync_cust_pl_field` | **Date** | string | `lookupValue()` → `parseLookupDate()` |

**These two are dates and must never be treated as selects.** Their field IDs are parameters
because the equivalent opportunity fields are unstored sourced fields and cannot be searched.

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
| 7 | Is `custbody_application_date` **on the Opportunity**? *(was open question 3 — renumbered on closing, because this table already had a 3)* | **Yes — Opportunity, Date**, read from the field definition's Applies To. It was implemented opportunity-level in 1.6.0 on the specification alone, because that session had no NetSuite access; the assumption markers cleared in 1.6.1. §9 scenario 70 stays as the **regression test** rather than being retired with the question: it is the only thing that would notice if the field were ever moved, and a moved field fails silently. | 2026-09-15 |
| 0b | What TYPE is `custbody_installer_subcontract_receive`? | **The code no longer needs the answer**, which is the only durable way to close it. It was the last presence-gates-shipping test on `!isEmpty()`; in 1.5.2 it moved to the project presence test, which is correct for checkbox, date and text alike and rejects the stringified `"false"` that a `lookupFields` result would deliver. Still worth confirming for its own sake. | 2026-09-15 |

### Open questions

| # | Question | Status |
|---|---|---|
| 0 | What TYPE are the three legacy evidence fields — checkbox, date or text? | **Open, and the code does not need the answer.** `isPresent()` is correct for all three. Worth confirming anyway: if any is a checkbox, §9 scenario 61 is the one that must pass. |
| 1 | Should `custbody_cad_worklist` on existing sales orders be **cleared** when the worklist record retires, or left as history? | **Open.** Clearing is a one-off data job, not something this feature does. Leaving it means a field pointing at a retired record. Nothing in this repo reads or writes it. |
| 2 | Is the *Won* gate early enough to be useful? | **Open, and knowingly accepted.** See section 6. It is a parameter, so widening it needs no code. |

### NetSuite configuration tasks for Steve

Not code. These are account changes the scripts assume have been made.

| # | Task | Why it matters |
|---|---|---|
| 1 | Define **nine** script parameters on the script record and set their values on the deployment, **in each environment** | Section 8, step 4. This now includes the mapping itself and `custscript_opsync_bus_no_value`. An unset qualifying list or an unset mapping makes the feature completely inert, and the only sign is one error line in the log. |
| 2 | Disable the `acs_ue_update_so.js` deployment when this one goes live | Section 8, step 6. Two writers of `custbody_finance_status`. |
| 3 | Create the two checkboxes on the Quote Type record and tick them per quote type | Section 4. Until they exist every quote type reads as "design required, certificates not required" — orders will be gated on design alone. |
| 4 | Set `custbody_ready_for_delivery` and `custbody_delivery_hold_reason` to **Inline Text** on all sales order forms | The script owns both fields. If users can edit them, their edits are silently overwritten on the next opportunity save. |
| 5 | Confirm `customrecord16`, `custbody38` and `customlist92` are those exact script IDs in **both** environments | Section 6. Auto-assigned ids carry no cross-account guarantee, and a wrong `custbody38` reads as blank — every order then reports *Awaiting DNO*. A wrong `customlist92` means the *No* option id in `custscript_opsync_bus_no_value` matches nothing and every heat pump order is held for a voucher. |
| 8 | ✅ **DONE 2026-09-15** — confirm `custbody_application_date`'s Applies To includes Opportunity | Closed question 7. Confirmed **Opportunity, Date** from the field definition. Kept here rather than deleted so the check is visible as having happened: it was the only field in this project committed before that check, and §9 scenario 70 is now its standing regression test. |
| 10 | **Create the `customscript_opsync_ue_salesorder` script record and deployment**, `afterSubmit` on Sales Order | Section 4. Without it readiness only ever refreshes when somebody saves the opportunity, which is the defect Phase 6 exists to fix. |
| 11 | **Define the six `custscript_sosync_*` parameters on the sales order script record**, each holding the same value as its `custscript_opsync_*` twin — and re-check both whenever either changes | Section 4. A script parameter is a custom field and custom field IDs are account-unique, so they **cannot** be shared; the sales order script's are prefixed `sosync_`. The differing prefix is the risk: nobody comparing two deployments will spot that the pairs are meant to match. If they diverge the scripts disagree about readiness and overwrite each other — **silently**, because neither can see the other's values. |
| 9 | **Define `custscript_opsync_no_shipdate_statuses` and populate it BEFORE uploading UE 1.7.0** — the *Design Complete* and *Redraw Required* Record Status ids, in each environment | Section 4. It **throws** when unset, so uploading the script first makes the whole sync inert — `OPPSYNC_PARAMETER_MISSING` and `OPPSYNC_FAILED` on every qualifying save, with nothing written. The parameter must exist before the code that reads it. |
| 7 | Set `custscript_opsync_bus_no_value` to the `customlist92` **No** option id in each environment | Section 4. It is a list option internal id and differs by account. Unset, the BUS condition applies to every heat pump order — safe, but everything is held. |
| 6 | Check `OPPSYNC_MAP_PARSED` in the log after the first save in each environment | Section 9, scenario 25. A hand-typed parameter of seven ID pairs is the most likely thing to be wrong, and this is the only place it becomes visible. |

---

## 11. Design Instruction

The design team records every design and redraw as a row on the custom record
`customrecord_cad_worklist` — *Design Instruction* — a child of the opportunity, shown as a sublist
on it. **A row is created by a change of the opportunity's sub-status, and completed by the
designer entering a completed date on the row**, which moves the opportunity on to be checked. Two
buttons on the opportunity — **Request Design** and **Request Redraw** — make the sub-status change
in one click.

### A separate feature beside the sync, deliberately

| | The sync (sections 1–10) | Design Instruction (this section) |
|---|---|---|
| Config module | `lib/opsync_lib_config.js` | `lib/dsi_lib_config.js` |
| Value-shape module | `lib/opsync_lib_values.js` | **the same file**, imported, never changed |
| Writes | Sales orders only | Design Instruction rows; the opportunity's sub-status and priority design box |
| Log prefix | `OPPSYNC_` | `DSI_` |

**Neither feature modifies the other's files.** The Design Instruction scripts cannot load
`opsync_lib_config.js`: its `resolveParameterId()` knows only the sync's two scripts and would
throw `OPPSYNC_SCRIPT_NOT_MAPPED`. They do import `opsync_lib_values.js`, so there is one
definition of what a select, a date or a sparse-XEDIT read means — the helpers whose subtleties
have already cost this project real defects (section 5).

**Both opportunity user events fire on the same saves.** `opsync_ue_opportunity.js` and
`dsi_ue_opportunity.js` touch no field in common, and neither depends on running before the other.

### Components

All in `src/FileCabinet/SuiteScripts/OpportunitySOSync/`, beside the sync, so the relative
`./lib/` imports resolve.

| File | Type | Script ID | Deployment |
|---|---|---|---|
| `lib/dsi_lib_config.js` | Shared AMD module — loaded by the client script too | — | **None.** File Cabinet upload only |
| `dsi_ue_opportunity.js` | User Event on Opportunity — `beforeLoad`, `afterSubmit` | `customscript_dsi_ue_opportunity` | `customdeploy_dsi_ue_opportunity` |
| `dsi_cs_opportunity.js` | Client Script, attached by `beforeLoad` through `form.clientScriptModulePath` | **None** | **None** |
| `dsi_ue_design_instruction.js` | User Event on `customrecord_cad_worklist` — `beforeSubmit`, `afterSubmit` | `customscript_dsi_ue_design_instruction` | `customdeploy_dsi_ue_design_instruction` |

**The client script needs no script record and no deployment.** A module attached per form with
`form.clientScriptModulePath` is loaded from the File Cabinet by path. Creating a script record
for it is unnecessary; deploying one would attach it to every opportunity form a second time.

### The buttons — `dsi_ue_opportunity.js` `beforeLoad` and `dsi_cs_opportunity.js`

**`beforeLoad`, VIEW only.** Wrapped whole — nothing may stop the record displaying — so a
failure logs `DSI_BEFORELOAD_FAILED` and the page shows without the buttons.

- **Request Design** is shown when the sub-status is in `custscript_dsi_btn_design_statuses`
  **and** `custscript_dsi_btn_design_target` is set.
- **Request Redraw** is shown when the sub-status is in `custscript_dsi_btn_redraw_statuses`
  **and** `custscript_dsi_btn_redraw_target` is set.
- **Visibility is by sub-status alone.** No search runs — the client's decision.
- With either button shown, the client script is attached and each shown button's values go into
  hidden fields: `custpage_dsi_status_design` from the design target; `custpage_dsi_status_redraw`
  from the redraw target, and `custpage_dsi_type_redraw` from `custscript_dsi_redraw_type`. **A
  button's hidden fields are added only with that button**, so a parameter belonging to a button
  that is not shown is never read and never logged. **Nothing is derived from the creation map.**
- **Consistency check.** Each shown button's target should be a key of `custscript_dsi_create_map`
  — a button whose status creates nothing is a configuration error. It is logged as
  `DSI_CONFIG_MISMATCH` at error and **otherwise ignored**: the button is still shown and still
  writes its status.

**The client script** confirms, then `record.submitFields` the sub-status on the opportunity. That
save fires the opportunity's user events as XEDIT — the sync and `dsi_ue_opportunity.js` alike —
and **the row is created by `afterSubmit`, exactly as for a sub-status changed by hand**. Request
Design then reloads the page. Request Redraw finds the newest row of the redraw type on this
opportunity with `dsiConfig.findRows()` — the same search the server uses, not a copy — and opens
it in edit mode for the user to enter the reason. No row found, or no redraw type configured:
the user is told, and the page reloads. Any error: the user is shown it, and the page is **not**
reloaded.

**An empty status is never written.** Writing `''` would clear the opportunity's sub-status. The
buttons are only added with a target, so an empty hidden-field read means the field could not be
read: the user is told, and nothing is written.

### Creation — `dsi_ue_opportunity.js`, `afterSubmit`

1. CREATE, EDIT or XEDIT only.
2. Read the sub-status after the save through `effectiveValue()`, and before it off `oldRecord`
   (empty on CREATE).
3. **Unchanged → return.** This *"has the sub-status changed"* exit is **required here** and is
   commented so in the code. The prohibition on that exit in `opsync_ue_opportunity.js`
   (section 5) exists because readiness has inputs the sub-status knows nothing about. This
   script's only input **is** the sub-status, and without the exit every save of an opportunity
   sitting at *Design Required* would create another row.
4. Look the new sub-status up in `custscript_dsi_create_map`. Not a key → `DSI_NO_CREATE` at debug,
   return.
5. **Overlap check.** `custscript_dsi_complete_status` is read — **it throws when unset**, so no row
   is created until it is set. If any key of the map equals it → `DSI_CONFIG_OVERLAP` at error,
   return, create nothing. A map that created a row at the completion status would give every
   completion **one extra open row** — not an endless loop, since the new row waits for a person,
   but an unwanted row each time.
6. Read `custscript_dsi_form_id` — **throws** when unset.
7. `record.create` in **standard** mode with the form in `defaultValues`, set the fields below,
   save with `ignoreMandatoryFields: true`. `DSI_ROW_CREATED` at audit.

A throw from step 5 or 6 is caught by the entry point and logged as `DSI_CREATE_FAILED`; the
opportunity has already saved.

| Row field | From the opportunity |
|---|---|
| `custrecord_cad_opportunity` | its internal id — **a sourced field**, set directly; see *unverified* |
| `custrecord_cad_customer` | `entity` |
| `custrecord_sales_rep` | `salesrep` |
| `custrecord_cad_proj_eng` | `custbody_pe` |
| `custrecord_cad_design_type` | the type the map gives the new sub-status |
| `custrecord_urgent_design` | `custbody_priority_design_box`, through `isTicked()` |
| `name` | built as below |

**Every copied value comes from ONE `search.lookupFields` on the opportunity as stored** —
`entity`, `salesrep`, `custbody_pe`, `custbody_priority_design_box`, `tranid` and the three name
parts. **Not from the event's `newRecord`.** A button press writes the sub-status with
`submitFields`, so this script runs as XEDIT with a sparse `newRecord` — and a sparse checkbox reads
as `false`, which is not empty, so `effectiveValue()` never falls back to `oldRecord`. Until 1.2.0
that copied priority design as **unticked on every button-created row**. `afterSubmit` runs after
the opportunity has saved, on CREATE included, so the lookup sees the record as stored and
`tranid` is the real number. `effectiveValue()` is now used for the **sub-status comparison only**.

Selects arrive as `[{value, text}]` and go through `asSelectId()`, which reads `[]` as blank. The
checkbox goes through `isTicked()`, which accepts the boolean `lookupFields` returns and the
`'T'` / `'true'` strings. **One lookup, one failure mode:** a column id that does not exist at all
fails the lookup and the row with it — `DSI_CREATE_FAILED`.

**`ignoreMandatoryFields: true` is belt and braces, not the fix.** The record carries a
mandatory multi-select that the client is un-mandating on the record definition; that is what
makes the save valid.

#### The name

**The script must set it.** The record definition has auto-numbering **off** and the name field
**included** — read from the record XML, not yet verified in Sandbox.

```
<tranid> · <type text> · <part 1> / <part 2> / <part 3>
```

The parts are `custbody_mi_opp_fc`, `custbody_comm_area_ufh` and `custbody_mi_heat_source`, in
that order — `NAME_PARTS` in `dsi_lib_config.js`, field ids only. **Their type does not matter**: a
select arrives from the lookup as `[{value, text}]` and contributes its text (a multi-select, its
texts joined); a text field arrives as a string and is used as it is. Each is included only when
non-empty after
trimming; ` / ` falls only between parts that are present; with none the name is
`<tranid> · <type text>`. An empty `tranid` or type text is left out the same way. The result is
truncated to `NAME_MAX_LENGTH`. The separator is U+00B7, the middle dot, written literally — the
repository is UTF-8 and the existing scripts already log non-ASCII text.

**The type text comes from `search.lookupFields` on `customlist_runner_etc`, not from `getText()`
on the new row.** The row is built in standard mode, and in standard mode `getText()` on a field
populated by `setValue()` throws `SSS_INVALID_API_USAGE`. If the lookup fails the row is still
created, without the type in its name, and `DSI_TYPE_TEXT_UNREADABLE` is logged at error.

### The row — `dsi_ue_design_instruction.js`

#### The row fields, as the 2026 form carries them

| Constant | Field | Label on the form | Read by a script |
|---|---|---|---|
| `ROW_FIELDS.DESIGNER` | `custrecord_cw_bom_completed_by` | *CAD completed by* | **Yes** — the completion gate and the design start stamp |
| `ROW_FIELDS.NOTES` | `custrecord_ease_designer_notes` | *Designer Notes* | **No** — documentation only |
| `ROW_FIELDS.AREA` | `custrecord_cad_area` | area (m²) | **No** — documentation only |
| `ROW_FIELDS.COMPLETED` | `custrecord_cad_completed` | completed date | **Yes** — entering it completes the row |
| `ROW_FIELDS.DESIGN_START` | `custrecord_cad_design_start` | design start | **Written** — the stamp |

> **⚠️ Two field IDs do not describe what they hold, deliberately.** `custrecord_cw_bom_completed_by`
> reads *"BoM completed by"* and holds the designer; `custrecord_ease_designer_notes` reads *"EASE
> designer notes"* and holds the designer's notes. **The script follows the form in use** — the
> client's decision. `custrecord_cad_designer` and `custrecord_cad_notes` still exist on the record,
> are not on the 2026 form, and are **not read by this feature**. Do not "correct" the constants
> back to them: that is the defect below.

> **Changed 24 Sep 2026 (row UE 1.2.0, config 1.3.0).** Sandbox testing found every completion
> refused with `DSI_INCOMPLETE` although the form was filled in: the script read
> `custrecord_cad_designer` and `custrecord_cad_notes`, which the 2026 form does not carry. The
> client decided the script follows the form, and that **only the designer is required** to
> complete a row. The area and notes checks were **removed, not relaxed**.

**`beforeSubmit`** — two steps, **two failure rules**, deliberately different:

1. **Design start stamp — wrapped.** `ROW_FIELDS.DESIGNER` present after the save, empty before
   it, and no start date → `custrecord_cad_design_start` = `new Date()`. A failure is logged as
   `DSI_STAMP_FAILED` and **the save goes on**: a missing start date must never stop a designer
   saving. The stamp follows the constant, so since 1.2.0 it watches *CAD completed by* — **if that
   field is filled in only at the end of a design, the start date lands on that save.**
2. **Completion gate — not wrapped.** On the save that completes the row, **`ROW_FIELDS.DESIGNER`
   is the only requirement**. Area and notes are not checked — a row completes with its area empty
   or zero and its notes empty. Otherwise `DSI_INCOMPLETE` at audit, naming `designer` as missing,
   then a thrown `DSI_INCOMPLETE` error that shows the user *"To complete this design instruction,
   enter who completed it (CAD completed by)."* **Skipped for a cancelled row.** Its throw is how
   it refuses the save, so it must reach NetSuite.

**`afterSubmit`** — wrapped whole; the row has already saved:

1. Only the save that **completes** the row — completed date present after, empty before. Clearing
   a completed date is never a completion.
2. Cancelled type → `DSI_CANCELLED_IGNORED` at audit, return.
3. `custscript_dsirow_complete_status` unset → `DSI_PARAMETER_MISSING` at error, return.
4. `record.submitFields` on the opportunity: the sub-status to the completion status, and
   `custbody_priority_design_box` to false — `enableSourcing: false`, `ignoreMandatoryFields:
   true`. `DSI_ROW_COMPLETED` at audit.

A row with no opportunity logs `DSI_COMPLETE_FAILED` and writes nothing.

#### The completion write re-runs the opportunity's user events — settled, do not reopen

The write in step 4 fires `opsync_ue_opportunity.js` and `dsi_ue_opportunity.js` on the
opportunity. The sync then carries *Post Design Check* to the sales orders (for a Won opportunity
whose map carries it), and `dsi_ue_opportunity.js` creates nothing, because the completion status
is never a creation key — the overlap check guarantees it.

**This was questioned and is settled by evidence from this account.** A user event's write to a
**different record type** fires that record's user events here: **scenario 95** depends on exactly
that — `customscript_opsync_ue_opportunity`'s `submitFields` on a sales order firing
`customscript_opsync_ue_salesorder` — and it has passed. **Scenario 124 is the confirming test for
this write.** No workaround is built and none is needed.

It does not loop: the sync never writes to the opportunity, and the completion status creates no
row.

### Parameters

**Ten**, all Free-Form Text, defined on the script record named, valued **on the deployment**.
Every value is an internal id and differs by environment, so **none is written here** — section 3,
no exceptions. They are described by name. The *what does empty mean* test is section 5's.

| Script | Parameter | Holds | Empty means | Behaviour |
|---|---|---|---|---|
| `customscript_dsi_ue_opportunity` | `custscript_dsi_create_map` | `subStatusId:typeId` pairs — *Design Required* → *New design*, *Redraw Required* → *Redraw* | No row is ever created | **Fails closed** — logs at error, returns `{}` |
| | `custscript_dsi_form_id` | The internal id of the *NH CAD Worklist (2026)* form | A row on no form is unusable | **Throws** in `afterSubmit` → `DSI_CREATE_FAILED` |
| | `custscript_dsi_complete_status` | The *Post Design Check* sub-status. **Must equal** `custscript_dsirow_complete_status` | The overlap check cannot run | **Throws** in `afterSubmit` → `DSI_CREATE_FAILED`. No row until it is set |
| | `custscript_dsi_btn_design_statuses` | Sub-statuses showing Request Design — *Awaiting Design Info* | Request Design never shown | **Fails closed** — logs at error, returns `[]` |
| | `custscript_dsi_btn_redraw_statuses` | Sub-statuses showing Request Redraw — *Design Complete* | Request Redraw never shown | **Fails closed** — logs at error, returns `[]` |
| | `custscript_dsi_btn_design_target` | The sub-status Request Design writes — *Design Required* | Request Design never shown | **Fails closed** — logs at **debug**, returns `''` |
| | `custscript_dsi_btn_redraw_target` | The sub-status Request Redraw writes — *Redraw Required* | Request Redraw never shown | **Fails closed** — logs at **debug**, returns `''` |
| | `custscript_dsi_redraw_type` | The *Redraw* design type | Request Redraw writes its status but cannot find the row — it reloads instead of opening it | **Fails closed** — logs at error, returns `''` |
| `customscript_dsi_ue_design_instruction` | `custscript_dsirow_complete_status` | The *Post Design Check* sub-status | A completion writes nothing to the opportunity | **Fails closed** — logs at error, returns. Not a throw: the row has already saved |
| | `custscript_dsirow_cancelled_type` | The *Cancelled* design type id(s), comma-separated | No type is treated as cancelled — the gate applies to every row and **every completion writes** | **Does not throw** — logs at error, returns `[]`. A configuration error now the value is known; left as built by the client's decision |

**Why the targets log at debug.** An absent button is visible to every user — it does not need an
error line to be noticed — and `beforeLoad` runs on every view of every opportunity, so an error
there would bury the log. Every other parameter logs at error.

**The complete-status pair has two logical keys in `dsi_lib_config.js`** — `OVERLAP_STATUS` on the
opportunity script, `COMPLETE_STATUS` on the row script — because empty means different things on
the two: the overlap check throws, the write-back fails closed. With one key, either accessor would
silently work from the wrong script; with two, the wrong one throws
`DSI_PARAMETER_NOT_ON_SCRIPT`. See the pairing table in section 4.

**The parsers keep the status map's contract** (section 4): whitespace trimmed, empty entries
ignored, a malformed entry logged as `DSI_INVALID_ENTRY` and skipped while the rest applies,
whole numbers only. In the creation map a **duplicate key** is logged as `DSI_MAP_AMBIGUOUS` and
**dropped entirely**. In a plain id list a repeated id means the same thing twice and is kept once.

**Resolution is by executing script**, from an explicit table in `dsi_lib_config.js` — no
derivation, no fallback, as in section 4. A script with no row throws `DSI_SCRIPT_NOT_MAPPED`; an
accessor its script does not define throws `DSI_PARAMETER_NOT_ON_SCRIPT`.

### Log keys

| Key | Level | Meaning |
|---|---|---|
| `DSI_ROW_CREATED` | audit | A row was created. Names the opportunity, the sub-status move, the type, the row and its name |
| `DSI_NO_CREATE` | debug | The sub-status moved to a value that creates nothing. Names both values |
| `DSI_CONFIG_OVERLAP` | error | The creation map has a key equal to the completion status. **No row is created for any sub-status** until it is fixed |
| `DSI_CONFIG_MISMATCH` | error | A shown button's target is not a key of the creation map, so pressing it creates no row. The button is still shown and still works |
| `DSI_CREATE_FAILED` | error | Creation threw — including an unset form id or complete status. **The opportunity still saved**; no row was created |
| `DSI_BEFORELOAD_FAILED` | error | The buttons could not be added. **The record still displayed**, without them |
| `DSI_TYPE_TEXT_UNREADABLE` | error | The design type's name could not be read. The row was created without it in its name |
| `DSI_STAMP_FAILED` | error | The design start date could not be stamped. **The row still saved**, without it |
| `DSI_INCOMPLETE` | audit, **and thrown** | A completion was refused because *CAD completed by* (`ROW_FIELDS.DESIGNER`) was empty. Names what was missing |
| `DSI_CANCELLED_IGNORED` | audit | A cancelled row was completed; nothing was written |
| `DSI_ROW_COMPLETED` | audit | A completion moved the opportunity on. Names the row, the opportunity and the status written |
| `DSI_COMPLETE_FAILED` | error | The completion write-back threw, or the row had no opportunity. **The row still saved**; the opportunity was not moved on |
| `DSI_PARAMETER_MISSING` | error, or **debug** for the two button targets — **and thrown** for `custscript_dsi_form_id` and `custscript_dsi_complete_status` | A parameter is unset or holds nothing usable. Names it and what that means |
| `DSI_INVALID_ENTRY` | error | One entry in a parameter is not the required shape. Skipped; the rest applies |
| `DSI_MAP_AMBIGUOUS` | error | A key appears twice in the creation map. Dropped entirely |
| `DSI_SCRIPT_NOT_MAPPED` | error + **throws** | The executing script has no row in `dsi_lib_config.js`'s parameter table |
| `DSI_PARAMETER_NOT_ON_SCRIPT` | error + **throws** | An accessor was called from a script that does not define its parameter. A coding error |

### Deliberate decisions — do not reverse

- **No duplicate-row guard and no "open row" guard on the opportunity.** The client's decision
  (22–23 Sep); a safety-net saved search covers it. A sub-status set to a creating value twice
  creates two rows.
- **Button visibility by sub-status only, no search in `beforeLoad`.**
- **Each button's target is its own parameter.** Nothing is derived from the creation map; a
  target the map does not carry is logged, not hidden.
- **The redraw reason, `custrecord_redraw_info`, is entered by hand.** The script only lands the
  user on the row.
- **Completion is the completed date being entered** — not a status field, not a button.
- **Every completion writes the same status**, *Post Design Check*, new design or redraw alike.
  One parameter, no per-type mapping, no Outcome field.
- **A cancelled row is one whose type the user sets to *Cancelled*.** The scripts ignore it.
  Nothing else happens.
- **`custbody_priority_design_box` is cleared on every completion**, not only the last.
- **The completion write relies on cross-record user event firing** — settled by scenario 95, see
  above.
- **Both user events are separate from the sync and do not touch its files.**

### Unverified in the account

| Item | Risk if wrong | Where it shows |
|---|---|---|
| That `custbody_mi_opp_fc`, `custbody_comm_area_ufh`, `custbody_mi_heat_source` **exist and apply to the Opportunity**. Their type no longer matters | Not applied to the opportunity: that part reads blank (section 0, trap 6). **Not existing at all: the one lookup fails and no row is created** | Scenario 119; scenario 112 for the second |
| The name field's **maximum length** — 83 assumed | Too high: saves fail on long names | Scenario 120. Fix `NAME_MAX_LENGTH` |
| **`custrecord_cad_opportunity` is a sourced field**, set directly with `setValue` | The link may not survive the save — an orphan row | Scenario 112: the row must appear on the opportunity's sublist |
| The record **auto-numbering off, name field included** — read from the record XML | The built name is ignored or refused | Scenario 112 |
| `customform` accepted in `record.create`'s `defaultValues` for this custom record | Rows land on the default form, or creation fails | Scenario 112 |
| `search.lookupFields` on a **custom list**, column `name` | The type is missing from every name | Scenario 112; `DSI_TYPE_TEXT_UNREADABLE` |
| `setValue` on a **sparse XEDIT** `newRecord` in `beforeSubmit` persists | Design start not stamped on an inline edit of the designer | Scenario 121, by inline edit |
| `new Date()` is the **server's** date, not the user's | Design start a day early before 08:00 UK | Scenario 121 |
| **Hidden `custpage_` fields are readable through `N/currentRecord` on a VIEW page** | The buttons alert *"could not read its configuration"* and write nothing — safe, but they do nothing | Scenarios 110 and 111 |
| **`lib/dsi_lib_config.js` loads in the browser** — every module it imports is one client scripts may use | The buttons fail at load, with an error in the browser console | Scenarios 110 and 111 |
| Request Redraw lands on the **newest** row of the redraw type | If creation failed but an **older** redraw row exists, the user lands on the older one | Scenario 111 |

### Deployment

**The client deploys. Nobody else.** Sequence:

1. Upload `lib/dsi_lib_config.js` **first** — every Design Instruction script fails at load time
   without it. `lib/opsync_lib_values.js` must already be present, as for the sync.
2. Upload `dsi_ue_opportunity.js`, `dsi_cs_opportunity.js` and `dsi_ue_design_instruction.js`
   into the **same folder** as the sync's scripts. The client script needs no script record and no
   deployment.
3. Create the two user event script records and deployments in the *Components* table.
4. **Define the ten parameters on their script records and set them on the deployments before
   releasing** — eight on `customscript_dsi_ue_opportunity`, two on
   `customscript_dsi_ue_design_instruction`. `custscript_dsi_form_id` and
   `custscript_dsi_complete_status` throw when unset. **Check that the two complete-status
   parameters hold the same value.** The values are internal ids for the account being deployed
   to — read them off that account, not from any document.
5. Confirm the *unverified* items above before release.

**Deployment settings are the client's**, and are recorded here only as *to be set*:

| Deployment | Status | Log level | Execute as |
|---|---|---|---|
| `customdeploy_dsi_ue_opportunity` | to be set by the client | to be set by the client — Debug shows `DSI_NO_CREATE` and a missing button target | to be set by the client |
| `customdeploy_dsi_ue_design_instruction` | to be set by the client | to be set by the client | **A role with Opportunity edit permission** — it writes to the opportunity. *Administrator* assumed until the client says otherwise. Scenario 129 shows why |

The client script runs as **the user pressing the button**, so the sub-status write needs that
user to be able to edit the opportunity.
