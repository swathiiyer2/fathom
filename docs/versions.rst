===============
Version History
===============

2.1
===

* Let costs be passed into distance() and clusters() so we can tune them per ruleset.
* Add nice documentation using Sphinx.
* Get the Chrome debugger working with our tests again (``make debugtest``).
* Officially support operating on DOM subtrees (which did work previously).

2.0
===
The focii for 2.0 are syntactic sugar and support for larger, more powerful rulesets that can operate at higher levels of abstraction. From these priorities spring all of the following:

* "Yankers" or aggregate functions are now part of the ruleset: :func:`max` and :func:`and` for now, with more in a later release. This in-ruleset mapping from the fuzzy domain of scores back to the boolean domain of types complements the opposite mapping provided by :func:`score` and lets ruleset authors choose between efficiency and completeness. It also saves imperative programming where maxima are referenced from more than one place. Finally, it opens the door to automatic optimization down the road.
* Answers are computed lazily, running only the necessary rules each time you call :func:`~BoundRuleset.get` and caching intermediate results to save work on later calls. We thus eschew 1.x's strategy of emitting the entire scored world for the surrounding imperative program to examine and instead expose a factbase that acts like a lazy hash of answers. This allows for large, sophisticated rulesets that are nonetheless fast and can be combined to reuse parts (see :func:`Ruleset.rules()`). Of course, if you still want to imbibe the entire scored corpus of nodes in your surrounding program, you can simply yank all nodes of a type using the :func:`type` yanker: just point it to :func:`out`, and the results will be available from the outside: ``rule(type('foo'), out('someKey'))``.
* We expand the domain of concern of a ruleset from a single dimension ("Find just the ads!") to multiple ones ("Find the ads and the navigation and the products and the prices!"). This is done by making scores and notes per-type.
* The rule syntax has been richly sugared to…
    * be shorter and easier to read in most cases
    * surface more info declaratively so the query planner can take advantage of it (:func:`props` is where the old-style ranker functions went, but avoid them when you don't need that much power, and you'll reap a reward of concision and efficiently planned queries)
    * allow you to concisely factor up repeated parts of complex LHSs and RHSs
* The new experimental :func:`and` combinator allows you to build more powerful abstractions upon the black boxes of types.
* Test coverage is greatly improved, and eslint is keeping us from doing overtly stupid things.

Backward-incompatible changes
-----------------------------

* RHSs (née ranker functions) can no longer return multiple facts, which simplifies both syntax and design. For now, use multiple rules, each emitting one fact, and share expensive intermediate computations in notes. If this proves a problem in practice, we'll switch back, but I never saw anyone return multiple facts in the wild.
* Scores are now per-type. This lets you deliver multiple independent scores per ruleset. It also lets Fathom optimize out downstream rules in many cases, since downstream rules' scores no longer back-propagate to upstream types. Per-type scores also enable complex computations with types as composable units of abstraction, open the possibility of over-such-and-such-a-score yankers, and make non-multiplication-based score components a possibility. However, the old behavior remains largely available via :func:`conserveScore`.
* Flavors are now types.

1.1.2
=====
* Stop assuming querySelectorAll() results conform to the iterator protocol. This fixes compatibility with Chrome.
* Add test coverage reporting.

1.1.1
=====
* No changes. Just bump the version in an attempt to get the npm index page to update.

1.1
===
* Stop using ``const`` in ``for...of`` loops. This lets Fathom run within Firefox, which does not allow this due to a bug in its ES implementation.
* Optimize DistanceMatrix.numClusters(), which should make clustering a bit faster.

1.0
===
* Initial release
