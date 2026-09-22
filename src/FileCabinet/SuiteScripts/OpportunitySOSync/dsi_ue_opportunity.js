/**
 * dsi_ue_opportunity.js
 *
 * Two jobs on the Opportunity:
 *
 *   beforeLoad   on VIEW, adds the Request Design and Request Redraw buttons, each shown by the
 *                sub-status alone, and attaches dsi_cs_opportunity.js to act on them;
 *   afterSubmit  creates a Design Instruction row (customrecord_cad_worklist) when the sub-status
 *                moves to one of the values in custscript_dsi_create_map — Design Required
 *                creates a New design row, Redraw Required a Redraw row, in the client's
 *                configuration.
 *
 * The buttons only write the sub-status. The row is created here, in afterSubmit, by the save
 * that write causes — exactly as for a sub-status changed by hand.
 *
 * SEPARATE FROM opsync_ue_opportunity.js, DELIBERATELY. Both fire on the same saves, and neither
 * touches the other's fields: the sync writes only to sales orders, this script only creates
 * rows. Neither file imports the other, and this one does not load opsync_lib_config.js, which
 * would refuse to resolve parameters for this script. See docs/context.md section 11.
 *
 * Nothing here may stop the opportunity displaying or block its save. Both entry points are
 * wrapped whole, and nothing read in beforeLoad throws.
 *
 * Every script ID this file uses comes from dsi_lib_config. No internal id is written out here.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.2.0
 */
