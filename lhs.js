// The left-hand side of a rule

const {clusters, distance} = require('./clusters');
const {maxes, getDefault, max, setDefault, sum} = require('./utils');


/**
 * Take nodes that match a given DOM selector. Example:
 * ``dom('meta[property="og:title"]')``
 *
 * Every ruleset has at least one ``dom`` rule, as that is where nodes begin to
 * flow into the system.
 */
function dom(selector) {
    return new DomLhs(selector);
}

/**
 * Rules and the LHSs and RHSs that comprise them have no mutable state. This
 * lets us make BoundRulesets from Rulesets without duplicating the rules. It
 * also lets us share a common cache among rules: multiple ones might care
 * about a cached type(), for instance; there isn't a one-to-one relationship
 * of storing with caring. There would also, because of the interdependencies
 * of rules in a ruleset, be little use in segmenting the caches: if you do
 * something that causes one to need to be cleared, you'll need to clear many
 * more as well.
 *
 * Lhses are responsible for maintaining ruleset.maxCache.
 *
 * Lhs and its subclasses are private to the Fathom framework.
 */
class Lhs {
    /** Return a new Lhs of the appropriate kind, given its first call. */
    static fromFirstCall(firstCall) {
        // firstCall is never 'dom', because dom() directly returns a DomLhs.
        if (firstCall.method === 'type') {
            return new TypeLhs(...firstCall.args);
        } else if (firstCall.method === 'and') {
            return new AndLhs(firstCall.args);
        } else {
            throw new Error('The left-hand side of a rule() must start with dom() or type().');
        }
    }

    // Return an iterable of output fnodes selected by this left-hand-side
    // expression.
    //
    // Pre: The rules I depend on have already been run, and their results are
    // in ruleset.typeCache.
    //
    // ruleset: a BoundRuleset
    // fnodes (ruleset)

    /**
     * Check that a RHS-emitted fact is legal for this kind of LHS, and throw
     * an error if it isn't.
     */
    checkFact(fact) {
    }

    /**
     * Return the single type the output of the LHS is guaranteed to have.
     * Return undefined if there is no such single type we can ascertain.
     */
    guaranteedType() {
    }

    /**
     * Return an iterable of rules that need to run in order to compute my
     * inputs, undefined if we can't tell without also consulting the RHS or if
     * the necessary prereqs are missing from the ruleset.
     */
    prerequisites(ruleset) {
        return undefined;
    }
}

class DomLhs extends Lhs {
    constructor(selector) {
        super();
        if (selector === undefined) {
            throw new Error('A querySelector()-style selector is required as the argument to dom().');
        }
        this.selector = selector;
    }

    fnodes(ruleset) {
        const matches = ruleset.doc.querySelectorAll(this.selector);
        const ret = [];
        for (let i = 0; i < matches.length; i++) {  // matches is a NodeList, which doesn't conform to iterator protocol
            const element = matches[i];
            ret.push(ruleset.fnodeForElement(element));
        }
        return ret;
    }

    checkFact(fact) {
        if (fact.type === undefined) {
            throw new Error(`The right-hand side of a dom() rule failed to specify a type. This means there is no way for its output to be used by later rules. All it specified was ${fact}.`);
        }
    }

    asLhs() {
        return this;
    }

    prerequisites(ruleset) {
        return [];
    }
}

/** Internal representation of a LHS constrained by type but not by max() */
class TypeLhs extends Lhs {
    constructor(type) {
        super();
        if (type === undefined) {
            throw new Error('A type name is required when calling type().');
        }
        this._type = type;  // the input type
    }

    fnodes(ruleset) {
        return getDefault(ruleset.typeCache, this._type, () => []);
    }

    /** Override the type previously specified by this constraint. */
    type(inputType) {
        // Preserve the class in case this is a TypeMaxLhs.
        return new this.constructor(inputType);
    }

    /**
     * Of the nodes selected by a ``type`` call to the left, constrain the LHS
     * to return only the max-scoring one. If there is a tie, more than 1 node
     * will be returned. Example: ``type('titley').max()``
     */
    max() {
        return new TypeMaxLhs(this._type);
    }

    /**
     * Take the nodes selected by a ``type`` call to the left, group them into
     * clusters, and return the nodes in the cluster that has the highest total
     * score (on the relevant type).
     *
     * Nodes come out in arbitrary order, so, if you plan to emit them,
     * consider using ``.out('whatever').allThrough(domSort)``. See
     * :func:`domSort`.
     *
     * If multiple clusters have equally high scores, return an arbitrary one,
     * because Fathom has no way to represent arrays of arrays in rulesets.
     *
     * @arg options {Object} The same depth costs taken by :func:`distance`,
     *     plus ``splittingDistance``, which is the distance beyond which 2
     *     clusters will be considered separate. ``splittingDistance``, if
     *     omitted, defaults to 3.
     */
    bestCluster(options) {
        return new BestClusterLhs(this._type, options);
    }

    // Other clustering calls could be called biggestCluster() (having the most
    // nodes) and bestAverageCluster() (having the highest average score).

    guaranteedType() {
        return this._type;
    }
}

/**
 * Abstract LHS that is an aggregate function taken across all fnodes of a type
 *
 * The main point here is that any aggregate function over a (typed) set of
 * nodes depends on first computing all the rules that could emit those nodes
 * (nodes of that type).
 */
class AggregateTypeLhs extends TypeLhs {
    prerequisites(ruleset) {
        return ruleset.inwardRulesThatCouldEmit(this._type);
    }
}

