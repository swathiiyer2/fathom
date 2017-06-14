const {forEach, map} = require('wu');

const {CycleError} = require('./exceptions');
const {Fnode} = require('./fnode');
const {getDefault, isDomElement, NiceSet, reversed, setDefault, toposort} = require('./utils');
const {out, OutwardRhs} = require('./rhs');


/**
 * Construct and return the proper type of rule class based on the
 * inwardness/outwardness of the RHS.
 */
function rule(lhs, rhs) {
    // Since out() is a valid call only on the RHS (unlike type()), we can take
    // a shortcut here: any outward RHS will already be an OutwardRhs; we don't
    // need to sidetrack it through being a Side. And OutwardRhs has an asRhs()
    // that just returns itself.
    return new ((rhs instanceof OutwardRhs) ? OutwardRule : InwardRule)(lhs, rhs);
}

/**
 * Return a new :class:`Ruleset` containing the given rules.
 */
function ruleset(...rules) {
    return new Ruleset(...rules);
}

/**
 * An unbound ruleset. Eventually, you'll be able to add rules to these. Then,
 * when you bind them by calling :func:`~Ruleset.against()`, the resulting
 * :class:`BoundRuleset` will be immutable.
 */
class Ruleset {
    constructor(...rules) {
        this._inRules = [];
        this._outRules = new Map();  // key -> rule
        this._rulesThatCouldEmit = new Map();  // type -> [rules]
        this._rulesThatCouldAdd = new Map();  // type -> [rules]

        // Separate rules into out ones and in ones, and sock them away. We do
        // this here so mistakes raise errors early.
        for (let rule of rules) {
            if (rule instanceof InwardRule) {
                this._inRules.push(rule);

                // Keep track of what inward rules can emit or add:
                // TODO: Combine these hashes for space efficiency:
                const emittedTypes = rule.typesItCouldEmit();
                for (let type of emittedTypes) {
                    setDefault(this._rulesThatCouldEmit, type, () => []).push(rule);
                }
                for (let type of rule.typesItCouldAdd()) {
                    setDefault(this._rulesThatCouldAdd, type, () => []).push(rule);
                }
            } else if (rule instanceof OutwardRule) {
                this._outRules.set(rule.key(), rule);
            } else {
                throw new Error(`This input to ruleset() wasn't a rule: ${rule}`);
            }
        }
    }

    /**
     * Commit this ruleset to running against a specific DOM tree.
     *
     * This doesn't actually modify the Ruleset but rather returns a fresh
     * BoundRuleset, which contains caches and other stateful, per-DOM
     * bric-a-brac.
     */
    against(doc) {
        return new BoundRuleset(doc,
                                this._inRules,
                                this._outRules,
                                this._rulesThatCouldEmit,
                                this._rulesThatCouldAdd);
    }

    /**
     * Return all the rules (both inward and outward) that make up this ruleset.
     *
     * From this, you can construct another ruleset like this one but with your
     * own rules added.
     */
    rules() {
        return Array.from([...this._inRules, ...this._outRules.values()]);
    }
}

/**
 * A ruleset that is earmarked to analyze a certain DOM
 *
 * Carries a cache of rule results on that DOM. Typically comes from
 * :func:`Ruleset.against`.
 */
class BoundRuleset {
    /**
     * @arg inRules {Array} Non-out() rules
     * @arg outRules {Map} Output key -> out() rule
     */
    constructor(doc, inRules, outRules, rulesThatCouldEmit, rulesThatCouldAdd) {
        this.doc = doc;
        this._inRules = inRules;
        this._outRules = outRules;
        this._rulesThatCouldEmit = rulesThatCouldEmit;
        this._rulesThatCouldAdd = rulesThatCouldAdd;

        // Private, for the use of only helper classes:
        this.maxCache = new Map();  // type => Array of max fnode (or fnodes, if tied) of this type
        this.typeCache = new Map();  // type => Set of all fnodes of this type found so far. (The dependency resolution during execution ensures that individual types will be comprehensive just in time.)
        this.elementCache = new Map();  // DOM element => fnode about it
        this.doneRules = new Set();  // InwardRules that have been executed. OutwardRules can be executed more than once because they don't change any fnodes and are thus idempotent.
    }

