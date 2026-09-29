/**
 * opsync_mr_readiness.js
 *
 * Re-evaluates delivery readiness for EVERY open sales order, and writes it where it has changed.
 * Scheduled nightly. Its first run, by hand, is also the backfill of the orders that have never
 * been evaluated.
 *
 * WHY IT EXISTS. The two user events only re-evaluate readiness when somebody SAVES an
 * opportunity or an order. A certificate that expires overnight changes nothing on either record,
 * so the order kept reading ready — and a stale "ready" ships goods. The customer dashboard will
 * offer "Arrange delivery" only on a ready order, so readiness has to be current every morning
 * whether or not anybody touched the order.
 *
 * "OPEN" MEANS WHAT THE SALES ORDER SCRIPT ALREADY MEANS BY IT, and nothing else: a linked
 * opportunity, and a Record Status that is not in the excluded list — a blank status counts as
 * open. NEVER the native transaction status. Two definitions of done are two answers to one
 * question, and the drift shows up as an order one script thinks is live and another thinks is
 * finished. See docs/context.md section 4.
 *
 * NO QUOTE TYPE FILTER. Parts and FOC orders are evaluated like any other, on purpose — their
 * quote type's two checkboxes decide which gates apply, exactly as they do on a save.
 *
 * THE SINGLE-ORDER PATH IS NOT HERE. It is lib/opsync_lib_so_readiness.js, the same path the
 * sales order script runs on a save — and the rule under it is lib/opsync_lib_readiness.js, the
 * same rule the opportunity script runs. Do not inline a check into this file.
 *
 * ITS OWN PARAMETERS. A script parameter is a custom field and custom field IDs are unique across
 * the account, so this script cannot read the sales order script's. It has the third copy of the
 * six — custscript_opsyncmr_* — which must be kept equal to custscript_opsync_* and
 * custscript_sosync_* by hand. If they diverge this script and the user events disagree about
 * readiness and each overwrites the other: this one every night. See docs/context.md section 4.
 *
 * FAILS AT THE START, NOT PART-WAY. getInputData reads every parameter before it returns the
 * search, so a missing one that throws stops the run before a single order is touched. The same
 * rule as the user events: an empty parameter that would remove a restriction throws.
 *
 * WRITES. Two fields, custbody_ready_for_delivery and custbody_delivery_hold_reason, in one
 * submitFields, only when the verdict changed. That write fires the sales order script where it
 * is deployed to run; it evaluates the same order through the same module, finds nothing to
 * change, and stops — the recursion guard in docs/context.md section 5.
 *
 * LOGGING. One OPPSYNC_MR_CHANGED line at audit for every order whose readiness changed. Nothing
 * for an unchanged order — it is counted. One OPPSYNC_MR_SUMMARY line at the end, plus one
 * OPPSYNC_MR_ORDER_FAILED line per order that threw.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/search', 'N/runtime', 'N/log', './lib/opsync_lib_config',
    './lib/opsync_lib_so_readiness'],
    function (search, runtime, log, opsyncConfig, soReadiness) {

    'use strict';

    var VERSION = '1.0.0';

    /**
     * The keys map() writes, one per order, which summarize() counts. Skips are written as
     * SKIPPED_PREFIX + the library's skip reason, so a new skip reason is counted without a
     * change here.
     * @type {Object}
     */
    var OUTCOME = {
        UNCHANGED: 'unchanged',
        TO_READY: 'changed to ready',
        TO_NOT_READY: 'changed to not ready',
        CHANGED_REASON: 'changed reason only',
        SKIPPED_PREFIX: 'skipped: '
    };

    /**
     * Reads every parameter this script uses, through the same accessors the user events use.
     *
     * Four throw when unset — the excluded list, the design-ok list, the DNO list and the two
     * customer field ids — and the BUS "No" value logs and returns '' rather than throwing, which
     * fails closed. Exactly the rules in docs/context.md section 5; nothing here decides them.
     *
     * @returns {Object} cfg for soReadiness.evaluateOrder()
     * @throws {Error} OPPSYNC_PARAMETER_MISSING naming the parameter
     */
    function readConfig() {
        return {
            excludedStatuses: opsyncConfig.getExcludedStatuses(),
            customerQualField: opsyncConfig.getCustomerQualField(),
            customerPlField: opsyncConfig.getCustomerPlField(),
            designOkStatuses: opsyncConfig.getDesignOkStatuses(),
            dnoOkValues: opsyncConfig.getDnoOkValues(),
            busNoValue: opsyncConfig.getBusNoValue(),
            quiet: true
        };
    }

    /**
     * The open sales orders, one row each, with every column the evaluation needs so no order
     * costs a lookup of its own.
     *
     * The Record Status filter is "none of the excluded list, OR empty". The empty branch is
     * spelt out rather than trusted to noneof: a blank Record Status is an open order, and
     * whether noneof returns empty values is not something this script should depend on.
     *
     * @returns {search.Search}
     */
    function getInputData() {
        var cfg = readConfig();
        var so = opsyncConfig.SALES_ORDER_FIELDS;

        log.audit({
            title: opsyncConfig.logKey('MR_START'),
            details: 'Readiness Map/Reduce ' + VERSION + ' starting. Excluded Record Statuses: ' +
                cfg.excludedStatuses.join(', ') + '.'
        });

        return search.create({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            filters: [
                [so.MAINLINE, 'is', 'T'],
                'AND',
                [so.OPPORTUNITY_LINK, 'noneof', '@NONE@'],
                'AND',
                [
                    [so.RECORD_STATUS, 'noneof', cfg.excludedStatuses],
                    'OR',
                    [so.RECORD_STATUS, 'anyof', '@NONE@']
                ]
            ],
            columns: [
                so.OPPORTUNITY_LINK,
                so.RECORD_STATUS,
                so.QUOTE_TYPE,
                so.SUBCONTRACT_RECEIVED,
                so.READY_FOR_DELIVERY,
                so.DELIVERY_HOLD_REASON
            ]
        });
    }

    /**
     * Evaluates one order.
     *
     * The row arrives as JSON, in the Map/Reduce search shape: a select is {value, text}, a
     * checkbox is 'T' or 'F', a date is a formatted string, an empty field is ''. The library
     * normalises every one of those through opsync_lib_values, as it does the record and lookup
     * shapes.
     *
     * The parameters are read again here, per order: each map invocation is its own execution
     * and nothing from getInputData survives into it. Reading a parameter costs no governance.
     * Nothing is cached across invocations, by design — there is nothing to cache within one
     * either, as one invocation is one order.
     *
     * Anything that throws is left to throw: the framework records it against the order's id and
     * summarize() reports it. Catching it here would turn a failure into a count.
     *
     * @param {Object} context
     */
    function map(context) {
        var row = JSON.parse(context.value);
        var columns = row.values || {};
        var so = opsyncConfig.SALES_ORDER_FIELDS;
        var orderId = String(row.id || context.key);
        var result;
        var outcome;

        result = soReadiness.evaluateOrder(readConfig(), orderId, {
            opportunityId: columns[so.OPPORTUNITY_LINK],
            financeStatus: columns[so.RECORD_STATUS],
            quoteTypeId: columns[so.QUOTE_TYPE],
            subcontractReceived: columns[so.SUBCONTRACT_RECEIVED],
            currentReady: columns[so.READY_FOR_DELIVERY],
            currentReason: columns[so.DELIVERY_HOLD_REASON]
        });

        if (result.skipped) {
            outcome = OUTCOME.SKIPPED_PREFIX + result.skipReason;
        } else if (!result.changed) {
            outcome = OUTCOME.UNCHANGED;
        } else if (result.ready !== result.currentReady) {
            outcome = result.ready ? OUTCOME.TO_READY : OUTCOME.TO_NOT_READY;
        } else {
            outcome = OUTCOME.CHANGED_REASON;
        }

        if (result.changed) {
            log.audit({
                title: opsyncConfig.logKey('MR_CHANGED'),
                details: 'Sales order ' + orderId + ', opportunity ' + result.opportunityId +
                    ', status ' + (result.status || '(empty)') +
                    ': ready ' + result.currentReady + ' -> ' + result.ready +
                    ', reason "' + result.currentReason + '" -> "' + result.reason + '".'
            });
        }

        context.write({ key: outcome, value: orderId });
    }

    /**
     * Counts the outcomes, reports every failure against its order, and logs one summary.
     *
     * @param {Object} summary
     */
    function summarize(summary) {
        var counts = {};
        var errors = 0;
        var evaluated = 0;
        var lines = [];

        if (summary.inputSummary.error) {
            log.error({
                title: opsyncConfig.logKey('MR_INPUT_FAILED'),
                details: 'The run stopped before any order was evaluated. Nothing was written. ' +
                    'If a parameter is named below, populate it on this deployment — its value ' +
                    'must equal the sales order script\'s. ' + summary.inputSummary.error
            });
        }

        summary.mapSummary.errors.iterator().each(function (key, error) {
            errors += 1;
            log.error({
                title: opsyncConfig.logKey('MR_ORDER_FAILED'),
                details: 'Sales order ' + key + ' could not be evaluated. Its readiness fields ' +
                    'are as they were. ' + error
            });
            return true;
        });

        summary.output.iterator().each(function (key) {
            counts[key] = (counts[key] || 0) + 1;
            if (key.indexOf(OUTCOME.SKIPPED_PREFIX) !== 0) {
                evaluated += 1;
            }
            return true;
        });

        Object.keys(counts).sort().forEach(function (key) {
            lines.push(key + ' ' + counts[key]);
        });

        log.audit({
            title: opsyncConfig.logKey('MR_SUMMARY'),
            details: 'Readiness Map/Reduce ' + VERSION + ': evaluated ' + evaluated +
                (lines.length === 0 ? '' : ' (' + lines.join(', ') + ')') +
                ', errors ' + errors +
                '. Usage ' + summary.usage + ' units over ' + summary.seconds + 's, ' +
                summary.yields + ' yield(s); summarize has ' +
                runtime.getCurrentScript().getRemainingUsage() + ' units remaining.'
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});
