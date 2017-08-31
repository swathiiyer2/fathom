const {assert} = require('chai');
const {dom, out, rule, ruleset, score, type} = require('../index');
const {NiceSet, toposort, staticDom, searchAttributes} = require('../utils');


describe('Utils', function () {
    describe('NiceSet', function () {
        it('pops', function () {
            const s = new NiceSet([1, 2]);
            assert.equal(s.pop(), 1);
            assert.equal(s.pop(), 2);
            assert.throws(() => s.pop(),
                          'Tried to pop from an empty NiceSet.');
        });
    });

    describe('toposort', function () {
        it('sorts', function () {
            // Return answers that express the graph...
            // 4 <- 5 <- 6   <-  7
            //           |       |
            //           v       v
            //          5.1  <- 6.1
            // ...where -> means "needs".
            function nodesThatNeed(node) {
                return node === 5.1 ? [6, 6.1] : (node === 7 ? [] : [Math.floor(node) + 1]);
            }
            assert.deepEqual(toposort([4, 5, 5.1, 6, 6.1, 7], nodesThatNeed),
                             [7, 6, 5, 4, 6.1, 5.1]);
        });
        it('detects cycles', function () {
            // Express a graph of 3 nodes pointing in a circle.
            function nodesThatNeed(node) {
                return [(node + 1) % 3];
            }
            assert.throws(() => toposort([0, 1, 2], nodesThatNeed),
                          'The graph has a cycle.');
        });
    });

    describe('searchAttributes', function () {
        it.only('search with no args', function () {
            const doc = staticDom(`
                <img id= "foo" alt= "boo"></img><img id="fat" src= "bat"></img>
            `);
            const rules = ruleset(
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), out('best'))
            );

            function scoreFunc(fnode){
              return searchAttributes(fnode, searchFunc)? 5 : 1;
            }

            function searchFunc(attr){
              return attr.includes("oo");
            }
            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 1);
            assert.equal(best[0].element.id, 'foo');
        });

        it.only('search with args', function () {
            const doc = staticDom(`
                <img id= "foo" alt= "bat"></img><img id="sat" src= "bat"></img>
            `);
            const rules = ruleset(
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), out('best'))
            );

            function scoreFunc(fnode){
              return searchAttributes(fnode, searchFunc, 'id')? 5 : 1;
            }

            function searchFunc(attr){
              return attr.includes("at");
            }
            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 1);
            assert.equal(best[0].element.id, 'sat');
        });

    });
});
