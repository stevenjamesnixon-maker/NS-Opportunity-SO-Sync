/**
 * dsi_ue_design_instruction.js
 *
 * User event on the Design Instruction row (customrecord_cad_worklist). Two jobs:
 *
 *   beforeSubmit  stamps the design start date when a designer is first assigned, and refuses to
 *                 let a row be completed without its designer, area and notes;
 *   afterSubmit   when a row is completed, moves its opportunity on to be checked — writes the
 *                 completion sub-status (Post Design Check) and clears the priority design box.
 *
 * COMPLETION IS THE COMPLETED DATE BEING ENTERED — empty before the save, present after. There
 * is no status field and no button. Every completion, New design or Redraw, writes the same
 * sub-status: one parameter, no per-type mapping. A row whose design type is Cancelled is ignored
 * by both jobs.
 *
 * beforeSubmit MAY throw, and that is the point of the completion gate: a throw there blocks the
 * row's save and shows the user what is missing. afterSubmit must NOT block anything — the row
 * has already saved — so its entry point is wrapped whole.
 *
 * ⚠️ THE OPPORTUNITY WRITE MAY NOT RE-RUN THE OPPORTUNITY'S OWN USER EVENTS. NetSuite documents
 * that user event scripts cannot be executed by other user event scripts. If that holds, the
 * submitFields below changes the sub-status WITHOUT opsync_ue_opportunity.js running, so Post
 * Design Check does not reach the sales orders on this save. Sandbox scenario 124 decides it. See
 * docs/context.md section 11, open decision 2.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/record', 'N/error', 'N/log', './lib/dsi_lib_config', './lib/opsync_lib_values'],
    function (record, error, log, dsiConfig, values) {

    'use strict';

    var VERSION = '1.0.0';

    /**
     * The message the user sees when the completion gate refuses a save.
     * @type {string}
     */
    var INCOMPLETE_MESSAGE = 'To complete this design instruction, enter the designer, the ' +
        'area (m²) and designer notes.';

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
     * Stamps the design start date with today when a designer is assigned for the first time and
     * no start date is already recorded.
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
     * The completion gate. Throws DSI_INCOMPLETE when the row is being completed without its
     * designer, area or notes. Skipped entirely for a cancelled row.
     *
     * AREA: present is enough, and ZERO IS PRESENT. The test is isEmpty(), never falsiness —
     * a falsy test would refuse a legitimate area of 0.
     *
     * NOTES: must be non-blank after trimming. A note of spaces is not a note.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @throws {Error} DSI_INCOMPLETE
     */
    function enforceCompletionGate(newRecord, oldRecord, sparse) {
        var fields = dsiConfig.ROW_FIELDS;
        var missing = [];
        var notes;

        if (values.contains(readType(newRecord, oldRecord, sparse),
                dsiConfig.getCancelledTypes())) {
            return;
        }

        if (values.asSelectId(values.effectiveValue(newRecord, oldRecord, fields.DESIGNER,
                sparse)) === '') {
            missing.push('designer');
        }
        if (values.isEmpty(values.effectiveValue(newRecord, oldRecord, fields.AREA, sparse))) {
            missing.push('area');
        }
        notes = values.effectiveValue(newRecord, oldRecord, fields.NOTES, sparse);
        if (values.isEmpty(notes) || String(notes).replace(/^\s+|\s+$/g, '') === '') {
            missing.push('designer notes');
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
     * NOT wrapped in a catch-all, unlike afterSubmit: a throw here is how the completion gate
     * works. The consequence is that any other failure here also refuses the row's save.
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

        stampDesignStart(context.newRecord, context.oldRecord, sparse);

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
