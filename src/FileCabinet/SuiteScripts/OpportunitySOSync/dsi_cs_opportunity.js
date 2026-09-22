/**
 * dsi_cs_opportunity.js
 *
 * The two Design Instruction buttons on the Opportunity's VIEW page — Request Design and Request
 * Redraw. Each asks for confirmation and writes the opportunity's sub-status. That write fires
 * the opportunity's user events, and dsi_ue_opportunity.js creates the row; this script creates
 * nothing itself.
 *
 * ATTACHED, NOT DEPLOYED. dsi_ue_opportunity.js sets form.clientScriptModulePath in beforeLoad
 * and adds the buttons there. This file needs NO script record and NO deployment — only its File
 * Cabinet upload, in the same folder as the user event.
 *
 * NO IDS IN THIS FILE. Every sub-status and type it uses arrives in the hidden fields beforeLoad
 * adds (dsiConfig.HIDDEN_FIELDS), read from that script's parameters. Script IDs come from
 * lib/dsi_lib_config.js, which this file loads for its constants and for findRows() — one
 * definition of the row search rather than a second copy here.
 *
 * AN EMPTY STATUS IS NEVER WRITTEN. Writing '' would CLEAR the opportunity's sub-status. The
 * button is only added when its target is set, so an empty read here means the hidden field could
 * not be read — the user is told and nothing is written.
 *
 * dialog.confirm and dialog.alert return Promises; that is NetSuite's API, not a departure from
 * the house style. Errors thrown inside a .then() callback do not reach an outer try/catch, so
 * each callback carries its own.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @version 1.1.0
 */
define(['N/currentRecord', 'N/record', 'N/url', 'N/ui/dialog', './lib/dsi_lib_config'],
    function (currentRecord, record, url, dialog, dsiConfig) {

    'use strict';

    var VERSION = '1.1.0';

    /**
     * Dialog title for every message this script shows.
     * @type {string}
     */
    var TITLE = 'Design Instruction';

    /**
     * User-facing wording. The client's.
     * @type {Object}
     */
    var MESSAGES = {
        CONFIRM_DESIGN: 'Request design for this project? The sub-status will move to Design ' +
            'Required and a Design Instruction row will be created.',
        CONFIRM_REDRAW: 'Request a redraw? The sub-status will move to Redraw Required. You will ' +
            'then be taken to the new row to enter the reason.',
        ROW_NOT_FOUND: 'The redraw was requested but its row could not be found — check the ' +
            'Design tab.',
        NOT_CONFIGURED: 'This button could not read its configuration, so nothing was changed. ' +
            'Please reload the page and try again, or tell your NetSuite administrator.'
    };

    /**
     * Required ClientScript entry point. Does nothing: the buttons call the two functions below
     * directly. NetSuite does not fire pageInit on a VIEW page in any case.
     */
    function pageInit() {
        return;
    }

    /**
     * Reads one of the hidden fields beforeLoad added.
     *
     * @param {Record} rec - the current record
     * @param {string} fieldId
     * @returns {string} trimmed, or '' when absent or unreadable
     */
    function readHidden(rec, fieldId) {
        var value;

        try {
            value = rec.getValue({ fieldId: fieldId });
        } catch (e) {
            return '';
        }

        if (value === null || value === undefined) {
            return '';
        }

        return String(value).replace(/^\s+|\s+$/g, '');
    }

    /**
     * Shows an error and leaves the page as it is — no reload, so the user can see what state
     * the record is in.
     *
     * @param {*} e
     */
    function showError(e) {
        dialog.alert({
            title: TITLE,
            message: (e && e.message) ? e.message : String(e)
        });
    }

    /**
     * Reloads the page, showing the record as it now is.
     */
    function reload() {
        window.location.reload();
    }

    /**
     * Writes the opportunity's sub-status. This save fires the opportunity's user events as
     * XEDIT — the sync and dsi_ue_opportunity.js alike — which is how the row gets created.
     *
     * @param {Record} rec - the current record
     * @param {string} status - never empty; the callers check
     */
    function writeSubStatus(rec, status) {
        var fieldValues = {};

        fieldValues[dsiConfig.OPPORTUNITY_FIELDS.SUB_STATUS] = status;

        record.submitFields({
            type: dsiConfig.RECORD_TYPES.OPPORTUNITY,
            id: rec.id,
            values: fieldValues
        });
    }

    /**
     * Asks for confirmation, then runs the action. Cancel does nothing. Any error from the action
     * is shown and the page is left alone.
     *
     * @param {string} message
     * @param {function} action
     */
    function confirmThen(message, action) {
        dialog.confirm({ title: TITLE, message: message }).then(function (confirmed) {
            if (!confirmed) {
                return;
            }
            try {
                action();
            } catch (e) {
                showError(e);
            }
        }, showError);
    }

    /**
     * Request Design: moves the sub-status to Design Required, then reloads.
     */
    function dsiRequestDesign() {
        var rec;
        var target;

        try {
            rec = currentRecord.get();
            target = readHidden(rec, dsiConfig.HIDDEN_FIELDS.STATUS_DESIGN);

            if (target === '') {
                dialog.alert({ title: TITLE, message: MESSAGES.NOT_CONFIGURED });
                return;
            }

            confirmThen(MESSAGES.CONFIRM_DESIGN, function () {
                writeSubStatus(rec, target);
                reload();
            });
        } catch (e) {
            showError(e);
        }
    }

    /**
     * Request Redraw: moves the sub-status to Redraw Required, then opens the new Redraw row in
     * edit mode so the user can enter the reason. The reason is entered by hand; nothing here
     * writes it.
     *
     * The row is found as the NEWEST row of the redraw type on this opportunity. The user event
     * creates it inside the submitFields call, so it exists by the time the search runs. When it
     * cannot be found — the redraw type is not configured, or creation failed — the user is told,
     * and the page reloads.
     */
    function dsiRequestRedraw() {
        var rec;
        var target;
        var redrawType;

        try {
            rec = currentRecord.get();
            target = readHidden(rec, dsiConfig.HIDDEN_FIELDS.STATUS_REDRAW);
            redrawType = readHidden(rec, dsiConfig.HIDDEN_FIELDS.TYPE_REDRAW);

            if (target === '') {
                dialog.alert({ title: TITLE, message: MESSAGES.NOT_CONFIGURED });
                return;
            }

            confirmThen(MESSAGES.CONFIRM_REDRAW, function () {
                var rows;

                writeSubStatus(rec, target);

                // No type, no search: findRows() without one would return the newest row of ANY
                // type and land the user on the wrong row.
                rows = (redrawType === '') ? [] : dsiConfig.findRows(String(rec.id), redrawType);

                if (rows.length === 0) {
                    dialog.alert({ title: TITLE, message: MESSAGES.ROW_NOT_FOUND })
                        .then(reload, reload);
                    return;
                }

                window.location.href = url.resolveRecord({
                    recordType: dsiConfig.RECORD_TYPES.DESIGN_INSTRUCTION,
                    recordId: rows[0].id,
                    isEditMode: true
                });
            });
        } catch (e) {
            showError(e);
        }
    }

    return {
        VERSION: VERSION,
        pageInit: pageInit,
        dsiRequestDesign: dsiRequestDesign,
        dsiRequestRedraw: dsiRequestRedraw
    };
});
