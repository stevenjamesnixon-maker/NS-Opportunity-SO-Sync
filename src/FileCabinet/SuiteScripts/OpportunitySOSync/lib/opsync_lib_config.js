/**
 * opsync_lib_config.js
 *
 * Shared configuration module for the Opportunity -> Sales Order sync. This is the only module
 * in the project that knows a NetSuite script ID, and the only module that reads
 * customrecord_fin_stat or the deployment's script parameters. Every other script imports from
 * here rather than restating an ID or running its own search.
 *
 * Shared AMD module: no script record and no deployment record is required. It must be uploaded
 * to the File Cabinet before any entry-point script, which will otherwise fail at load time.
 *
 * House style is ES5 throughout — var, function, 'use strict'. This is a deliberate convention
 * for consistency across the project, not a limitation of SuiteScript 2.1. Do not modernise it.
 *
 * See docs/context.md for the design constraints this module exists to serve.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/search', 'N/runtime', 'N/log'], function (search, runtime, log) {

    'use strict';

    var VERSION = '1.0.0';

    /* ------------------------------------------------------------------------------------------
     * NETSUITE IDS — THE SINGLE SOURCE
     *
     * Every value below is a SCRIPT ID or a native NetSuite id. Script IDs are chosen by the
     * developer and are identical in Sandbox and Production, which is why they are safe to
     * commit.
     *
     * No numeric internal ID appears anywhere in this file, or in any other file in this repo.
     * Status ids, list option ids and record ids are assigned per account and differ between
     * environments: they are read at runtime from the script parameters and from
     * customrecord_fin_stat. See docs/context.md section 3 — the rule has no exceptions.
     *
     *   Purpose                            Script ID                              Type
     *   ---------------------------------- -------------------------------------- ------------------
     *   Record Status custom record        customrecord_fin_stat                  Custom record
     *   Record Status: mapped sub-statuses custrecord_fin_stat_opp_sub_status     Multiple Select
     *   Opportunity: design sub-status     custbody_opportunity_sub_status        List
     *   Opportunity: delivery date         custbody_opp_del_date                  Date
     *   Sales Order: Record Status         custbody_finance_status                List/Record
     *   Sales Order: expected ship date    custbody_defaultshipdate               Date
     *   Sales Order -> Opportunity link    opportunity                            Native field
     *
     * Both the sub-status field on the Opportunity and the mapping multi-select on the Record
     * Status record source the same list, customlist_opp_sub_status_list, so both store the same
     * option internal IDs. Comparison between them is therefore ID-to-ID and needs no text
     * normalisation. See docs/context.md section 0, trap 4.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Prefix on every log title raised anywhere in this project, so the execution log can be
     * filtered on one string. Build every title with logKey() rather than writing the prefix out.
     * @type {string}
     */
    var LOG_PREFIX = 'OPPSYNC_';

    /**
     * Upper bound on the Record Status records read when resolving one sub-status.
     *
     * NOT a NetSuite internal id — this is a result-set bound. A correct configuration returns
     * exactly one record and a broken one returns two; the bound exists so that a search which
     * somehow matches far more cannot run away, not because a real mapping approaches it.
     *
     * @type {number}
     */
    var MAX_MAPPING_MATCHES = 1000;

    /**
     * Record type script IDs.
     * @type {Object}
     */
    var RECORD_TYPES = {
        /** The Record Status custom record. Holds the mapping — see MAPPING_FIELDS. */
        RECORD_STATUS: 'customrecord_fin_stat',
        /** Native sales order record type, as used in a search. */
        SALES_ORDER: 'salesorder'
    };

    /**
     * Field script IDs on customrecord_fin_stat.
     * @type {Object}
     */
    var MAPPING_FIELDS = {
        /**
         * Multiple Select sourcing customlist_opp_sub_status_list: "opportunity sub-statuses
         * that map here". Each Record Status declares which sub-statuses feed it, so several
         * sub-statuses may map to one status without duplication and the rule is visible on the
         * record rather than in code.
         */
        OPP_SUB_STATUS: 'custrecord_fin_stat_opp_sub_status'
    };

    /**
     * Field script IDs read from the Opportunity.
     * @type {Object}
     */
    var OPPORTUNITY_FIELDS = {
        /** Native status field. Partly maintained by NetSuite itself — see docs/context.md §0. */
        ENTITY_STATUS: 'entitystatus',
        /** List sourcing customlist_opp_sub_status_list. The design stage. */
        SUB_STATUS: 'custbody_opportunity_sub_status',
        /** Date. Copied directly to the order's expected ship date. */
        DELIVERY_DATE: 'custbody_opp_del_date'
    };

    /**
     * Field script IDs read from and written to the Sales Order.
     * @type {Object}
     */
    var SALES_ORDER_FIELDS = {
        /** List/Record -> customrecord_fin_stat. Written only through the mapping, never raw. */
        RECORD_STATUS: 'custbody_finance_status',
        /** Date. Written from the opportunity's delivery date. */
        SHIP_DATE: 'custbody_defaultshipdate',
        /**
         * The link back to the Opportunity. The NATIVE opportunity field — not createdfrom.
         * Confirmed by Steve for Phase 2.
         */
        OPPORTUNITY_LINK: 'opportunity',
        /** Native search filter. Body-level rows only, so each order is returned once. */
        MAINLINE: 'mainline'
    };

    /**
     * Script parameter IDs. Both are set on the DEPLOYMENT, so Sandbox and Production carry
     * their own values and neither set of ids appears in code. See docs/context.md section 8.
     * @type {Object}
     */
    var PARAMETERS = {
        /** Free-Form Text. Comma-separated entitystatus ids that open the gate. */
        QUALIFYING_STATUSES: 'custscript_opsync_qualifying_statuses',
        /** Free-Form Text. Comma-separated Record Status ids that must not be overwritten. */
        EXCLUDED_STATUSES: 'custscript_opsync_excluded_statuses'
    };

    /* ------------------------------------------------------------------------------------------
     * NO CACHING
     *
     * getMappedStatus() runs a search on every call and nothing here is memoised. That is
     * deliberate, not an oversight. The mapping is configuration that people edit in the UI, and
     * a cache would risk resolving a sub-status against a mapping that was correct a moment ago
     * — writing a stale Record Status onto a sales order. One search per qualifying save is
     * trivial governance next to that risk.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Builds a log title. Every title in this project is built here, so the prefix cannot drift
     * between scripts and the execution log can be filtered on one string.
     *
     * @param {string} suffix - e.g. 'ORDER_UPDATED'
     * @returns {string} e.g. 'OPPSYNC_ORDER_UPDATED'
     */
    function logKey(suffix) {
        return LOG_PREFIX + String(suffix);
    }

    /**
     * Reads a value from a search.lookupFields result.
     *
     * Select and List/Record fields come back as an ARRAY of { value, text } objects, not as a
     * scalar — and an EMPTY list field comes back as an empty array. The predecessor script read
     * lookup.custbody_finance_status[0].value with no guard and therefore threw on every sales
     * order whose Record Status happened to be blank. Every array access on a lookup result in
     * this project goes through here. See docs/context.md section 5.
     *
     * @param {Object} lookup - a search.lookupFields result
     * @param {string} fieldId
     * @returns {string} the raw stored value, or '' when absent, empty or unset
     */
    function lookupValue(lookup, fieldId) {
        var raw;

        if (!lookup || !fieldId) {
            return '';
        }

        raw = lookup[fieldId];

        if (raw === null || raw === undefined) {
            return '';
        }

        // List/Record and Select fields: an array of { value, text }, empty when the field is
        // unset. Length is checked before indexing, every time.
        if (Object.prototype.toString.call(raw) === '[object Array]') {
            if (raw.length === 0) {
                return '';
            }
            if (raw[0] && raw[0].value !== null && raw[0].value !== undefined) {
                return String(raw[0].value);
            }
            return '';
        }

        return String(raw);
    }

    /**
     * Parses a comma-separated script parameter into an array of id strings.
     *
     * An empty or unparseable parameter is a CONFIGURATION ERROR, not a reason to proceed: it is
     * logged at error and an empty array is returned. Both callers fail safe on an empty array —
     * an empty qualifying list means the gate never opens, and an empty excluded list is
     * reported by the caller rather than treated as "nothing is protected".
     *
     * @param {string} parameterId
     * @returns {string[]} ids, or [] when the parameter is missing or empty
     */
    function parseIdListParameter(parameterId) {
        var raw;
        var parts;
        var ids = [];
        var i;
        var trimmed;

        try {
            raw = runtime.getCurrentScript().getParameter({ name: parameterId });
        } catch (e) {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Could not read script parameter ' + parameterId +
                    '. Is it defined on the script record and set on the deployment? ' + e
            });
            return [];
        }

        if (raw === null || raw === undefined || String(raw) === '') {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Script parameter ' + parameterId + ' is empty. It must be populated on ' +
                    'the deployment in this account — its value differs by environment. ' +
                    'See docs/context.md section 8.'
            });
            return [];
        }

        parts = String(raw).split(',');

        for (i = 0; i < parts.length; i += 1) {
            trimmed = parts[i].replace(/^\s+|\s+$/g, '');
            if (trimmed !== '') {
                ids.push(trimmed);
            }
        }

        if (ids.length === 0) {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Script parameter ' + parameterId + ' held no usable ids. Raw value: ' + raw
            });
        }

        return ids;
    }

    /**
     * The entitystatus values that open the gate, from the deployment's script parameter.
     *
     * @returns {string[]} ids as strings, or [] when unset — which closes the gate entirely
     */
    function getQualifyingStatuses() {
        return parseIdListParameter(PARAMETERS.QUALIFYING_STATUSES);
    }

    /**
     * The Record Statuses that must never be overwritten, from the deployment's script parameter.
     *
     * Design Cancelled maps to Cancelled and Cancelled is in this list, so an order that lands
     * there can never be moved again by this sync. That is a deliberate one-way door — see
     * docs/context.md section 6. Do not "fix" it by removing Cancelled from the parameter.
     *
     * @returns {string[]} ids as strings, or [] when unset
     */
    function getExcludedStatuses() {
        return parseIdListParameter(PARAMETERS.EXCLUDED_STATUSES);
    }

    /**
     * Resolves an opportunity sub-status to the Record Status that declares it.
     *
     * Searches customrecord_fin_stat for the ACTIVE record whose mapping multi-select contains
     * the given sub-status. The comparison is ID-to-ID: both fields source
     * customlist_opp_sub_status_list, so both hold the same option internal ids and no text
     * normalisation is involved.
     *
     * Two active records claiming one sub-status is a configuration error. This returns null and
     * logs OPPSYNC_MAPPING_AMBIGUOUS at error naming every match, rather than picking one.
     * Writing a wrong status onto a sales order is the failure this whole design exists to
     * prevent; leaving the order alone is recoverable, and the log names what to fix.
     *
     * No match is NOT an error — most sub-statuses are deliberately unmapped. It returns null
     * quietly and the caller stops.
     *
     * @param {string} subStatusId - a customlist_opp_sub_status_list option internal id
     * @returns {string|null} the Record Status internal id, or null
     */
    function getMappedStatus(subStatusId) {
        var matches = [];
        var results;

        if (subStatusId === null || subStatusId === undefined || String(subStatusId) === '') {
            return null;
        }

        results = search.create({
            type: RECORD_TYPES.RECORD_STATUS,
            filters: [
                [MAPPING_FIELDS.OPP_SUB_STATUS, 'anyof', String(subStatusId)],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: MAX_MAPPING_MATCHES });

        results.forEach(function (result) {
            matches.push(String(result.id));
        });

        if (matches.length === 0) {
            return null;
        }

        if (matches.length > 1) {
            log.error({
                title: logKey('MAPPING_AMBIGUOUS'),
                details: 'Opportunity sub-status ' + subStatusId + ' is claimed by ' +
                    matches.length + ' active ' + RECORD_TYPES.RECORD_STATUS +
                    ' records: ' + matches.join(', ') + '. Nothing was written. ' +
                    'Remove the sub-status from all but one of those records.'
            });
            return null;
        }

        return matches[0];
    }

    return {
        VERSION: VERSION,
        LOG_PREFIX: LOG_PREFIX,
        RECORD_TYPES: RECORD_TYPES,
        MAPPING_FIELDS: MAPPING_FIELDS,
        OPPORTUNITY_FIELDS: OPPORTUNITY_FIELDS,
        SALES_ORDER_FIELDS: SALES_ORDER_FIELDS,
        PARAMETERS: PARAMETERS,
        logKey: logKey,
        lookupValue: lookupValue,
        getQualifyingStatuses: getQualifyingStatuses,
        getExcludedStatuses: getExcludedStatuses,
        getMappedStatus: getMappedStatus
    };
});