/**
 * Internal representation of a LHS that has both type and max([NUMBER])
 * constraints. max(NUMBER != 1) support is not yet implemented.
 */
class TypeMaxLhs extends AggregateTypeLhs {
    /**
     * Return the max-scoring node (or nodes if there is a tie) of the given
     * type.
     */
    fnodes(ruleset) {
        // TODO: Optimize better. Walk the dependency tree, and run only the
        // rules that could possibly lead to a max result. As part of this,
        // make RHSs expose their max potential scores.
        const self = this;
        // Work around V8 bug:
        // https://stackoverflow.com/questions/32943776/using-super-within-an-
        // arrow-function-within-an-arrow-function-within-a-method
        const getSuperFnodes = () => super.fnodes(ruleset);
        return setDefault(
            ruleset.maxCache,
            this._type,
            function maxFnodesOfType() {
                return maxes(getSuperFnodes(), fnode => fnode.scoreSoFarFor(self._type));
            });
    }
}

class BestClusterLhs extends AggregateTypeLhs {
    constructor(type, options) {
        super(type);
        this._options = options || {splittingDistance: 3};
    }

    /**
     * Group the nodes of my type into clusters, and return the cluster with
     * the highest total score for that type.
     */
    fnodes(ruleset) {
        // Get the nodes of the type:
        const fnodesOfType = Array.from(super.fnodes(ruleset));
        if (fnodesOfType.length === 0) {
            return [];
        }
        // Cluster them:
        const clusts = clusters(
            fnodesOfType,
            this._options.splittingDistance,
            (a, b) => distance(a, b, this._options));
        // Tag each cluster with the total of its nodes' scores:
        const clustsAndSums = clusts.map(
            clust => [clust,
                      sum(clust.map(fnode => fnode.scoreFor(this._type)))]);
        // Return the highest-scoring cluster:
        return max(clustsAndSums, clustAndSum => clustAndSum[1])[0];
    }
}

class AndLhs extends Lhs {
    constructor(lhss) {
        super();

        function sideToTypeLhs(side) {
            const lhs = side.asLhs();
            if (!(lhs.constructor === TypeLhs)) {
                throw new Error('and() supports only simple type() calls as arguments for now.');
                // TODO: Though we could solve this with a compilation step: and(type(A), type(B).max()) is equivalent to type(B).max() -> type(Bmax); and(type(A), type(Bmax)).
                // In fact, we should be able to compile most (any?) arbitrary and()s, including nested ands and and(type(...).max(), ...) constructions into several and(type(A), type(B), ...) rules.
            }
            return lhs;
        }

        // For the moment, we accept only type()s as args. TODO: Generalize to
        // type().max() and such later.
        this._args = lhss.map(sideToTypeLhs);
    }

    *fnodes(ruleset) {
        // Take an arbitrary one for starters. Optimization: we could always
        // choose the pickiest one to start with.
        const fnodes = this._args[0].fnodes(ruleset);
        // Then keep only the fnodes that have the type of every other arg:
        fnodeLoop: for (let fnode of fnodes) {
            for (let otherLhs of this._args.slice(1)) {
                // Optimization: could use a .hasTypeSoFar() below
                if (!fnode.hasType(otherLhs.guaranteedType())) {
                    // TODO: This is n^2. Why is there no set intersection in JS?!
                    continue fnodeLoop;
                }
            }
            yield fnode;
        }
    }

    /**
     * We require all rules that emit any of the types mentioned in my args.
     */
    prerequisites(ruleset) {
        // TODO: Figure out what to do about and('A') -> type('A'). That's
        // equivalent to A -> A, which depends on only adders, not emitters.
        //
        // and(A) -> A depends on adding A (changes no types)  ! emits A
        // and(A, B) -> A depends on adding A, emitting B  # finalizes B, because it's converting it to an A. When we finalize something, we depend on emitting in (not merely adding it, because the score must be complete).  ! adds A
        // and(A) -> typeIn(A, B) depends on anything emitting A (It's A->*, according to how our current Rule.prerequisites() code behaves.)  # finalizes A by converting it to B  ! adds B, emits A
        // and(A, B) -> typeIn(A, B) depends on adding A or B (because it never changes the type of any fnode: they all already have A and B)  # finalizes nothing (same as "changes no types")  ! emits A and B
        // and(A, B) -> typeIn(A, B, C) depends on anything emitting A or B (because it can change a fnode's type by adding C).  # finalizes A and B (cuz they could get converted to C)  ! adds C, emits A and B
        //
        // Now find a pattern to the above, and code it up.
        // * [No] If RHS is a single type and that type appears on the LHS, depend on adding that type and emitting any other LHS types. (No: and(A, B) -> typeIn(A, B))
        // * [No] Start by assuming all LHS types need Emitting. For each such type that appears on the RHS, change it to Adding. If there are any left over on RHS, everything changes back to Emitting. 
        // * [Yes!] Depends on emitters of any LHS type we finalize (might change the type of). Depends on adders of any other LHS types. THIS IS A GENERAL RULE: works even for simple, non-and rules!
        const prereqTypes = this._args.map(arg => arg.guaranteedType());
        const prereqs = new Set();
        for (let type of prereqTypes) {
            for (let rule of ruleset.inwardRulesThatCouldEmit(type)) {
                prereqs.add(rule);
            }
        }
        return prereqs;
    }
}

module.exports = {
    dom,
    Lhs
};
