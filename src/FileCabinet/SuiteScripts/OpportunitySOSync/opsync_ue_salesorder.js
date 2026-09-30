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
 * THE SINGLE-ORDER PATH IS NOT HERE EITHER, since 1.1.0. The reads, the compare and the write
 * moved unchanged into lib/opsync_lib_so_readiness.js, which the nightly Map/Reduce
 * (opsync_mr_readiness.js) calls too. This script now reads the order's own fields off the record
 * being saved and hands them over. Its behaviour is unchanged: the same parameters are read at
 * the same points, the same lookups run, the same write happens and the same lines are logged.
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
 * @version 1.1.0
 */
define(['N/log', './lib/opsync_lib_config', './lib/opsync_lib_values',
    './lib/opsync_lib_so_readiness'],
    function (log, opsyncConfig, values, soReadiness) {

    'use strict';

    var VERSION = '1.1.0';

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
        var fields = opsyncConfig.SALES_ORDER_FIELDS;
        var result;

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

            // 2. The order's own facts. Every field goes through effectiveValue, not a plain
            //    newRecord read. On XEDIT — inline edit from a list view — NetSuite populates
            //    newRecord with ONLY the fields that were edited, so an untouched field reads as
            //    EMPTY rather than as unchanged. Reading the quote type straight off a sparse
            //    newRecord would see a blank quote type, skip the certificate gate, and mark a
            //    held order ready.
            //
            //    The cfg is EMPTY on purpose: every parameter is then read by the library at the
            //    point this script has always read it, so an order with no linked opportunity
            //    still exits before any parameter is touched. See the file header of
            //    lib/opsync_lib_so_readiness.js.
            result = soReadiness.evaluateOrder({}, orderId, {
                opportunityId: values.effectiveValue(
                    newRecord, oldRecord, fields.OPPORTUNITY_LINK, sparse),
                financeStatus: values.effectiveValue(
                    newRecord, oldRecord, fields.RECORD_STATUS, sparse),
                quoteTypeId: values.effectiveValue(
                    newRecord, oldRecord, fields.QUOTE_TYPE, sparse),
                subcontractReceived: values.effectiveValue(
                    newRecord, oldRecord, fields.SUBCONTRACT_RECEIVED, sparse),
                currentReady: values.effectiveValue(
                    newRecord, oldRecord, fields.READY_FOR_DELIVERY, sparse),
                currentReason: values.effectiveValue(
                    newRecord, oldRecord, fields.DELIVERY_HOLD_REASON, sparse)
            });

            if (!result.changed) {
                return;
            }

            log.audit({
                title: opsyncConfig.logKey('SO_READINESS_UPDATED'),
                details: 'Sales order ' + orderId + ': ready ' + result.currentReady + ' -> ' +
                    result.ready + ' (' + (result.reason || 'no hold') + '), from its own ' +
                    'save rather than from opportunity ' + result.opportunityId + '.'
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
