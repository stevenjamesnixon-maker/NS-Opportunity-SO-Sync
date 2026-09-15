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
 * @version 1.6.1
 */
define(['N/runtime', 'N/error', 'N/log'], function (runtime, error, log) {

    'use strict';

    var VERSION = '1.6.1';

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
     *   Opportunity: design sub-status     custbody_opportunity_sub_status        List
     *   Opportunity: delivery date         custbody_opp_del_date                  Date
     *   Sales Order: Record Status         custbody_finance_status                List/Record
     *   Sales Order: expected ship date    custbody_defaultshipdate               Date
     *   Sales Order -> Opportunity link    opportunity                            Native field
     *
     * The sub-status -> Record Status mapping is NOT held on a record. It is a script
     * parameter — see PARAMETERS.STATUS_MAP and getMappedStatus(). A custom record was
     * specified first and deliberately abandoned: see docs/context.md section 5.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Prefix on every log title raised anywhere in this project, so the execution log can be
     * filtered on one string. Build every title with logKey() rather than writing the prefix out.
     * @type {string}
     */
    var LOG_PREFIX = 'OPPSYNC_';

    /**
     * Record type script IDs.
     * @type {Object}
     */
    var RECORD_TYPES = {
        /**
         * Native sales order record type, as used in a search.
         *
         * customrecord_fin_stat is deliberately NOT here. Nothing in this project reads that
         * record any more — the mapping moved to a script parameter — and an unused constant
         * naming it would invite someone to search it again. The Record Status custom record
         * still exists in NetSuite and is still what custbody_finance_status points at; this
         * code simply never loads it.
         */
        SALES_ORDER: 'salesorder',
        /**
         * The Quote Type list record, pointed at by the sales order's custbody_quote_type.
         * Carries the two checkboxes that decide which readiness gates apply.
         *
         * "customrecord16" is an auto-assigned SCRIPT ID, not an internal id — NetSuite names a
         * custom record customrecordN when the developer does not choose an id. It is committable
         * on that basis, but see docs/context.md section 6: an auto-assigned id is only stable
         * across accounts if the record travelled between them, and it must be confirmed in each.
         */
        QUOTE_TYPE: 'customrecord16'
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
        DELIVERY_DATE: 'custbody_opp_del_date',
        /**
         * List/Record -> Customer. The installer whose certificates gate delivery readiness.
         * The certificate dates are NOT read from here — the equivalent opportunity fields are
         * unstored sourced fields and cannot be searched. The script goes to the customer record
         * this points at. See getCustomerQualField() and getCustomerPlField().
         */
        INSTALLER: 'custbody_installer_ns',

        /**
         * The DNO status, on the OPPORTUNITY — the sales order has no DNO field at all.
         *
         * "custbody38" is an auto-assigned SCRIPT ID, not an internal id: NetSuite names a body
         * field custbodyN when no id is chosen. See docs/context.md section 6.
         *
         * Opportunity-level, so it applies to every linked sales order. That is correct — the
         * DNO notification is a property of the installation, not of an individual order.
         */
        DNO_STATUS: 'custbody38',

        /* --------------------------------------------------------------------------------------
         * LEGACY EVIDENCE FIELDS — ON THE OPPORTUNITY
         *
         * Three fields carrying evidence recorded under the OLD process, before installers were
         * logged as customer records. On those opportunities custbody_installer_ns may be blank
         * while the evidence itself is present, so the modern path has nothing to read and every
         * linked order would be held for an installer that was verified years ago.
         *
         * They live on the OPPORTUNITY, so they are read ONCE per save from the record being
         * saved — no lookupFields, no per-order read. One consequence follows and is intended:
         * legacy evidence satisfies the certificate gate for EVERY sales order linked to that
         * opportunity, including any order added later. The flags record that the work was
         * verified under the old process, and the opportunity is the unit that process operated
         * on. See docs/context.md section 4.
         *
         * A legacy field is a PRESENCE test and nothing more. Present means satisfied — a ticked
         * checkbox, any date, any text. There is NO expiry comparison on a legacy field: the flag
         * records that the evidence was verified, not when it runs out. An absent legacy field
         * means nothing at all and fails nothing on its own; it simply leaves the modern path to
         * answer.
         *
         * THE FIELD TYPES ARE NOT CONFIRMED — they may be checkbox, date or text. The presence
         * test therefore has to be correct for all three: see isLegacyPresent() in
         * opsync_ue_opportunity.js, and note in particular that an UNTICKED checkbox arrives as
         * boolean false, which a naive "not empty string" test would read as present and hand
         * every legacy opportunity a free pass on its certificates.
         *
         * Do not "improve" these by parsing them as dates and checking expiry. The values are
         * whatever the old process happened to record, and a failed parse would turn a satisfied
         * legacy opportunity into a held one.
         * -------------------------------------------------------------------------------------- */

        /**
         * NOTE THE ID: custbody + subcontract, with NO underscore between them. That is the ID
         * as it exists in the account. Never "correct" it — see docs/context.md section 0,
         * trap 5. The corrected version does not exist and the failure is silent.
         */
        SUBCONTRACT_LEGACY: 'custbodysubcontract_received_legacy',
        /** Presence satisfies the installer qualification condition outright. */
        QUAL_LOGGED_LEGACY: 'custbody_installer_qual_logged_legacy',
        /** Presence satisfies the public liability condition outright. */
        PL_LOGGED_LEGACY: 'custbody_installer_pl_logged_legacy',

        /* --------------------------------------------------------------------------------------
         * BUS VOUCHER — BOTH ON THE OPPORTUNITY
         *
         * The Boiler Upgrade Scheme voucher. A heat pump order intended for BUS must not ship
         * before the voucher is approved: a project that should have claimed a voucher and
         * shipped without one cannot claim it retrospectively.
         *
         * Opportunity-level like the DNO status and the legacy flags, so both are read ONCE per
         * save from the record being saved and apply to every linked sales order. That is
         * correct — a voucher is claimed for the installation, not for an individual order.
         *
         * There is NO legacy path for this condition and there must not be one. The BUS scheme
         * postdates the old process entirely, so no legacy BUS field exists and the three legacy
         * flags say nothing about a voucher. Do not wire them in here.
         * -------------------------------------------------------------------------------------- */

        /** Date. Non-blank means the voucher has been approved. Presence test only, no expiry. */
        VOUCHER_APPROVAL_DATE: 'custbody_voucher_approval_date',
        /**
         * List -> customlist92 ("YesNo"). Is the project intended for BUS.
         *
         * BLANK IS TREATED AS "INTENDED" and holds the order — see the rule in
         * opsync_ue_opportunity.js. The internal id that means "No" differs by account, so it is
         * read from a script parameter: see PARAMETERS.BUS_NO_VALUE and getBusNoValue().
         */
        BUS_RHI_INTENDED: 'custbody_bus_project_rhi_intended'
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
        MAINLINE: 'mainline',
        /**
         * Checkbox. Is this order available to ship. Written by this script and nothing else;
         * Inline Text on the forms so users cannot edit it.
         */
        READY_FOR_DELIVERY: 'custbody_ready_for_delivery',
        /**
         * Long text. Why the order is not ready, blank when it is. Written alongside
         * READY_FOR_DELIVERY and never on its own.
         */
        DELIVERY_HOLD_REASON: 'custbody_delivery_hold_reason',
        /** List/Record -> the Quote Type record. Decides which readiness gates apply. */
        QUOTE_TYPE: 'custbody_quote_type',
        /** Must not be blank before an order needing installer certificates is ready. */
        SUBCONTRACT_RECEIVED: 'custbody_installer_subcontract_receive'
        /*
         * NOT HERE, and each was assumed to be here once:
         *
         *   custbody38                             the DNO status
         *   custbodysubcontract_received_legacy    legacy subcontract evidence
         *   custbody_installer_qual_logged_legacy  legacy qualification evidence
         *   custbody_installer_pl_logged_legacy    legacy PL evidence
         *
         * All four are on the OPPORTUNITY — see OPPORTUNITY_FIELDS. The custbody_ prefix means
         * "transaction body field" and says NOTHING about which transaction types the field
         * applies to. Asking a sales order for a field that applies only to opportunities
         * returns BLANK rather than erroring, so the mistake is silent. See docs/context.md
         * section 0, trap 6.
         */
    };

    /**
     * Checkbox script IDs on the Quote Type record.
     *
     * The two gates are INDEPENDENT. Neither checkbox short-circuits the other: a quote type
     * with both ticked still has its certificates checked, it simply skips the design check.
     * @type {Object}
     */
    var QUOTE_TYPE_FIELDS = {
        /** Checkbox "Can ship without design". Ticked, the design gate passes with no check. */
        NO_DESIGN_REQUIRED: 'custrecord_qt_no_design_required',
        /** Checkbox "Requires installer certificates". Unticked, the certificate gate passes. */
        REQUIRES_INSTALLER_CERTS: 'custrecord_qt_requires_installer_certs'
    };

    /**
     * Script parameter IDs. All eight are set on the DEPLOYMENT, so Sandbox and Production
     * carry their own values and no internal id appears in code. See docs/context.md section 8.
     * @type {Object}
     */
    var PARAMETERS = {
        /** Free-Form Text. Comma-separated entitystatus ids that open the gate. */
        QUALIFYING_STATUSES: 'custscript_opsync_qualifying_statuses',
        /** Free-Form Text. Comma-separated Record Status ids that must not be overwritten. */
        EXCLUDED_STATUSES: 'custscript_opsync_excluded_statuses',
        /**
         * Free-Form Text. The sub-status -> Record Status mapping, as comma-separated
         * subStatusId:recordStatusId pairs. See parseStatusMap() for the format and the
         * handling of malformed and duplicate entries.
         */
        STATUS_MAP: 'custscript_opsync_status_map',
        /** Free-Form Text. Comma-separated Record Status ids that satisfy the design gate. */
        DESIGN_OK_STATUSES: 'custscript_opsync_design_ok_statuses',
        /** Free-Form Text. Comma-separated custbody38 values that satisfy the DNO check. */
        DNO_OK_VALUES: 'custscript_opsync_dno_ok_values',
        /**
         * Free-Form Text. The SCRIPT ID of the installer qualification expiry date field on the
         * CUSTOMER record.
         *
         * A parameter rather than a constant because the equivalent field on the opportunity is
         * an unstored sourced field and cannot be read by a search — the script has to go to the
         * customer record that custbody_installer_ns points at, and which field that is has to
         * be configurable per account.
         */
        CUSTOMER_QUAL_FIELD: 'custscript_opsync_cust_qual_field',
        /** Free-Form Text. The SCRIPT ID of the Public Liability expiry date field. As above. */
        CUSTOMER_PL_FIELD: 'custscript_opsync_cust_pl_field',
        /**
         * Free-Form Text. The single customlist92 option internal id that means "NOT intended
         * for BUS" — the one value of custbody_bus_project_rhi_intended that switches the BUS
         * condition off. Every other value, blank included, leaves it on.
         *
         * A parameter rather than a constant for the usual reason: it is a list option internal
         * id and differs by account. See getBusNoValue() for why it does NOT throw when unset.
         */
        BUS_NO_VALUE: 'custscript_opsync_bus_no_value'
    };

    /* ------------------------------------------------------------------------------------------
     * NO CACHING
     *
     * getMappedStatus() re-reads and re-parses the mapping parameter on every call and nothing
     * here is memoised. That is deliberate, not an oversight. The mapping is configuration that
     * people edit, and a cache would risk resolving a sub-status against a mapping that was
     * correct a moment ago — writing a stale Record Status onto a sales order.
     *
     * Since the mapping moved from a saved search to a script parameter the cost is a string
     * split rather than a query, so there is even less to weigh against that risk than before.
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
     * logged at error and an empty array is returned.
     *
     * Its ONE remaining caller is getQualifyingStatuses(), where an empty array fails closed —
     * the gate never opens and nothing is written. Do not reuse this for a parameter whose empty
     * value removes a restriction; use requiredValueList() for those. See the block comment
     * above getExcludedStatuses().
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
     * REQUIRED — this throws when unset. An empty exclusion list does not mean "protect nothing
     * by default", it means protect nothing at all: the script would write status, ship date and
     * readiness onto orders at Release to Warehouse, Cancelled and Design Cancelled, which are
     * precisely the orders this parameter exists to protect. Returning an empty array would make
     * the safety mechanism fail open. The throw lands before the sales order loop, so those
     * orders are left untouched.
     *
     * Design Cancelled maps to Cancelled and Cancelled is in this list, so an order that lands
     * there can never be moved again by this sync. That is a deliberate one-way door — see
     * docs/context.md section 6. Do not "fix" it by removing Cancelled from the parameter.
     *
     * @returns {string[]} ids as strings, at least one
     * @throws {Error} OPPSYNC_PARAMETER_MISSING when absent or empty
     */
    function getExcludedStatuses() {
        return requiredValueList(PARAMETERS.EXCLUDED_STATUSES);
    }

    /* ------------------------------------------------------------------------------------------
     * REQUIRED PARAMETERS — FIVE OF THE EIGHT THROW, THREE DO NOT
     *
     * Count them against the code before trusting any prose, here or in docs/context.md section
     * 5: this count was wrong in both places until 1.6.1, and it is consulted precisely when
     * somebody is deciding how a NEW parameter should behave.
     *
     * The test is not "how important is this parameter". It is: WHAT DOES EMPTY MEAN?
     *
     * THE THREE THAT DO NOT THROW all fail CLOSED — empty makes the script do LESS, not more:
     *
     *   QUALIFYING_STATUSES  empty means no opportunity qualifies. The gate never opens, the
     *                        script does nothing, and no sales order is touched.
     *                        parseIdListParameter() logs at error and returns [].
     *   STATUS_MAP           empty means no sub-status resolves, so no Record Status is written
     *                        to any order. parseStatusMap() logs at error and returns null.
     *                        (Readiness is still evaluated against each order's OWN status — see
     *                        the decided status in docs/context.md section 4. That is a
     *                        deliberate widening of what an unmapped save does, not a leak: it
     *                        writes no status anywhere.)
     *   BUS_NO_VALUE         empty means no list value is recognised as "No", so the BUS
     *                        condition applies to EVERYTHING — it adds a restriction rather
     *                        than removing one, and the worst case is an order held until
     *                        somebody looks at the log. getBusNoValue() logs at error and
     *                        returns ''. See the note on that function.
     *
     * THE FIVE THAT THROW all fail OPEN — empty removes a restriction rather than applying one:
     *
     *   EXCLUDED_STATUSES   empty means nothing is excluded, so the script writes over orders at
     *                       Release to Warehouse, Cancelled and Design Cancelled — exactly the
     *                       orders the parameter exists to protect.
     *   DESIGN_OK_STATUSES  empty means no status satisfies the design gate, so every order is
     *                       stamped "not ready, Design not complete" including ones that are
     *                       perfectly ready.
     *   DNO_OK_VALUES       likewise: every certificate-gated order reports Awaiting DNO.
     *   CUSTOMER_*_FIELD    empty means the certificate dates cannot be read at all, so they
     *                       read as missing and every gated order is held.
     *
     * In each of those five, returning an empty array produces confidently wrong data on every
     * sales order of the opportunity — which is worse than doing nothing. So they THROW, and
     * they are resolved BEFORE the sales order loop begins, so a missing one cannot leave some
     * orders written and the rest not. The throw is caught by the entry point's outer handler and
     * logged as OPPSYNC_FAILED; the opportunity still saves.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Reads a parameter that must be present, throwing when it is not.
     *
     * @param {string} parameterId
     * @returns {string} the trimmed raw value
     * @throws {Error} OPPSYNC_PARAMETER_MISSING when absent or empty
     */
    function requiredParameter(parameterId) {
        var raw;
        var trimmed;

        try {
            raw = runtime.getCurrentScript().getParameter({ name: parameterId });
        } catch (e) {
            raw = null;
        }

        trimmed = (raw === null || raw === undefined) ? '' : String(raw).replace(/^\s+|\s+$/g, '');

        if (trimmed === '') {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Required script parameter ' + parameterId + ' is not set. Delivery ' +
                    'readiness cannot be evaluated without it, and guessing would write a ' +
                    'confidently wrong readiness onto every sales order on this opportunity. ' +
                    'Nothing was written. Populate it on the deployment in this account — its ' +
                    'value differs by environment. See docs/context.md section 8.'
            });
            throw error.create({
                name: logKey('PARAMETER_MISSING'),
                message: 'Required script parameter ' + parameterId + ' is not set.',
                notifyOff: true
            });
        }

        return trimmed;
    }

    /**
     * Reads a required comma-separated parameter as an array of trimmed values.
     *
     * Unlike parseIdListParameter() these are not necessarily numeric — getDnoOkValues() may
     * hold list option ids or stored text, depending on how custbody38 is built in the account.
     * They are compared as strings either way.
     *
     * @param {string} parameterId
     * @returns {string[]} at least one entry
     * @throws {Error} OPPSYNC_PARAMETER_MISSING when absent, empty, or holding nothing usable
     */
    function requiredValueList(parameterId) {
        var parts = requiredParameter(parameterId).split(',');
        var values = [];
        var i;
        var trimmed;

        for (i = 0; i < parts.length; i += 1) {
            trimmed = parts[i].replace(/^\s+|\s+$/g, '');
            if (trimmed !== '') {
                values.push(trimmed);
            }
        }

        if (values.length === 0) {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Required script parameter ' + parameterId + ' held no usable values.'
            });
            throw error.create({
                name: logKey('PARAMETER_MISSING'),
                message: 'Required script parameter ' + parameterId + ' held no usable values.',
                notifyOff: true
            });
        }

        return values;
    }

    /**
     * Record Statuses that satisfy the design gate — the design is far enough along to ship.
     *
     * @returns {string[]}
     * @throws {Error} OPPSYNC_PARAMETER_MISSING
     */
    function getDesignOkStatuses() {
        return requiredValueList(PARAMETERS.DESIGN_OK_STATUSES);
    }

    /**
     * custbody38 values that satisfy the DNO check. Blank or absent on the order always fails.
     *
     * @returns {string[]}
     * @throws {Error} OPPSYNC_PARAMETER_MISSING
     */
    function getDnoOkValues() {
        return requiredValueList(PARAMETERS.DNO_OK_VALUES);
    }

    /**
     * Script ID of the installer qualification expiry date field on the CUSTOMER record.
     *
     * @returns {string}
     * @throws {Error} OPPSYNC_PARAMETER_MISSING
     */
    function getCustomerQualField() {
        return requiredParameter(PARAMETERS.CUSTOMER_QUAL_FIELD);
    }

    /**
     * Script ID of the Public Liability expiry date field on the CUSTOMER record.
     *
     * @returns {string}
     * @throws {Error} OPPSYNC_PARAMETER_MISSING
     */
    function getCustomerPlField() {
        return requiredParameter(PARAMETERS.CUSTOMER_PL_FIELD);
    }

    /**
     * The customlist92 option internal id that means "NOT intended for BUS".
     *
     * THIS ONE DOES NOT THROW, and that is the §5 test applied rather than an exception to it.
     * Ask what EMPTY means: with no id configured, no value of custbody_bus_project_rhi_intended
     * is recognised as "No", so the BUS condition applies to every certificate-gated order. That
     * ADDS a restriction — orders are held, never shipped — so empty fails CLOSED, like
     * getQualifyingStatuses() and parseStatusMap() before it. Throwing would abandon the whole
     * sync, including the status and
     * ship date writes, over a parameter whose absence is already safe. It is logged at error so
     * the misconfiguration is still visible.
     *
     * The empty return also has to be handled at the comparison, and is: a blank intention must
     * NOT match a blank parameter and switch the condition off. See evaluateReadiness().
     *
     * @returns {string} the internal id, or '' when unset — which applies the condition to all
     */
    function getBusNoValue() {
        var raw;
        var trimmed;

        try {
            raw = runtime.getCurrentScript().getParameter({ name: PARAMETERS.BUS_NO_VALUE });
        } catch (e) {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Could not read script parameter ' + PARAMETERS.BUS_NO_VALUE +
                    '. Is it defined on the script record and set on the deployment? Every ' +
                    'certificate-gated order will be held for a BUS voucher until it is. ' + e
            });
            return '';
        }

        trimmed = (raw === null || raw === undefined) ? '' : String(raw).replace(/^\s+|\s+$/g, '');

        if (trimmed === '') {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Script parameter ' + PARAMETERS.BUS_NO_VALUE + ' is empty, so no ' +
                    'value of ' + OPPORTUNITY_FIELDS.BUS_RHI_INTENDED + ' is recognised as ' +
                    '"not intended for BUS" and every certificate-gated order is held for a ' +
                    'voucher. That is the safe direction, so nothing was thrown — but it is ' +
                    'still a misconfiguration. Populate it on the deployment in this account: ' +
                    'its value is a customlist92 option internal id and differs by ' +
                    'environment. See docs/context.md section 8.'
            });
        }

        return trimmed;
    }

    /**
     * True when the text is a plain non-negative integer — the shape every NetSuite internal id
     * takes. Guards the map parser against text that would otherwise be written to a record.
     *
     * @param {string} text
     * @returns {boolean}
     */
    function isIdText(text) {
        return /^[0-9]+$/.test(text);
    }

    /**
     * Parses the mapping parameter into a plain object keyed by sub-status id.
     *
     * Format: comma-separated subStatusId:recordStatusId pairs, e.g.
     * "<subStatusId>:<recordStatusId>,<subStatusId>:<recordStatusId>". Both sides are internal
     * ids, so the real value differs by environment and lives on the deployment — never here,
     * and never in the repository. See docs/context.md section 3.
     *
     * The parser is deliberately forgiving about SHAPE and unforgiving about MEANING:
     *
     *   - whitespace around any element is trimmed, because someone will paste with spaces;
     *   - empty entries are ignored, so a trailing comma is harmless;
     *   - a pair that will not parse is logged and SKIPPED, and the remaining pairs still
     *     apply. One typo must not disable the whole feature;
     *   - a DUPLICATE key is logged and the key is DROPPED ENTIRELY. Not the first, not the
     *     last. Writing a wrong status onto a sales order is the failure this design exists to
     *     prevent, and there is no way to tell which of two conflicting rows was meant. Writing
     *     nothing is recoverable and the log names what to fix.
     *
     * @returns {Object|null} sub-status id -> Record Status id, or null when unusable
     */
    function parseStatusMap() {
        var raw;
        var entries;
        var map = {};
        var duplicates = {};
        var summary = [];
        var i;
        var entry;
        var halves;
        var key;
        var value;
        var usable = 0;

        try {
            raw = runtime.getCurrentScript().getParameter({ name: PARAMETERS.STATUS_MAP });
        } catch (e) {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Could not read script parameter ' + PARAMETERS.STATUS_MAP +
                    '. Is it defined on the script record and set on the deployment? ' + e
            });
            return null;
        }

        if (raw === null || raw === undefined || String(raw) === '') {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Script parameter ' + PARAMETERS.STATUS_MAP + ' is empty. No ' +
                    'sub-status can be resolved, so no sales order will be updated at all. ' +
                    'Populate it on the deployment in this account — its value differs by ' +
                    'environment. See docs/context.md section 8.'
            });
            return null;
        }

        entries = String(raw).split(',');

        for (i = 0; i < entries.length; i += 1) {
            entry = entries[i].replace(/^\s+|\s+$/g, '');

            // A trailing or doubled comma is not worth an error line.
            if (entry === '') {
                continue;
            }

            halves = entry.split(':');
            key = halves.length === 2 ? halves[0].replace(/^\s+|\s+$/g, '') : '';
            value = halves.length === 2 ? halves[1].replace(/^\s+|\s+$/g, '') : '';

            if (halves.length !== 2 || !isIdText(key) || !isIdText(value)) {
                log.error({
                    title: logKey('MAP_INVALID_ENTRY'),
                    details: 'Entry "' + entry + '" in ' + PARAMETERS.STATUS_MAP + ' is not a ' +
                        'subStatusId:recordStatusId pair of whole numbers. It was skipped; the ' +
                        'rest of the mapping still applies. Correct it on the deployment.'
                });
                continue;
            }

            if (map.hasOwnProperty(key)) {
                duplicates[key] = true;
                continue;
            }

            map[key] = value;
            usable += 1;
        }

        // Drop every duplicated key outright, AFTER the pass — so a key duplicated three times
        // is dropped once and the first occurrence does not survive by being first.
        Object.keys(duplicates).forEach(function (duplicateKey) {
            log.error({
                title: logKey('MAP_AMBIGUOUS'),
                details: 'Sub-status ' + duplicateKey + ' appears more than once in ' +
                    PARAMETERS.STATUS_MAP + '. The whole entry was dropped rather than guessing ' +
                    'which mapping was meant, so that sub-status now resolves to nothing and ' +
                    'its sales orders are left alone. Remove the duplicate on the deployment.'
            });
            delete map[duplicateKey];
            usable -= 1;
        });

        if (usable <= 0) {
            log.error({
                title: logKey('PARAMETER_MISSING'),
                details: 'Script parameter ' + PARAMETERS.STATUS_MAP + ' held no usable pairs ' +
                    'after parsing. Nothing can be resolved. Raw value: ' + raw
            });
            return null;
        }

        // One line, so a typo can be spotted by eye in the execution log rather than inferred
        // from an order that did not sync. Requires the deployment's Log Level to be Debug.
        Object.keys(map).forEach(function (mapKey) {
            summary.push(mapKey + ' -> ' + map[mapKey]);
        });
        log.debug({
            title: logKey('MAP_PARSED'),
            details: summary.join(', ')
        });

        return map;
    }

    /**
     * Resolves an opportunity sub-status to its Record Status through the mapping parameter.
     *
     * No match is NOT an error — most sub-statuses are deliberately unmapped. It returns null
     * quietly and the caller stops. A sub-status dropped for being duplicated resolves to null
     * for the same reason, having already been logged at error by parseStatusMap().
     *
     * @param {string} subStatusId - a customlist_opp_sub_status_list option internal id
     * @returns {string|null} the Record Status internal id, or null
     */
    function getMappedStatus(subStatusId) {
        var map;
        var key;

        if (subStatusId === null || subStatusId === undefined || String(subStatusId) === '') {
            return null;
        }

        map = parseStatusMap();
        if (map === null) {
            return null;
        }

        key = String(subStatusId);

        return map.hasOwnProperty(key) ? map[key] : null;
    }

    return {
        VERSION: VERSION,
        LOG_PREFIX: LOG_PREFIX,
        RECORD_TYPES: RECORD_TYPES,
        QUOTE_TYPE_FIELDS: QUOTE_TYPE_FIELDS,
        OPPORTUNITY_FIELDS: OPPORTUNITY_FIELDS,
        SALES_ORDER_FIELDS: SALES_ORDER_FIELDS,
        PARAMETERS: PARAMETERS,
        logKey: logKey,
        lookupValue: lookupValue,
        getQualifyingStatuses: getQualifyingStatuses,
        getExcludedStatuses: getExcludedStatuses,
        getDesignOkStatuses: getDesignOkStatuses,
        getDnoOkValues: getDnoOkValues,
        getCustomerQualField: getCustomerQualField,
        getCustomerPlField: getCustomerPlField,
        getBusNoValue: getBusNoValue,
        getMappedStatus: getMappedStatus
    };
});
