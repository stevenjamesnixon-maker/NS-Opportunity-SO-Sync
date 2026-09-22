/**
 * dsi_ue_opportunity.js
 *
 * Creates a Design Instruction row (customrecord_cad_worklist) when an opportunity's sub-status
 * moves to one of the values in custscript_dsi_create_map — Design Required creates a New design
 * row, Redraw Required a Redraw row, in the client's configuration.
 *
 * SEPARATE FROM opsync_ue_opportunity.js, DELIBERATELY. Both fire on the same saves, and neither
 * touches the other's fields: the sync writes only to sales orders, this script only creates
 * rows. Neither file imports the other, and this one does not load opsync_lib_config.js, which
 * would refuse to resolve parameters for this script. See docs/context.md section 11.
 *
 * afterSubmit only, in this phase. The brief also specifies a beforeLoad adding Request Design
 * and Request Redraw buttons; it is NOT BUILT, because the buttons' target sub-status ids have no
 * defined source. See docs/context.md section 11, open decision 1.
 *
 * Nothing here may block the opportunity save. The entry point is wrapped whole.
 *
 * Every script ID this file uses comes from dsi_lib_config. No internal id is written out here.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/record', 'N/search', 'N/log', './lib/dsi_lib_config', './lib/opsync_lib_values'],
    function (record, search, log, dsiConfig, values) {

    'use strict';

    var VERSION = '1.0.0';

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
     * Reads a field's display text, tolerating an absent record or a field it does not carry.
     * The getText() counterpart of opsync_lib_values.readField().
     *
     * @param {Record} rec
     * @param {string} fieldId
     * @returns {*} the text, or null
     */
    function readText(rec, fieldId) {
        if (!rec) {
            return null;
        }
        try {
            return rec.getText({ fieldId: fieldId });
        } catch (e) {
            return null;
        }
    }

    /**
     * The getText() counterpart of opsync_lib_values.effectiveValue(): on a sparse XEDIT
     * newRecord an untouched field reads as empty, so fall back to oldRecord — and only then.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {string} fieldId
     * @param {boolean} sparse
     * @returns {*}
     */
    function effectiveText(newRecord, oldRecord, fieldId, sparse) {
        var text = readText(newRecord, fieldId);

        if (sparse && values.isEmpty(text)) {
            return readText(oldRecord, fieldId);
        }

        return text;
    }

    /**
     * Renders a field value as trimmed text for the name. A multi-select's getText() returns an
     * array, which is joined.
     *
     * @param {*} value
     * @returns {string} '' when empty
     */
    function asNameText(value) {
        if (values.isEmpty(value)) {
            return '';
        }
        if (Object.prototype.toString.call(value) === '[object Array]') {
            return value.join(', ').replace(/^\s+|\s+$/g, '');
        }
        return String(value).replace(/^\s+|\s+$/g, '');
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
            return asNameText(lookup.name);
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
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @param {string} typeText
     * @returns {string}
     */
    function buildName(newRecord, oldRecord, sparse, typeText) {
        var segments = [];
        var parts = [];
        var name;
        var tranId = asNameText(values.effectiveValue(newRecord, oldRecord,
            dsiConfig.OPPORTUNITY_FIELDS.TRAN_ID, sparse));

        dsiConfig.NAME_PARTS.forEach(function (part) {
            var text = asNameText(part.isSelect ?
                effectiveText(newRecord, oldRecord, part.fieldId, sparse) :
                values.effectiveValue(newRecord, oldRecord, part.fieldId, sparse));
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
     * Every opportunity value is read through effectiveValue(), so an inline edit that changed
     * only the sub-status still sees the rest of the record rather than a sparse newRecord's
     * blanks.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @param {string} opportunityId
     * @param {string} typeId
     * @param {string} formId
     * @returns {{id: string, name: string}}
     */
    function createRow(newRecord, oldRecord, sparse, opportunityId, typeId, formId) {
        var opp = dsiConfig.OPPORTUNITY_FIELDS;
        var fields = dsiConfig.ROW_FIELDS;
        var defaultValues = {};
        var name = buildName(newRecord, oldRecord, sparse, readTypeText(typeId));
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
            value: values.asSelectId(values.effectiveValue(newRecord, oldRecord,
                opp.CUSTOMER, sparse))
        });
        row.setValue({
            fieldId: fields.SALES_REP,
            value: values.asSelectId(values.effectiveValue(newRecord, oldRecord,
                opp.SALES_REP, sparse))
        });
        row.setValue({
            fieldId: fields.PROJECT_ENGINEER,
            value: values.asSelectId(values.effectiveValue(newRecord, oldRecord,
                opp.PROJECT_ENGINEER, sparse))
        });
        row.setValue({ fieldId: fields.DESIGN_TYPE, value: typeId });
        row.setValue({
            fieldId: fields.URGENT,
            value: values.isTicked(values.effectiveValue(newRecord, oldRecord,
                opp.PRIORITY_DESIGN, sparse))
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
            //    edit of something else falls back to oldRecord and compares equal below.
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
            //    would turn every completion into a new row. Refuse the whole map rather than
            //    guess which entry is wrong.
            completeStatus = dsiConfig.getCompleteStatus();
            if (completeStatus !== '' && createMap.hasOwnProperty(completeStatus)) {
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
            created = createRow(newRecord, oldRecord, sparse, opportunityId, typeId, formId);

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
        afterSubmit: afterSubmit
    };
});
