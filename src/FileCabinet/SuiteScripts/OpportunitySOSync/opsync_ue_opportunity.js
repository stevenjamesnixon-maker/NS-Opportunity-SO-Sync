/**
 * opsync_ue_opportunity.js
 *
 * Brings a won opportunity's sales orders into step with it: the design sub-status is translated
 * through the mapping held on customrecord_fin_stat and written to the order's Record Status,
 * and the opportunity's delivery date is copied to the order's expected ship date.
 *
 * Replaces acs_ue_update_so.js, which drove the same updates from a CAD Worklist custom record
 * that is being retired. The two must never both be deployed — see docs/context.md section 8.
 *
 * afterSubmit, never beforeSubmit. The predecessor wrote to sales orders before its own record
 * had committed, so a failed opportunity save left the orders already changed and the
 * opportunity unchanged, with nothing in the log to say why. afterSubmit runs only once the
 * opportunity is actually saved.
 *
 * Nothing here may block the opportunity save. The whole entry point is wrapped, and each order
 * is processed in its own try/catch so one unreachable order does not stop the others.
 *
 * Every script ID this file uses comes from opsync_lib_config. No NetSuite id is written out
 * here — see docs/context.md section 3.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.7.0
 */
define(['N/search', 'N/record', 'N/format', 'N/runtime', 'N/log', './lib/opsync_lib_config'],
    function (search, record, format, runtime, log, opsyncConfig) {

    'use strict';

    var VERSION = '1.7.0';

    /**
     * Governance units that must remain before another sales order is processed.
     *
     * NOT a NetSuite internal id — this is a unit count. Each order costs one lookupFields plus,
     * at most, one submitFields, and the exact cost of submitFields varies by record type. The
     * floor is therefore set well above a single iteration so the loop stops cleanly and says
     * what it left undone, rather than dying part-way through with some orders updated and the
     * rest silently skipped.
     *
     * @type {number}
     */
    var GOVERNANCE_FLOOR_UNITS = 100;

    /**
     * Raised by the qualification condition and by the public liability condition independently.
     * It is de-duplicated before the reasons are joined: one missing installer is one problem to
     * fix, and saying so twice reads as two.
     * @type {string}
     */
    var INSTALLER_NOT_SET = 'Installer not set on opportunity';

    /**
     * Upper bound on the orders read for one opportunity. An opportunity legitimately has
     * several; it does not have thousands, and an unbounded getRange is how a user event starts
     * timing out on a record nobody expected.
     *
     * @type {number}
     */
    var MAX_ORDERS = 1000;

    /**
     * True when the value is absent, null, or the empty string.
     *
     * @param {*} value
     * @returns {boolean}
     */
    function isEmpty(value) {
        return value === null || value === undefined || String(value) === '';
    }

    /**
     * THE PROJECT'S PRESENCE TEST for any field where "is this filled in" decides whether an
     * order ships. NOT isEmpty() — see below.
     *
     * It was called isLegacyPresent() until 1.5.3, having been written for the three legacy
     * evidence fields, whose types are NOT confirmed and may be checkbox, date or text. It was
     * never legacy-only, and by then it also served a CONFIRMED Date and a lookupFields value —
     * so a reader meeting isLegacyPresent(voucherDate) had to go and check whether they were
     * looking at a bug. A helper whose name has to be explained away in a comment is the same
     * defect as custbody_ meaning only "transaction body field", in a cheaper place.
     *
     * It is correct for a checkbox, a date and a text field alike, because the cost of being
     * wrong is always in the same direction.
     *
     * THAT DIRECTION IS WHY THIS IS THE DEFAULT. An UNTICKED checkbox arrives as boolean FALSE.
     * isEmpty(false) is false, because String(false) is the five-character string "false" — so a
     * presence test written as !isEmpty(value), or as value !== '', reads an unticked box as
     * PRESENT and hands the order a free pass on the condition. Silently, and in the direction
     * that ships goods rather than holding them. A field whose type is confirmed today can be
     * changed in the UI tomorrow by someone who will never read this file, and nothing in the
     * script would notice. This test survives that change; isEmpty() does not.
     *
     * So use this for EVERY presence-gates-shipping test, whether or not the type is confirmed.
     * There is no longer an exception: custbody_installer_subcontract_receive was the last one
     * on !isEmpty() and moved across in 1.5.2. A new presence test written as !isEmpty() is the
     * defect, not the field it happens to be reading.
     *
     * It is correct on a lookupFields result as well as on a record, and the subcontract field
     * is the proof: lookupValue() stringifies, so an unticked checkbox arrives as the STRING
     * "false" rather than as boolean false. Both shapes are rejected below, by name.
     *
     * So false, '' , null and undefined are all absent. The string forms 'F' and 'false' are
     * treated as absent too, in case a checkbox reaches this by a path that stringifies it —
     * neither is a plausible value for a genuine text or date field.
     *
     * @param {*} value
     * @returns {boolean} true when the value is present
     */
    function isPresent(value) {
        var text;

        if (value === null || value === undefined || value === false) {
            return false;
        }

        if (value === true) {
            return true;
        }

        text = String(value).replace(/^\s+|\s+$/g, '');

        return text !== '' && text !== 'F' && text !== 'false';
    }

    /**
     * Reads a field from a record, tolerating a record that is absent (oldRecord on CREATE) or a
     * field that is not present on it (any field on a sparse XEDIT newRecord).
     *
     * @param {Record} rec
     * @param {string} fieldId
     * @returns {*} the raw value, or null
     */
    function readField(rec, fieldId) {
        if (!rec) {
            return null;
        }
        try {
            return rec.getValue({ fieldId: fieldId });
        } catch (e) {
            return null;
        }
    }

    /**
     * Normalises a list value for comparison. List fields return raw stored values, and both
     * sides of every comparison in this script are ids from the same list, so this is a string
     * coercion and nothing more — see docs/context.md section 0, trap 4.
     *
     * @param {*} value
     * @returns {string}
     */
    function asId(value) {
        return isEmpty(value) ? '' : String(value);
    }

    /**
     * Normalises a select value to its internal ID string, whatever shape it arrives in.
     *
     * TWO APIS, TWO SHAPES. search.lookupFields returns a select as an ARRAY of {value, text};
     * record.getValue returns the same field as a plain internal ID STRING. A value that moves
     * between the two — as custbody38 did in 1.4.0, from a per-order lookupFields to a read off
     * the opportunity record — changes shape without changing meaning.
     *
     * String([{value:'1'}]) is '[object Object]', which is in no parameter list, so a select
     * compared in the wrong shape fails as a legitimate "not acceptable" rather than as an
     * error. Nothing is logged and nothing throws. This is deliberately tolerant of BOTH shapes
     * so the comparison stays correct wherever the value came from.
     *
     * It is not a substitute for knowing which record a field is on: a normaliser cannot fix a
     * field that returns blank because it does not apply to the record being asked.
     *
     * @param {*} value - array of {value,text}, {value}, string, number, or empty
     * @returns {string} the internal ID, or '' when blank
     */
    function asSelectId(value) {
        if (value === null || value === undefined) {
            return '';
        }

        if (Object.prototype.toString.call(value) === '[object Array]') {
            if (value.length === 0) {
                return '';
            }
            return asSelectId(value[0]);
        }

        if (typeof value === 'object') {
            return (value.value === null || value.value === undefined) ? '' : String(value.value);
        }

        return String(value);
    }

    /**
     * Normalises a date to a single representation so the two sides of a comparison can actually
     * be equal.
     *
     * THIS IS THE TRAP. record.getValue() on a date field returns a Date OBJECT.
     * search.lookupFields() returns the same field as a STRING in the current user's date format.
     * Comparing them directly is always unequal — so "only write when something changed" quietly
     * becomes "write every time", which fills every sales order with system notes, re-fires the
     * orders' own user events on every opportunity save, and defeats the guard that breaks the
     * feedback loop described in docs/context.md section 5.
     *
     * Both sides are therefore rendered as a string in the current user's date format, which is
     * the representation lookupFields already returns.
     *
     * THE RESULT IS A COMPARISON KEY AND MUST NEVER BE WRITTEN TO A RECORD. It is a localised
     * string — this is a UK account on dd/mm/yyyy — and anything in the chain that parses it as
     * mm/dd turns 5 September into 9 May. The mis-parse is silent, and only possible for days
     * below 13, so it survives a test run on the 14th and fails on the 5th. Use
     * asDateForWrite() for the value that goes to submitFields. See docs/context.md section 5.
     *
     * @param {*} value - a Date, a formatted string, or empty
     * @returns {string} a comparison key; '' when unset
     */
    function asDateKey(value) {
        if (isEmpty(value)) {
            return '';
        }

        if (Object.prototype.toString.call(value) === '[object Date]') {
            return format.format({ value: value, type: format.Type.DATE });
        }

        return String(value).replace(/^\s+|\s+$/g, '');
    }

    /**
     * Prepares a date for writing to a record.
     *
     * Returns the ORIGINAL Date object that record.getValue() handed back, untouched. NetSuite
     * accepts a Date natively on submitFields, so no formatting, no locale and no parsing are
     * involved in the write — and therefore nothing that can read 05/09 as 9 May.
     *
     * The split from asDateKey() is deliberate and is not tidiness waiting to happen:
     *
     *   the STRING is a comparison key only, and must never be written;
     *   the DATE is written, and must never be compared.
     *
     * Do not collapse the two back into one variable. See docs/context.md section 5.
     *
     * Anything that is not a Date is treated as unset and returns '', which is how submitFields
     * clears a date field. The value only ever arrives here from a date field's getValue(), so
     * in practice that is the empty case and nothing else.
     *
     * @param {*} value - the raw value from the opportunity
     * @returns {Date|string} the Date to write, or '' to clear
     */
    function asDateForWrite(value) {
        if (Object.prototype.toString.call(value) === '[object Date]') {
            return value;
        }
        return '';
    }

    /**
     * Reduces a date to a plain YYYYMMDD number for ORDERING.
     *
     * asDateKey() is deliberately not used for this. It produces a localised dd/mm/yyyy string,
     * and comparing those with < or > orders them alphabetically — "05/12/2026" sorts before
     * "06/01/2026" though it is a year later. Ordering must be numeric.
     *
     * The number is built from the date PARTS, so any time component is discarded rather than
     * tipping a same-day comparison. A certificate expiring today is valid: the brief is
     * explicit that "on or after the current date" passes, and a datetime comparison would fail
     * exactly those same-day certificates while appearing to work for every other case.
     *
     * @param {Date} value
     * @returns {number|null} e.g. 20260915, or null when not a date
     */
    function asDayNumber(value) {
        if (Object.prototype.toString.call(value) !== '[object Date]' || isNaN(value.getTime())) {
            return null;
        }
        return (value.getFullYear() * 10000) + ((value.getMonth() + 1) * 100) + value.getDate();
    }

    /**
     * Parses a date that came back from search.lookupFields as a localised string.
     *
     * format.parse is the inverse of the format.format used in asDateKey, so the account's date
     * preference is honoured in both directions. A value that will not parse is treated as
     * absent rather than as a date in the distant past — an unreadable certificate date must
     * read as "missing", never as "valid".
     *
     * @param {string} text
     * @returns {Date|null}
     */
    function parseLookupDate(text) {
        var parsed;

        if (isEmpty(text)) {
            return null;
        }

        try {
            parsed = format.parse({ value: String(text), type: format.Type.DATE });
        } catch (e) {
            return null;
        }

        return Object.prototype.toString.call(parsed) === '[object Date]' ? parsed : null;
    }

    /**
     * Today, as a YYYYMMDD number.
     *
     * @returns {number}
     */
    function todayDayNumber() {
        return asDayNumber(new Date());
    }

    /**
     * Tests a certificate expiry date from the CUSTOMER record.
     *
     * Blank and expired are different failures and are reported differently, because they need
     * different actions: a blank field means nobody recorded the certificate, an expired one
     * means it needs renewing.
     *
     * @param {string} rawDate - the value as lookupFields returned it
     * @param {number} today
     * @param {string} label - e.g. 'Installer qualification certificate'
     * @returns {string} '' when the certificate is valid, else the failure reason
     */
    function expiryFailure(rawDate, today, label) {
        var day = asDayNumber(parseLookupDate(rawDate));

        if (day === null) {
            return label + ' missing';
        }

        // On or after today passes. A certificate expiring today is still valid.
        return day < today ? (label + ' expired') : '';
    }

    /**
     * Resolves one certificate condition — qualification or public liability.
     *
     * The legacy evidence field wins outright. It is an OR, not an AND: an order whose legacy
     * flag is set is satisfied even if the modern certificate on the customer record has
     * expired, because the legacy flag records that the evidence was verified under the old
     * process and there is nothing to re-check.
     *
     * Only when there is no legacy evidence does the modern path matter, and only then does a
     * missing installer become a problem — which is why "installer not set" is no longer a
     * standalone check. An order satisfied entirely by legacy fields does not need an installer
     * at all.
     *
     * @param {string} legacyValue - the legacy evidence field from the sales order
     * @param {string} installerId
     * @param {string} rawExpiry - the expiry from the customer record
     * @param {number} today
     * @param {string} label
     * @returns {Object} { reason: string, path: string } — reason '' when satisfied
     */
    function resolveCertificate(legacyValue, installerId, rawExpiry, today, label) {
        if (isPresent(legacyValue)) {
            return { reason: '', path: 'legacy' };
        }

        if (isEmpty(installerId)) {
            return { reason: INSTALLER_NOT_SET, path: 'no installer' };
        }

        var failure = expiryFailure(rawExpiry, today, label);
        return { reason: failure, path: failure === '' ? 'modern' : 'modern fail' };
    }

    /**
     * True when the id appears in the list of ids. Both sides are normalised first.
     *
     * @param {string} id
     * @param {string[]} ids
     * @returns {boolean}
     */
    function contains(id, ids) {
        var i;
        var needle = asId(id);

        if (needle === '' || !ids) {
            return false;
        }

        for (i = 0; i < ids.length; i += 1) {
            if (asId(ids[i]) === needle) {
                return true;
            }
        }

        return false;
    }

    /**
     * Reads an opportunity field, falling back to oldRecord when newRecord does not carry it.
     *
     * On XEDIT (inline edit) NetSuite populates newRecord with ONLY the fields that were edited.
     * Reading straight off newRecord therefore returns empty for every field the user did not
     * touch. Two things follow, and neither is obvious:
     *
     *   1. A gate reading entitystatus off newRecord sees an empty status on a perfectly valid
     *      inline edit, exits, and logs nothing — the feature looks dead rather than broken.
     *   2. Taking a field's value from a sparse newRecord and writing it to the sales order
     *      would push an empty value onto the order, clearing a ship date nobody touched.
     *
     * oldRecord is complete on XEDIT, so it is the reliable source unless the field is itself
     * what was edited — in which case newRecord carries it and wins.
     *
     * The fallback is applied ONLY on XEDIT for the synced fields. On CREATE and EDIT newRecord
     * is complete, so an empty value there is a real clear by a real user and must be respected;
     * falling back would resurrect a value the user had just removed.
     *
     * Do not "simplify" this to a plain newRecord read.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {string} fieldId
     * @param {boolean} sparse - true when newRecord may be missing untouched fields (XEDIT)
     * @returns {*}
     */
    function effectiveValue(newRecord, oldRecord, fieldId, sparse) {
        var value = readField(newRecord, fieldId);

        if (sparse && isEmpty(value)) {
            return readField(oldRecord, fieldId);
        }

        return value;
    }

    /**
     * Finds the sales orders linked to an opportunity.
     *
     * Filtered on the native opportunity field — not createdfrom — and on mainline, so each
     * order is returned once rather than once per line. One opportunity may have several orders.
     *
     * @param {string} opportunityId
     * @returns {string[]} sales order internal ids
     */
    function findSalesOrders(opportunityId) {
        var ids = [];

        search.create({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            filters: [
                [opsyncConfig.SALES_ORDER_FIELDS.OPPORTUNITY_LINK, 'anyof', opportunityId],
                'AND',
                [opsyncConfig.SALES_ORDER_FIELDS.MAINLINE, 'is', 'T']
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: MAX_ORDERS }).forEach(function (result) {
            ids.push(String(result.id));
        });

        return ids;
    }

    /**
     * True when a checkbox value from search.lookupFields is ticked. lookupFields returns a
     * boolean for a checkbox, but a string slips through often enough to be worth tolerating.
     *
     * @param {*} value
     * @returns {boolean}
     */
    function isTicked(value) {
        return value === true || value === 'T' || value === 'true';
    }

    /**
     * Reads the two gate checkboxes off a Quote Type record, through a per-save cache.
     *
     * Several sales orders on one opportunity commonly share a quote type, so the cache turns
     * N lookups into one per distinct type. It lives for a single execution only — a cache that
     * outlived the save would risk gating an order on a checkbox someone had since changed.
     *
     * A BLANK quote type behaves as neither checkbox ticked: the design gate applies and the
     * certificate gate does not. That is the conservative reading — an order with no quote type
     * still has to have its design finished before it ships.
     *
     * @param {string} quoteTypeId
     * @param {Object} cache - keyed by quote type id, mutated in place
     * @returns {Object} { noDesignRequired: boolean, requiresCerts: boolean }
     */
    function getQuoteTypeGates(quoteTypeId, cache) {
        var lookup;
        var gates;

        if (isEmpty(quoteTypeId)) {
            return { noDesignRequired: false, requiresCerts: false };
        }

        if (cache.hasOwnProperty(quoteTypeId)) {
            return cache[quoteTypeId];
        }

        try {
            lookup = search.lookupFields({
                type: opsyncConfig.RECORD_TYPES.QUOTE_TYPE,
                id: quoteTypeId,
                columns: [
                    opsyncConfig.QUOTE_TYPE_FIELDS.NO_DESIGN_REQUIRED,
                    opsyncConfig.QUOTE_TYPE_FIELDS.REQUIRES_INSTALLER_CERTS
                ]
            });
            gates = {
                noDesignRequired: isTicked(
                    lookup[opsyncConfig.QUOTE_TYPE_FIELDS.NO_DESIGN_REQUIRED]),
                requiresCerts: isTicked(
                    lookup[opsyncConfig.QUOTE_TYPE_FIELDS.REQUIRES_INSTALLER_CERTS])
            };
        } catch (e) {
            // An unreadable quote type falls back to the strictest reading: design required,
            // certificates not. Treating it as "can ship without design" would let an order
            // through on the strength of a failed lookup.
            log.error({
                title: opsyncConfig.logKey('QUOTE_TYPE_UNREADABLE'),
                details: 'Quote type ' + quoteTypeId + ' could not be read. Treated as ' +
                    'design-required. ' + e
            });
            gates = { noDesignRequired: false, requiresCerts: false };
        }

        cache[quoteTypeId] = gates;
        return gates;
    }

    /**
     * Decides whether one sales order is ready for delivery, and why not.
     *
     * TWO INDEPENDENT GATES, and an order is ready only when BOTH pass. Neither checkbox
     * short-circuits the other: a quote type with both ticked skips the design check and still
     * has its certificates checked.
     *
     * Readiness is evaluated against the status THIS SAVE is about to write, not the status the
     * order had on entry — the design gate is asking "will this order be far enough along once
     * this save lands", not "was it before".
     *
     * The first three certificate conditions have a LEGACY path — see resolveCertificate and the
     * note on the legacy constants in opsync_lib_config.js. Legacy evidence satisfies its
     * condition outright, so an order verified under the old process is ready even with a blank
     * installer. DNO and the BUS voucher have no legacy path and must never be given one.
     *
     * THE CERTIFICATE GATE IS THE DEFINITION OF A HEAT PUMP PROJECT for this script. The BUS
     * voucher condition sits inside it for exactly that reason and needs no field of its own to
     * decide what a heat pump is. custbody_value_proposition is deliberately NOT consulted: the
     * physical product decides these rules, not the commercial package, and a second definition
     * of "heat pump" in the same rule would be free to disagree with the first.
     *
     * The legacy values come off the CONTEXT, not the order: they live on the opportunity and
     * are read once per save. The evaluation rule is unchanged by that — only the source is.
     *
     * @param {Object} order - { quoteTypeId, subcontractReceived }
     * @param {string} decidedStatus - the Record Status this save will write
     * @param {Object} ctx - the per-opportunity readiness context
     * @returns {Object} { ready: boolean, reason: string, paths: Object }
     */
    function evaluateReadiness(order, decidedStatus, ctx) {
        var gates = getQuoteTypeGates(order.quoteTypeId, ctx.quoteTypeCache);
        var reasons = [];
        var paths = {};
        var qual;
        var pl;

        // (b) Design gate.
        if (!gates.noDesignRequired && !contains(decidedStatus, ctx.designOkStatuses)) {
            reasons.push('Design not complete');
        }

        // (c) Certificate gate. Three conditions evaluated INDEPENDENTLY, each with its own
        //     legacy path, plus DNO which has none.
        if (gates.requiresCerts) {

            // 1. Subcontract. Either field satisfies it.
            //
            //    BOTH sides go through the presence test. The modern field's type is still
            //    unconfirmed, and it was the last !isEmpty() presence test in this script — the
            //    one place a type change in the UI could still flip a condition to fail OPEN,
            //    in the ship-the-goods direction, with nothing logged.
            //
            //    IT ARRIVES FROM A lookupFields RESULT, NOT FROM THE RECORD, AND THAT IS WHY
            //    THE TEST WORKS. lookupValue() stringifies, so an unticked checkbox reaches
            //    here as the five-character string "false" rather than as boolean false — which
            //    is exactly the shape !isEmpty() reads as PRESENT. The presence test rejects
            //    'false' and 'F' by name for that case, so the lookup shape is covered as well
            //    as the record shape.
            //
            //    It is a date today, so this changes no behaviour. The point is that the class
            //    is closed rather than documented.
            if (isPresent(order.subcontractReceived)) {
                paths.subcontract = 'modern';
            } else if (isPresent(ctx.subcontractLegacy)) {
                paths.subcontract = 'legacy';
            } else {
                paths.subcontract = 'fail';
                reasons.push('Subcontract agreement not received');
            }

            // 2. Installer qualification.
            qual = resolveCertificate(ctx.qualLegacy, ctx.installerId, ctx.qualExpiry,
                ctx.today, 'Installer qualification certificate');
            paths.qualification = qual.path;
            if (qual.reason !== '') {
                reasons.push(qual.reason);
            }

            // 3. Public liability.
            pl = resolveCertificate(ctx.plLegacy, ctx.installerId, ctx.plExpiry,
                ctx.today, 'Public Liability certificate');
            paths.publicLiability = pl.path;
            if (pl.reason !== '') {
                // De-duplicate: both conditions raise the same reason when the installer is
                // blank, and one missing installer is one problem to fix.
                if (pl.reason !== INSTALLER_NOT_SET || qual.reason !== INSTALLER_NOT_SET) {
                    reasons.push(pl.reason);
                }
            }

            // 4. DNO. NO legacy equivalent exists, so there is no legacy path here. Blank or
            //    absent always fails — there is no "no news is good news".
            if (contains(ctx.dnoStatus, ctx.dnoOkValues)) {
                paths.dno = 'modern';
            } else {
                paths.dno = 'fail';
                reasons.push('Awaiting DNO');
            }

            // 5. BUS voucher. NO legacy path either, and for a firmer reason than DNO's: the BUS
            //    scheme postdates the old process entirely, so no legacy BUS field exists and
            //    the three legacy flags say nothing about a voucher. Do not wire them in.
            //
            //    THE BLANK CASE IS THE POINT. A blank intention is treated as INTENDED and holds
            //    the order, because a project that should have claimed a voucher and shipped
            //    without one cannot claim it retrospectively. The safe direction is to hold and
            //    ask.
            //
            //    THE THREE FAILURE REASONS ARE DELIBERATELY DIFFERENT and must not be merged.
            //    Each is actioned by a different person:
            //
            //      'BUS intention not confirmed'      a missing answer — somebody must decide
            //      'Awaiting BUS voucher application' nobody has applied yet — somebody's job
            //      'Awaiting BUS voucher approval'    applied and waiting on the scheme — a
            //                                         genuine wait, and nothing to chase here
            //
            //    AT MOST ONE OF THEM EVER APPEARS, because this is one if/else chain and not
            //    four independent tests. Do not refactor it into separate ifs: two BUS reasons
            //    in one hold string would read as two problems where there is one.
            //
            //    THE INTENTION QUESTION TAKES PRECEDENCE over the application question. A blank
            //    intention reports 'BUS intention not confirmed' whether or not an application
            //    date exists, because an application against an unrecorded intention is still
            //    an unanswered question — and answering it may make the whole condition moot.
            //
            //    ctx.busNoValue IS CHECKED FOR EMPTY FIRST, and that guard is load-bearing. An
            //    unset parameter leaves it '', a blank intention normalises to '' too, and a
            //    bare equality test would then match the two and switch the condition OFF for
            //    every order — turning a parameter that is supposed to fail closed into one that
            //    ships goods. See getBusNoValue() in opsync_lib_config.js.
            if (ctx.busNoValue !== '' && ctx.busRhiIntended === ctx.busNoValue) {
                paths.busVoucher = 'not intended';
            } else if (isPresent(ctx.voucherApprovalDate)) {
                // Presence only, never an expiry comparison: an approved voucher does not lapse
                // for this purpose.
                //
                // isPresent(), not isEmpty(), although the field is a CONFIRMED Date and
                // isEmpty() would be correct for one. The tolerant test is correct for a date
                // too, and a type change in the UI would flip an isEmpty() test to fail OPEN,
                // in the ship-the-goods direction. The class is closed, not the instance.
                paths.busVoucher = 'approved';
            } else if (isEmpty(ctx.busRhiIntended)) {
                paths.busVoucher = 'fail unconfirmed';
                reasons.push('BUS intention not confirmed');
            } else if (!isPresent(ctx.applicationDate)) {
                // Reached ONLY when the intention is recorded and not "No", and the voucher is
                // not yet approved. So the question is genuinely "has anyone applied", and a
                // blank application date is the answer.
                paths.busVoucher = 'fail not applied';
                reasons.push('Awaiting BUS voucher application');
            } else {
                paths.busVoucher = 'fail awaiting';
                reasons.push('Awaiting BUS voucher approval');
            }
        }

        return {
            ready: reasons.length === 0,
            reason: reasons.join('; '),
            paths: paths
        };
    }

    /**
     * Renders the certificate paths for the log. Empty when the certificate gate did not apply.
     *
     * @param {Object} paths
     * @returns {string}
     */
    function describePaths(paths) {
        var parts = [];

        if (!paths) {
            return '(none)';
        }

        Object.keys(paths).forEach(function (key) {
            parts.push(key + '=' + paths[key]);
        });

        return parts.length === 0 ? '(certificates not required)' : parts.join(' ');
    }

    /**
     * Brings one sales order into step with the opportunity: status, ship date, and readiness.
     *
     * Reads everything it needs in a SINGLE lookupFields and writes everything it changes in a
     * SINGLE submitFields. Every value comes off the lookup through opsyncConfig.lookupValue,
     * which checks length before indexing — the predecessor read
     * .custbody_finance_status[0].value unguarded and threw on any order whose status was blank.
     *
     * The opportunity's delivery date arrives as BOTH a comparison key and a writable value.
     * They are not interchangeable — see asDateKey and asDateForWrite.
     *
     * @param {string} orderId
     * @param {string|null} mappedStatusId - null when the sub-status maps to nothing, in which
     *        case the order keeps its own status and that becomes the decided status
     * @param {string} deliveryDateKey - comparison key. Compared, never written
     * @param {Date|string} deliveryDateValue - the original Date. Written, never compared
     * @param {string[]} excludedStatuses
     * @param {string} opportunityId - for the log only
     * @param {Object} ctx - the per-opportunity readiness context
     * @returns {string} 'updated', 'skipped' or 'unchanged'
     */
    function syncSalesOrder(orderId, mappedStatusId, deliveryDateKey, deliveryDateValue,
        excludedStatuses, opportunityId, ctx) {
        var lookup;
        var currentStatus;
        var currentShipDateKey;
        var currentReady;
        var currentReason;
        var quoteTypeId;
        var decidedStatus;
        var verdict = null;
        var targetExcluded;
        var shipDateSuppressed;
        var values = {};
        var changes = [];

        lookup = search.lookupFields({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            id: orderId,
            columns: [
                opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS,
                opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE,
                opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY,
                opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON,
                opsyncConfig.SALES_ORDER_FIELDS.QUOTE_TYPE,
                opsyncConfig.SALES_ORDER_FIELDS.SUBCONTRACT_RECEIVED
            ]
        });

        currentStatus = opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS);
        currentShipDateKey = asDateKey(opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE));
        currentReady = isTicked(lookup[opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY]);
        currentReason = opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON);
        quoteTypeId = opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.QUOTE_TYPE);

        // The exclusion tests the order's CURRENT status, not the status being written. An order
        // the warehouse or finance has moved on is theirs, and the opportunity does not reclaim
        // it. An empty current status is not excluded — it is exactly the order that needs one.
        if (contains(currentStatus, excludedStatuses)) {
            log.audit({
                title: opsyncConfig.logKey('ORDER_SKIPPED'),
                details: 'Sales order ' + orderId + ' left alone: its current Record Status (' +
                    currentStatus + ') is in the excluded list. Opportunity ' + opportunityId + '.'
            });
            return 'skipped';
        }

        // THE DECIDED STATUS — one definition, used by the exclusion test, the design gate and
        // the status write alike. The mapped status when there is one; otherwise the order's own
        // current status, because nothing is going to change it on this save.
        decidedStatus = (mappedStatusId === null) ? currentStatus : mappedStatusId;

        // The Record Status is written ONLY when the mapping produced one. An unmapped
        // sub-status means the order keeps the status it has — writing currentStatus back over
        // itself would be a no-op anyway, but the guard says so explicitly rather than relying
        // on that.
        if (mappedStatusId !== null && asId(currentStatus) !== asId(mappedStatusId)) {
            values[opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS] = mappedStatusId;
            changes.push('Record Status ' + (currentStatus || '(empty)') + ' -> ' + mappedStatusId);
        }

        // The ship date is INDEPENDENT of the mapping and always has been — it is a direct copy
        // from the opportunity, not something the status map governs. It is therefore written on
        // an unmapped save too, on its own comparison. (Before 1.3.0 an unmapped sub-status
        // returned before the loop, so in practice it was never written; that was a side effect
        // of the early exit, not a rule.)
        //
        // Both sides of the COMPARISON are date keys — see asDateKey. Comparing a Date against
        // a lookup string here would make every order look changed on every save.
        //
        // What is WRITTEN is the original Date, never the key. The key is a localised dd/mm
        // string and a mis-parse downstream would silently move the date. See asDateForWrite.
        //
        // SUPPRESSED BY STATUS. Once a job reaches design complete the delivery date is managed
        // on the SALES ORDER, and the opportunity must stop overwriting it. Only this ONE FIELD
        // is suppressed: the status write and the full readiness evaluation below both run
        // exactly as they would otherwise.
        //
        // NOT THE EXCLUDED LIST, and this is the distinction the whole design turns on. Adding
        // these statuses to custscript_opsync_excluded_statuses would skip the order entirely —
        // no status, no ship date and NO READINESS EVALUATION. Design Complete is the status
        // where readiness matters most, and Redraw Required is where readiness must DROP to
        // not-ready. Excluding either would silently disable delivery readiness for exactly the
        // orders it exists for. See docs/context.md section 4.
        //
        // IT TESTS THE DECIDED STATUS, not the status the order arrived with. So the save that
        // MOVES an order into Design Complete already stops syncing the date. That is the
        // boundary being the order reaching the stage, rather than the next save after it — see
        // the note on the alternative in docs/context.md section 4.
        shipDateSuppressed = contains(decidedStatus, ctx.noShipDateStatuses);

        if (currentShipDateKey !== deliveryDateKey) {
            if (shipDateSuppressed) {
                // Logged because a ship date silently NOT updating looks identical on the record
                // to one that did not need updating. Only logged when the write would actually
                // have happened — saying "suppressed" where nothing was going to be written
                // would be noise, and would make the real cases harder to find.
                log.debug({
                    title: opsyncConfig.logKey('SHIPDATE_SUPPRESSED'),
                    details: 'Sales order ' + orderId + ': expected ship date left at ' +
                        (currentShipDateKey || '(empty)') + ' rather than being set to ' +
                        (deliveryDateKey || '(empty)') + ', because its decided Record Status (' +
                        decidedStatus + ') is in ' +
                        opsyncConfig.PARAMETERS.NO_SHIPDATE_STATUSES + '. The delivery date is ' +
                        'managed on the sales order at this status. Status and readiness were ' +
                        'still evaluated and written as normal.'
                });
            } else {
                values[opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE] = deliveryDateValue;
                changes.push('ship date ' + (currentShipDateKey || '(empty)') + ' -> ' +
                    (deliveryDateKey || '(empty)'));
            }
        }

        // THE SECOND EXCLUSION TEST, on the status this save DECIDES rather than the one the
        // order arrived with. The status map can legitimately map a sub-status onto a value that
        // is itself excluded — Design Cancelled -> Cancelled is the standing example.
        //
        // When that happens the status and ship date are written as normal, and readiness is
        // left exactly as it is: not set to false, not given a reason, not included in the write
        // at all. An excluded status means the order is past the delivery gate or is dead, so
        // readiness is not applicable — and "not ready" on a delivered order is worse than
        // stale, it is wrong. See docs/context.md section 6.
        // On an unmapped save decidedStatus IS currentStatus, which already passed the entry
        // exclusion test above — so this can only fire when the mapping actually moved the order
        // onto an excluded status.
        targetExcluded = contains(decidedStatus, excludedStatuses);

        if (targetExcluded) {
            log.debug({
                title: opsyncConfig.logKey('READINESS_NOT_APPLICABLE'),
                details: 'Sales order ' + orderId + ': status ' + decidedStatus + ' is in the ' +
                    'excluded list, so readiness was not evaluated and both readiness fields ' +
                    'were left as they were (ready=' + currentReady + ').'
            });
        } else {
            verdict = evaluateReadiness({
                quoteTypeId: quoteTypeId,
                subcontractReceived: opsyncConfig.lookupValue(
                    lookup, opsyncConfig.SALES_ORDER_FIELDS.SUBCONTRACT_RECEIVED)
            }, decidedStatus, ctx);

            // The paths matter as much as the verdict. When a legacy order comes up in a year
            // and nobody remembers these fields exist, this line is the only thing that explains
            // why an order with a blank installer is ready to ship.
            log.debug({
                title: opsyncConfig.logKey('READINESS'),
                details: 'Sales order ' + orderId + ', quote type ' +
                    (quoteTypeId || '(none)') + ', status ' + decidedStatus +
                    (mappedStatusId === null ? ' (unmapped — order\'s own)' : ' (mapped)') +
                    ', ready=' +
                    verdict.ready + ', reason=' + (verdict.reason || '(none)') +
                    ', paths=' + describePaths(verdict.paths) +
                    ', dnoRaw=' + JSON.stringify(ctx.dnoStatusRaw) +
                    ' -> ' + (ctx.dnoStatus || '(blank)') +
                    ', dnoOk=' + ctx.dnoOkValues.join('/') +
                    ', rhiRaw=' + JSON.stringify(ctx.busRhiIntendedRaw) +
                    ' -> ' + (ctx.busRhiIntended || '(blank)') +
                    ', busNo=' + (ctx.busNoValue || '(unset — condition applies to all)') +
                    ', voucherDate=' + (asDateKey(ctx.voucherApprovalDate) || '(blank)') +
                    ', applicationDate=' + (asDateKey(ctx.applicationDate) || '(blank)')
            });

            // Both fields are written together or not at all: a reason without its checkbox, or
            // a checkbox without its reason, reads as a contradiction on the record.
            if (verdict.ready !== currentReady || verdict.reason !== currentReason) {
                values[opsyncConfig.SALES_ORDER_FIELDS.READY_FOR_DELIVERY] = verdict.ready;
                values[opsyncConfig.SALES_ORDER_FIELDS.DELIVERY_HOLD_REASON] = verdict.reason;
                changes.push('ready ' + currentReady + ' -> ' + verdict.ready +
                    ' (' + (verdict.reason || 'no hold') + ')');
            }
        }

        // Readiness alone is enough to justify the write — the status and ship date may both be
        // unchanged while a certificate has expired since the last save.
        if (changes.length === 0) {
            log.debug({
                title: opsyncConfig.logKey('ORDER_UNCHANGED'),
                details: 'Sales order ' + orderId + ' already matches the opportunity. Nothing ' +
                    'written — no submitFields, no system note.'
            });
            return 'unchanged';
        }

        record.submitFields({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            id: orderId,
            values: values
        });

        log.audit({
            title: opsyncConfig.logKey('ORDER_UPDATED'),
            details: 'Sales order ' + orderId + ' updated from opportunity ' + opportunityId +
                ': ' + changes.join('; ') + '.'
        });

        return 'updated';
    }

    /**
     * Builds the per-opportunity context, ONCE, before the sales order loop.
     *
     * Mostly readiness, and named for that, but it also carries the ship-date suppression list —
     * which is not a readiness value at all. It lives here because the rule that governs it is
     * the same one: every throwing parameter is resolved before the loop.
     *
     * Two things are resolved here and nowhere else:
     *
     * 1. The five throwing parameters, plus getBusNoValue() which does not throw. They are read
     *    UP FRONT precisely so that a missing one
     *    throws before a single order has been written — a throw from inside the loop would
     *    leave some orders updated and the rest not, which is the "no partial writes" the brief
     *    asks for. See the note on requiredParameter() in opsync_lib_config.js.
     *
     * 2. The DNO status, the BUS voucher pair and the three LEGACY evidence flags, straight off
     *    the opportunity — no lookup at all.
     *    Because they are opportunity-level, they satisfy the certificate gate for EVERY linked
     *    sales order, including any order added later. That is intended: the flags record that
     *    the work was verified under the old process, and the opportunity is the unit that
     *    process operated on.
     *
     * 3. The installer's two certificate expiry dates, in ONE lookupFields, cached for the whole
     *    loop. The equivalent fields on the opportunity are unstored sourced fields and cannot
     *    be read by a search, so the script goes to the customer record custbody_installer_ns
     *    points at. When the installer is blank the lookup is skipped entirely — there is
     *    nothing to look up, and the certificate gate reports the missing installer instead.
     *
     * @param {Record} newRecord
     * @param {Record} oldRecord
     * @param {boolean} sparse
     * @returns {Object} the readiness context
     * @throws {Error} OPPSYNC_PARAMETER_MISSING if any required parameter is unset
     */
    function buildReadinessContext(newRecord, oldRecord, sparse) {
        var ctx = {
            designOkStatuses: opsyncConfig.getDesignOkStatuses(),
            dnoOkValues: opsyncConfig.getDnoOkValues(),
            // Not a readiness value — it governs the SHIP DATE write. It is resolved here for
            // the same reason the readiness parameters are: every throwing parameter must be
            // read BEFORE the sales order loop, so a missing one cannot leave some orders
            // written and the rest not.
            noShipDateStatuses: opsyncConfig.getNoShipDateStatuses(),
            installerId: '',
            qualExpiry: '',
            plExpiry: '',
            // The DNO status is on the OPPORTUNITY — the sales order has no DNO field at all.
            // The RAW shape is kept alongside the normalised id because it goes in the log: this
            // check once failed for a whole Sandbox cycle with no error and no clue as to why.
            dnoStatusRaw: effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.DNO_STATUS, sparse),

            // Legacy evidence also lives on the OPPORTUNITY, so it too is read once here from
            // the record being saved — no lookupFields, and not per order. All of these go
            // through effectiveValue like the installer, so a sparse XEDIT newRecord falls back
            // to oldRecord rather than reading a populated flag as blank and holding every
            // linked order.
            subcontractLegacy: effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.SUBCONTRACT_LEGACY, sparse),
            qualLegacy: effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.QUAL_LOGGED_LEGACY, sparse),
            plLegacy: effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.PL_LOGGED_LEGACY, sparse),

            // The BUS voucher pair is on the OPPORTUNITY too, and is read here ONCE for the same
            // reason — not per order. Both go through effectiveValue so a sparse XEDIT newRecord
            // falls back to oldRecord: reading a populated voucher date as blank would hold every
            // linked order on an inline edit of something else entirely.
            //
            // The raw intention is kept alongside the normalised id because it goes in the log,
            // exactly as dnoStatusRaw is. A select read off a record is a plain id string, but the
            // same field read through a search is an array of {value,text} — so it is normalised
            // through asSelectId() below and never through String().
            busRhiIntendedRaw: effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.BUS_RHI_INTENDED, sparse),
            // A Date object from record.getValue(). Tested for PRESENCE only, through
            // isPresent() rather than isEmpty() — never parsed, never compared to today.
            // An approved voucher does not expire.
            voucherApprovalDate: effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.VOUCHER_APPROVAL_DATE,
                sparse),
            // The APPLICATION date, which is not the approval date and must never be read as
            // one. Same source, same helper, same presence test — and consulted only after the
            // approval date has been found blank, so it cannot contradict an approval.
            //
            // ON THE OPPORTUNITY, Date — confirmed from the field definition's Applies To, so
            // this read is the right one. Were it ever moved, this would return blank rather
            // than erroring and every 'Awaiting BUS voucher approval' would silently become
            // 'Awaiting BUS voucher application'. Section 9 scenario 70 is what would catch it.
            applicationDate: effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.APPLICATION_DATE, sparse),
            // '' when the parameter is unset, which applies the BUS condition to everything
            // rather than to nothing. It does not throw — see getBusNoValue().
            busNoValue: opsyncConfig.getBusNoValue(),

            today: todayDayNumber(),
            quoteTypeCache: {}
        };
        var qualField = opsyncConfig.getCustomerQualField();
        var plField = opsyncConfig.getCustomerPlField();
        var lookup;

        // Selects are normalised through asSelectId, not asId: record.getValue returns a plain
        // id string, but the same field read through a search returns an array of {value,text},
        // and String() on that is '[object Object]'.
        ctx.dnoStatus = asSelectId(ctx.dnoStatusRaw);
        ctx.busRhiIntended = asSelectId(ctx.busRhiIntendedRaw);

        ctx.installerId = asSelectId(effectiveValue(
            newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.INSTALLER, sparse));

        if (isEmpty(ctx.installerId)) {
            return ctx;
        }

        try {
            lookup = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: ctx.installerId,
                columns: [qualField, plField]
            });
            // Through lookupValue, which checks length before indexing — lookupFields returns an
            // empty array for an empty field.
            ctx.qualExpiry = opsyncConfig.lookupValue(lookup, qualField);
            ctx.plExpiry = opsyncConfig.lookupValue(lookup, plField);
        } catch (e) {
            // An unreadable installer leaves both dates blank, so the certificate gate reports
            // them as missing. That is the safe direction: it holds the order rather than
            // shipping it on the strength of a failed lookup.
            log.error({
                title: opsyncConfig.logKey('INSTALLER_UNREADABLE'),
                details: 'Installer customer ' + ctx.installerId + ' could not be read for ' +
                    qualField + ' / ' + plField + '. Both certificates will read as missing. ' + e
            });
        }

        return ctx;
    }

    /**
     * Entry point. See docs/context.md section 4 for the agreed flow.
     *
     * @param {Object} context
     */
    function afterSubmit(context) {
        var newRecord;
        var oldRecord;
        var sparse;
        var opportunityId;
        var entityStatus;
        var qualifyingStatuses;
        var excludedStatuses;
        var subStatus;
        var deliveryDateKey;
        var deliveryDateValue;
        var deliveryDateRaw;
        var mappedStatusId;
        var orderIds;
        var readinessContext;
        var processed = 0;
        var updated = 0;
        var skipped = 0;
        var unchanged = 0;
        var outcome;
        var i;

        try {
            // 1. CREATE, EDIT or XEDIT only. Never DELETE — there is no opportunity left to sync
            //    from, and the orders keep whatever they last had.
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT &&
                context.type !== context.UserEventType.XEDIT) {
                return;
            }

            newRecord = context.newRecord;
            oldRecord = context.oldRecord;
            sparse = (context.type === context.UserEventType.XEDIT);
            opportunityId = newRecord ? String(newRecord.id) : '';

            // 2. entitystatus from newRecord if it carries it, otherwise from oldRecord. See
            //    effectiveValue — on XEDIT newRecord holds only the edited fields, and a gate
            //    reading straight off it exits on every valid inline edit without logging.
            entityStatus = asSelectId(effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.ENTITY_STATUS, true));

            // 3. The gate. An empty qualifying list means the parameter is unset; the library has
            //    already logged that at error, and the gate stays shut rather than opening wide.
            qualifyingStatuses = opsyncConfig.getQualifyingStatuses();
            if (!contains(entityStatus, qualifyingStatuses)) {
                return;
            }

            subStatus = asSelectId(effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.SUB_STATUS, sparse));
            // Read the delivery date ONCE, then derive both forms from it: a key for comparing
            // and the original Date for writing. See asDateKey and asDateForWrite — they are
            // deliberately not the same value and must not be merged.
            deliveryDateRaw = effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.DELIVERY_DATE, sparse);
            deliveryDateKey = asDateKey(deliveryDateRaw);
            deliveryDateValue = asDateForWrite(deliveryDateRaw);

            // 4. NO "HAS THE SUB-STATUS CHANGED" SHORT-CIRCUIT. Deliberately removed in 1.2.0,
            //    and it must not come back.
            //
            //    Phase 2 exited here when neither the sub-status nor the delivery date had moved
            //    since oldRecord. That was correct while those two fields were the only inputs:
            //    if neither changed, nothing downstream could have changed either.
            //
            //    Readiness broke that assumption. It depends on the installer, the two
            //    certificate dates on the installer's CUSTOMER record, the subcontract date,
            //    custbody38, the quote type and the legacy evidence fields — none of which the
            //    sub-status knows anything about. Editing a won opportunity to populate the
            //    installer left every linked order untouched, because the sub-status had not
            //    moved.
            //
            //    So every save of a qualifying opportunity now evaluates readiness. The
            //    "don't write when nothing changed" optimisation still holds, but it lives at
            //    the VALUE level in syncSalesOrder(): each value is compared with what the order
            //    already holds, unchanged ones are left out of the submitFields call, and an
            //    order with nothing to change is not written at all. That is also what keeps the
            //    feedback loop in docs/context.md section 0, trap 3 broken — the guard is the
            //    value comparison, never the early exit.

            // 5. Resolve through the mapping. NEVER copy the raw sub-status across: the two
            //    lists share no ids and no values, and a raw copy writes a warehouse
            //    instruction. See docs/context.md section 0, trap 1. There is no default and
            //    there must never be one.
            //
            //    NO MAPPING NO LONGER STOPS THE SAVE — removed in 1.3.0, and it must not come
            //    back. It used to return here, before the orders were even searched, so a won
            //    opportunity at an unmapped sub-status never had its readiness refreshed.
            //
            //    The map governs STATUS PROPAGATION. It does not govern whether an order is fit
            //    to ship, and whether readiness refreshes must not depend on whether a
            //    sub-status happens to appear in it. A won opportunity at Partially Delivered or
            //    Delivery Complete can still carry a linked order that has not shipped — one
            //    opportunity may have several orders.
            //
            //    So mappedStatusId stays null and each order falls back to its OWN current
            //    status as its decided status. See syncSalesOrder.
            mappedStatusId = opsyncConfig.getMappedStatus(subStatus);
            if (mappedStatusId === null) {
                log.audit({
                    title: opsyncConfig.logKey('NO_MAPPING'),
                    details: 'Opportunity ' + opportunityId + ' sub-status ' +
                        (subStatus || '(empty)') + ' resolves to no Record Status, so no ' +
                        'Record Status will be written. Readiness is still evaluated against ' +
                        'each order\'s own current status. Most sub-statuses are deliberately ' +
                        'unmapped — see docs/context.md section 5. If a duplicate or a ' +
                        'malformed entry in the mapping parameter was the cause, ' +
                        opsyncConfig.logKey('MAP_AMBIGUOUS') + ' and ' +
                        opsyncConfig.logKey('MAP_INVALID_ENTRY') + ' name it.'
                });
            }

            excludedStatuses = opsyncConfig.getExcludedStatuses();

            // Readiness context BEFORE the loop: the readiness parameters (so a missing throwing
            // one throws before anything is written) and the installer's certificates (one
            // lookup, cached for every order). See buildReadinessContext.
            readinessContext = buildReadinessContext(newRecord, oldRecord, sparse);

            // 6. One opportunity may have several sales orders.
            orderIds = findSalesOrders(opportunityId);
            if (orderIds.length === 0) {
                return;
            }

            // 7. Each order in its own try/catch, so one bad order does not stop the rest.
            for (i = 0; i < orderIds.length; i += 1) {

                // 8. Stop cleanly while there is still governance left, and say what was left
                //    undone. Dying mid-loop would leave some orders updated and the rest silently
                //    untouched, with no record of which were which.
                if (runtime.getCurrentScript().getRemainingUsage() < GOVERNANCE_FLOOR_UNITS) {
                    log.error({
                        title: opsyncConfig.logKey('GOVERNANCE_STOP'),
                        details: 'Stopped after ' + processed + ' of ' + orderIds.length +
                            ' sales orders for opportunity ' + opportunityId +
                            '. Not processed: ' + orderIds.slice(i).join(', ') +
                            '. Re-save the opportunity to pick them up.'
                    });
                    return;
                }

                try {
                    outcome = syncSalesOrder(orderIds[i], mappedStatusId, deliveryDateKey,
                        deliveryDateValue, excludedStatuses, opportunityId, readinessContext);
                    processed += 1;
                    if (outcome === 'updated') {
                        updated += 1;
                    } else if (outcome === 'skipped') {
                        skipped += 1;
                    } else {
                        unchanged += 1;
                    }
                } catch (orderError) {
                    log.error({
                        title: opsyncConfig.logKey('ORDER_FAILED'),
                        details: 'Sales order ' + orderIds[i] + ' could not be synced from ' +
                            'opportunity ' + opportunityId + '. The remaining orders were still ' +
                            'processed. ' + orderError
                    });
                }
            }

            // One summary per opportunity, so the execution log can be read at the level of
            // "what did this save do" without reconstructing it from the per-order lines.
            log.audit({
                title: opsyncConfig.logKey('SYNC_SUMMARY'),
                details: 'Opportunity ' + opportunityId + ': ' + orderIds.length +
                    ' sales order(s) — ' + updated + ' updated, ' + unchanged + ' unchanged, ' +
                    skipped + ' skipped as excluded. Status ' +
                    (mappedStatusId === null ? '(unmapped — not written)' : mappedStatusId) + '.'
            });

        } catch (e) {
            // The opportunity has already saved. Nothing here may change that.
            log.error({
                title: opsyncConfig.logKey('FAILED'),
                details: 'Sync failed for opportunity ' +
                    (context && context.newRecord ? context.newRecord.id : 'unknown') +
                    ' on ' + (context ? context.type : 'unknown') +
                    '. The opportunity saved normally; its sales orders may be out of step. ' + e
            });
        }
    }

    return {
        VERSION: VERSION,
        afterSubmit: afterSubmit
    };
});
