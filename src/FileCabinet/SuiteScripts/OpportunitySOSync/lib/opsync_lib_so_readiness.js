/**
 * opsync_lib_so_readiness.js
 *
 * Evaluates delivery readiness for ONE sales order and writes it when — and only when — the
 * verdict has changed. Two entry points call it: opsync_ue_salesorder.js on the order's own save,
 * and opsync_mr_readiness.js every night.
 *
 * WHY IT IS A MODULE AT ALL. Until 1.1.0 of the sales order script this was private to that
 * script's afterSubmit. Readiness then only refreshed when somebody SAVED an opportunity or an
 * order, so a certificate that expired overnight left the order reading ready — and a stale
 * "ready" ships goods. A nightly re-evaluation needed a second caller, and a second caller needs
 * the same single-order path rather than a copy that drifts.
 *
 * The code was MOVED here from opsync_ue_salesorder.js 1.0.0, comments and all. Behaviour is
 * unchanged for that script: the same reads in the same order, the same parameters read at the
 * same points, the same lookups, the same compare, the same write and the same log lines.
 *
 * THE RULE ITSELF IS STILL NOT HERE. It is in opsync_lib_readiness.js, which the opportunity
 * script calls too. This module fetches the facts for one order and decides whether to write;
 * evaluate() decides what the verdict is.
 *
 * PARAMETERS ARE READ LAZILY, AND THAT IS WHAT KEEPS THE SALES ORDER SCRIPT EQUIVALENT. A caller
 * may hand in any parameter value it has already read (the Map/Reduce reads them all at the
 * start, so a missing one fails the run before a single order is touched). A value the caller
 * leaves out is read through its opsync_lib_config accessor at exactly the point the sales order
 * script always read it. The sales order script passes nothing, so an order with no linked
 * opportunity still exits before any parameter is read — as it always did — rather than throwing
 * over a parameter it was never going to need.
 *
 * Shared AMD module: no script record and no deployment record is required.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/search', 'N/record', 'N/log', './opsync_lib_config', './opsync_lib_values',
    './opsync_lib_readiness'],
    function (search, record, log, opsyncConfig, values, readiness) {

    'use strict';

    var VERSION = '1.0.0';

    /**
     * Skip reasons returned by evaluateOrder(). The Map/Reduce counts on them, so they are
     * constants rather than strings written out at each return.
     * @type {Object}
     */
    var SKIP = {
        NO_OPPORTUNITY: 'no opportunity',
        EXCLUDED_STATUS: 'excluded status'
    };

    /**
     * Returns the parameter value the caller supplied, or reads it through its accessor.
     *
     * "Supplied" means the property is present on cfg, whatever its value. An accessor is only
     * ever called for a value the caller did not supply, and it is called at the point this
     * function is called — which is what lets the sales order script keep its original order of
     * reads and failures. See the note on lazy parameters in the file header.
     *
     * @param {Object} cfg
     * @param {string} key - e.g. 'excludedStatuses'
     * @param {Function} accessor - the opsync_lib_config accessor for that parameter
     * @returns {*}
     */
    function setting(cfg, key, accessor) {
        if (cfg && cfg.hasOwnProperty(key)) {
            return cfg[key];
        }
        return accessor();
    }

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
     * The four throwing parameters are resolved here, before anything is written — unless the
     * caller supplied them in cfg, in which case they were resolved earlier still.
     *
     * @param {string} opportunityId
     * @param {Object} cfg - parameter values the caller has already read; see setting()
     * @returns {Object} the opportunity context, in the shape readiness.evaluate() expects
     * @throws {Error} OPPSYNC_PARAMETER_MISSING if any required parameter is unset
     */
    function buildOpportunityContext(opportunityId, cfg) {
        var fields = opsyncConfig.OPPORTUNITY_FIELDS;
        var qualField = setting(cfg, 'customerQualField', opsyncConfig.getCustomerQualField);
        var plField = setting(cfg, 'customerPlField', opsyncConfig.getCustomerPlField);
        var ctx = {
            designOkStatuses: setting(cfg, 'designOkStatuses', opsyncConfig.getDesignOkStatuses),
            dnoOkValues: setting(cfg, 'dnoOkValues', opsyncConfig.getDnoOkValues),
            busNoValue: setting(cfg, 'busNoValue', opsyncConfig.getBusNoValue),
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
     * Reads the order's own facts with ONE lookupFields, for a caller that has neither the
     * record nor search columns in hand.
     *
     * Neither current caller uses it — the sales order script reads off the record being saved
     * and the Map/Reduce reads search columns — but evaluateOrder() promises to work from an id
     * alone, and this is the one place that promise is kept. The values come back in lookup
     * shape (selects as arrays, a checkbox as a boolean), which evaluateOrder() normalises
     * exactly as it normalises the other two shapes.
     *
     * @param {string} orderId
     * @returns {Object} soFacts
     */
    function readOrderFacts(orderId) {
        var so = opsyncConfig.SALES_ORDER_FIELDS;
        var lookup = search.lookupFields({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            id: orderId,
            columns: [
                so.OPPORTUNITY_LINK,
                so.RECORD_STATUS,
                so.QUOTE_TYPE,
                so.SUBCONTRACT_RECEIVED,
                so.READY_FOR_DELIVERY,
                so.DELIVERY_HOLD_REASON
            ]
        });

        return {
            opportunityId: lookup[so.OPPORTUNITY_LINK],
            financeStatus: lookup[so.RECORD_STATUS],
            quoteTypeId: lookup[so.QUOTE_TYPE],
            subcontractReceived: opsyncConfig.lookupValue(lookup, so.SUBCONTRACT_RECEIVED),
            currentReady: lookup[so.READY_FOR_DELIVERY],
            currentReason: opsyncConfig.lookupValue(lookup, so.DELIVERY_HOLD_REASON)
        };
    }

    /**
     * Evaluates readiness for one sales order and writes it if the verdict changed.
     *
     * soFacts are the order's OWN fields, in whatever shape the caller has them — a record value,
     * a lookupFields value or a Map/Reduce search column. Every one is normalised here, through
     * the same helpers whichever shape arrives:
     *
     *   opportunityId, financeStatus, quoteTypeId   selects, through asSelectId()
     *   subcontractReceived                         passed through; readiness uses isPresent()
     *   currentReady                                checkbox, through isTicked()
     *   currentReason                               '' when empty, else String()
     *
     * When soFacts is absent they are read with one lookupFields — see readOrderFacts().
     *
     * THE SKIPS, in the order the sales order script has always applied them:
     *
     *   1. No linked opportunity: no context to evaluate from. Not an error — an order raised
     *      outside this process is simply not this feature's business.
     *   2. Record Status in the excluded list: the SAME list the opportunity script uses, and
     *      deliberately not a second definition based on the native transaction status. That
     *      list already means "past the delivery gate or dead" — Release to Warehouse is in it —
     *      and two definitions of done are two answers to one question.
     *
     * THE DECIDED STATUS here is always the order's OWN current status. There is no mapping on
     * this path: the status map governs what the OPPORTUNITY propagates, and neither caller of
     * this function ever writes a status.
     *
     * THE ONLY GUARD AGAINST RECURSION, and against system-note churn on a record people read, is
     * the compare: nothing is written unless the verdict differs from what the order already
     * holds. See the recursion note in docs/context.md section 5. Both fields go together or not
     * at all: a reason without its checkbox, or a checkbox without its reason, reads as a
     * contradiction on the record.
     *
     * LOGGING. The per-order debug lines — OPPSYNC_SO_NO_OPPORTUNITY, OPPSYNC_SO_SKIPPED and
     * OPPSYNC_SO_READINESS — are the sales order script's, unchanged, and are raised here so that
     * they stay in the same place relative to the write. cfg.quiet suppresses them for the
     * Map/Reduce, which counts outcomes rather than logging each order. The audit line for a
     * write is the CALLER's, because only the caller knows what caused it.
     *
     * @param {Object} cfg - parameter values the caller has already read, any of:
     *        excludedStatuses, designOkStatuses, dnoOkValues, customerQualField, customerPlField,
     *        busNoValue. A value left out is read through its accessor at the point the sales
     *        order script always read it. Plus quiet: true to suppress the per-order debug lines.
     * @param {string} orderId
     * @param {Object} [soFacts] - see above
     * @returns {Object} { skipped, skipReason, changed, ready, reason, paths, currentReady,
     *        currentReason, opportunityId, quoteTypeId, status }
     * @throws {Error} OPPSYNC_PARAMETER_MISSING if a required parameter is unset; and whatever
     *        a lookup or the write throws. Nothing here is caught on the caller's behalf.
     */
    function evaluateOrder(cfg, orderId, soFacts) {
        var facts = soFacts || readOrderFacts(orderId);
        var quiet = !!(cfg && cfg.quiet === true);
        var result = {
            skipped: false,
            skipReason: '',
            changed: false,
            ready: null,
            reason: '',
            paths: null,
            currentReady: null,
            currentReason: '',
            opportunityId: '',
            quoteTypeId: '',
            status: ''
        };
        var currentStatus;
        var quoteTypeId;
        var currentReady;
        var currentReason;
        var gates;
        var oppContext;
        var verdict;
        var fieldValues = {};

        orderId = String(orderId);
        result.opportunityId = values.asSelectId(facts.opportunityId);

        // 1. No linked opportunity, no context to evaluate from.
        if (values.isEmpty(result.opportunityId)) {
            if (!quiet) {
                log.debug({
                    title: opsyncConfig.logKey('SO_NO_OPPORTUNITY'),
                    details: 'Sales order ' + orderId + ' has no linked opportunity, so there ' +
                        'is no context to evaluate readiness from. Nothing written.'
                });
            }
            result.skipped = true;
            result.skipReason = SKIP.NO_OPPORTUNITY;
            return result;
        }

        currentStatus = values.asSelectId(facts.financeStatus);
        result.status = currentStatus;

        // 2. The SAME excluded list the opportunity script uses. An order finance or the
        //    warehouse has moved on is theirs; readiness is no longer applicable and a "not
        //    ready" stamped on a delivered order is worse than stale, it is wrong.
        if (values.contains(currentStatus,
                setting(cfg, 'excludedStatuses', opsyncConfig.getExcludedStatuses))) {
            if (!quiet) {
                log.debug({
                    title: opsyncConfig.logKey('SO_SKIPPED'),
                    details: 'Sales order ' + orderId + ' left alone: its Record Status (' +
                        currentStatus + ') is in the excluded list, so readiness is not ' +
                        'applicable. Nothing written.'
                });
            }
            result.skipped = true;
            result.skipReason = SKIP.EXCLUDED_STATUS;
            return result;
        }

        quoteTypeId = values.asSelectId(facts.quoteTypeId);
        currentReady = values.isTicked(facts.currentReady);
        currentReason = values.isEmpty(facts.currentReason) ? '' : String(facts.currentReason);
        result.quoteTypeId = quoteTypeId;
        result.currentReady = currentReady;
        result.currentReason = currentReason;

        // 3. and 4. The opportunity context, then the quote type gates.
        oppContext = buildOpportunityContext(result.opportunityId, cfg);
        gates = readQuoteTypeGates(quoteTypeId);

        verdict = readiness.evaluate(oppContext, {
            quoteTypeId: quoteTypeId,
            noDesignRequired: gates.noDesignRequired,
            requiresCerts: gates.requiresCerts,
            decidedStatus: currentStatus,
            subcontractReceived: facts.subcontractReceived
        });

        result.ready = verdict.ready;
        result.reason = verdict.reason;
        result.paths = verdict.paths;
        result.changed = (verdict.ready !== currentReady || verdict.reason !== currentReason);

        // 5. One line per evaluation, whether or not anything was written. A readiness value
        //    that did not change looks identical on the record to one that was never evaluated,
        //    and the difference matters when somebody is asking why an order is still held.
        if (!quiet) {
            log.debug({
                title: opsyncConfig.logKey('SO_READINESS'),
                details: 'Sales order ' + orderId + ', opportunity ' + result.opportunityId +
                    ', quote type ' + (quoteTypeId || '(none)') +
                    ', status ' + (currentStatus || '(empty)') +
                    ', ready=' + verdict.ready +
                    ', reason=' + (verdict.reason || '(none)') +
                    ', paths=' + readiness.describePaths(verdict.paths) +
                    ', written=' + result.changed
            });
        }

        // 6. The compare — see the note on recursion above.
        if (!result.changed) {
            return result;
        }

        fieldValues[opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY] = verdict.ready;
        fieldValues[opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON] = verdict.reason;

        record.submitFields({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            id: orderId,
            values: fieldValues
        });

        return result;
    }

    return {
        VERSION: VERSION,
        SKIP: SKIP,
        evaluateOrder: evaluateOrder
    };
});
