/**
 * opsync_lib_readiness.js
 *
 * THE ONE definition of whether a sales order is ready for delivery. Two entry points call it —
 * opsync_ue_opportunity.js and opsync_ue_salesorder.js — and neither has a copy of the rule.
 *
 * WHY IT IS A MODULE AT ALL. Before 1.8.0 the evaluation lived inside the opportunity user
 * event, which meant readiness only refreshed when somebody saved the OPPORTUNITY. Once design
 * is complete people work on the sales order — the subcontract date, the quote type, the finance
 * status — and nothing re-evaluated, so the two readiness fields went stale exactly when the
 * order was in active use. Fixing that needed a second caller, and a second caller needs one
 * shared rule rather than two that drift.
 *
 * IF THE TWO CALLERS EVER DISAGREE the result is worse than either answer on its own: each
 * writes its verdict over the other's, on a record people are reading, with nothing logged to
 * say they differ. This file existing is the defence. Do not inline "just this one check" into
 * either caller.
 *
 * IT TAKES A CONTEXT, NOT A RECORD. Nothing here loads a record or runs a search — the callers
 * fetch, this decides. That is what lets the same rule serve a caller reading off the record
 * being saved and a caller reading through lookupFields, which return the same field in
 * different shapes.
 *
 * NOT IN opsync_lib_config.js. That file is configuration. Behaviour in a file named config is
 * how buildReadinessContext() ended up carrying values that are not readiness.
 *
 * The rule itself was MOVED here unchanged from opsync_ue_opportunity.js 1.7.0, comments and
 * all — they record failures this project actually had. See docs/context.md section 4.
 *
 * Shared AMD module: no script record and no deployment record is required.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['./opsync_lib_values'], function (values) {

    'use strict';

    var VERSION = '1.0.0';

    /**
     * Raised by the qualification condition and by the public liability condition independently.
     * It is de-duplicated before the reasons are joined: one missing installer is one problem to
     * fix, and saying so twice reads as two.
     * @type {string}
     */
    var INSTALLER_NOT_SET = 'Installer not set on opportunity';

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
        var day = values.asDayNumber(values.parseLookupDate(rawDate));

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
        if (values.isPresent(legacyValue)) {
            return { reason: '', path: 'legacy' };
        }

        if (values.isEmpty(installerId)) {
            return { reason: INSTALLER_NOT_SET, path: 'no installer' };
        }

        var failure = expiryFailure(rawExpiry, today, label);
        return { reason: failure, path: failure === '' ? 'modern' : 'modern fail' };
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
     * The legacy values come off the OPPORTUNITY CONTEXT, not the order: they live on the
     * opportunity. The evaluation rule is unchanged by that — only the source is.
     *
     * IT TAKES A CONTEXT, NOT A RECORD, and that is the whole point of this module. Two entry
     * points call it — the opportunity user event and the sales order user event — and they
     * reach the same values by different routes: the opportunity script reads them off the
     * record being saved, the sales order script reads them through lookupFields. A select is a
     * plain id string one way and an array of {value,text} the other; a date is a Date object
     * one way and a localised string the other. Every value here is therefore normalised by
     * opsync_lib_values, which accepts both shapes, and NOTHING in this function may load a
     * record or run a search. If it needs a new value, the CALLERS fetch it.
     *
     * THE TWO CALLERS MUST AGREE. An order the opportunity thinks is ready and the sales order
     * thinks is not is worse than either answer alone, and the disagreement is silent — each
     * writes its own verdict over the other's. One copy of this logic is the only defence.
     *
     * @param {Object} oppContext - everything that comes from the OPPORTUNITY and the
     *        parameters: installerId, qualExpiry, plExpiry, dnoStatus, subcontractLegacy,
     *        qualLegacy, plLegacy, busRhiIntended, voucherApprovalDate, applicationDate,
     *        busNoValue, designOkStatuses, dnoOkValues, today
     * @param {Object} orderFacts - everything that comes from the ORDER: quoteTypeId,
     *        noDesignRequired, requiresCerts, decidedStatus, subcontractReceived
     * @returns {Object} { ready: boolean, reason: string, paths: Object }
     */
    function evaluate(oppContext, orderFacts) {
        var gates = {
            noDesignRequired: orderFacts.noDesignRequired === true,
            requiresCerts: orderFacts.requiresCerts === true
        };
        var decidedStatus = orderFacts.decidedStatus;
        var reasons = [];
        var paths = {};
        var qual;
        var pl;

        // (b) Design gate.
        if (!gates.noDesignRequired &&
                !values.contains(decidedStatus, oppContext.designOkStatuses)) {
            reasons.push('Design not complete');
        }

        // (c) Certificate gate. Three conditions evaluated INDEPENDENTLY, each with its own
        //     legacy path, plus DNO which has none.
        if (gates.requiresCerts) {

            // 1. Subcontract. Either field satisfies it.
            //
            //    BOTH sides go through the presence test. The modern field's type is still
            //    unconfirmed, and it was the last !isEmpty() presence test in this project — the
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
            if (values.isPresent(orderFacts.subcontractReceived)) {
                paths.subcontract = 'modern';
            } else if (values.isPresent(oppContext.subcontractLegacy)) {
                paths.subcontract = 'legacy';
            } else {
                paths.subcontract = 'fail';
                reasons.push('Subcontract agreement not received');
            }

            // 2. Installer qualification.
            qual = resolveCertificate(oppContext.qualLegacy, oppContext.installerId,
                oppContext.qualExpiry, oppContext.today, 'Installer qualification certificate');
            paths.qualification = qual.path;
            if (qual.reason !== '') {
                reasons.push(qual.reason);
            }

            // 3. Public liability.
            pl = resolveCertificate(oppContext.plLegacy, oppContext.installerId,
                oppContext.plExpiry, oppContext.today, 'Public Liability certificate');
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
            if (values.contains(oppContext.dnoStatus, oppContext.dnoOkValues)) {
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
            //    busNoValue IS CHECKED FOR EMPTY FIRST, and that guard is load-bearing. An
            //    unset parameter leaves it '', a blank intention normalises to '' too, and a
            //    bare equality test would then match the two and switch the condition OFF for
            //    every order — turning a parameter that is supposed to fail closed into one that
            //    ships goods. See getBusNoValue() in opsync_lib_config.js.
            if (oppContext.busNoValue !== '' &&
                    oppContext.busRhiIntended === oppContext.busNoValue) {
                paths.busVoucher = 'not intended';
            } else if (values.isPresent(oppContext.voucherApprovalDate)) {
                // Presence only, never an expiry comparison: an approved voucher does not lapse
                // for this purpose.
                //
                // isPresent(), not isEmpty(), although the field is a CONFIRMED Date and
                // isEmpty() would be correct for one. The tolerant test is correct for a date
                // too, and a type change in the UI would flip an isEmpty() test to fail OPEN,
                // in the ship-the-goods direction. The class is closed, not the instance.
                paths.busVoucher = 'approved';
            } else if (values.isEmpty(oppContext.busRhiIntended)) {
                paths.busVoucher = 'fail unconfirmed';
                reasons.push('BUS intention not confirmed');
            } else if (!values.isPresent(oppContext.applicationDate)) {
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

    return {
        VERSION: VERSION,
        INSTALLER_NOT_SET: INSTALLER_NOT_SET,
        evaluate: evaluate,
        describePaths: describePaths
    };
});