    /**
     * Return an array of zero or more fnodes.
     * @arg thing {string|Lhs|Node} Can be...
     *
     *       * A string which matches up with an "out" rule in the ruleset. If the
     *         out rule uses through(), the results of through's callback (which
     *         might not be fnodes) will be returned.
     *       * An arbitrary LHS which we calculate and return the results of
     *       * A DOM node, for which we will return the corresponding fnode
     *
     *     Results are cached in the first and third cases.
     */
    get(thing) {
        if (typeof thing === 'string') {
            if (this._outRules.has(thing)) {
                return Array.from(this._execute(this._outRules.get(thing)));
            } else {
                throw new Error(`There is no out() rule with key "${thing}".`);
            }
        } else if (isDomElement(thing)) {
            // Return the fnode and let it run type(foo) on demand, as people
            // ask it things like scoreFor(foo).
            return this.fnodeForElement(thing);
        } else if (thing.asLhs !== undefined) {
            // Make a temporary out rule, and run it. This may add things to
            // the ruleset's cache, but that's fine: it doesn't change any
            // future results; it just might make them faster. For example, if
            // you ask for .get(type('smoo')) twice, the second time will be a
            // cache hit.
            const outRule = rule(thing, out(Symbol('outKey')));
            return Array.from(this._execute(outRule));
        } else {
            throw new Error('ruleset.get() expects a string, an expression like on the left-hand side of a rule, or a DOM node.');
        }
    }

    // Provide an opaque context object to be made available to all ranker
    // functions.
    // context (object) {
    //     self.context = object;
    // }

    // -------- Methods below this point are private to the framework. --------

    /**
     * Return all the thus-far-unexecuted rules that will have to run to run
     * the requested rule, in the form of Map(prereq: [rulesItIsNeededBy]).
     */
    _prerequisitesTo(rule, undonePrereqs = new Map()) {
        for (let prereq of rule.prerequisites(this)) {
            if (!this.doneRules.has(prereq)) {
                // prereq is not already run. (If it were, we wouldn't care
                // about adding it to the graph.)
                const alreadyAdded = undonePrereqs.has(prereq);
                setDefault(undonePrereqs, prereq, () => []).push(rule);

                // alreadyAdded means we've already computed the prereqs of
                // this prereq and added them to undonePrereqs. So, now
                // that we've hooked up the rule to this prereq in the
                // graph, we can stop. But, if we haven't, then...
                if (!alreadyAdded) {
                    this._prerequisitesTo(prereq, undonePrereqs);
                }
            }
        }
        return undonePrereqs;
    }

    /**
     * Run the given rule (and its dependencies, in the proper order), and
     * return its results.
     *
     * The caller is responsible for ensuring that _execute() is not called
     * more than once for a given InwardRule, lest non-idempotent
     * transformations, like score multiplications, be applied to fnodes more
     * than once.
     *
     * The basic idea is to sort rules in topological order (according to input
     * and output types) and then run them. On top of that, we do some
     * optimizations. We keep a cache of results by type (whether partial or
     * comprehensive--either way, the topology ensures that any
     * non-comprehensive typeCache entry is made comprehensive before another
     * rule needs it). And we prune our search for prerequisite rules at the
     * first encountered already-executed rule.
     */
    _execute(rule) {
        const prereqs = this._prerequisitesTo(rule);
        let sorted;
        try {
            sorted = [rule].concat(toposort(prereqs.keys(),
                                            prereq => prereqs.get(prereq)));
        } catch (exc) {
            if (exc instanceof CycleError) {
                throw new CycleError('There is a cyclic dependency in the ruleset.');
            } else {
                throw exc;
            }
        }
        let fnodes;
        for (let eachRule of reversed(sorted)) {
            // Sock each set of results away in this.typeCache:
            fnodes = eachRule.results(this);
        }
        return Array.from(fnodes);
    }

    /** @return {Rule[]} */
    inwardRulesThatCouldEmit(type) {
        return getDefault(this._rulesThatCouldEmit, type, () => []);
    }

    /** @return {Rule[]} */
    inwardRulesThatCouldAdd(type) {
        return getDefault(this._rulesThatCouldAdd, type, () => []);
    }

    /**
     * @return the Fathom node that describes the given DOM element. This does
     *     not trigger any execution, so the result may be incomplete.
     */
    fnodeForElement(element) {
        return setDefault(this.elementCache,
                          element,
                          () => new Fnode(element, this));
    }
}

/**
 * We place the in/out distinction in Rules because it determines whether the
 * RHS result is cached, and Rules are responsible for maintaining the rulewise
 * cache ruleset.ruleCache.
 */
class Rule {  // abstract
    constructor(lhs, rhs) {
        this.lhs = lhs.asLhs();
        this.rhs = rhs.asRhs();
    }

