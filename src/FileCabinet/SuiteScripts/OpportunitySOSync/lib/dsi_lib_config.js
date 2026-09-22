/**
 * dsi_lib_config.js
 *
 * Shared configuration module for the Design Instruction feature. The only module in that
 * feature that knows a NetSuite script ID, and the only one that reads its script parameters.
 * The Design Instruction scripts import from here rather than restating an ID.
 *
 * SEPARATE FROM opsync_lib_config.js, DELIBERATELY. That module belongs to the Opportunity ->
 * Sales Order sync and resolves parameters only for the sync's own two scripts — loading it from
 * a Design Instruction script would throw OPPSYNC_SCRIPT_NOT_MAPPED on the first parameter read.
 * This module mirrors its structure and conventions and neither imports nor modifies it. The
 * value-shape helpers ARE shared: the Design Instruction scripts import opsync_lib_values.js
 * directly, so there is one definition of what a select, a date or a presence flag means.
 *
 * Shared AMD module: no script record and no deployment record is required. It must be uploaded
 * to the File Cabinet before any Design Instruction script, which will otherwise fail at load
 * time.
 *
 * LOADED BY THE CLIENT SCRIPT TOO. dsi_cs_opportunity.js imports this module for its constants
 * and for findRows(), so every module in the define() below must stay one that client scripts
 * can load — N/runtime, N/search, N/error and N/log all are. The client script never calls a
 * parameter accessor: parameters are read on the server in beforeLoad and handed over in hidden
 * fields.
 *
 * ⚠️ UNVERIFIED BEFORE DEPLOYMENT — the client must confirm both:
 *
 *   1. NAME_PARTS. That custbody_mi_opp_fc, custbody_comm_area_ufh and custbody_mi_heat_source
 *      exist and apply to the Opportunity. Their TYPE no longer matters: the name is built from a
 *      search.lookupFields result, which returns a select as [{value, text}] and a text field as
 *      a string, and the builder reads whichever shape arrives. But a field that does not apply
 *      to the Opportunity reads as blank rather than erroring (docs/context.md section 0, trap
 *      6), and a field id that does not exist at all fails the lookup — and with it the row.
 *   2. NAME_MAX_LENGTH. The maximum length of the custom record's name field. 83 is assumed.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * See docs/context.md section 11 for the design this module serves.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.3.0
 */
