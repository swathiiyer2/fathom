const assert = require('chai').assert;
const {jsdom} = require('jsdom');

const {clusters, distance} = require('../clusters');
const {dom, out, props, rule, ruleset, score, type} = require('../index');
const {domSort, inlineTextLength, linkDensity, max, numberOfMatches, page, sum} = require('../utils');


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
        // Potential advantages over readability:
        // * State clearly contained
        // * Should work fine with ideographic languages and others that lack
        //   space-delimited words
        // * Pluggable
        // * Potential to have rules generated or tuned by training
        // * Adaptable to find things other than the main body text (like
        //   clusters of nav links)
        // * Potential to perform better since it doesn't have to run over and
        //   over, loosening constraints each time, if it fails

        // Score a node based on how much text is directly inside it and its
        // inline-tag children.
        function scoreByLength(fnode) {
            const length = inlineTextLength(fnode.element);
            return {
                score: length,  // May be scaled someday
                note: {inlineLength: length}  // Store expensive inline length for linkDensity().
            };
        }

        // This set of rules is the beginning of something that works.
        // It's modeled after what I do when I try to do this by hand: I look
        // for balls of black text, and I look for them to be near each other,
        // generally siblings: a "cluster" of them.
        const rules = ruleset(
            // Score on text length -> paragraphish. We start with this
            // because, no matter the other markup details, the main body text
            // is definitely going to have a bunch of text.
            rule(dom('p,div'), props(scoreByLength).type('paragraphish')),
            // TODO: Maybe include <li>s, blockquotes, and such in here too,
            // and let the linkDensity and clustering cull out the nav
            // elements. Or just do a "blur" algorithm within the cluster,
            // pulling in other elements with decent text density, good CSS
            // smells, and such. (Interstitials like those probably won't split
            // clusters if the stride cost is set low enough.) To test, add a
            // very short paragraph in the midst of the long one, thus testing
            // our leaning toward contiguousness.

            // Scale it by inverse of link density:
            rule(type('paragraphish'), score(fnode => 1 - linkDensity(fnode, fnode.noteFor('paragraphish').inlineLength))),

            // Give bonuses for being in p tags.
            rule(dom('p'), score(1.5).type('paragraphish'))
            // TODO: article tags, etc., too

            // TODO: Ignore invisible nodes so people can't game us with those.
        );

        // Return a 20-char snippet of each paragraph from a document's main
        // textual content.
        function snippetsFrom(doc) {
            const facts = rules.against(doc);
            const paragraphishes = facts.get(type('paragraphish'));
            const paragraphishNodes = paragraphishes.map(fnode => fnode.element);
            const clusts = clusters(
                paragraphishNodes,
                3,
                (a, b) => distance(a, b, {differentDepthCost: 2,
                                          differentTagCost: 2,
                                          sameTagCost: 1,
                                          strideCost: 1

                                          // This is an addition to the distance
                                          // function which makes nodes that have
                                          // outlier lengths further away. It's meant to
                                          // help filter out interstitials like ads.
                                          // +1 to make a zero difference in length be 0
                                          // /10 to bring (only) large differences in length into scale with the above costs
                                          // additionalCost: (a, b) => Math.log(Math.abs(a.noteFor('paragraphish').inlineLength -
                                          //                                             b.noteFor('paragraphish').inlineLength) / 10 + 1)
                                          // TODO: Consider a logistic function instead of log.
                }));
            // TODO: Probably promote someting like a "bestCluster()" to an in-
            // ruleset aggregate function so its output can feed into other
            // rules. It should take cost coefficients without requiring
            // distance() itself to be wrapped and passed in.

            // Tag each cluster with the total of its paragraphs' scores:
            const clustsAndSums = clusts.map(clust => [clust,
                                                       sum(clust.map(para => facts.get(para).scoreFor('paragraphish')))]);
            // TODO: Make clusters() take fnodes, not nodes, so we can call
            // scoreFor directly on the fnode above.
            // TODO: Once that's done, use score as part of the distance metric,
            // which should tend to push outlier-sized paragraphs out of clusters,
            // especially if they're separated topographically (like copyright
            // notices).
            const bestClust = max(clustsAndSums, clustAndSum => clustAndSum[1])[0];
            const sortedBest = domSort(bestClust);
            return sortedBest.map(p => p.textContent.trim().substr(0, 20).trim());
            // Other ideas: We could pick the cluster around the highest-scoring
            // node (which is more like what Readability does) or the highest-
            // scoring cluster by some formula (num typed nodes * scores of the
            // nodes), and contiguous() it so things like ads are excluded but
            // short paragraphs are included.
        }

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
    });
});

// Right now, I'm writing features. We can use a supervised learning algorithm to find their coefficients. Someday, we can stop writing features and have deep learning algorithm come up with them. TODO: Grok unsupervised learning, and apply it to OpenCrawl.
// If we ever end up doing actual processing server-side, consider cheeriojs instead of jsdom. It may be 8x faster, though with a different API.