    /**
     * Return a NiceSet of the rules that this one shallowly depends on in the
     * given ruleset. In a BoundRuleset, this may include rules that have
     * already been executed.
     *
     * Depend on emitters of any LHS type this rule finalizes. (See
     * _typesFinalized for a definition.) Depend on adders of any other LHS
     * types (because, after all, we need to know what nodes have that type in
     * order to find the set of LHS nodes). This works for simple rules and
     * complex ones like and().
     *
     * Specific examples (where A is a type):
     * * A.max->* depends on anything emitting A.
     * * Even A.max->A depends on A emitters, because we have to have all the
     *   scores factored in first. For example, what if we did
     *   max(A)->score(.5)?
     * * A->A depends on anything adding A.
     * * A->(something other than A) depends on anything emitting A. (For
     *   example, we need the A score finalized before we could transfer it to
     *   B using conserveScore().)
     * * A->out() also depends on anything emitting A. Fnode methods aren't
     *   smart enough to lazily run emitter rules as needed. We could make them
     *   so if it was shown to be an advantage.
     */
    prerequisites(ruleset) {
        // Optimization: we could cache the result of this when in a compiled (immutable) ruleset.
        const prereqs = new NiceSet();

        // Add finalized types:
        for (let type of this._typesFinalized()) {
            prereqs.extend(ruleset.inwardRulesThatCouldEmit(type));
        }

        // Add mentioned types:
        for (let type of this.lhs.typesMentioned()) {
            // We could say this.lhs.typesMentioned().minus(typesFinalized) as
            // an optimization. But since types mentioned are a superset of
            // types finalized and rules adding are a subset of rules emitting,
            // we get the same result without.
            prereqs.extend(ruleset.inwardRulesThatCouldAdd(type));
        }

        return prereqs;
    }

    /**
     * Return the types that this rule finalizes.
     *
     * To "finalize" a type means to make sure we're finished running all
     * possible rules that might change a node's score or notes w.r.t. a given
     * type. This is generally done because we're about to use those data for
     * something, like computing a new type's score or or an aggregate
     * function. Exhaustively, we're about to...
     * * change the type of the nodes or
     * * aggregate all nodes of a type
     *
     * This base-class implementation just returns what aggregate functions
     * need, since that need spans inward and outward rules.
     *
     * @return Set of types
     */
    _typesFinalized() {
        // Get the types that are fed to aggregate functions. Aggregate
        // functions are more demanding than a simple type() LHS. A type() LHS
        // itself does not finalize its nodes because the things it could do to
        // them without changing their type (adding notes, multiplying score)
        // are immutable or commutative (respectively). Thus, we require a RHS
        // type change in order to require finalization of a simple type()
        // mention. A max(B), OTOH, is not commutative with other B->B rules
        // (imagine type(B).max()->score(.5)), so it must depend on B emitters
        // and thus finalize B. (This will have to be relaxed or rethought when
        // we do the max()/atMost() optimization. Perhaps we can delegate to
        // aggregate functions up in Rule.prerequisites() to ask what their
        // prereqs are. If they implement such an optimization, they can reply.
        // Otherwise, we can assume they are all the nodes of their type.)
        //
        // TODO: Could arbitrary predicates (once we implement those) matter
        // too? Maybe it's not just aggregations.
        const type = this.lhs.aggregatedType();
        return (type === undefined) ? new NiceSet() : new NiceSet([type]);
    }
}

/**
 * A normal rule, whose results head back into the Fathom knowledgebase, to be
 * operated on by further rules.
 */
class InwardRule extends Rule {
    // TODO: On construct, complain about useless rules, like a dom() rule that
    // doesn't assign a type.

    /**
     * Return an iterable of the fnodes emitted by the RHS of this rule.
     * Side effect: update ruleset's store of fnodes, its accounting of which
     * rules are done executing, and its cache of results per type.
     */
    results(ruleset) {
        if (ruleset.doneRules.has(this)) {  // shouldn't happen
            throw new Error('A bug in Fathom caused results() to be called on an inward rule twice. That could cause redundant score multiplications, etc.');
        }
        const self = this;
        // For now, we consider most of what a LHS computes to be cheap, aside
        // from type() and type().max(), which are cached by their specialized
        // LHS subclasses.
        const leftFnodes = this.lhs.fnodes(ruleset);
        // Avoid returning a single fnode more than once. LHSs uniquify
        // themselves, but the RHS can change the element it's talking
        // about and thus end up with dupes.
        const returnedFnodes = new Set();

        // Merge facts into fnodes:
        forEach(
            function updateFnode(leftFnode) {
                const leftType = self.lhs.guaranteedType();
                const fact = self.rhs.fact(leftFnode, leftType);
                self.lhs.checkFact(fact);
                const rightFnode = ruleset.fnodeForElement(fact.element || leftFnode.element);
                // If the RHS doesn't specify a type, default to the
                // type of the LHS, if any:
                const rightType = fact.type || self.lhs.guaranteedType();
                if (fact.conserveScore) {
                    // If conserving, multiply in the input-type score
                    // from the LHS node. (Never fall back to
                    // multiplying in the RHS-type score from the LHS:
                    // it's not guaranteed to be there, and even if it
                    // will ever be, the executor doesn't guarantee it
                    // has been filled in yet.)
                    if (leftType !== undefined) {
                        rightFnode.conserveScoreFrom(leftFnode, leftType, rightType);
                    } else {
                        throw new Error('conserveScore() was called in a rule whose left-hand side is a dom() selector and thus has no predictable type.');
                    }
                }
                if (fact.score !== undefined) {
                    if (rightType !== undefined) {
                        rightFnode.multiplyScoreFor(rightType, fact.score);
                    } else {
                        throw new Error(`The right-hand side of a rule specified a score (${fact.score}) with neither an explicit type nor one we could infer from the left-hand side.`);
                    }
                }
                if (fact.type !== undefined || fact.note !== undefined) {
                    // There's a reason to call setNoteFor.
                    if (rightType === undefined) {
                        throw new Error(`The right-hand side of a rule specified a note (${fact.note}) with neither an explicit type nor one we could infer from the left-hand side. Notes are per-type, per-node, so that's a problem.`);
                    } else {
                        rightFnode.setNoteFor(rightType, fact.note);
                    }
                }
                returnedFnodes.add(rightFnode);
            },
            leftFnodes);

        // Update ruleset lookup tables.
        // First, mark this rule as done:
        ruleset.doneRules.add(this);
        // Then, stick each fnode in typeCache under all applicable types.
        // Optimization: we really only need to loop over the types
        // this rule can possibly add.
        for (let fnode of returnedFnodes) {
            for (let type of fnode.typesSoFar()) {
                setDefault(ruleset.typeCache, type, () => new Set()).add(fnode);
            }
        }
        return returnedFnodes.values();
    }

