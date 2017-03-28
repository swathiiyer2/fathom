const assert = require('chai').assert;
const {jsdom} = require('jsdom');

const {deviationScore, readabilityDocPairs, tunedContentNodes} = require('../examples/readability');
const {dom, out, props, rule, ruleset, type} = require('../index');
const {numberOfMatches, page, sum} = require('../utils');


describe('Design-driving demos', function () {
    it('handles a simple series of short-circuiting rules', function () {
        // TODO: Short-circuiting isn't implemented yet. The motivation of this
        // test is to inspire engine so it's smart enough to run the highest-
        // possible-scoring type-chain of rules first and, if it succeeds,
        // omit the others.
        const doc = jsdom(`
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
        assert(isProbablyLoggedIn(jsdom(`
            <html>
                <a href="/authentication/signout/" class="signout">Sign Out</a>
            </html>
        `)));
        // crateandbarrel.com
        assert(isProbablyLoggedIn(jsdom(`
            <html>
                <div class="dropdown-sign-in">
                    <a href="/account/logout" rel="nofollow">Sign Out</a>
                </div>
            </html>
        `)));
        // slashdot.org
        assert(isProbablyLoggedIn(jsdom(`
            <html>
                <a href="///slashdot.org/my/logout">
                  Log out
                </a>
            </html>
        `)));
        // news.ycombinator.com
        assert(isProbablyLoggedIn(jsdom(`
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

        it('closely clustered runs of text', function () {
            const doc = jsdom(`
                <div>
                    <h1>
                        Welcome to here.
                    </h1>
                    <p>
                        <a class="good" href="/things">Things</a> / <a class="bad" href="/things/tongs">Tongs</a>
                    </p>
                </div>
                <div id="lovelyContent">
                    <p>
                        Once upon a time, there was a large bear named Sid. Sid was very large and bearish, and he had a bag of hammers.
                    </p>
                    <p>
                        Sid dreamed of doughnuts--bear claws in particular--and wanted nothing more than to sink his stinking teeth into some. One day, Sid traded the bag of hammers to a serial scribbler named Sam for a dozen doughnuts. It was a good trade. Sid lived happily ever after.
                    </p>
                    <p>
                        Did you ever trade a bag of hammers for something? What was it? What were you doing with a bag of hammers, anyway? Don't you know that keeping your hammers in a bag leads to chipped heads? What is wrong with you, anyway?
                    </p>
                    <p>
                        Hamstrung by ham-handed dreams of hammers, you will ham-handedly hamper Hap's handbag handbooks. You'll be handing out handbills by the handful until they handcuff you and handicap your handiworks. What, then, will become of your handkerchief handles?
                    </p>
                </div>
                <div>
                    <p>
                        Hammers are copyright 1996.
                    </p>
                </div>
            `);

            assert.deepEqual(snippetsFrom(doc),
                             ['Once upon a time, th',
                              'Sid dreamed of dough',
                              'Did you ever trade a',
                              'Hamstrung by ham-han']);
        });

        it('large inner clusters with some piddly little text in their container', function () {
            // Feel free to change what you want out of this, but this exists
            // to show that we thought it a sane output at one point.
            // distance() considers inner things almost infinitely far from
            // outer so we end up with either-or: generally just the outer,
            // which are often more plentiful. We then get the inner by means
            // of having their containers.
            const doc = jsdom(`
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
            const doc = jsdom(`
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
            assert.isBelow(deviationScore(readabilityDocPairs()), 8);
        });
    });
});

// Right now, I'm writing features and using optimization algos to find their coefficients. Someday, we can stop writing features and have deep learning come up with them. TODO: Grok unsupervised learning, and apply it to OpenCrawl.