define(['N/record', 'N/search', 'N/log', 'N/ui/serverWidget', './lib/dsi_lib_config',
    './lib/opsync_lib_values'],
    function (record, search, log, serverWidget, dsiConfig, values) {

    'use strict';

    var VERSION = '1.2.0';

    /**
     * The client script the buttons call, relative to this file. Attached per form by beforeLoad:
     * it needs no script record and no deployment.
     * @type {string}
     */
    var CLIENT_SCRIPT_PATH = './dsi_cs_opportunity.js';

    /**
     * The two buttons. functionName is a BARE function name exported by the client script —
     * NetSuite appends the parentheses. No arguments are passed in the string; the values the
     * functions need arrive in hidden fields.
     * @type {Object}
     */
    var BUTTONS = {
        DESIGN: {
            id: 'custpage_dsi_request_design',
            label: 'Request Design',
            functionName: 'dsiRequestDesign'
        },
        REDRAW: {
            id: 'custpage_dsi_request_redraw',
            label: 'Request Redraw',
            functionName: 'dsiRequestRedraw'
        }
    };

    /**
     * Separator between the name's main segments. U+00B7, the middle dot, written literally: the
     * repository is UTF-8 by .editorconfig, and the existing scripts already carry non-ASCII
     * characters in logged strings.
     * @type {string}
     */
    var NAME_SEPARATOR = ' · ';

    /**
     * Separator between the name parts that follow the type.
     * @type {string}
     */
    var PART_SEPARATOR = ' / ';

    /**
     * Renders one value from a search.lookupFields result as trimmed text for the name, whatever
     * its shape:
     *
     *   select / multi-select   an ARRAY of {value, text} — the texts, joined for a multi-select;
     *                           an empty select is [] and renders as ''
     *   text, number, date      a STRING — used as it is
     *
     * This is what makes the name parts' field types irrelevant: the shape that arrives says
     * which it is.
     *
     * @param {*} value
     * @returns {string} '' when empty
     */
    function lookupText(value) {
        var texts = [];

        if (Object.prototype.toString.call(value) === '[object Array]') {
            value.forEach(function (option) {
                var text = (option && !values.isEmpty(option.text)) ?
                    String(option.text).replace(/^\s+|\s+$/g, '') : '';
                if (text !== '') {
                    texts.push(text);
                }
            });
            return texts.join(', ');
        }

        if (values.isEmpty(value)) {
            return '';
        }

        return String(value).replace(/^\s+|\s+$/g, '');
    }

    /**
     * Reads every value the row copies from the opportunity, in ONE search.lookupFields.
     *
     * NOT off the event's newRecord. A button press writes the sub-status with submitFields, so
     * this script runs as XEDIT and newRecord is sparse — and a sparse checkbox reads as false,
     * which is not empty, so effectiveValue() never fell back to oldRecord and the priority box
     * was copied as unticked on every button-created row. Rather than reason field by field about
     * what a sparse newRecord returns, the copied values come from the record as STORED:
     * afterSubmit runs after the opportunity has saved, on CREATE included, so tranid is the real
     * number too.
     *
     * One lookup for every column: a column id that does not exist at all fails the whole lookup,
     * and the row with it (DSI_CREATE_FAILED). A field that exists but does not apply to the
     * Opportunity reads as blank — docs/context.md section 0, trap 6.
     *
     * @param {string} opportunityId
     * @returns {Object} the lookupFields result
     */
    function readOpportunity(opportunityId) {
        var opp = dsiConfig.OPPORTUNITY_FIELDS;

        return search.lookupFields({
            type: dsiConfig.RECORD_TYPES.OPPORTUNITY,
            id: opportunityId,
            columns: [
                opp.CUSTOMER,
                opp.SALES_REP,
                opp.PROJECT_ENGINEER,
                opp.PRIORITY_DESIGN,
                opp.TRAN_ID
            ].concat(dsiConfig.NAME_PARTS)
        });
    }

    /**
     * The design type's display name, for the row name.
     *
     * Read with search.lookupFields on the LIST, not with getText() on the new row. The brief
     * offered both; getText() is not available here, because the row is created in STANDARD
     * mode (isDynamic: false) and in standard mode getText() on a field populated by setValue()
     * throws SSS_INVALID_API_USAGE rather than returning the text.
     *
     * An unreadable name does not stop the row being created — the row is the point, the name is
     * a label. It is logged at error and the type segment is left out of the name.
     *
     * @param {string} typeId
     * @returns {string} '' when it cannot be read
     */
    function readTypeText(typeId) {
        var lookup;

        try {
            lookup = search.lookupFields({
                type: dsiConfig.LISTS.DESIGN_TYPE,
                id: typeId,
                columns: ['name']
            });
            return lookupText(lookup.name);
        } catch (e) {
            log.error({
                title: dsiConfig.logKey('TYPE_TEXT_UNREADABLE'),
                details: 'Design type ' + typeId + ' could not be read from ' +
                    dsiConfig.LISTS.DESIGN_TYPE + ', so the row name leaves out its type. The ' +
                    'row is still created. ' + e
            });
            return '';
        }
    }

    /**
     * Builds the row name:
     *
     *   <tranid> · <type text> · <part1> / <part2> / <part3>
     *
     * Each part is included only when non-empty after trimming, and ' / ' falls only between
     * parts that are present. With no parts the name is <tranid> · <type text>. An empty tranid
     * or type text is left out the same way, so the name never starts or ends with a separator.
     * The result is truncated to NAME_MAX_LENGTH — itself unverified, see dsi_lib_config.js.
     *
     * @param {Object} opportunity - the readOpportunity() lookup
     * @param {string} typeText
     * @returns {string}
     */
    function buildName(opportunity, typeText) {
        var segments = [];
        var parts = [];
        var name;
        var tranId = lookupText(opportunity[dsiConfig.OPPORTUNITY_FIELDS.TRAN_ID]);

        dsiConfig.NAME_PARTS.forEach(function (fieldId) {
            var text = lookupText(opportunity[fieldId]);
            if (text !== '') {
                parts.push(text);
            }
        });

        if (tranId !== '') {
            segments.push(tranId);
        }
        if (typeText !== '') {
            segments.push(typeText);
        }
        if (parts.length > 0) {
            segments.push(parts.join(PART_SEPARATOR));
        }

        name = segments.join(NAME_SEPARATOR);

        return name.length > dsiConfig.NAME_MAX_LENGTH ?
            name.substring(0, dsiConfig.NAME_MAX_LENGTH) : name;
    }

    /**
     * Creates the Design Instruction row.
     *
     * Every copied value comes from ONE lookup of the opportunity as stored — see
     * readOpportunity() for why the event records are not used. Selects go through asSelectId(),
     * which reads the [{value, text}] shape and treats [] as blank; the priority box through
     * isTicked(), which accepts the boolean lookupFields returns and the 'T' / 'true' strings.
     *
     * @param {string} opportunityId
     * @param {string} typeId
     * @param {string} formId
     * @returns {{id: string, name: string}}
     */
    function createRow(opportunityId, typeId, formId) {
        var opp = dsiConfig.OPPORTUNITY_FIELDS;
        var fields = dsiConfig.ROW_FIELDS;
        var defaultValues = {};
        var opportunity = readOpportunity(opportunityId);
        var name = buildName(opportunity, readTypeText(typeId));
        var row;

        defaultValues[fields.CUSTOM_FORM] = formId;

        row = record.create({
            type: dsiConfig.RECORD_TYPES.DESIGN_INSTRUCTION,
            isDynamic: false,
            defaultValues: defaultValues
        });

        // A SOURCED field on the record. Set directly, as the SS1.0 predecessor did with
        // setFieldValue. Sandbox must confirm the value survives the save.
        row.setValue({ fieldId: fields.OPPORTUNITY, value: opportunityId });
        row.setValue({
            fieldId: fields.CUSTOMER,
            value: values.asSelectId(opportunity[opp.CUSTOMER])
        });
        row.setValue({
            fieldId: fields.SALES_REP,
            value: values.asSelectId(opportunity[opp.SALES_REP])
        });
        row.setValue({
            fieldId: fields.PROJECT_ENGINEER,
            value: values.asSelectId(opportunity[opp.PROJECT_ENGINEER])
        });
        row.setValue({ fieldId: fields.DESIGN_TYPE, value: typeId });
        row.setValue({
            fieldId: fields.URGENT,
            value: values.isTicked(opportunity[opp.PRIORITY_DESIGN])
        });
        row.setValue({ fieldId: fields.NAME, value: name });

        // ignoreMandatoryFields is BELT AND BRACES, not the fix. The record carries a mandatory
        // multi-select that the client is un-mandating on the record definition; that change is
        // what makes this save valid. The flag only stops the row failing if it has not landed.
        return {
            id: String(row.save({ ignoreMandatoryFields: true })),
            name: name
        };
    }

    /**
     * Adds one hidden field carrying a value for the client script.
     *
     * @param {serverWidget.Form} form
     * @param {string} fieldId - from dsiConfig.HIDDEN_FIELDS
     * @param {string} value
     */
    function addHiddenField(form, fieldId, value) {
        var field = form.addField({
            id: fieldId,
            type: serverWidget.FieldType.TEXT,
            label: fieldId
        });

        field.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        field.defaultValue = value;
    }

    /**
     * The configuration consistency check: a button's target should be a key of the creation
     * map. A button whose status creates nothing still works — it writes the status — so this
     * is logged at error and otherwise ignored. It must not hide the button or break the page.
     *
     * @param {Object} createMap
     * @param {string} target
     * @param {string} label
     * @param {string} opportunityId
     */
    function checkTarget(createMap, target, label, opportunityId) {
        if (!createMap.hasOwnProperty(target)) {
            log.error({
                title: dsiConfig.logKey('CONFIG_MISMATCH'),
                details: 'The ' + label + ' button writes sub-status ' + target + ', which is ' +
                    'not a key of custscript_dsi_create_map, so pressing it creates no Design ' +
                    'Instruction. The button is still shown and still writes the status. Seen ' +
                    'on opportunity ' + opportunityId + '.'
            });
        }
    }

    /**
     * Entry point. On VIEW, adds the Request Design and Request Redraw buttons.
     *
     * Visibility is by sub-status ALONE — no search runs here, by the client's decision. A
     * button is shown when the sub-status is in its visibility list AND its target parameter is
     * set; a button with nothing to write is not shown.
     *
     * Each button's hidden fields are added only with that button, so a parameter belonging to a
     * button that is not shown is never read and never logged.
     *
     * Wrapped whole. Nothing here may stop the record displaying: every parameter read in this
     * entry point fails closed, and anything that does throw is logged as DSI_BEFORELOAD_FAILED.
     *
     * @param {Object} context
     */
    function beforeLoad(context) {
        var form;
        var opportunityId;
        var subStatus;
        var designTarget = '';
        var redrawTarget = '';
        var createMap;

        try {
            if (context.type !== context.UserEventType.VIEW) {
                return;
            }

            form = context.form;
            opportunityId = context.newRecord ? String(context.newRecord.id) : '';
            subStatus = values.asId(values.readField(context.newRecord,
                dsiConfig.OPPORTUNITY_FIELDS.SUB_STATUS));

            if (values.contains(subStatus, dsiConfig.getBtnDesignStatuses())) {
                designTarget = dsiConfig.getBtnDesignTarget();
            }
            if (values.contains(subStatus, dsiConfig.getBtnRedrawStatuses())) {
                redrawTarget = dsiConfig.getBtnRedrawTarget();
            }

            if (designTarget === '' && redrawTarget === '') {
                return;
            }

            form.clientScriptModulePath = CLIENT_SCRIPT_PATH;
            createMap = dsiConfig.getCreateMap();

            if (designTarget !== '') {
                form.addButton(BUTTONS.DESIGN);
                addHiddenField(form, dsiConfig.HIDDEN_FIELDS.STATUS_DESIGN, designTarget);
                checkTarget(createMap, designTarget, BUTTONS.DESIGN.label, opportunityId);
            }

            if (redrawTarget !== '') {
                form.addButton(BUTTONS.REDRAW);
                addHiddenField(form, dsiConfig.HIDDEN_FIELDS.STATUS_REDRAW, redrawTarget);
                addHiddenField(form, dsiConfig.HIDDEN_FIELDS.TYPE_REDRAW,
                    dsiConfig.getRedrawType());
                checkTarget(createMap, redrawTarget, BUTTONS.REDRAW.label, opportunityId);
            }

        } catch (e) {
            // The record must still display. Without the buttons, if need be.
            log.error({
                title: dsiConfig.logKey('BEFORELOAD_FAILED'),
                details: 'Design Instruction buttons could not be added to opportunity ' +
                    (context && context.newRecord ? context.newRecord.id : 'unknown') +
                    '. The record displayed normally, without them. ' + e
            });
        }
    }

    /**
     * Entry point. See docs/context.md section 11.
     *
     * @param {Object} context
     */
    function afterSubmit(context) {
        var newRecord;
        var oldRecord;
        var sparse;
        var opportunityId;
        var newStatus;
        var oldStatus;
        var createMap;
        var completeStatus;
        var typeId;
        var formId;
        var created;

        try {
            // 1. CREATE, EDIT or XEDIT only.
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT &&
                context.type !== context.UserEventType.XEDIT) {
                return;
            }

            newRecord = context.newRecord;
            oldRecord = context.oldRecord;
            sparse = (context.type === context.UserEventType.XEDIT);
            opportunityId = newRecord ? String(newRecord.id) : '';

            // 2. The sub-status before and after. On CREATE there is no oldRecord and the old
            //    value is empty. On XEDIT newRecord carries only the edited fields, so an inline
            //    edit of something else falls back to oldRecord and compares equal below. This is
            //    the ONLY value this script reads off the event records — everything the row
            //    copies comes from readOpportunity().
            newStatus = values.asId(values.effectiveValue(newRecord, oldRecord,
                dsiConfig.OPPORTUNITY_FIELDS.SUB_STATUS, sparse));
            oldStatus = values.asId(values.readField(oldRecord,
                dsiConfig.OPPORTUNITY_FIELDS.SUB_STATUS));

            // 3. THIS "HAS THE SUB-STATUS CHANGED" EXIT IS REQUIRED HERE. Do not remove it.
            //
            //    opsync_ue_opportunity.js forbids exactly this short-circuit, and that
            //    prohibition is right THERE: the sync evaluates delivery readiness, whose inputs
            //    have nothing to do with the sub-status, so an exit on an unchanged sub-status
            //    left readiness stale. See the comment at step 4 of its afterSubmit and
            //    docs/context.md section 5.
            //
            //    It does not apply here. This script's ONLY input is the sub-status, and its only
            //    action — creating a row — must happen on the save that MOVES the sub-status and
            //    on no other. Without this exit every save of an opportunity sitting at Design
            //    Required would create another row.
            if (newStatus === oldStatus) {
                return;
            }

            // 4. Does the new sub-status create a row, and of which type?
            createMap = dsiConfig.getCreateMap();
            if (!createMap.hasOwnProperty(newStatus)) {
                log.debug({
                    title: dsiConfig.logKey('NO_CREATE'),
                    details: 'Opportunity ' + opportunityId + ': sub-status ' +
                        (oldStatus || '(empty)') + ' -> ' + (newStatus || '(empty)') + ' creates ' +
                        'no Design Instruction.'
                });
                return;
            }
            typeId = createMap[newStatus];

            // 5. The overlap check. A creation map that creates a row at the completion status
            //    would give every completion one extra open row. Not an endless loop — the new
            //    row waits for a person — but one unwanted row per completion. Refuse the whole
            //    map rather than guess which entry is wrong.
            //
            //    getOverlapStatus() THROWS when unset (caught below as DSI_CREATE_FAILED): a
            //    creation with this check silently skipped is the fail-open case section 5
            //    forbids, so no row is created until the parameter is set.
            completeStatus = dsiConfig.getOverlapStatus();
            if (createMap.hasOwnProperty(completeStatus)) {
                log.error({
                    title: dsiConfig.logKey('CONFIG_OVERLAP'),
                    details: 'custscript_dsi_create_map has an entry for sub-status ' +
                        completeStatus + ', which is also custscript_dsi_complete_status — the ' +
                        'status a completed Design Instruction writes back. No row was created ' +
                        'for opportunity ' + opportunityId + ' (sub-status ' + newStatus + '), ' +
                        'and none will be for any sub-status until the map no longer contains ' +
                        'the completion status.'
                });
                return;
            }

            // 6. Throws when unset — caught below as DSI_CREATE_FAILED. Read only now, when a row
            //    is actually about to be created.
            formId = dsiConfig.getFormId();

            // 7. NO DUPLICATE GUARD, by the client's decision (22-23 Sep): a sub-status set to a
            //    creating value twice creates two rows. A saved search is the safety net.
            created = createRow(opportunityId, typeId, formId);

            log.audit({
                title: dsiConfig.logKey('ROW_CREATED'),
                details: 'Design Instruction ' + created.id + ' created for opportunity ' +
                    opportunityId + ' on sub-status ' + (oldStatus || '(empty)') + ' -> ' +
                    newStatus + ': type ' + typeId + ', name "' + created.name + '".'
            });

        } catch (e) {
            // The opportunity has already saved. Nothing here may change that.
            log.error({
                title: dsiConfig.logKey('CREATE_FAILED'),
                details: 'Design Instruction creation failed for opportunity ' +
                    (context && context.newRecord ? context.newRecord.id : 'unknown') +
                    ' on ' + (context ? context.type : 'unknown') +
                    '. The opportunity saved normally; no row was created. ' + e
            });
        }
    }

    return {
        VERSION: VERSION,
        beforeLoad: beforeLoad,
        afterSubmit: afterSubmit
    };
});
