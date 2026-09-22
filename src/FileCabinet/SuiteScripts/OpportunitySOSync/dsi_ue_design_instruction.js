/**
 * dsi_ue_design_instruction.js
 *
 * User event on the Design Instruction row (customrecord_cad_worklist). Two jobs:
 *
 *   beforeSubmit  stamps the design start date when "CAD completed by" is first filled in, and
 *                 refuses to let a row be completed without it;
 *   afterSubmit   when a row is completed, moves its opportunity on to be checked — writes the
 *                 completion sub-status (Post Design Check) and clears the priority design box.
 *
 * COMPLETION IS THE COMPLETED DATE BEING ENTERED — empty before the save, present after. There
 * is no status field and no button. Every completion, New design or Redraw, writes the same
 * sub-status: one parameter, no per-type mapping. A row whose design type is Cancelled is ignored
 * by both jobs.
 *
 * beforeSubmit throws in ONE place, deliberately: the completion gate, whose throw blocks the
 * row's save and shows the user what is missing. The design start stamp is wrapped so that it
 * can never block a designer's save. afterSubmit must not block anything — the row has already
 * saved — so its entry point is wrapped whole.
 *
 * The completion write re-runs the opportunity's user events, including the sync, which carries
 * Post Design Check on to the sales orders. A user event's write to a DIFFERENT record type does
 * fire that record's user events in this account: the sync's own scenario 95 depends on it and
 * has passed. Scenario 124 confirms it for this write. See docs/context.md section 11.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.2.0
 */