    /**
     * Return a Set of the types that could be emitted back into the system.
     * To emit a type means to either to add it to a fnode emitted from the RHS
     * or to leave it on such a fnode where it already exists.
     */
    typesItCouldEmit() {
        const rhs = this.rhs.possibleEmissions();
        if (!rhs.couldChangeType && this.lhs.guaranteedType() !== undefined) {
            // It's a b -> b rule.
            return new Set([this.lhs.guaranteedType()]);
        } else if (rhs.possibleTypes.size > 0) {
            // We can prove the type emission from the RHS alone.
            return rhs.possibleTypes;
        } else {
            throw new Error('Could not determine the emitted type of a rule because its right-hand side calls props() without calling typeIn().');
        }
    }

    /**
     * Return a Set of types I could add to fnodes I output (where the fnodes
     * did not already have them).
     */
    typesItCouldAdd() {
        const ret = new Set(this.typesItCouldEmit());
        ret.delete(this.lhs.guaranteedType());
        return ret;
    }

    /**
     * Add the types we could change to the superclass's result.
     */
    _typesFinalized() {
        const self = this;
        function typesThatCouldChange() {
            const ret = new NiceSet();

            // Get types that could change:
            const emissions = self.rhs.possibleEmissions();
            if (emissions.couldChangeType) {
                // Get the possible guaranteed combinations of types on the LHS
                // (taking just this LHS into account). For each combo, if the RHS
                // adds a type that's not in the combo, the types in the combo get
                // unioned into ret.
                for (let combo of self.lhs.possibleTypeCombinations()) {
                    for (let rhsType of emissions.possibleTypes) {
                        if (!combo.has(rhsType)) {
                            ret.extend(combo);
                            break;
                        }
                    }
                }
            }
            // Optimization: the possible combos could be later expanded to be
            // informed by earlier rules which add the types mentioned in the LHS.
            // If the only way for something to get B is to have Q first, then we
            // can add Q to each combo and end up with fewer types finalized. Would
            // this imply the existence of a Q->B->Q cycle and thus be impossible?
            // Think about it. If we do this, we can centralize that logic here,
            // rather than repeating it in all the Lhs subclasses).
            return ret;
        }

        return typesThatCouldChange().extend(super._typesFinalized());
    }
}

/**
 * A rule whose RHS is an out(). This represents a final goal of a ruleset.
 * Its results go out into the world, not inward back into the Fathom
 * knowledgebase.
 */
class OutwardRule extends Rule {
    /**
     * Compute the whole thing, including any .through() and .allThrough().
     * Do not mark me done in ruleset.doneRules; out rules are never marked as
     * done so they can be requested many times without having to cache their
     * (potentially big, since they aren't necessarily fnodes?) results. (We
     * can add caching later if it proves beneficial.)
     */
    results(ruleset) {
        return this.rhs.allCallback(map(this.rhs.callback, this.lhs.fnodes(ruleset)));
    }

    /**
     * @return the key under which the output of this rule will be available
     */
    key() {
        return this.rhs.key;
    }

    /**
     * OutwardRules finalize all types mentioned.
     */
    _typesFinalized() {
        return this.lhs.typesMentioned().extend(super._typesFinalized());
    }
}

module.exports = {
    rule,
    ruleset
};
