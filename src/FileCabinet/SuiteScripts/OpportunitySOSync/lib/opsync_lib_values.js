/**
 * opsync_lib_values.js
 *
 * The value-shape layer for the Opportunity -> Sales Order sync. Every function here answers one
 * question: what does this value actually MEAN, given that NetSuite hands the same field back in
 * different shapes depending on which API asked for it.
 *
 * WHY THIS IS ITS OWN MODULE. Two entry points now evaluate delivery readiness — the opportunity
 * and the sales order — and they must agree. Two copies of asSelectId() would be two chances to
 * normalise a select differently, and the failure would be silent: a value compared in the wrong
 * shape fails as a legitimate "not acceptable" rather than as an error. One copy, both callers.
 *
 * WHY NOT opsync_lib_config.js. That file is configuration — script IDs and parameters. Putting
 * behaviour in a file named config is how buildReadinessContext() ended up carrying values that
 * are not readiness. A module's name has to describe its contents or it stops being a guide.
 *
 * WHY NOT opsync_lib_readiness.js. readField() and effectiveValue() read a NetSuite record and
 * know about XEDIT's sparse newRecord. That is not readiness, and the same rule applies.
 *
 * Every function in this file was MOVED here unchanged from opsync_ue_opportunity.js 1.7.0. The
 * comments came with them, because they record failures this project actually had.
 *
 * Shared AMD module: no script record and no deployment record is required. It must be uploaded
 * to the File Cabinet before any entry-point script, which will otherwise fail at load time.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/format'], function (format) {

    'use strict';

    var VERSION = '1.0.0';

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
     * True when a checkbox value from search.lookupFields is ticked. lookupFields returns a
     * boolean for a checkbox, but a string slips through often enough to be worth tolerating.
     *
     * @param {*} value
     * @returns {boolean}
     */
    function isTicked(value) {
        return value === true || value === 'T' || value === 'true';
    }

    return {
        VERSION: VERSION,
        isEmpty: isEmpty,
        isPresent: isPresent,
        readField: readField,
        asId: asId,
        asSelectId: asSelectId,
        asDateKey: asDateKey,
        asDateForWrite: asDateForWrite,
        asDayNumber: asDayNumber,
        parseLookupDate: parseLookupDate,
        todayDayNumber: todayDayNumber,
        contains: contains,
        effectiveValue: effectiveValue,
        isTicked: isTicked
    };
});