define(['N/record', 'N/error', 'N/log', './lib/dsi_lib_config', './lib/opsync_lib_values'],
    function (record, error, log, dsiConfig, values) {

    'use strict';

    var VERSION = '1.2.0';

    /**
     * The message the user sees when the completion gate refuses a save.
     * @type {string}
     */
    var INCOMPLETE_MESSAGE = 'To complete this design instruction, enter who completed it ' +
        '(CAD completed by).';

    /**
     * True for the three event types both entry points handle.
     *
     * @param {Object} context
     * @returns {boolean}
     */
    function isHandledType(context) {
        return context.type === context.UserEventType.CREATE ||
            context.type === context.UserEventType.EDIT ||
            context.type === context.UserEventType.XEDIT;
    }

    /**
     * True when this save COMPLETES the row: the completed date is present after the save and was
     * empty before it. On CREATE there is no oldRecord, so "before" is empty.
     *
     * The after value goes through effectiveValue(): on an XEDIT of some other field, newRecord
     * does not carry the completed date and falls back to oldRecord — so an already-completed row
     * reads present both sides and this is false, as it should be. Clearing a completed date is
     * never a completion either, whatever the event type.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @returns {boolean}
     */
    function isCompletion(newRecord, oldRecord, sparse) {
        var field = dsiConfig.ROW_FIELDS.COMPLETED;

        return values.isPresent(values.effectiveValue(newRecord, oldRecord, field, sparse)) &&
            !values.isPresent(values.readField(oldRecord, field));
    }

    /**
     * The row's design type id, XEDIT-aware.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @returns {string}
     */
    function readType(newRecord, oldRecord, sparse) {
        return values.asSelectId(values.effectiveValue(newRecord, oldRecord,
            dsiConfig.ROW_FIELDS.DESIGN_TYPE, sparse));
    }

    /**
     * Stamps the design start date with today when ROW_FIELDS.DESIGNER is filled in for the first
     * time and no start date is already recorded.
     *
     * Since 1.2.0 ROW_FIELDS.DESIGNER is custrecord_cw_bom_completed_by — "CAD completed by" on
     * the form. This function follows the constant and needed no change of its own. If that field
     * is filled in only when the design is finished, the start date is stamped on that save.
     *
     * "Today" is new Date() in the SERVER's time zone, as the brief specifies. Near midnight UK
     * time the server's date can differ from the user's; Sandbox should confirm the stamped date
     * is the expected one. See docs/context.md section 11.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     */
    function stampDesignStart(newRecord, oldRecord, sparse) {
        var fields = dsiConfig.ROW_FIELDS;
        var designerAfter = values.asSelectId(values.effectiveValue(newRecord, oldRecord,
            fields.DESIGNER, sparse));
        var designerBefore = values.asSelectId(values.readField(oldRecord, fields.DESIGNER));
        var start = values.effectiveValue(newRecord, oldRecord, fields.DESIGN_START, sparse);

        if (designerAfter !== '' && designerBefore === '' && values.isEmpty(start)) {
            newRecord.setValue({ fieldId: fields.DESIGN_START, value: new Date() });
        }
    }

    /**
     * The completion gate. Throws DSI_INCOMPLETE when the row is being completed without
     * ROW_FIELDS.DESIGNER — "CAD completed by". Skipped entirely for a cancelled row.
     *
     * THE DESIGNER IS THE ONLY REQUIREMENT, by the client's decision of 24 Sep 2026. The area and
     * notes checks were REMOVED, not relaxed: a row completes with its area empty or zero and its
     * notes empty. Do not add them back without the client.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @throws {Error} DSI_INCOMPLETE
     */
    function enforceCompletionGate(newRecord, oldRecord, sparse) {
        var missing = [];

        if (values.contains(readType(newRecord, oldRecord, sparse),
                dsiConfig.getCancelledTypes())) {
            return;
        }

        if (values.asSelectId(values.effectiveValue(newRecord, oldRecord,
                dsiConfig.ROW_FIELDS.DESIGNER, sparse)) === '') {
            missing.push('designer');
        }

        if (missing.length === 0) {
            return;
        }

        log.audit({
            title: dsiConfig.logKey('INCOMPLETE'),
            details: 'Design Instruction ' + (newRecord.id || '(new)') + ' was not completed: ' +
                'missing ' + missing.join(', ') + '. The save was refused.'
        });
        throw error.create({
            name: dsiConfig.logKey('INCOMPLETE'),
            message: INCOMPLETE_MESSAGE,
            notifyOff: false
        });
    }

    /**
     * Entry point. Runs before the row is written, so it may change newRecord and may refuse the
     * save. See docs/context.md section 11.
     *
     * TWO STEPS, TWO FAILURE RULES — do not unify them:
     *
     *   1. The design start stamp is WRAPPED. A stamping failure is logged as DSI_STAMP_FAILED
     *      and the save goes on: a missing start date must never stop a designer saving.
     *   2. The completion gate is NOT wrapped. Its throw is how it refuses an incomplete
     *      completion, so it must reach NetSuite.
     *
     * @param {Object} context
     * @throws {Error} DSI_INCOMPLETE
     */
    function beforeSubmit(context) {
        var sparse;

        if (!isHandledType(context)) {
            return;
        }

        sparse = (context.type === context.UserEventType.XEDIT);

        // 1. Wrapped — must not block the save.
        try {
            stampDesignStart(context.newRecord, context.oldRecord, sparse);
        } catch (e) {
            log.error({
                title: dsiConfig.logKey('STAMP_FAILED'),
                details: 'The design start date could not be stamped on Design Instruction ' +
                    (context.newRecord && context.newRecord.id ? context.newRecord.id : '(new)') +
                    '. The row was saved without it. ' + e
            });
        }

        // 2. Not wrapped — a throw here is the gate refusing the save.
        if (isCompletion(context.newRecord, context.oldRecord, sparse)) {
            enforceCompletionGate(context.newRecord, context.oldRecord, sparse);
        }
    }

    /**
     * Entry point. When this save completed the row, moves the opportunity on.
     *
     * @param {Object} context
     */
    function afterSubmit(context) {
        var newRecord;
        var oldRecord;
        var sparse;
        var rowId;
        var typeId;
        var completeStatus;
        var opportunityId;
        var fieldValues = {};

        try {
            if (!isHandledType(context)) {
                return;
            }

            newRecord = context.newRecord;
            oldRecord = context.oldRecord;
            sparse = (context.type === context.UserEventType.XEDIT);
            rowId = newRecord ? String(newRecord.id) : '';

            // 1. Only the save that completes the row.
            if (!isCompletion(newRecord, oldRecord, sparse)) {
                return;
            }

            // 2. A cancelled row's completion writes nothing.
            typeId = readType(newRecord, oldRecord, sparse);
            if (values.contains(typeId, dsiConfig.getCancelledTypes())) {
                log.audit({
                    title: dsiConfig.logKey('CANCELLED_IGNORED'),
                    details: 'Design Instruction ' + rowId + ' was completed, but its type (' +
                        typeId + ') is cancelled. Nothing was written to the opportunity.'
                });
                return;
            }

            // 3. Empty is logged at error by the accessor, and nothing is written. Not a throw:
            //    the row has already saved, and a throw here could not undo that.
            completeStatus = dsiConfig.getCompleteStatus();
            if (completeStatus === '') {
                return;
            }

            opportunityId = values.asSelectId(values.effectiveValue(newRecord, oldRecord,
                dsiConfig.ROW_FIELDS.OPPORTUNITY, sparse));
            if (opportunityId === '') {
                log.error({
                    title: dsiConfig.logKey('COMPLETE_FAILED'),
                    details: 'Design Instruction ' + rowId + ' was completed but has no ' +
                        'opportunity, so there is nothing to move on. Check ' +
                        dsiConfig.ROW_FIELDS.OPPORTUNITY + ' on the row.'
                });
                return;
            }

            // 4. The write-back. The priority design box is cleared on EVERY completion, not
            //    only the last — the client's decision.
            //
            //    This write fires the opportunity's user events, the sync included: a user
            //    event's write to another record type fires that record's user events here —
            //    the sync's scenario 95 depends on it and has passed. Scenario 124 confirms it.
            fieldValues[dsiConfig.OPPORTUNITY_FIELDS.SUB_STATUS] = completeStatus;
            fieldValues[dsiConfig.OPPORTUNITY_FIELDS.PRIORITY_DESIGN] = false;

            record.submitFields({
                type: dsiConfig.RECORD_TYPES.OPPORTUNITY,
                id: opportunityId,
                values: fieldValues,
                options: {
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                }
            });

            log.audit({
                title: dsiConfig.logKey('ROW_COMPLETED'),
                details: 'Design Instruction ' + rowId + ' completed. Opportunity ' +
                    opportunityId + ' sub-status set to ' + completeStatus + ' and priority ' +
                    'design cleared.'
            });

        } catch (e) {
            // The row has already saved. Nothing here may change that.
            log.error({
                title: dsiConfig.logKey('COMPLETE_FAILED'),
                details: 'Completion write-back failed for Design Instruction ' +
                    (context && context.newRecord ? context.newRecord.id : 'unknown') +
                    ' on ' + (context ? context.type : 'unknown') + '. The row saved normally; ' +
                    'its opportunity was not moved on. ' + e
            });
        }
    }

    return {
        VERSION: VERSION,
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});
