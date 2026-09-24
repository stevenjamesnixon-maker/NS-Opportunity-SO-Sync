/**
 * opsync_ue_opportunity.js
 *
 * Brings a won opportunity's sales orders into step with it: the design sub-status is translated
 * through the mapping held on customrecord_fin_stat and written to the order's Record Status,
 * and the opportunity's delivery date is copied to the order's expected ship date.
 *
 * Replaces acs_ue_update_so.js, which drove the same updates from a CAD Worklist custom record
 * that is being retired. The two must never both be deployed — see docs/context.md section 8.
 *
 * afterSubmit, never beforeSubmit. The predecessor wrote to sales orders before its own record
 * had committed, so a failed opportunity save left the orders already changed and the
 * opportunity unchanged, with nothing in the log to say why. afterSubmit runs only once the
 * opportunity is actually saved.
 *
 * Nothing here may block the opportunity save. The whole entry point is wrapped, and each order
 * is processed in its own try/catch so one unreachable order does not stop the others.
 *
 * Every script ID this file uses comes from opsync_lib_config. No NetSuite id is written out
 * here — see docs/context.md section 3.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.9.0
 */
define(['N/search', 'N/record', 'N/runtime', 'N/log', './lib/opsync_lib_config',
    './lib/opsync_lib_values', './lib/opsync_lib_readiness'],
    function (search, record, runtime, log, opsyncConfig, values, readiness) {

    'use strict';

    var VERSION = '1.9.0';

    /**
     * Governance units that must remain before another sales order is processed.
     *
     * NOT a NetSuite internal id — this is a unit count. Each order costs one lookupFields plus,
     * at most, one submitFields, and the exact cost of submitFields varies by record type. The
     * floor is therefore set well above a single iteration so the loop stops cleanly and says
     * what it left undone, rather than dying part-way through with some orders updated and the
     * rest silently skipped.
     *
     * @type {number}
     */
    var GOVERNANCE_FLOOR_UNITS = 100;

    /**
     * Upper bound on the orders read for one opportunity. An opportunity legitimately has
     * several; it does not have thousands, and an unbounded getRange is how a user event starts
     * timing out on a record nobody expected.
     *
     * @type {number}
     */
    var MAX_ORDERS = 1000;

    /**
     * Finds the sales orders linked to an opportunity.
     *
     * Filtered on the native opportunity field — not createdfrom — and on mainline, so each
     * order is returned once rather than once per line. One opportunity may have several orders.
     *
     * @param {string} opportunityId
     * @returns {string[]} sales order internal ids
     */
    function findSalesOrders(opportunityId) {
        var ids = [];

        search.create({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            filters: [
                [opsyncConfig.SALES_ORDER_FIELDS.OPPORTUNITY_LINK, 'anyof', opportunityId],
                'AND',
                [opsyncConfig.SALES_ORDER_FIELDS.MAINLINE, 'is', 'T']
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: MAX_ORDERS }).forEach(function (result) {
            ids.push(String(result.id));
        });

        return ids;
    }

    /**
     * Reads the two gate checkboxes off a Quote Type record, through a per-save cache.
     *
     * Several sales orders on one opportunity commonly share a quote type, so the cache turns
     * N lookups into one per distinct type. It lives for a single execution only — a cache that
     * outlived the save would risk gating an order on a checkbox someone had since changed.
     *
     * A BLANK quote type behaves as neither checkbox ticked: the design gate applies and the
     * certificate gate does not. That is the conservative reading — an order with no quote type
     * still has to have its design finished before it ships.
     *
     * @param {string} quoteTypeId
     * @param {Object} cache - keyed by quote type id, mutated in place
     * @returns {Object} { noDesignRequired: boolean, requiresCerts: boolean }
     */
    function getQuoteTypeGates(quoteTypeId, cache) {
        var lookup;
        var gates;

        if (values.isEmpty(quoteTypeId)) {
            return { noDesignRequired: false, requiresCerts: false };
        }

        if (cache.hasOwnProperty(quoteTypeId)) {
            return cache[quoteTypeId];
        }

        try {
            lookup = search.lookupFields({
                type: opsyncConfig.RECORD_TYPES.QUOTE_TYPE,
                id: quoteTypeId,
                columns: [
                    opsyncConfig.QUOTE_TYPE_FIELDS.NO_DESIGN_REQUIRED,
                    opsyncConfig.QUOTE_TYPE_FIELDS.REQUIRES_INSTALLER_CERTS
                ]
            });
            gates = {
                noDesignRequired: values.isTicked(
                    lookup[opsyncConfig.QUOTE_TYPE_FIELDS.NO_DESIGN_REQUIRED]),
                requiresCerts: values.isTicked(
                    lookup[opsyncConfig.QUOTE_TYPE_FIELDS.REQUIRES_INSTALLER_CERTS])
            };
        } catch (e) {
            // An unreadable quote type falls back to the strictest reading: design required,
            // certificates not. Treating it as "can ship without design" would let an order
            // through on the strength of a failed lookup.
            log.error({
                title: opsyncConfig.logKey('QUOTE_TYPE_UNREADABLE'),
                details: 'Quote type ' + quoteTypeId + ' could not be read. Treated as ' +
                    'design-required. ' + e
            });
            gates = { noDesignRequired: false, requiresCerts: false };
        }

        cache[quoteTypeId] = gates;
        return gates;
    }

    /**
     * Brings one sales order into step with the opportunity: status, ship date, and readiness.
     *
     * Reads everything it needs in a SINGLE lookupFields and writes everything it changes in a
     * SINGLE submitFields. Every value comes off the lookup through opsyncConfig.lookupValue,
     * which checks length before indexing — the predecessor read
     * .custbody_finance_status[0].value unguarded and threw on any order whose status was blank.
     *
     * The opportunity's delivery date arrives as BOTH a comparison key and a writable value.
     * They are not interchangeable — see asDateKey and asDateForWrite.
     *
     * @param {string} orderId
     * @param {string|null} mappedStatusId - null when the sub-status maps to nothing, in which
     *        case the order keeps its own status and that becomes the decided status
     * @param {string} deliveryDateKey - comparison key. Compared, never written
     * @param {Date|string} deliveryDateValue - the original Date. Written, never compared
     * @param {*} deliveryDateRaw - the opportunity's delivery date exactly as read. Tested for
     *        emptiness only — an empty one never clears the order's ship date
     * @param {string[]} excludedStatuses
     * @param {string} opportunityId - for the log only
     * @param {Object} ctx - the per-opportunity readiness context
     * @returns {string} 'updated', 'skipped' or 'unchanged'
     */
    function syncSalesOrder(orderId, mappedStatusId, deliveryDateKey, deliveryDateValue,
        deliveryDateRaw, excludedStatuses, opportunityId, ctx) {
        var lookup;
        var currentStatus;
        var currentShipDateKey;
        var currentReady;
        var currentReason;
        var quoteTypeId;
        var decidedStatus;
        var verdict = null;
        var targetExcluded;
        var shipDateSuppressed;
        var gates;
        var fieldValues = {};
        var changes = [];

        lookup = search.lookupFields({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            id: orderId,
            columns: [
                opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS,
                opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE,
                opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY,
                opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON,
                opsyncConfig.SALES_ORDER_FIELDS.QUOTE_TYPE,
                opsyncConfig.SALES_ORDER_FIELDS.SUBCONTRACT_RECEIVED
            ]
        });

        currentStatus = opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS);
        currentShipDateKey = values.asDateKey(opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE));
        currentReady = values.isTicked(lookup[opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY]);
        currentReason = opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON);
        quoteTypeId = opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.QUOTE_TYPE);

        // The exclusion tests the order's CURRENT status, not the status being written. An order
        // the warehouse or finance has moved on is theirs, and the opportunity does not reclaim
        // it. An empty current status is not excluded — it is exactly the order that needs one.
        if (values.contains(currentStatus, excludedStatuses)) {
            log.audit({
                title: opsyncConfig.logKey('ORDER_SKIPPED'),
                details: 'Sales order ' + orderId + ' left alone: its current Record Status (' +
                    currentStatus + ') is in the excluded list. Opportunity ' + opportunityId + '.'
            });
            return 'skipped';
        }

        // THE DECIDED STATUS — one definition, used by the exclusion test, the design gate and
        // the status write alike. The mapped status when there is one; otherwise the order's own
        // current status, because nothing is going to change it on this save.
        decidedStatus = (mappedStatusId === null) ? currentStatus : mappedStatusId;

        // The Record Status is written ONLY when the mapping produced one. An unmapped
        // sub-status means the order keeps the status it has — writing currentStatus back over
        // itself would be a no-op anyway, but the guard says so explicitly rather than relying
        // on that.
        if (mappedStatusId !== null && values.asId(currentStatus) !== values.asId(mappedStatusId)) {
            fieldValues[opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS] = mappedStatusId;
            changes.push('Record Status ' + (currentStatus || '(empty)') + ' -> ' + mappedStatusId);
        }

        // The ship date is INDEPENDENT of the mapping and always has been — it is a direct copy
        // from the opportunity, not something the status map governs. It is therefore written on
        // an unmapped save too, on its own comparison. (Before 1.3.0 an unmapped sub-status
        // returned before the loop, so in practice it was never written; that was a side effect
        // of the early exit, not a rule.)
        //
        // Both sides of the COMPARISON are date keys — see asDateKey. Comparing a Date against
        // a lookup string here would make every order look changed on every save.
        //
        // What is WRITTEN is the original Date, never the key. The key is a localised dd/mm
        // string and a mis-parse downstream would silently move the date. See asDateForWrite.
        //
        // SUPPRESSED BY STATUS. Once a job reaches design complete the delivery date is managed
        // on the SALES ORDER, and the opportunity must stop overwriting it. Only this ONE FIELD
        // is suppressed: the status write and the full readiness evaluation below both run
        // exactly as they would otherwise.
        //
        // NOT THE EXCLUDED LIST, and this is the distinction the whole design turns on. Adding
        // these statuses to custscript_opsync_excluded_statuses would skip the order entirely —
        // no status, no ship date and NO READINESS EVALUATION. Design Complete is the status
        // where readiness matters most, and Redraw Required is where readiness must DROP to
        // not-ready. Excluding either would silently disable delivery readiness for exactly the
        // orders it exists for. See docs/context.md section 4.
        //
        // IT TESTS THE DECIDED STATUS, not the status the order arrived with. So the save that
        // MOVES an order into Design Complete already stops syncing the date. That is the
        // boundary being the order reaching the stage, rather than the next save after it — see
        // the note on the alternative in docs/context.md section 4.
        shipDateSuppressed = values.contains(decidedStatus, ctx.noShipDateStatuses);

        // AN EMPTY OPPORTUNITY DELIVERY DATE MEANS "NOTHING TO SAY", NEVER "CLEAR THE ORDER"
        // (1.9.0, PR #7). Do not turn this into a return: only the ship date
        // is skipped — the Record Status and readiness below are still evaluated on this save.
        //
        // Before 1.9.0 an empty date compared unequal to the order's date and was written,
        // wiping it. Creating a sales order marks the opportunity Won, and that system save ran
        // the sync on opportunities with no delivery date yet, clearing every linked order's
        // date. It is the section 5 "what does empty mean" test applied to a record value:
        // empty must make the script do less.
        //
        // Tested on the RAW value, not the derived key or write value. Checked BEFORE the status
        // suppression, so when both apply this is the one that logs: an empty date would not be
        // written at any status, so suppression has nothing to suppress. Logged only when the
        // order has a date to protect, by the same rule as SHIPDATE_SUPPRESSED below — a log
        // where nothing would have been written anyway is noise.
        if (values.isEmpty(deliveryDateRaw)) {
            if (currentShipDateKey !== '') {
                log.debug({
                    title: opsyncConfig.logKey('SHIPDATE_EMPTY'),
                    details: 'Sales order ' + orderId + ': expected ship date left at ' +
                        currentShipDateKey + ', because opportunity ' + opportunityId + ' has ' +
                        'no delivery date. An empty delivery date never clears an order\'s ' +
                        'date. Status and readiness were still evaluated as normal.'
                });
            }
        } else if (currentShipDateKey !== deliveryDateKey) {
            if (shipDateSuppressed) {
                // Logged because a ship date silently NOT updating looks identical on the record
                // to one that did not need updating. Only logged when the write would actually
                // have happened — saying "suppressed" where nothing was going to be written
                // would be noise, and would make the real cases harder to find.
                log.debug({
                    title: opsyncConfig.logKey('SHIPDATE_SUPPRESSED'),
                    details: 'Sales order ' + orderId + ': expected ship date left at ' +
                        (currentShipDateKey || '(empty)') + ' rather than being set to ' +
                        (deliveryDateKey || '(empty)') + ', because its decided Record Status (' +
                        decidedStatus + ') is in ' +
                        opsyncConfig.resolveParameterId('NO_SHIPDATE_STATUSES',
                            'getNoShipDateStatuses') + '. The delivery date is ' +
                        'managed on the sales order at this status. Status and readiness were ' +
                        'still evaluated and written as normal.'
                });
            } else {
                fieldValues[opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE] = deliveryDateValue;
                changes.push('ship date ' + (currentShipDateKey || '(empty)') + ' -> ' +
                    (deliveryDateKey || '(empty)'));
            }
        }

        // THE SECOND EXCLUSION TEST, on the status this save DECIDES rather than the one the
        // order arrived with. The status map can legitimately map a sub-status onto a value that
        // is itself excluded — Design Cancelled -> Cancelled is the standing example.
        //
        // When that happens the status and ship date are written as normal, and readiness is
        // left exactly as it is: not set to false, not given a reason, not included in the write
        // at all. An excluded status means the order is past the delivery gate or is dead, so
        // readiness is not applicable — and "not ready" on a delivered order is worse than
        // stale, it is wrong. See docs/context.md section 6.
        // On an unmapped save decidedStatus IS currentStatus, which already passed the entry
        // exclusion test above — so this can only fire when the mapping actually moved the order
        // onto an excluded status.
        targetExcluded = values.contains(decidedStatus, excludedStatuses);

        if (targetExcluded) {
            log.debug({
                title: opsyncConfig.logKey('READINESS_NOT_APPLICABLE'),
                details: 'Sales order ' + orderId + ': status ' + decidedStatus + ' is in the ' +
                    'excluded list, so readiness was not evaluated and both readiness fields ' +
                    'were left as they were (ready=' + currentReady + ').'
            });
        } else {
            // The gates are resolved HERE, not inside readiness.evaluate() — that function
            // takes facts and never runs a lookup. getQuoteTypeGates() keeps its per-save cache,
            // so several orders sharing a quote type still cost one lookup between them.
            gates = getQuoteTypeGates(quoteTypeId, ctx.quoteTypeCache);

            verdict = readiness.evaluate(ctx, {
                quoteTypeId: quoteTypeId,
                noDesignRequired: gates.noDesignRequired,
                requiresCerts: gates.requiresCerts,
                decidedStatus: decidedStatus,
                subcontractReceived: opsyncConfig.lookupValue(
                    lookup, opsyncConfig.SALES_ORDER_FIELDS.SUBCONTRACT_RECEIVED)
            });

            // The paths matter as much as the verdict. When a legacy order comes up in a year
            // and nobody remembers these fields exist, this line is the only thing that explains
            // why an order with a blank installer is ready to ship.
            log.debug({
                title: opsyncConfig.logKey('READINESS'),
                details: 'Sales order ' + orderId + ', quote type ' +
                    (quoteTypeId || '(none)') + ', status ' + decidedStatus +
                    (mappedStatusId === null ? ' (unmapped — order\'s own)' : ' (mapped)') +
                    ', ready=' +
                    verdict.ready + ', reason=' + (verdict.reason || '(none)') +
                    ', paths=' + readiness.describePaths(verdict.paths) +
                    ', dnoRaw=' + JSON.stringify(ctx.dnoStatusRaw) +
                    ' -> ' + (ctx.dnoStatus || '(blank)') +
                    ', dnoOk=' + ctx.dnoOkValues.join('/') +
                    ', rhiRaw=' + JSON.stringify(ctx.busRhiIntendedRaw) +
                    ' -> ' + (ctx.busRhiIntended || '(blank)') +
                    ', busNo=' + (ctx.busNoValue || '(unset — condition applies to all)') +
                    ', voucherDate=' + (values.asDateKey(ctx.voucherApprovalDate) || '(blank)') +
                    ', applicationDate=' + (values.asDateKey(ctx.applicationDate) || '(blank)')
            });

            // Both fields are written together or not at all: a reason without its checkbox, or
            // a checkbox without its reason, reads as a contradiction on the record.
            if (verdict.ready !== currentReady || verdict.reason !== currentReason) {
                fieldValues[opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY] = verdict.ready;
                fieldValues[opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON] = verdict.reason;
                changes.push('ready ' + currentReady + ' -> ' + verdict.ready +
                    ' (' + (verdict.reason || 'no hold') + ')');
            }
        }

        // Readiness alone is enough to justify the write — the status and ship date may both be
        // unchanged while a certificate has expired since the last save.
        if (changes.length === 0) {
            log.debug({
                title: opsyncConfig.logKey('ORDER_UNCHANGED'),
                details: 'Sales order ' + orderId + ' already matches the opportunity. Nothing ' +
                    'written — no submitFields, no system note.'
            });
            return 'unchanged';
        }

        record.submitFields({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            id: orderId,
            values: fieldValues
        });

        log.audit({
            title: opsyncConfig.logKey('ORDER_UPDATED'),
            details: 'Sales order ' + orderId + ' updated from opportunity ' + opportunityId +
                ': ' + changes.join('; ') + '.'
        });

        return 'updated';
    }

    /**
     * Builds the per-opportunity context, ONCE, before the sales order loop.
     *
     * Mostly readiness, and named for that, but it also carries the ship-date suppression list —
     * which is not a readiness value at all. It lives here because the rule that governs it is
     * the same one: every throwing parameter is resolved before the loop.
     *
     * Two things are resolved here and nowhere else:
     *
     * 1. The five throwing parameters, plus getBusNoValue() which does not throw. They are read
     *    UP FRONT precisely so that a missing one
     *    throws before a single order has been written — a throw from inside the loop would
     *    leave some orders updated and the rest not, which is the "no partial writes" the brief
     *    asks for. See the note on requiredParameter() in opsync_lib_config.js.
     *
     * 2. The DNO status, the BUS voucher pair and the three LEGACY evidence flags, straight off
     *    the opportunity — no lookup at all.
     *    Because they are opportunity-level, they satisfy the certificate gate for EVERY linked
     *    sales order, including any order added later. That is intended: the flags record that
     *    the work was verified under the old process, and the opportunity is the unit that
     *    process operated on.
     *
     * 3. The installer's two certificate expiry dates, in ONE lookupFields, cached for the whole
     *    loop. The equivalent fields on the opportunity are unstored sourced fields and cannot
     *    be read by a search, so the script goes to the customer record custbody_installer_ns
     *    points at. When the installer is blank the lookup is skipped entirely — there is
     *    nothing to look up, and the certificate gate reports the missing installer instead.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @returns {Object} the readiness context
     * @throws {Error} OPPSYNC_PARAMETER_MISSING if any required parameter is unset
     */
    function buildReadinessContext(newRecord, oldRecord, sparse) {
        var ctx = {
            designOkStatuses: opsyncConfig.getDesignOkStatuses(),
            dnoOkValues: opsyncConfig.getDnoOkValues(),
            // Not a readiness value — it governs the SHIP DATE write. It is resolved here for
            // the same reason the readiness parameters are: every throwing parameter must be
            // read BEFORE the sales order loop, so a missing one cannot leave some orders
            // written and the rest not.
            noShipDateStatuses: opsyncConfig.getNoShipDateStatuses(),
            installerId: '',
            qualExpiry: '',
            plExpiry: '',
            // The DNO status is on the OPPORTUNITY — the sales order has no DNO field at all.
            // The RAW shape is kept alongside the normalised id because it goes in the log: this
            // check once failed for a whole Sandbox cycle with no error and no clue as to why.
            dnoStatusRaw: values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.DNO_STATUS, sparse),

            // Legacy evidence also lives on the OPPORTUNITY, so it too is read once here from
            // the record being saved — no lookupFields, and not per order. All of these go
            // through effectiveValue like the installer, so a sparse XEDIT newRecord falls back
            // to oldRecord rather than reading a populated flag as blank and holding every
            // linked order.
            subcontractLegacy: values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.SUBCONTRACT_LEGACY, sparse),
            qualLegacy: values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.QUAL_LOGGED_LEGACY, sparse),
            plLegacy: values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.PL_LOGGED_LEGACY, sparse),

            // The BUS voucher pair is on the OPPORTUNITY too, and is read here ONCE for the same
            // reason — not per order. Both go through effectiveValue so a sparse XEDIT newRecord
            // falls back to oldRecord: reading a populated voucher date as blank would hold every
            // linked order on an inline edit of something else entirely.
            //
            // The raw intention is kept alongside the normalised id because it goes in the log,
            // exactly as dnoStatusRaw is. A select read off a record is a plain id string, but the
            // same field read through a search is an array of {value,text} — so it is normalised
            // through asSelectId() below and never through String().
            busRhiIntendedRaw: values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.BUS_RHI_INTENDED, sparse),
            // A Date object from record.getValue(). Tested for PRESENCE only, through
            // isPresent() rather than isEmpty() — never parsed, never compared to today.
            // An approved voucher does not expire.
            voucherApprovalDate: values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.VOUCHER_APPROVAL_DATE,
                sparse),
            // The APPLICATION date, which is not the approval date and must never be read as
            // one. Same source, same helper, same presence test — and consulted only after the
            // approval date has been found blank, so it cannot contradict an approval.
            //
            // ON THE OPPORTUNITY, Date — confirmed from the field definition's Applies To, so
            // this read is the right one. Were it ever moved, this would return blank rather
            // than erroring and every 'Awaiting BUS voucher approval' would silently become
            // 'Awaiting BUS voucher application'. Section 9 scenario 70 is what would catch it.
            applicationDate: values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.APPLICATION_DATE, sparse),
            // '' when the parameter is unset, which applies the BUS condition to everything
            // rather than to nothing. It does not throw — see getBusNoValue().
            busNoValue: opsyncConfig.getBusNoValue(),

            today: values.todayDayNumber(),
            quoteTypeCache: {}
        };
        var qualField = opsyncConfig.getCustomerQualField();
        var plField = opsyncConfig.getCustomerPlField();
        var lookup;

        // Selects are normalised through asSelectId, not asId: record.getValue returns a plain
        // id string, but the same field read through a search returns an array of {value,text},
        // and String() on that is '[object Object]'.
        ctx.dnoStatus = values.asSelectId(ctx.dnoStatusRaw);
        ctx.busRhiIntended = values.asSelectId(ctx.busRhiIntendedRaw);

        ctx.installerId = values.asSelectId(values.effectiveValue(
            newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.INSTALLER, sparse));

        if (values.isEmpty(ctx.installerId)) {
            return ctx;
        }

        try {
            lookup = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: ctx.installerId,
                columns: [qualField, plField]
            });
            // Through lookupValue, which checks length before indexing — lookupFields returns an
            // empty array for an empty field.
            ctx.qualExpiry = opsyncConfig.lookupValue(lookup, qualField);
            ctx.plExpiry = opsyncConfig.lookupValue(lookup, plField);
        } catch (e) {
            // An unreadable installer leaves both dates blank, so the certificate gate reports
            // them as missing. That is the safe direction: it holds the order rather than
            // shipping it on the strength of a failed lookup.
            log.error({
                title: opsyncConfig.logKey('INSTALLER_UNREADABLE'),
                details: 'Installer customer ' + ctx.installerId + ' could not be read for ' +
                    qualField + ' / ' + plField + '. Both certificates will read as missing. ' + e
            });
        }

        return ctx;
    }

    /**
     * Entry point. See docs/context.md section 4 for the agreed flow.
     *
     * @param {Object} context
     */
    function afterSubmit(context) {
        var newRecord;
        var oldRecord;
        var sparse;
        var opportunityId;
        var entityStatus;
        var qualifyingStatuses;
        var excludedStatuses;
        var subStatus;
        var deliveryDateKey;
        var deliveryDateValue;
        var deliveryDateRaw;
        var mappedStatusId;
        var orderIds;
        var readinessContext;
        var processed = 0;
        var updated = 0;
        var skipped = 0;
        var unchanged = 0;
        var outcome;
        var i;

        try {
            // 1. CREATE, EDIT or XEDIT only. Never DELETE — there is no opportunity left to sync
            //    from, and the orders keep whatever they last had.
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT &&
                context.type !== context.UserEventType.XEDIT) {
                return;
            }

            newRecord = context.newRecord;
            oldRecord = context.oldRecord;
            sparse = (context.type === context.UserEventType.XEDIT);
            opportunityId = newRecord ? String(newRecord.id) : '';

            // 2. entitystatus from newRecord if it carries it, otherwise from oldRecord. See
            //    effectiveValue — on XEDIT newRecord holds only the edited fields, and a gate
            //    reading straight off it exits on every valid inline edit without logging.
            entityStatus = values.asSelectId(values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.ENTITY_STATUS, true));

            // 3. The gate. An empty qualifying list means the parameter is unset; the library has
            //    already logged that at error, and the gate stays shut rather than opening wide.
            qualifyingStatuses = opsyncConfig.getQualifyingStatuses();
            if (!values.contains(entityStatus, qualifyingStatuses)) {
                return;
            }

            subStatus = values.asSelectId(values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.SUB_STATUS, sparse));
            // Read the delivery date ONCE, then derive both forms from it: a key for comparing
            // and the original Date for writing. See asDateKey and asDateForWrite — they are
            // deliberately not the same value and must not be merged.
            deliveryDateRaw = values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.DELIVERY_DATE, sparse);
            deliveryDateKey = values.asDateKey(deliveryDateRaw);
            deliveryDateValue = values.asDateForWrite(deliveryDateRaw);

            // 4. NO "HAS THE SUB-STATUS CHANGED" SHORT-CIRCUIT. Deliberately removed in 1.2.0,
            //    and it must not come back.
            //
            //    Phase 2 exited here when neither the sub-status nor the delivery date had moved
            //    since oldRecord. That was correct while those two fields were the only inputs:
            //    if neither changed, nothing downstream could have changed either.
            //
            //    Readiness broke that assumption. It depends on the installer, the two
            //    certificate dates on the installer's CUSTOMER record, the subcontract date,
            //    custbody38, the quote type and the legacy evidence fields — none of which the
            //    sub-status knows anything about. Editing a won opportunity to populate the
            //    installer left every linked order untouched, because the sub-status had not
            //    moved.
            //
            //    So every save of a qualifying opportunity now evaluates readiness. The
            //    "don't write when nothing changed" optimisation still holds, but it lives at
            //    the VALUE level in syncSalesOrder(): each value is compared with what the order
            //    already holds, unchanged ones are left out of the submitFields call, and an
            //    order with nothing to change is not written at all. That is also what keeps the
            //    feedback loop in docs/context.md section 0, trap 3 broken — the guard is the
            //    value comparison, never the early exit.

            // 5. Resolve through the mapping. NEVER copy the raw sub-status across: the two
            //    lists share no ids and no values, and a raw copy writes a warehouse
            //    instruction. See docs/context.md section 0, trap 1. There is no default and
            //    there must never be one.
            //
            //    NO MAPPING NO LONGER STOPS THE SAVE — removed in 1.3.0, and it must not come
            //    back. It used to return here, before the orders were even searched, so a won
            //    opportunity at an unmapped sub-status never had its readiness refreshed.
            //
            //    The map governs STATUS PROPAGATION. It does not govern whether an order is fit
            //    to ship, and whether readiness refreshes must not depend on whether a
            //    sub-status happens to appear in it. A won opportunity at Partially Delivered or
            //    Delivery Complete can still carry a linked order that has not shipped — one
            //    opportunity may have several orders.
            //
            //    So mappedStatusId stays null and each order falls back to its OWN current
            //    status as its decided status. See syncSalesOrder.
            mappedStatusId = opsyncConfig.getMappedStatus(subStatus);
            if (mappedStatusId === null) {
                log.audit({
                    title: opsyncConfig.logKey('NO_MAPPING'),
                    details: 'Opportunity ' + opportunityId + ' sub-status ' +
                        (subStatus || '(empty)') + ' resolves to no Record Status, so no ' +
                        'Record Status will be written. Readiness is still evaluated against ' +
                        'each order\'s own current status. Most sub-statuses are deliberately ' +
                        'unmapped — see docs/context.md section 5. If a duplicate or a ' +
                        'malformed entry in the mapping parameter was the cause, ' +
                        opsyncConfig.logKey('MAP_AMBIGUOUS') + ' and ' +
                        opsyncConfig.logKey('MAP_INVALID_ENTRY') + ' name it.'
                });
            }

            excludedStatuses = opsyncConfig.getExcludedStatuses();

            // Readiness context BEFORE the loop: the readiness parameters (so a missing throwing
            // one throws before anything is written) and the installer's certificates (one
            // lookup, cached for every order). See buildReadinessContext.
            readinessContext = buildReadinessContext(newRecord, oldRecord, sparse);

            // 6. One opportunity may have several sales orders.
            orderIds = findSalesOrders(opportunityId);
            if (orderIds.length === 0) {
                return;
            }

            // 7. Each order in its own try/catch, so one bad order does not stop the rest.
            for (i = 0; i < orderIds.length; i += 1) {

                // 8. Stop cleanly while there is still governance left, and say what was left
                //    undone. Dying mid-loop would leave some orders updated and the rest silently
                //    untouched, with no record of which were which.
                if (runtime.getCurrentScript().getRemainingUsage() < GOVERNANCE_FLOOR_UNITS) {
                    log.error({
                        title: opsyncConfig.logKey('GOVERNANCE_STOP'),
                        details: 'Stopped after ' + processed + ' of ' + orderIds.length +
                            ' sales orders for opportunity ' + opportunityId +
                            '. Not processed: ' + orderIds.slice(i).join(', ') +
                            '. Re-save the opportunity to pick them up.'
                    });
                    return;
                }

                try {
                    outcome = syncSalesOrder(orderIds[i], mappedStatusId, deliveryDateKey,
                        deliveryDateValue, deliveryDateRaw, excludedStatuses, opportunityId,
                        readinessContext);
                    processed += 1;
                    if (outcome === 'updated') {
                        updated += 1;
                    } else if (outcome === 'skipped') {
                        skipped += 1;
                    } else {
                        unchanged += 1;
                    }
                } catch (orderError) {
                    log.error({
                        title: opsyncConfig.logKey('ORDER_FAILED'),
                        details: 'Sales order ' + orderIds[i] + ' could not be synced from ' +
                            'opportunity ' + opportunityId + '. The remaining orders were still ' +
                            'processed. ' + orderError
                    });
                }
            }

            // One summary per opportunity, so the execution log can be read at the level of
            // "what did this save do" without reconstructing it from the per-order lines.
            log.audit({
                title: opsyncConfig.logKey('SYNC_SUMMARY'),
                details: 'Opportunity ' + opportunityId + ': ' + orderIds.length +
                    ' sales order(s) — ' + updated + ' updated, ' + unchanged + ' unchanged, ' +
                    skipped + ' skipped as excluded. Status ' +
                    (mappedStatusId === null ? '(unmapped — not written)' : mappedStatusId) + '.'
            });

        } catch (e) {
            // The opportunity has already saved. Nothing here may change that.
            log.error({
                title: opsyncConfig.logKey('FAILED'),
                details: 'Sync failed for opportunity ' +
                    (context && context.newRecord ? context.newRecord.id : 'unknown') +
                    ' on ' + (context ? context.type : 'unknown') +
                    '. The opportunity saved normally; its sales orders may be out of step. ' + e
            });
        }
    }

    return {
        VERSION: VERSION,
        afterSubmit: afterSubmit
    };
});
