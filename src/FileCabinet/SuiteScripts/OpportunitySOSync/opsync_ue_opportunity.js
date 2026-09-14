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
 * @version 1.0.1
 */
define(['N/search', 'N/record', 'N/format', 'N/runtime', 'N/log', './lib/opsync_lib_config'],
    function (search, record, format, runtime, log, opsyncConfig) {

    'use strict';

    var VERSION = '1.0.1';

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
     * Brings one sales order into step with the opportunity.
     *
     * Reads the order's current Record Status and ship date in a single lookupFields, and takes
     * every value off that result through opsyncConfig.lookupValue — which checks length before
     * indexing. The predecessor read .custbody_finance_status[0].value unguarded and threw on
     * any order whose status was blank; that is the specific bug that made it fragile.
     *
     * The opportunity's delivery date arrives as BOTH a comparison key and a writable value.
     * They are not interchangeable — see asDateKey and asDateForWrite.
     *
     * @param {string} orderId
     * @param {string} mappedStatusId
     * @param {string} deliveryDateKey - comparison key. Compared, never written
     * @param {Date|string} deliveryDateValue - the original Date. Written, never compared
     * @param {string[]} excludedStatuses
     * @param {string} opportunityId - for the log only
     */
    function syncSalesOrder(orderId, mappedStatusId, deliveryDateKey, deliveryDateValue,
        excludedStatuses, opportunityId) {
        var lookup;
        var currentStatus;
        var currentShipDateKey;
        var values = {};
        var changes = [];

        lookup = search.lookupFields({
            type: opsyncConfig.RECORD_TYPES.SALES_ORDER,
            id: orderId,
            columns: [
                opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS,
                opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE
            ]
        });

        currentStatus = opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS);
        currentShipDateKey = asDateKey(opsyncConfig.lookupValue(
            lookup, opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE));

        // The exclusion tests the order's CURRENT status, not the status being written. An order
        // the warehouse or finance has moved on is theirs, and the opportunity does not reclaim
        // it. An empty current status is not excluded — it is exactly the order that needs one.
        if (contains(currentStatus, excludedStatuses)) {
            log.audit({
                title: opsyncConfig.logKey('ORDER_SKIPPED'),
                details: 'Sales order ' + orderId + ' left alone: its current Record Status (' +
                    currentStatus + ') is in the excluded list. Opportunity ' + opportunityId + '.'
            });
            return;
        }

        if (asId(currentStatus) !== asId(mappedStatusId)) {
            values[opsyncConfig.SALES_ORDER_FIELDS.RECORD_STATUS] = mappedStatusId;
            changes.push('Record Status ' + (currentStatus || '(empty)') + ' -> ' + mappedStatusId);
        }

        // Both sides of the COMPARISON are date keys — see asDateKey. Comparing a Date against
        // a lookup string here would make every order look changed on every save.
        //
        // What is WRITTEN is the original Date, never the key. The key is a localised dd/mm
        // string and a mis-parse downstream would silently move the date. See asDateForWrite.
        if (currentShipDateKey !== deliveryDateKey) {
            values[opsyncConfig.SALES_ORDER_FIELDS.SHIP_DATE] = deliveryDateValue;
            changes.push('ship date ' + (currentShipDateKey || '(empty)') + ' -> ' +
                (deliveryDateKey || '(empty)'));
        }

        if (changes.length === 0) {
            log.debug({
                title: opsyncConfig.logKey('ORDER_UNCHANGED'),
                details: 'Sales order ' + orderId + ' already matches the opportunity. Nothing ' +
                    'written — no submitFields, no system note.'
            });
            return;
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
        var processed = 0;
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
            entityStatus = asId(effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.ENTITY_STATUS, true));

            // 3. The gate. An empty qualifying list means the parameter is unset; the library has
            //    already logged that at error, and the gate stays shut rather than opening wide.
            qualifyingStatuses = opsyncConfig.getQualifyingStatuses();
            if (!contains(entityStatus, qualifyingStatuses)) {
                return;
            }

            subStatus = asId(effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.SUB_STATUS, sparse));
            // Read the delivery date ONCE, then derive both forms from it: a key for comparing
            // and the original Date for writing. See asDateKey and asDateForWrite — they are
            // deliberately not the same value and must not be merged.
            deliveryDateRaw = effectiveValue(
                newRecord, oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.DELIVERY_DATE, sparse);
            deliveryDateKey = asDateKey(deliveryDateRaw);
            deliveryDateValue = asDateForWrite(deliveryDateRaw);

            // 4. Something relevant must have changed. On CREATE there is no oldRecord and
            //    everything is new, so proceed. On XEDIT the effectiveValue fallback above means
            //    a field absent from newRecord reads back as its old value and therefore
            //    compares equal — absence of both fields is correctly read as "neither changed".
            if (context.type !== context.UserEventType.CREATE) {
                if (subStatus === asId(readField(
                        oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.SUB_STATUS)) &&
                    deliveryDateKey === asDateKey(readField(
                        oldRecord, opsyncConfig.OPPORTUNITY_FIELDS.DELIVERY_DATE))) {
                    return;
                }
            }

            // 5. Resolve through the mapping. NEVER copy the raw sub-status across: the two lists
            //    share no ids and no values, and a raw copy writes a warehouse instruction. See
            //    docs/context.md section 0, trap 1. No mapping means stop — there is no default
            //    and there must never be one.
            mappedStatusId = opsyncConfig.getMappedStatus(subStatus);
            if (mappedStatusId === null) {
                log.audit({
                    title: opsyncConfig.logKey('NO_MAPPING'),
                    details: 'Opportunity ' + opportunityId + ' sub-status ' +
                        (subStatus || '(empty)') + ' resolves to no single active Record Status. ' +
                        'No sales order was touched. Most sub-statuses are deliberately unmapped ' +
                        '— see docs/context.md section 5. If an ambiguity was the cause, ' +
                        opsyncConfig.logKey('MAPPING_AMBIGUOUS') + ' names the records.'
                });
                return;
            }

            excludedStatuses = opsyncConfig.getExcludedStatuses();

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
                    syncSalesOrder(orderIds[i], mappedStatusId, deliveryDateKey,
                        deliveryDateValue, excludedStatuses, opportunityId);
                    processed += 1;
                } catch (orderError) {
                    log.error({
                        title: opsyncConfig.logKey('ORDER_FAILED'),
                        details: 'Sales order ' + orderIds[i] + ' could not be synced from ' +
                            'opportunity ' + opportunityId + '. The remaining orders were still ' +
                            'processed. ' + orderError
                    });
                }
            }

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
