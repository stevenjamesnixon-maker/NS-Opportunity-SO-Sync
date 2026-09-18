/**
 * opsync_ue_salesorder.js
 *
 * Re-evaluates delivery readiness for ONE sales order when that order is saved.
 *
 * WHY IT EXISTS. Until 1.8.0 readiness was only ever evaluated in the opportunity's
 * afterSubmit, so it only refreshed when somebody saved the OPPORTUNITY. Once design is complete
 * people work on the SALES ORDER — the subcontract date, the quote type, the finance status —
 * and nothing saved the opportunity, so nothing re-evaluated. The two readiness fields went
 * stale exactly when the order was in active use, and a stale "ready" ships goods.
 *
 * IT WRITES TWO FIELDS AND ONLY TWO: custbody_ready_for_delivery and
 * custbody_delivery_hold_reason. The Record Status and the expected ship date stay
 * opportunity-driven and must never be touched here — the opportunity owns the design lifecycle
 * and this script owns nothing but the verdict. Adding a third field to this write is how the
 * two scripts start fighting over a record.
 *
 * THE RULE ITSELF IS NOT HERE. It is in lib/opsync_lib_readiness.js, which the opportunity
 * script calls too. If the two ever disagree about an order the result is worse than either
 * answer alone: each writes its verdict over the other's, on a record people are reading, with
 * nothing logged to say they differ. Do not inline "just this one check" into this file.
 *
 * afterSubmit, never beforeSubmit — same reason as the opportunity script. Nothing here may
 * block a sales order save; the whole entry point is wrapped.
 *
 * RECURSION. The opportunity script writes to sales orders with record.submitFields, which
 * fires this script. There is no supported SuiteScript API that says "this save came from
 * another user event" — runtime.executionContext reports the origin of the whole REQUEST, so a
 * nested user event during a UI save still reads USERINTERFACE. See the recursion note in
 * docs/context.md section 5. The guard is therefore CHANGE DETECTION and nothing else: the
 * opportunity script has just written the readiness values, this script evaluates the same
 * context through the same module, the verdict compares equal, and no submitFields happens. The
 * chain is bounded at depth two even when a write IS warranted — this script's own write fires
 * this script again, which finds nothing to change and stops.
 *
 * That is a SINGLE-LAYERED guard and it is deliberately named as one. A second layer that did
 * not actually work would be worse than knowing there is one.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/search', 'N/record', 'N/log', './lib/opsync_lib_config',
    './lib/opsync_lib_values', './lib/opsync_lib_readiness'],
    function (search, record, log, opsyncConfig, values, readiness) {

    'use strict';

    var VERSION = '1.0.0';

    /**
     * Reads the two gate checkboxes off the Quote Type record.
     *
     * No cache, unlike the opportunity script's version — that one evaluates several orders in
     * a loop and a cache turns N lookups into one per distinct type. Here there is exactly one
     * order and one quote type, so a cache would be a variable that never gets a second read.
     *
     * A BLANK quote type behaves as neither checkbox ticked: the design gate applies and the
     * certificate gate does not. An UNREADABLE one falls back to the same strictest reading.
     * Both match the opportunity script exactly, and they have to — see the note on the two
     * callers agreeing in opsync_lib_readiness.js.
     *
     * @param {string} quoteTypeId
     * @returns {Object} { noDesignRequired: boolean, requiresCerts: boolean }
     */
    function readQuoteTypeGates(quoteTypeId) {
        var lookup;

        if (values.isEmpty(quoteTypeId)) {
            return { noDesignRequired: false, requiresCerts: false };
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
            return {
                noDesignRequired: values.isTicked(
                    lookup[opsyncConfig.QUOTE_TYPE_FIELDS.NO_DESIGN_REQUIRED]),
                requiresCerts: values.isTicked(
                    lookup[opsyncConfig.QUOTE_TYPE_FIELDS.REQUIRES_INSTALLER_CERTS])
            };
        } catch (e) {
            log.error({
                title: opsyncConfig.logKey('QUOTE_TYPE_UNREADABLE'),
                details: 'Quote type ' + quoteTypeId + ' could not be read. Treated as ' +
                    'design-required. ' + e
            });
            return { noDesignRequired: false, requiresCerts: false };
        }
    }

    /**
     * Builds the opportunity-side readiness context for ONE order, from the linked opportunity.
     *
     * The opportunity script reads these values off the record being saved. This one has no
     * opportunity record in hand, so it reaches them through a SINGLE lookupFields. That is the
     * shape difference readiness.evaluate() is built to tolerate: lookupFields returns a select
     * as an array of {value,text} and a date as a localised STRING, where record.getValue()
     * returns a plain id and a Date object. Every value below therefore goes through
     * opsync_lib_values, never through String().
     *
     * The installer's two certificate expiry dates cost a SECOND lookup, on the CUSTOMER record
     * — the equivalent opportunity fields are unstored sourced fields and cannot be searched.
     * It is SKIPPED ENTIRELY when the installer is blank, which is exactly the legacy case: an
     * order satisfied by legacy evidence costs no customer lookup.
     *
     * The four throwing parameters are resolved here, before anything is written.
     *
     * @param {string} opportunityId
     * @returns {Object} the opportunity context, in the shape readiness.evaluate() expects
     * @throws {Error} OPPSYNC_PARAMETER_MISSING if any required parameter is unset
     */
    function buildOpportunityContext(opportunityId) {
        var fields = opsyncConfig.OPPORTUNITY_FIELDS;
        var qualField = opsyncConfig.getCustomerQualField();
        var plField = opsyncConfig.getCustomerPlField();
        var ctx = {
            designOkStatuses: opsyncConfig.getDesignOkStatuses(),
            dnoOkValues: opsyncConfig.getDnoOkValues(),
            busNoValue: opsyncConfig.getBusNoValue(),
            today: values.todayDayNumber(),
            installerId: '',
            qualExpiry: '',
            plExpiry: ''
        };
        var lookup;

        lookup = search.lookupFields({
            type: opsyncConfig.RECORD_TYPES.OPPORTUNITY,
            id: opportunityId,
            columns: [
                fields.INSTALLER,
                fields.DNO_STATUS,
                fields.SUBCONTRACT_LEGACY,
                fields.QUAL_LOGGED_LEGACY,
                fields.PL_LOGGED_LEGACY,
                fields.BUS_RHI_INTENDED,
                fields.VOUCHER_APPROVAL_DATE,
                fields.APPLICATION_DATE
            ]
        });

        // Selects through asSelectId, which accepts the array shape lookupFields returns AND the
        // plain id the opportunity script gets from record.getValue(). String() on an array of
        // {value,text} is '[object Object]', which is in no parameter list — so the comparison
        // would fail as a legitimate "not acceptable" rather than as an error. Nothing logged,
        // nothing thrown. See docs/context.md section 5.
        ctx.installerId = values.asSelectId(lookup[fields.INSTALLER]);
        ctx.dnoStatusRaw = lookup[fields.DNO_STATUS];
        ctx.dnoStatus = values.asSelectId(ctx.dnoStatusRaw);
        ctx.busRhiIntendedRaw = lookup[fields.BUS_RHI_INTENDED];
        ctx.busRhiIntended = values.asSelectId(ctx.busRhiIntendedRaw);

        // Presence-only values. lookupValue() checks length before indexing — lookupFields
        // returns an EMPTY ARRAY for an empty field and the predecessor script threw on exactly
        // that. The legacy flags and the two BUS dates are then tested with isPresent(), never
        // isEmpty(), inside readiness.evaluate().
        ctx.subcontractLegacy = opsyncConfig.lookupValue(lookup, fields.SUBCONTRACT_LEGACY);
        ctx.qualLegacy = opsyncConfig.lookupValue(lookup, fields.QUAL_LOGGED_LEGACY);
        ctx.plLegacy = opsyncConfig.lookupValue(lookup, fields.PL_LOGGED_LEGACY);
        ctx.voucherApprovalDate = opsyncConfig.lookupValue(lookup, fields.VOUCHER_APPROVAL_DATE);
        ctx.applicationDate = opsyncConfig.lookupValue(lookup, fields.APPLICATION_DATE);

        if (values.isEmpty(ctx.installerId)) {
            return ctx;
        }

        try {
            lookup = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: ctx.installerId,
                columns: [qualField, plField]
            });
            ctx.qualExpiry = opsyncConfig.lookupValue(lookup, qualField);
            ctx.plExpiry = opsyncConfig.lookupValue(lookup, plField);
        } catch (e) {
            // An unreadable installer leaves both dates blank, so the certificate gate reports
            // them as missing and the order is held. That is the safe direction, and it matches
            // the opportunity script exactly.
            log.error({
                title: opsyncConfig.logKey('INSTALLER_UNREADABLE'),
                details: 'Installer customer ' + ctx.installerId + ' could not be read for ' +
                    qualField + ' / ' + plField + '. Both certificates will read as missing. ' + e
            });
        }

        return ctx;
    }

    /**
     * Entry point. See docs/context.md section 4.
     *
     * @param {Object} context
     */
    function afterSubmit(context) {
        var newRecord;
        var oldRecord;
        var sparse;
        var orderId;
        var opportunityId;
        var currentStatus;
        var currentReady;
        var currentReason;
        var quoteTypeId;
        var subcontractReceived;
        var gates;
        var oppContext;
        var verdict;
        var fieldValues = {};

        try {
            // 1. CREATE, EDIT or XEDIT only. Never DELETE — there is no order left to evaluate.
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT &&
                context.type !== context.UserEventType.XEDIT) {
                return;
            }

            newRecord = context.newRecord;
            oldRecord = context.oldRecord;
            sparse = (context.type === context.UserEventType.XEDIT);
            orderId = newRecord ? String(newRecord.id) : '';

            // Every field below goes through effectiveValue, not a plain newRecord read. On
            // XEDIT — inline edit from a list view — NetSuite populates newRecord with ONLY the
            // fields that were edited, so an untouched field reads as EMPTY rather than as
            // unchanged. Reading the quote type straight off a sparse newRecord would see a
            // blank quote type, skip the certificate gate, and mark a held order ready.
            opportunityId = values.asSelectId(values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.SALES_ORDER_FIELDS.OPPORTUNITY_LINK, sparse));

            // 2. No linked opportunity, no context to evaluate from. Not an error — an order
            //    raised outside this process is simply not this script's business.
            if (values.isEmpty(opportunityId)) {
                log.debug({
                    title: opsyncConfig.logKey('SO_NO_OPPORTUNITY'),
                    details: 'Sales order ' + orderId + ' has no linked opportunity, so there ' +
                        'is no context to evaluate readiness from. Nothing written.'
                });
                return;
            }

            currentStatus = values.asSelectId(values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS, sparse));

            // 3. The SAME excluded list the opportunity script uses, and deliberately not a
            //    second definition based on the native transaction status. That list already
            //    means "past the delivery gate or dead" — Release to Warehouse is in it — and
            //    two definitions of done are two answers to one question. An order finance or
            //    the warehouse has moved on is theirs; readiness is no longer applicable and a
            //    "not ready" stamped on a delivered order is worse than stale, it is wrong.
            if (values.contains(currentStatus, opsyncConfig.getExcludedStatuses())) {
                log.debug({
                    title: opsyncConfig.logKey('SO_SKIPPED'),
                    details: 'Sales order ' + orderId + ' left alone: its Record Status (' +
                        currentStatus + ') is in the excluded list, so readiness is not ' +
                        'applicable. Nothing written.'
                });
                return;
            }

            quoteTypeId = values.asSelectId(values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.SALES_ORDER_FIELDS.QUOTE_TYPE, sparse));
            subcontractReceived = values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.SALES_ORDER_FIELDS.SUBCONTRACT_RECEIVED,
                sparse);
            currentReady = values.isTicked(values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY,
                sparse));
            currentReason = values.effectiveValue(
                newRecord, oldRecord, opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON,
                sparse);
            currentReason = values.isEmpty(currentReason) ? '' : String(currentReason);

            // 4. and 5. The opportunity context, then the quote type gates.
            oppContext = buildOpportunityContext(opportunityId);
            gates = readQuoteTypeGates(quoteTypeId);

            // 6. THE DECIDED STATUS on this side is always the order's OWN current status.
            //    There is no mapping here: the status map governs what the OPPORTUNITY
            //    propagates, and this script never writes a status at all. The definition still
            //    matches the opportunity script's — "the mapped status when there is one,
            //    otherwise the order's own" — because from here there is never one.
            verdict = readiness.evaluate(oppContext, {
                quoteTypeId: quoteTypeId,
                noDesignRequired: gates.noDesignRequired,
                requiresCerts: gates.requiresCerts,
                decidedStatus: currentStatus,
                subcontractReceived: subcontractReceived
            });

            // 7. One line per save, whether or not anything was written. A readiness value that
            //    did not change looks identical on the record to one that was never evaluated,
            //    and the difference matters when somebody is asking why an order is still held.
            log.debug({
                title: opsyncConfig.logKey('SO_READINESS'),
                details: 'Sales order ' + orderId + ', opportunity ' + opportunityId +
                    ', quote type ' + (quoteTypeId || '(none)') +
                    ', status ' + (currentStatus || '(empty)') +
                    ', ready=' + verdict.ready +
                    ', reason=' + (verdict.reason || '(none)') +
                    ', paths=' + readiness.describePaths(verdict.paths) +
                    ', written=' + (verdict.ready !== currentReady ||
                        verdict.reason !== currentReason)
            });

            // 8. THE ONLY GUARD AGAINST RECURSION, and against system-note churn on a record
            //    people read. Nothing is written unless the verdict actually differs from what
            //    the order already holds — so the write the opportunity script has just made
            //    compares equal here and stops the chain dead. See the recursion note in the
            //    file header.
            //
            //    Both fields go together or not at all: a reason without its checkbox, or a
            //    checkbox without its reason, reads as a contradiction on the record.
            if (verdict.ready === currentReady && verdict.reason === currentReason) {
                return;
            }

            fieldValues[opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY] = verdict.ready;
            fieldValues[opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON] = verdict.reason;

            record.submitFields({
                type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
                id: orderId,
                values: fieldValues
            });

            log.audit({
                title: opsyncConfig.logKey('SO_READINESS_UPDATED'),
                details: 'Sales order ' + orderId + ': ready ' + currentReady + ' -> ' +
                    verdict.ready + ' (' + (verdict.reason || 'no hold') + '), from its own ' +
                    'save rather than from opportunity ' + opportunityId + '.'
            });

        } catch (e) {
            // The sales order has already saved. Nothing here may change that.
            log.error({
                title: opsyncConfig.logKey('SO_FAILED'),
                details: 'Readiness re-evaluation failed for sales order ' +
                    (context && context.newRecord ? context.newRecord.id : 'unknown') +
                    ' on ' + (context ? context.type : 'unknown') +
                    '. The order saved normally; its readiness fields may be out of step. ' + e
            });
        }
    }

    return {
        VERSION: VERSION,
        afterSubmit: afterSubmit
    };
});