define(['N/runtime', 'N/search', 'N/error', 'N/log'], function (runtime, search, error, log) {

    'use strict';

    var VERSION = '1.3.0';

    /* ------------------------------------------------------------------------------------------
     * NETSUITE IDS — THE SINGLE SOURCE FOR THIS FEATURE
     *
     * Every value below is a SCRIPT ID or a native NetSuite id, identical in Sandbox and
     * Production. No numeric internal ID appears in this file: sub-status ids, design type ids,
     * the form's internal id — all of them arrive through the script parameters below. See
     * docs/context.md section 3; the rule has no exceptions.
     *
     * The Design Instruction form is addressed ONLY by its internal id, from
     * custscript_dsi_form_id. Its script ID is not written here: it is not needed by the code,
     * and the auto-assigned form script ID embeds the account number, which section 3 lists as
     * never committable.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Prefix on every log title raised by the Design Instruction scripts. Build every title with
     * logKey() rather than writing the prefix out. Distinct from the sync's OPPSYNC_ so the two
     * features can be filtered apart in the execution log.
     * @type {string}
     */
    var LOG_PREFIX = 'DSI_';

    /**
     * Record type script IDs.
     * @type {Object}
     */
    var RECORD_TYPES = {
        OPPORTUNITY: 'opportunity',
        /** "Design Instruction". A child of the Opportunity, shown as a sublist on it. */
        DESIGN_INSTRUCTION: 'customrecord_cad_worklist'
    };

    /**
     * Custom list script IDs.
     * @type {Object}
     */
    var LISTS = {
        /**
         * The design type list behind custrecord_cad_design_type. Read by search.lookupFields to
         * turn a type id into its name for the row name — see the Design Instruction user event.
         */
        DESIGN_TYPE: 'customlist_runner_etc'
    };

    /**
     * Hidden fields that beforeLoad adds to the opportunity's VIEW form, carrying the ids the
     * client script needs. The client script contains no id: everything it writes arrives here.
     * Shared by both sides so the two cannot disagree on a field id.
     * @type {Object}
     */
    var HIDDEN_FIELDS = {
        /** The sub-status Request Design writes — custscript_dsi_btn_design_target. */
        STATUS_DESIGN: 'custpage_dsi_status_design',
        /** The sub-status Request Redraw writes — custscript_dsi_btn_redraw_target. */
        STATUS_REDRAW: 'custpage_dsi_status_redraw',
        /** The design type of the row Request Redraw lands on — custscript_dsi_redraw_type. */
        TYPE_REDRAW: 'custpage_dsi_type_redraw'
    };

    /**
     * Field script IDs on the Opportunity.
     * @type {Object}
     */
    var OPPORTUNITY_FIELDS = {
        /**
         * List -> customlist_opp_sub_status_list. The design stage. Read to decide whether a row
         * is created; WRITTEN by the Design Instruction user event when a row is completed.
         */
        SUB_STATUS: 'custbody_opportunity_sub_status',
        /** Native. The customer. Copied to the row. */
        CUSTOMER: 'entity',
        /** Native. The sales rep. Copied to the row. */
        SALES_REP: 'salesrep',
        /** The project engineer. Copied to the row. */
        PROJECT_ENGINEER: 'custbody_pe',
        /**
         * Checkbox. Priority design. Copied to the row as its urgent flag; CLEARED on the
         * opportunity by every completion, not only the last.
         */
        PRIORITY_DESIGN: 'custbody_priority_design_box',
        /** Native. The opportunity number. First segment of the row name. */
        TRAN_ID: 'tranid',
        /** Row name part 1. Existence on the Opportunity UNCONFIRMED — see NAME_PARTS. */
        MI_OPP_FC: 'custbody_mi_opp_fc',
        /** Row name part 2. Existence on the Opportunity UNCONFIRMED — see NAME_PARTS. */
        COMM_AREA_UFH: 'custbody_comm_area_ufh',
        /** Row name part 3. Existence on the Opportunity UNCONFIRMED — see NAME_PARTS. */
        MI_HEAT_SOURCE: 'custbody_mi_heat_source'
    };

    /**
     * Field script IDs on the Design Instruction row.
     * @type {Object}
     */
    var ROW_FIELDS = {
        /**
         * The parent opportunity. A SOURCED field on the record. Set directly with setValue, as
         * the SS1.0 predecessor did with setFieldValue — whether the value survives the save must
         * be confirmed in Sandbox. See docs/context.md section 11.
         */
        OPPORTUNITY: 'custrecord_cad_opportunity',
        CUSTOMER: 'custrecord_cad_customer',
        SALES_REP: 'custrecord_sales_rep',
        PROJECT_ENGINEER: 'custrecord_cad_proj_eng',
        /** List -> customlist_runner_etc. New design, Redraw or Cancelled. */
        DESIGN_TYPE: 'custrecord_cad_design_type',
        /** Checkbox, from the opportunity's priority design box. */
        URGENT: 'custrecord_urgent_design',
        /**
         * Native custom record name. Built by the opportunity user event, which MUST set it: the
         * record definition has auto-numbering off and the name field included — read from the
         * record XML, not yet verified in Sandbox.
         */
        NAME: 'name',
        /** Date. Stamped with today when DESIGNER is first filled in. */
        DESIGN_START: 'custrecord_cad_design_start',
        /**
         * WHO COMPLETED THE DESIGN — labelled "CAD completed by" on the 2026 form. The ONLY field
         * the completion gate requires, and the field the design start stamp watches.
         *
         * ⚠️ THE ID DOES NOT DESCRIBE WHAT IT HOLDS. It reads "BoM completed by"; on this record it
         * holds the designer. That is the client's decision (24 Sep 2026): the script follows the
         * form in use, and the form carries this field, not custrecord_cad_designer. Do not
         * "correct" it to custrecord_cad_designer — that field still exists on the record, is not
         * on the form, and is NOT read by this feature. Reading it is the defect Sandbox found:
         * every completion refused, with the form filled in.
         */
        DESIGNER: 'custrecord_cw_bom_completed_by',
        /**
         * Area in m². NOT READ BY ANY SCRIPT since 24 Sep 2026 — the client removed it from the
         * completion gate. Listed as documentation of a field the form carries.
         */
        AREA: 'custrecord_cad_area',
        /**
         * Designer notes — labelled "Designer Notes" on the 2026 form. NOT READ BY ANY SCRIPT since
         * 24 Sep 2026 — the client removed it from the completion gate. Listed as documentation.
         *
         * ⚠️ THE ID DOES NOT DESCRIBE WHAT IT HOLDS. It reads "EASE designer notes"; on this record
         * it holds the designer's notes. The form carries this field, so it is the one recorded
         * here — the client's decision to match the form in use. custrecord_cad_notes still exists
         * on the record, is not on the form, and is NOT read by this feature.
         */
        NOTES: 'custrecord_ease_designer_notes',
        /** Date. Entering it is what completes the row — there is no status field or button. */
        COMPLETED: 'custrecord_cad_completed',
        /**
         * The redraw reason. Entered BY HAND — no script reads or writes it. Listed so the field
         * is recorded here with the others; the user is landed on the row to fill it in.
         */
        REDRAW_INFO: 'custrecord_redraw_info',
        /** Native. The entry form, set through record.create's defaultValues. */
        CUSTOM_FORM: 'customform'
    };

    /**
     * The three opportunity fields that make up the tail of the row name, in order.
     *
     * Field ids only. There is no per-field type flag: they are read through search.lookupFields,
     * and the name builder uses a select's text or a text field's value according to the shape
     * that arrives. ⚠️ Their existence on the Opportunity is UNCONFIRMED — see the file header.
     *
     * @type {string[]}
     */
    var NAME_PARTS = [
        OPPORTUNITY_FIELDS.MI_OPP_FC,
        OPPORTUNITY_FIELDS.COMM_AREA_UFH,
        OPPORTUNITY_FIELDS.MI_HEAT_SOURCE
    ];

    /**
     * Maximum length of the Design Instruction's name field. The built name is truncated to it.
     *
     * ⚠️ UNVERIFIED. 83 is an assumption, not a value read from the account. A cap that is too
     * high lets the save fail on a long name; a cap that is too low merely shortens names.
     * Confirm it against the record definition before deployment.
     *
     * @type {number}
     */
    var NAME_MAX_LENGTH = 83;

    /**
     * Upper bound on the rows findRows() returns. NOT a NetSuite internal id — a row count.
     * @type {number}
     */
    var FIND_ROWS_LIMIT = 50;

    /**
     * Entry-point script IDs that read parameters through this module.
     *
     * The client script dsi_cs_opportunity.js is not here, and has no script record at all: it
     * is attached by form.clientScriptModulePath and reads no parameters.
     * @type {Object}
     */
    var SCRIPTS = {
        UE_OPPORTUNITY: 'customscript_dsi_ue_opportunity',
        UE_DESIGN_INSTRUCTION: 'customscript_dsi_ue_design_instruction'
    };

    /* ------------------------------------------------------------------------------------------
     * SCRIPT PARAMETER IDS, PER SCRIPT
     *
     * A script parameter is a custom field, and custom field IDs are UNIQUE ACROSS THE ACCOUNT.
     * Two script records therefore cannot share one, which is why the two Design Instruction
     * scripts carry different prefixes — dsi_ on the opportunity script, dsirow_ on the row
     * script. The same constraint produced the opsync_/sosync_ pair; see docs/context.md
     * section 4.
     *
     * ⚠️ ONE PAIR MUST HOLD THE SAME VALUE, and nothing in NetSuite relates them:
     *
     *   custscript_dsi_complete_status   ==   custscript_dsirow_complete_status
     *
     * The row script WRITES its value to the opportunity on completion. The opportunity script
     * reads its own copy only to refuse a creation map that would create a row at that same
     * status — the overlap check. If the two diverge, the check tests the wrong value.
     *
     * THE PAIR HAS TWO LOGICAL KEYS, NOT ONE — OVERLAP_STATUS and COMPLETE_STATUS — because
     * empty means different things on the two scripts: the overlap check throws, the write-back
     * fails closed. With one key, either accessor would silently work from the wrong script;
     * with two, calling the wrong one throws DSI_PARAMETER_NOT_ON_SCRIPT.
     *
     * THE MAP IS EXPLICIT, as in opsync_lib_config.js: no derivation from the script id and no
     * fallback to another script's parameter. A new script means a new row here.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Logical parameter key -> the real parameter ID, per executing script.
     *
     *   CREATE_MAP            sub-status id -> design type id pairs. Which sub-statuses create
     *                         a row, and of which type
     *   FORM_ID               internal id of the Design Instruction entry form
     *   OVERLAP_STATUS        the completion sub-status, as the OPPORTUNITY script knows it —
     *                         for the overlap check only
     *   BTN_DESIGN_STATUSES   sub-statuses at which Request Design is shown
     *   BTN_REDRAW_STATUSES   sub-statuses at which Request Redraw is shown
     *   BTN_DESIGN_TARGET     the sub-status Request Design writes
     *   BTN_REDRAW_TARGET     the sub-status Request Redraw writes
     *   REDRAW_TYPE           the design type of the row Request Redraw lands the user on
     *   COMPLETE_STATUS       the completion sub-status, as the ROW script writes it
     *   CANCELLED_TYPES       design type ids treated as cancelled
     *
     * What each does when empty is in the accessor block below.
     *
     * All values are set on the DEPLOYMENT, so each environment carries its own and no internal
     * id appears in code.
     * @type {Object}
     */
    var SCRIPT_PARAMETERS = {
        'customscript_dsi_ue_opportunity': {
            CREATE_MAP: 'custscript_dsi_create_map',
            FORM_ID: 'custscript_dsi_form_id',
            OVERLAP_STATUS: 'custscript_dsi_complete_status',
            BTN_DESIGN_STATUSES: 'custscript_dsi_btn_design_statuses',
            BTN_REDRAW_STATUSES: 'custscript_dsi_btn_redraw_statuses',
            BTN_DESIGN_TARGET: 'custscript_dsi_btn_design_target',
            BTN_REDRAW_TARGET: 'custscript_dsi_btn_redraw_target',
            REDRAW_TYPE: 'custscript_dsi_redraw_type'
        },
        'customscript_dsi_ue_design_instruction': {
            COMPLETE_STATUS: 'custscript_dsirow_complete_status',
            CANCELLED_TYPES: 'custscript_dsirow_cancelled_type'
        }
    };

    /**
     * Builds a log title. Every Design Instruction log title is built here, so the prefix cannot
     * drift between scripts.
     *
     * @param {string} suffix - e.g. 'ROW_CREATED'
     * @returns {string} e.g. 'DSI_ROW_CREATED'
     */
    function logKey(suffix) {
        return LOG_PREFIX + String(suffix);
    }

    /**
     * Resolves a logical parameter key to the real parameter ID for the EXECUTING script.
     *
     * Same contract as opsync_lib_config.resolveParameterId, and for the same reasons. Both
     * failures are CODING or DEPLOYMENT errors that no parameter value could fix, so both throw
     * rather than failing closed:
     *
     *   UNKNOWN SCRIPT   the executing script has no row in SCRIPT_PARAMETERS
     *   WRONG SCRIPT     the script has a row but does not define this key — e.g. getFormId()
     *                    reached from the row script, which has no form parameter
     *
     * @param {string} key - a key from SCRIPT_PARAMETERS
     * @param {string} accessor - the calling accessor's name, for the error message only
     * @returns {string} the parameter ID for the currently executing script
     * @throws {Error} DSI_SCRIPT_NOT_MAPPED or DSI_PARAMETER_NOT_ON_SCRIPT
     */
    function resolveParameterId(key, accessor) {
        var scriptId;
        var forScript;

        try {
            scriptId = String(runtime.getCurrentScript().id).toLowerCase();
        } catch (e) {
            scriptId = '';
        }

        forScript = SCRIPT_PARAMETERS.hasOwnProperty(scriptId) ? SCRIPT_PARAMETERS[scriptId] : null;

        if (!forScript) {
            log.error({
                title: logKey('SCRIPT_NOT_MAPPED'),
                details: 'Script "' + scriptId + '" is not listed in SCRIPT_PARAMETERS in ' +
                    'dsi_lib_config.js, so none of its parameter IDs can be resolved and nothing ' +
                    'was read. Add its row with its OWN parameter IDs — they are account-unique ' +
                    'and cannot be shared. See docs/context.md section 11.'
            });
            throw error.create({
                name: logKey('SCRIPT_NOT_MAPPED'),
                message: 'Script "' + scriptId + '" has no parameter map in dsi_lib_config.js.',
                notifyOff: true
            });
        }

        if (!forScript.hasOwnProperty(key)) {
            log.error({
                title: logKey('PARAMETER_NOT_ON_SCRIPT'),
                details: accessor + '() asked for the ' + key + ' parameter, but script "' +
                    scriptId + '" does not define one. That script defines: ' +
                    Object.keys(forScript).join(', ') + '. This is a coding error — do not ' +
                    '"fix" it on the deployment, where the field does not exist.'
            });
            throw error.create({
                name: logKey('PARAMETER_NOT_ON_SCRIPT'),
                message: accessor + '() is not available to script "' + scriptId +
                    '": it defines no ' + key + ' parameter.',
                notifyOff: true
            });
        }

        return forScript[key];
    }

    /**
     * Trims leading and trailing whitespace.
     *
     * @param {*} value
     * @returns {string} '' for null or undefined
     */
    function trim(value) {
        if (value === null || value === undefined) {
            return '';
        }
        return String(value).replace(/^\s+|\s+$/g, '');
    }

    /**
     * True when the text is a plain non-negative integer — the shape every NetSuite internal id
     * takes. Anything else in an id parameter is a typo, and must never be written to a record.
     *
     * @param {string} text
     * @returns {boolean}
     */
    function isIdText(text) {
        return /^[0-9]+$/.test(text);
    }

    /**
     * Reads a parameter as trimmed text. Never throws: an unreadable parameter reads as ''.
     * Whether '' is then an error, a throw or a quiet default is the ACCESSOR's decision, made by
     * the section 5 test — what does empty mean.
     *
     * @param {string} parameterId
     * @returns {string}
     */
    function readParameter(parameterId) {
        try {
            return trim(runtime.getCurrentScript().getParameter({ name: parameterId }));
        } catch (e) {
            return '';
        }
    }

    /**
     * Logs an unset or unusable parameter, naming what the emptiness means.
     *
     * At ERROR unless the caller says otherwise. The one exception is a button's target: an
     * absent button is visible to every user, so it does not need the error level to be noticed,
     * and at error it would fill the log on every view of every opportunity.
     *
     * @param {string} parameterId
     * @param {string} consequence - what the script does, or does not do, as a result
     * @param {string} [level] - 'debug' or 'error'; defaults to 'error'
     */
    function logMissing(parameterId, consequence, level) {
        var entry = {
            title: logKey('PARAMETER_MISSING'),
            details: 'Script parameter ' + parameterId + ' is not set or holds nothing usable. ' +
                consequence + ' Populate it on the deployment in this account — its value is ' +
                'an internal id and differs by environment. See docs/context.md section 11.'
        };

        // Called as methods of log, never detached from it: a throw here would land inside the
        // path that reports missing configuration, and hide the very message it exists to give.
        if (level === 'debug') {
            log.debug(entry);
        } else {
            log.error(entry);
        }
    }

    /**
     * Splits a comma-separated parameter into trimmed, non-empty entries. A trailing or doubled
     * comma is not worth an error line.
     *
     * @param {string} raw
     * @returns {string[]}
     */
    function splitEntries(raw) {
        var parts = raw.split(',');
        var entries = [];
        var i;
        var entry;

        for (i = 0; i < parts.length; i += 1) {
            entry = trim(parts[i]);
            if (entry !== '') {
                entries.push(entry);
            }
        }

        return entries;
    }

    /**
     * Logs one entry that is not the shape its parameter requires. The entry is skipped and the
     * rest of the parameter still applies — one typo must not disable the whole feature.
     *
     * @param {string} parameterId
     * @param {string} entry
     * @param {string} expected - e.g. 'a whole number'
     */
    function logInvalidEntry(parameterId, entry, expected) {
        log.error({
            title: logKey('INVALID_ENTRY'),
            details: 'Entry "' + entry + '" in ' + parameterId + ' is not ' + expected + '. It ' +
                'was skipped; the rest of the parameter still applies. Correct it on the ' +
                'deployment.'
        });
    }

    /**
     * Parses a comma-separated list of internal ids. Same contract as
     * opsync_lib_config.parseStatusMap — forgiving about SHAPE, unforgiving about MEANING:
     * whitespace trimmed, empty entries ignored, a non-numeric entry logged and skipped.
     *
     * A repeated id is not ambiguous in a list — it says the same thing twice — so it is kept
     * once, silently. Contrast parseIdMap(), where a repeated KEY is.
     *
     * Never throws. Returns [] when nothing usable remains; the caller decides what that means.
     *
     * @param {string} parameterId
     * @returns {string[]}
     */
    function parseIdList(parameterId) {
        var entries = splitEntries(readParameter(parameterId));
        var ids = [];
        var seen = {};
        var i;

        for (i = 0; i < entries.length; i += 1) {
            if (!isIdText(entries[i])) {
                logInvalidEntry(parameterId, entries[i], 'a whole number');
            } else if (!seen.hasOwnProperty(entries[i])) {
                seen[entries[i]] = true;
                ids.push(entries[i]);
            }
        }

        return ids;
    }

    /**
     * Parses comma-separated key:value pairs of internal ids into a plain object. Same contract
     * as opsync_lib_config.parseStatusMap:
     *
     *   - whitespace around any element is trimmed, because someone will paste with spaces;
     *   - empty entries are ignored, so a trailing comma is harmless;
     *   - a pair that will not parse — no colon, two colons, either side not a whole number —
     *     is logged and SKIPPED, and the remaining pairs still apply;
     *   - a DUPLICATE key is logged and DROPPED ENTIRELY. Not the first, not the last: there is
     *     no way to tell which of two conflicting rows was meant, and creating a row of the wrong
     *     type is worse than creating none. Dropped in a second pass, so a key repeated three
     *     times is not rescued by being first.
     *
     * Never throws. Returns {} when nothing usable remains; the caller decides what that means.
     *
     * @param {string} parameterId
     * @returns {Object} key id -> value id
     */
    function parseIdMap(parameterId) {
        var entries = splitEntries(readParameter(parameterId));
        var map = {};
        var duplicates = {};
        var i;
        var halves;
        var key;
        var value;

        for (i = 0; i < entries.length; i += 1) {
            halves = entries[i].split(':');
            key = halves.length === 2 ? trim(halves[0]) : '';
            value = halves.length === 2 ? trim(halves[1]) : '';

            if (!isIdText(key) || !isIdText(value)) {
                logInvalidEntry(parameterId, entries[i], 'a key:value pair of whole numbers');
            } else if (map.hasOwnProperty(key)) {
                duplicates[key] = true;
            } else {
                map[key] = value;
            }
        }

        Object.keys(duplicates).forEach(function (duplicateKey) {
            log.error({
                title: logKey('MAP_AMBIGUOUS'),
                details: 'Key ' + duplicateKey + ' appears more than once in ' + parameterId +
                    '. The whole entry was dropped rather than guessing which was meant, so ' +
                    'that key now resolves to nothing. Remove the duplicate on the deployment.'
            });
            delete map[duplicateKey];
        });

        return map;
    }

    /**
     * Reads a parameter holding ONE internal id.
     *
     * @param {string} parameterId
     * @returns {string} the id, or '' when unset or not a whole number — never throws
     */
    function parseSingleId(parameterId) {
        var raw = readParameter(parameterId);

        if (raw !== '' && !isIdText(raw)) {
            logInvalidEntry(parameterId, raw, 'a single whole number');
            return '';
        }

        return raw;
    }

    /**
     * Reads a parameter holding ONE internal id that MUST be present.
     *
     * @param {string} parameterId
     * @param {string} consequence - what cannot happen without it, for the log
     * @returns {string}
     * @throws {Error} DSI_PARAMETER_MISSING when unset or not a whole number
     */
    function requiredSingleId(parameterId, consequence) {
        var id = parseSingleId(parameterId);

        if (id === '') {
            logMissing(parameterId, consequence);
            throw error.create({
                name: logKey('PARAMETER_MISSING'),
                message: 'Required script parameter ' + parameterId + ' is not set.',
                notifyOff: true
            });
        }

        return id;
    }

    /* ------------------------------------------------------------------------------------------
     * THE ACCESSORS — AND WHAT EMPTY MEANS FOR EACH
     *
     * The test is the one in docs/context.md section 5: not "how important is this parameter",
     * but WHAT DOES EMPTY MEAN — does the script do less, or more?
     *
     * Opportunity script, afterSubmit:
     *
     *   getCreateMap()          empty: no rows are created. Less. Fails closed: logs, returns {}.
     *   getFormId()             empty: a row would be created on no form, which is unusable.
     *                           THROWS.
     *   getOverlapStatus()      empty: the overlap check cannot run, and creating without it is
     *                           a safety check removed — MORE. THROWS, so no row is created
     *                           until the parameter is set.
     *
     * Opportunity script, beforeLoad — which must never stop the record displaying, so nothing
     * here throws:
     *
     *   getBtnDesignStatuses()  empty: Request Design is never shown. Less. Fails closed: logs at
     *   getBtnRedrawStatuses()  error, returns [].
     *   getBtnDesignTarget()    empty: that button is never shown. Less. Fails closed, and logs
     *   getBtnRedrawTarget()    at DEBUG — see logMissing().
     *   getRedrawType()         empty: Request Redraw still writes its status, but cannot find
     *                           the new row, so it reloads the page instead of landing on it.
     *                           Less. Fails closed: logs at error, returns ''.
     *
     * Row script:
     *
     *   getCompleteStatus()     empty: completion writes nothing. Less. Fails closed: logs,
     *                           returns ''. Not a throw — the row has already saved.
     *   getCancelledTypes()     empty: no type is treated as cancelled. In beforeSubmit that is
     *                           MORE restriction (the gate applies to every row); in afterSubmit
     *                           it is MORE writing (a cancelled row's completion moves the
     *                           opportunity). Left as a logged configuration error by the
     *                           client's decision, now that the value has been supplied.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Which opportunity sub-statuses create a row, and of which design type.
     *
     * @returns {Object} sub-status id -> design type id; {} when unset, which creates nothing
     */
    function getCreateMap() {
        var parameterId = resolveParameterId('CREATE_MAP', 'getCreateMap');
        var map = parseIdMap(parameterId);

        if (Object.keys(map).length === 0) {
            logMissing(parameterId, 'No sub-status can create a Design Instruction, so none ' +
                'will be created.');
        }

        return map;
    }

    /**
     * Internal id of the Design Instruction entry form.
     *
     * REQUIRED — throws when unset or not a whole number. A row created on the wrong form is not
     * a smaller version of the feature, it is a row nobody can work with.
     *
     * @returns {string}
     * @throws {Error} DSI_PARAMETER_MISSING
     */
    function getFormId() {
        return requiredSingleId(resolveParameterId('FORM_ID', 'getFormId'),
            'A Design Instruction cannot be created without its form, so none was.');
    }

    /**
     * The completion sub-status, as the OPPORTUNITY script holds it — for the overlap check
     * only. Must equal custscript_dsirow_complete_status.
     *
     * REQUIRED — throws when unset. Without it the overlap check cannot run, and creating rows
     * with a safety check silently removed is the fail-open case section 5 forbids.
     *
     * @returns {string}
     * @throws {Error} DSI_PARAMETER_MISSING
     */
    function getOverlapStatus() {
        return requiredSingleId(resolveParameterId('OVERLAP_STATUS', 'getOverlapStatus'),
            'The check that the creation map never creates a row at the completion status ' +
            'cannot run, so no Design Instruction was created.');
    }

    /**
     * Reads a button's visibility list.
     *
     * @param {string} key
     * @param {string} accessor
     * @param {string} label - the button's label, for the log
     * @returns {string[]} [] when unset — the button is never shown
     */
    function buttonStatuses(key, accessor, label) {
        var parameterId = resolveParameterId(key, accessor);
        var ids = parseIdList(parameterId);

        if (ids.length === 0) {
            logMissing(parameterId, 'The ' + label + ' button is never shown.');
        }

        return ids;
    }

    /**
     * Reads a button's target sub-status.
     *
     * @param {string} key
     * @param {string} accessor
     * @param {string} label - the button's label, for the log
     * @returns {string} '' when unset — the button is never shown. Logged at DEBUG
     */
    function buttonTarget(key, accessor, label) {
        var parameterId = resolveParameterId(key, accessor);
        var id = parseSingleId(parameterId);

        if (id === '') {
            logMissing(parameterId, 'The ' + label + ' button has no sub-status to write, so it ' +
                'is not shown.', 'debug');
        }

        return id;
    }

    /**
     * Sub-statuses at which the Request Design button is shown.
     * @returns {string[]} [] when unset
     */
    function getBtnDesignStatuses() {
        return buttonStatuses('BTN_DESIGN_STATUSES', 'getBtnDesignStatuses', 'Request Design');
    }

    /**
     * Sub-statuses at which the Request Redraw button is shown.
     * @returns {string[]} [] when unset
     */
    function getBtnRedrawStatuses() {
        return buttonStatuses('BTN_REDRAW_STATUSES', 'getBtnRedrawStatuses', 'Request Redraw');
    }

    /**
     * The sub-status the Request Design button writes — Design Required.
     * @returns {string} '' when unset
     */
    function getBtnDesignTarget() {
        return buttonTarget('BTN_DESIGN_TARGET', 'getBtnDesignTarget', 'Request Design');
    }

    /**
     * The sub-status the Request Redraw button writes — Redraw Required.
     * @returns {string} '' when unset
     */
    function getBtnRedrawTarget() {
        return buttonTarget('BTN_REDRAW_TARGET', 'getBtnRedrawTarget', 'Request Redraw');
    }

    /**
     * The design type of the row Request Redraw lands the user on — Redraw.
     *
     * @returns {string} '' when unset — the button still writes its status, and the client
     *          script reloads the page rather than landing on the row
     */
    function getRedrawType() {
        var parameterId = resolveParameterId('REDRAW_TYPE', 'getRedrawType');
        var id = parseSingleId(parameterId);

        if (id === '') {
            logMissing(parameterId, 'Request Redraw still writes its sub-status, but cannot find ' +
                'the new row, so it reloads the page instead of opening the row.');
        }

        return id;
    }

    /**
     * The sub-status a completed row moves the opportunity to — Post Design Check — as the ROW
     * script holds it. Must equal custscript_dsi_complete_status.
     *
     * @returns {string} the id, or '' when unset — never throws
     */
    function getCompleteStatus() {
        var parameterId = resolveParameterId('COMPLETE_STATUS', 'getCompleteStatus');
        var status = parseSingleId(parameterId);

        if (status === '') {
            logMissing(parameterId, 'A completed Design Instruction writes nothing to its ' +
                'opportunity.');
        }

        return status;
    }

    /**
     * Design type ids treated as cancelled. A cancelled row skips the completion gate and its
     * completion writes nothing to the opportunity.
     *
     * @returns {string[]} [] when unset — no type is treated as cancelled. Never throws
     */
    function getCancelledTypes() {
        var parameterId = resolveParameterId('CANCELLED_TYPES', 'getCancelledTypes');
        var types = parseIdList(parameterId);

        if (types.length === 0) {
            logMissing(parameterId, 'No design type is treated as cancelled: every row must ' +
                'pass the completion gate, and every completion writes to the opportunity.');
        }

        return types;
    }

    /**
     * Finds the Design Instruction rows on an opportunity, newest first.
     *
     * @param {string} opportunityId
     * @param {string} [typeId] - when given, only rows of that design type
     * @returns {Array.<{id: string, completed: *}>} at most FIND_ROWS_LIMIT rows
     */
    function findRows(opportunityId, typeId) {
        var filters = [[ROW_FIELDS.OPPORTUNITY, 'anyof', opportunityId]];
        var rows = [];

        if (typeId !== null && typeId !== undefined && String(typeId) !== '') {
            filters.push('AND');
            filters.push([ROW_FIELDS.DESIGN_TYPE, 'anyof', typeId]);
        }

        search.create({
            type: RECORD_TYPES.DESIGN_INSTRUCTION,
            filters: filters,
            columns: [
                search.createColumn({ name: 'created', sort: search.Sort.DESC }),
                'internalid',
                ROW_FIELDS.COMPLETED
            ]
        }).run().getRange({ start: 0, end: FIND_ROWS_LIMIT }).forEach(function (result) {
            rows.push({
                id: String(result.id),
                completed: result.getValue({ name: ROW_FIELDS.COMPLETED })
            });
        });

        return rows;
    }

    return {
        VERSION: VERSION,
        LOG_PREFIX: LOG_PREFIX,
        RECORD_TYPES: RECORD_TYPES,
        LISTS: LISTS,
        HIDDEN_FIELDS: HIDDEN_FIELDS,
        OPPORTUNITY_FIELDS: OPPORTUNITY_FIELDS,
        ROW_FIELDS: ROW_FIELDS,
        NAME_PARTS: NAME_PARTS,
        NAME_MAX_LENGTH: NAME_MAX_LENGTH,
        SCRIPTS: SCRIPTS,
        SCRIPT_PARAMETERS: SCRIPT_PARAMETERS,
        logKey: logKey,
        resolveParameterId: resolveParameterId,
        getCreateMap: getCreateMap,
        getFormId: getFormId,
        getOverlapStatus: getOverlapStatus,
        getBtnDesignStatuses: getBtnDesignStatuses,
        getBtnRedrawStatuses: getBtnRedrawStatuses,
        getBtnDesignTarget: getBtnDesignTarget,
        getBtnRedrawTarget: getBtnRedrawTarget,
        getRedrawType: getRedrawType,
        getCompleteStatus: getCompleteStatus,
        getCancelledTypes: getCancelledTypes,
        findRows: findRows
    };
});
