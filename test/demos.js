const assert = require('chai').assert;

const {deviationScore, readabilityDocPairs, tunedContentNodes} = require('../examples/readability');
const {dom, out, props, rule, ruleset, type} = require('../index');
const {numberOfMatches, page, staticDom, sum} = require('../utils');


describe('Design-driving demos', function () {
    it('handles a simple series of short-circuiting rules', function () {
        // TODO: Short-circuiting isn't implemented yet. The motivation of this
        // test is to inspire engine so it's smart enough to run the highest-
        // possible-scoring type-chain of rules first and, if it succeeds,
        // omit the others.
        const doc = staticDom(`
            <meta name="hdl" content="HDL">
            <meta property="og:title" content="OpenGraph">
            <meta property="twitter:title" content="Twitter">
            <title>Title</title>
        `);
        const typeAndNote = type('titley').note(fnode => fnode.element.getAttribute('content'));
        const rules = ruleset(
            rule(dom('meta[property="og:title"]'),
                 typeAndNote.score(40)),
            rule(dom('meta[property="twitter:title"]'),
                 typeAndNote.score(30)),
            rule(dom('meta[name="hdl"]'),
                 typeAndNote.score(20)),
            rule(dom('title'),
                 typeAndNote.score(10).note(fnode => fnode.element.text)),
            rule(type('titley').max(), out('bestTitle'))
        );
        const facts = rules.against(doc);
        const node = facts.get('bestTitle')[0];
        assert.equal(node.scoreFor('titley'), 40);
        assert.equal(node.noteFor('titley'), 'OpenGraph');
    });

    it('identifies logged-in pages', function () {
        // Stick a score on the root element based on how much the classes on `fnode`
        // mention logging out.
        function scoreByLogoutClasses(fnode) {
            const classes = Array.from(fnode.element.classList);
            const score = Math.pow(2,
                                   sum(classes.map(cls => numberOfMatches(/(?:^|[-_])(?:log[-_]?out|sign[-_]?out)(?:$|[-_ $])/ig, cls))));
            if (score > 1) {
                return {score, type: 'logoutClass'};
            }
        }

        function scoreByLogoutHrefs(fnode) {
            const href = fnode.element.getAttribute('href');
            const score = Math.pow(2, numberOfMatches(/(?:^|\W)(?:log[-_]?out|sign[-_]?out)(?:$|\W)/ig, href));
            if (score > 1) {
                return {score, type: 'logoutHref'};
            }
        }

        const rules = ruleset(
            // Look for "logout", "signout", etc. in CSS classes and parts thereof:
            rule(dom('button[class], a[class]'),
                 props(page(scoreByLogoutClasses)).typeIn('logoutClass')),
            // Look for "logout" or "signout" in hrefs:
            rule(dom('a[href]'),
                 props(page(scoreByLogoutHrefs)).typeIn('logoutHref')),

            // Union the two intermediate results into a more general loggedIn type:
            rule(type('logoutClass'),
                 type('loggedIn').conserveScore()),
            rule(type('logoutHref'),
                 type('loggedIn').conserveScore())

            // Look for "Log out", "Sign out", etc. in content of links: a
            // bonus for English pages.
            // rule(dom('a[href]'), props(page(...)).typeIn('logout
        );

        function isProbablyLoggedIn(doc) {
            const ins = rules.against(doc).get(type('loggedIn'));
            return ins.length && ins[0].scoreFor('loggedIn') > 1;
        }

        // air.mozilla.org:
        assert(isProbablyLoggedIn(staticDom(`
            <html>
                <a href="/authentication/signout/" class="signout">Sign Out</a>
            </html>
        `)));
        // crateandbarrel.com
        assert(isProbablyLoggedIn(staticDom(`
            <html>
                <div class="dropdown-sign-in">
                    <a href="/account/logout" rel="nofollow">Sign Out</a>
                </div>
            </html>
        `)));
        // slashdot.org
        assert(isProbablyLoggedIn(staticDom(`
            <html>
                <a href="///slashdot.org/my/logout">
                  Log out
                </a>
            </html>
        `)));
        // news.ycombinator.com
        assert(isProbablyLoggedIn(staticDom(`
            <html>
                <a href="logout?auth=123456789abcdef&amp;goto=news">logout</a>
            </html>
        `)));
    });

    describe('finds content in a Readability-like fashion from', function () {
        this.timeout(0);  // This early in the dev process, some things still take awhile.

        // ---------------------- Test helper routines: -----------------------

        /**
         * Return a 20-char snippet of each node from a document's main
         * textual content.
         */
        function snippetsFrom(doc) {
            return tunedContentNodes()(doc).map(p => p.textContent.trim().substr(0, 20).trim());
        }

        // ----------------------------- Tests: -------------------------------

        it('large inner clusters with some piddly little text in their container', function () {
            // Feel free to change what you want out of this, but this exists
            // to show that we thought it a sane output at one point.
            // distance() considers inner things almost infinitely far from
            // outer so we end up with either-or: generally just the outer,
            // which are often more plentiful. We then get the inner by means
            // of having their containers.
            const doc = staticDom(`
                <div>
                    Smoo bars.
                    <p>
                        One <code>fish</code>
                    </p>
                    <p>
                        Two <code>fish</code>
                    </p>
                    <p>
                        Three
                    </p>
                    Yo.
                </div>
            `);
            assert.deepEqual(snippetsFrom(doc),
                             ['One fish', 'Two fish', 'Three']);
        });

        it('large outer clusters with some piddly inner things contained', function () {
            // For instance, if the inner things were <code> blocks and the
            // outer were <p>s, we'd want the <p>s.
            const doc = staticDom(`
                <div>
                    Smoo bars.
                    <p>
                        One
                    </p>
                    <p>
                        Two
                    </p>
                    <p>
                        Three
                    </p>
                    Yo.
                </div>
                <div>
                    Mangaroo. Witches and kangaroo.
                </div>
                <div>
                    Bing bang, I saw the whole mang.
                </div>
            `);
            assert.deepEqual(snippetsFrom(doc),
                             ['Smoo bars.', 'Mangaroo. Witches an', 'Bing bang, I saw the']);
        });

        it('the Readability test suite', function () {
            // We keep dropping this as we get better, to prevent regressions:
            assert.isBelow(deviationScore(readabilityDocPairs()), 7.1);
        });
    });
});

// Right now, I'm writing features and using optimization algos to find their coefficients. Someday, we can stop writing features and have deep learning come up with them. TODO: Grok unsupervised learning, and apply it to OpenCrawl.
