import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const M = createRequire(import.meta.url)('../../app/model.js');

const fixture = () => ({
  roles: [{ id: 'member' }, { id: 'admin' }, { id: 'visitor' }],
  screens: [
    {
      id: 'SCR-HOME', name: 'HomeScreen', kind: 'screen',
      states: [
        { id: 'member', name: 'Member', when: { role: 'member' }, mockup: 'mockups/home-member.html' },
        { id: 'admin', name: 'Admin', when: { role: 'admin' }, mockup: 'mockups/home-admin.html' },
        { id: 'visitor', name: 'Visitor', when: { role: 'visitor' }, sameAs: 'member' }
      ]
    },
    {
      id: 'SCR-CARD', name: 'VisitorsCard', kind: 'component',
      states: [
        { id: 'waiting', name: '3 waiting', when: { also: 'visitors waiting' }, mockup: 'mockups/card-waiting.html' },
        { id: 'none', name: 'None waiting', when: { also: 'nobody waiting' }, mockup: 'mockups/card-none.html' }
      ]
    }
  ],
  chapters: [
    {
      id: 'c', sections: [
        { id: 'a', shows: [{ state: 'SCR-HOME.admin', highlight: 'SCR-CARD' }], requirements: [{ id: 'R1', text: 'one', screens: [{ screen: 'SCR-CARD' }] }] },
        { id: 'b', shows: [{ state: 'SCR-HOME.admin' }, { state: 'SCR-HOME.visitor' }], requirements: [{ id: 'R2', text: 'two', screens: [{ screen: 'SCR-HOME', state: 'admin' }] }] }
      ]
    }
  ]
});
// Section full ids are "<chapter>-<section>"; the brief calls them c-a and c-b.
const mockups = () => ({
  'mockups/home-member.html': '<p>member home</p>',
  'mockups/home-admin.html': '<main><sb-component id="SCR-CARD" state="waiting"></sb-component></main>',
  'mockups/card-waiting.html': '<b>3 waiting</b>',
  'mockups/card-none.html': '<b>none</b>'
});
const all = () => true;

test('stateKey, screenIndex and drawnState', () => {
  const book = fixture();
  assert.equal(M.stateKey('SCR-HOME', 'admin'), 'SCR-HOME.admin');
  const ix = M.screenIndex(book);
  assert.equal(ix.byName.HomeScreen, 'SCR-HOME');
  assert.equal(ix.screens['SCR-CARD'].name, 'VisitorsCard');
  assert.equal(ix.states['SCR-HOME.admin'].state.id, 'admin');
  assert.equal(M.drawnState(book, 'SCR-HOME.visitor').state.id, 'member');
  assert.equal(M.drawnState(book, 'SCR-HOME.nope'), null);
});

test('mockupPaths covers mockup and today, deduplicated', () => {
  const book = fixture();
  book.screens[0].states[0].today = 'mockups/old.html';
  book.screens[0].states[1].today = 'mockups/old.html';
  const paths = M.mockupPaths(book);
  assert.equal(paths.length, 5);
  assert.ok(paths.includes('mockups/old.html'));
  assert.ok(paths.includes('mockups/card-none.html'));
});

test('componentsIn reads id and state in either order', () => {
  const html = '<sb-component state="a" id="X"></sb-component><sb-component id="Y" state=\'b\'/>';
  assert.deepEqual(M.componentsIn(html), [{ id: 'X', state: 'a' }, { id: 'Y', state: 'b' }]);
});

test('expandMockup places the component, outlines it, and flags problems', () => {
  const book = fixture();
  const m = mockups();
  const out = M.expandMockup(book, m, m['mockups/home-admin.html']);
  assert.match(out, /<div class="sb-component" data-key="SCR-CARD\.waiting">/);
  assert.match(out, /<b>3 waiting<\/b>/);
  assert.doesNotMatch(out, /sb-hl/);
  assert.match(M.expandMockup(book, m, m['mockups/home-admin.html'], { highlight: 'SCR-CARD' }), /<div class="sb-component sb-hl" data-key="SCR-CARD\.waiting">/);

  m['mockups/card-waiting.html'] = '<sb-component id="SCR-CARD" state="waiting"></sb-component>';
  const loop = M.expandMockup(book, m, m['mockups/card-waiting.html']);
  assert.match(loop, /<div class="sb-missing"[^>]*>Missing component SCR-CARD\.waiting<\/div>/);

  const gone = M.expandMockup(book, m, '<sb-component id="SCR-CARD" state="gone"></sb-component>');
  assert.match(gone, /<div class="sb-missing"[^>]*>Missing component SCR-CARD\.gone<\/div>/);
  assert.match(M.expandMockup(book, m, '<sb-component id="SCR-NOPE" state="x"></sb-component>'), />Missing component SCR-NOPE\.x<\/div>/);
});

test('usedOn, shownIn and gateKeys', () => {
  const book = fixture();
  const m = mockups();
  assert.deepEqual(M.usedOn(book, m)['SCR-CARD'], ['SCR-HOME.admin']);
  assert.deepEqual(M.shownIn(book)['SCR-HOME.admin'], ['c-a', 'c-b']);
  const keys = M.gateKeys(book, m, 'c-b');
  for (const k of ['SCR-HOME.admin', 'SCR-HOME.visitor', 'SCR-HOME.member', 'SCR-CARD.waiting', 'SCR-HOME', 'SCR-CARD']) {
    assert.ok(keys.includes(k), k);
  }
  assert.equal(new Set(keys).size, keys.length);
});

test('requirementsFor lists direct and via-component requirements in book order', () => {
  const rows = M.requirementsFor(fixture(), mockups(), 'SCR-HOME');
  assert.equal(rows.length, 2);
  const r2 = rows.find(r => r.req.id === 'R2');
  const r1 = rows.find(r => r.req.id === 'R1');
  assert.equal(r2.state, 'admin');
  assert.equal(r2.via, null);
  assert.equal(r2.fullId, 'c-b');
  assert.equal(r2.chapterId, 'c');
  assert.equal(r1.via, 'SCR-CARD');
});

test('missingRoles', () => {
  const book = fixture();
  assert.deepEqual(M.missingRoles(book, 'SCR-HOME'), []);
  assert.deepEqual(M.missingRoles(book, 'SCR-CARD'), []);
  book.screens[0].states.pop();
  assert.deepEqual(M.missingRoles(book, 'SCR-HOME'), ['visitor']);
  book.screens[0].states[0].when.role = 'anyone';
  assert.deepEqual(M.missingRoles(book, 'SCR-HOME'), []);
});

test('screenProblem is null for a valid book and names the culprit otherwise', () => {
  const m = mockups();
  assert.equal(M.screenProblem(fixture(), all, m), null);
  const bad = (mutate, re, exists = all, mk = m) => {
    const b = fixture();
    mutate(b);
    const p = M.screenProblem(b, exists, mk);
    assert.ok(p && re.test(p), String(p));
  };
  bad(b => { b.screens[1].id = 'SCR-HOME'; }, /share the id SCR-HOME/);
  bad(b => { b.screens[1].name = 'HomeScreen'; }, /named HomeScreen/);
  bad(b => { b.screens[0].states[1].id = 'member'; }, /two states with the id member/);
  bad(b => { b.screens[0].states[0].sameAs = 'admin'; }, /SCR-HOME\.member needs exactly one/);
  bad(b => { b.screens[0].states[2].sameAs = 'visitor'; }, /SCR-HOME\.visitor is in a sameAs cycle/);
  bad(b => { b.screens[0].states[2].sameAs = 'ghost'; }, /SCR-HOME\.visitor is sameAs ghost, which is not a state/);
  bad(b => { b.screens[0].states.push({ id: 'x', name: 'X', sameAs: 'visitor' }); }, /SCR-HOME\.x is sameAs visitor, which is itself sameAs/);
  bad(b => { b.screens[0].states[0].sameAs = 'visitor'; delete b.screens[0].states[0].mockup; b.screens[0].states[2].sameAs = 'member'; }, /SCR-HOME\.member is in a sameAs cycle/);
  bad(b => { b.screens[0].states[0].when.role = 'wizard'; }, /SCR-HOME\.member names the role wizard/);
  bad(b => {}, /SCR-HOME\.admin points at a missing picture, mockups\/home-admin\.html/, p => p !== 'mockups/home-admin.html');
  bad(b => {}, /places SCR-NOPE, which is not a component/, all, { ...m, 'mockups/home-member.html': '<sb-component id="SCR-NOPE" state="a"></sb-component>' });
  bad(b => {}, /places SCR-CARD\.gone, which is not a state/, all, { ...m, 'mockups/home-member.html': '<sb-component id="SCR-CARD" state="gone"></sb-component>' });
  bad(b => { b.chapters[0].sections[0].requirements[0].screens = [{ screen: 'SCR-HOME', state: 'ghost' }]; }, /Requirement R1 names SCR-HOME\.ghost, which is not a state/);
  bad(b => { b.chapters[0].sections[0].shows[0].state = 'SCR-HOME.ghost'; }, /Section c-a shows SCR-HOME\.ghost, which is not a state/);
  bad(b => { b.chapters[0].sections[1].shows[0].highlight = 'SCR-CARD'; b.chapters[0].sections[1].shows[0].state = 'SCR-HOME.member'; }, /Section c-b highlights SCR-CARD, which SCR-HOME\.member does not place/);
  bad(b => { b.screens.push(null); }, /Screen entry 3 is not an object/);
  bad(b => { b.screens[0].states.push({ name: 'no id' }); }, /State 4 of screen SCR-HOME is not an object with an id/);
  bad(b => { b.screens[0].states.push(7); }, /State 4 of screen SCR-HOME/);
});

test('a highlight may name a component nested inside a placed component', () => {
  const book = fixture();
  book.screens.push({ id: 'SCR-DOT', name: 'Dot', kind: 'component', states: [{ id: 'on', name: 'On', mockup: 'mockups/dot.html' }] });
  const m = { ...mockups(), 'mockups/dot.html': '<i>dot</i>', 'mockups/card-waiting.html': '<sb-component id="SCR-DOT" state="on"></sb-component>' };
  book.chapters[0].sections[0].shows[0].highlight = 'SCR-DOT';
  assert.equal(M.screenProblem(book, all, m), null);
  assert.match(M.expandMockup(book, m, m['mockups/home-admin.html'], { highlight: 'SCR-DOT' }), /sb-component sb-hl" data-key="SCR-DOT\.on"/);
});

test('offPageKeys: what a section gates but cannot draw, and what bySection leaves out of its count', () => {
  const book = fixture();
  const m = mockups();
  const under = (...keys) => ({ byKey: Object.fromEntries(keys.map(k => [k, { key: k }])) });
  // c-b shows SCR-HOME.admin (which places SCR-CARD.waiting) and SCR-HOME.visitor (sameAs member).
  // A state it shows is drawn there: not linked.
  assert.deepEqual(M.offPageKeys(book, m, 'c-b', under('SCR-HOME.admin')), { keys: [], uncounted: 0 });
  // A component state placed in a shown picture: linked and uncounted.
  assert.deepEqual(M.offPageKeys(book, m, 'c-b', under('SCR-CARD.waiting')), { keys: ['SCR-CARD.waiting'], uncounted: 1 });
  // The state a shown state is drawn as (sameAs), not shown here itself: linked and uncounted.
  assert.deepEqual(M.offPageKeys(book, m, 'c-b', under('SCR-HOME.member')), { keys: ['SCR-HOME.member'], uncounted: 1 });
  // The heading of a screen the section shows: linked, but bySection counts it already.
  assert.deepEqual(M.offPageKeys(book, m, 'c-b', under('SCR-HOME')), { keys: ['SCR-HOME'], uncounted: 0 });
  // The heading of a screen it does not show (the placed component's): linked and uncounted.
  assert.deepEqual(M.offPageKeys(book, m, 'c-b', under('SCR-CARD')), { keys: ['SCR-CARD'], uncounted: 1 });
  // A section that shows nothing has nothing off the page.
  assert.deepEqual(M.offPageKeys(book, m, 'c-x', under('SCR-CARD')), { keys: [], uncounted: 0 });
});

test('offPageKeys agrees with reviews().bySection: together they count each gated review once', () => {
  const book = fixture();
  const m = mockups();
  const accepted = Object.fromEntries(Object.entries(M.itemsOf(book, m)).map(([k, it]) => [k, JSON.parse(JSON.stringify(it.value))]));
  // Change the shown state, the sameAs target, the placed component state and both screens' headings.
  m['mockups/home-admin.html'] += ' ';
  m['mockups/home-member.html'] += ' ';
  m['mockups/card-waiting.html'] += ' ';
  book.screens[0].file = 'Home.tsx';
  book.screens[1].file = 'Card.tsx';
  const rv = M.reviews(book, m, { accepted }, null);
  const off = M.offPageKeys(book, m, 'c-b', rv);
  assert.deepEqual([...off.keys].sort(), ['SCR-CARD', 'SCR-CARD.waiting', 'SCR-HOME', 'SCR-HOME.member']);
  const gated = new Set(M.gateKeys(book, m, 'c-b').filter(k => rv.byKey[k]));
  assert.equal(rv.bySection['c-b'] + off.uncounted, gated.size);
});

test('screenOrder: book order of first appearance, then the rest in catalog order', () => {
  const book = fixture();
  const m = mockups();
  assert.deepEqual(M.screenOrder(book, m), ['SCR-HOME', 'SCR-CARD']);
  book.screens.unshift({ id: 'SCR-LOST', name: 'Lost', kind: 'screen', states: [] }, { id: 'SCR-REQ', name: 'Named', kind: 'screen', states: [] });
  book.chapters[0].sections[0].shows = [];
  book.chapters[0].sections[0].requirements[0].screens = [{ screen: 'SCR-REQ' }, { screen: 'SCR-GONE' }];
  // c-a now shows nothing and names SCR-REQ; c-b shows Home, which places the card; Lost is never reached.
  assert.deepEqual(M.screenOrder(book, m), ['SCR-REQ', 'SCR-HOME', 'SCR-CARD', 'SCR-LOST']);
});

test('byRole: anyone, then the book\'s roles in order, then unknown roles, then no role; ties keep their order', () => {
  const book = fixture();
  const st = (id, role) => ({ id, when: role ? { role } : {} });
  const states = [st('none1'), st('vis', 'visitor'), st('mem1', 'member'), st('odd', 'guest'), st('all', 'anyone'), st('mem2', 'member'), st('none2'), st('adm', 'admin')];
  assert.deepEqual(M.byRole(book, states).map(s => s.id), ['all', 'mem1', 'mem2', 'adm', 'vis', 'odd', 'none1', 'none2']);
  assert.deepEqual(M.byRole(book, undefined), []);
});

test('componentsIn reads id and state, not data-id or data-state', () => {
  const html = '<sb-component data-id="Z" data-state="q" id="X" state="a"></sb-component><sb-component data-state="q" state="b" data-id="Z" id="Y">';
  assert.deepEqual(M.componentsIn(html), [{ id: 'X', state: 'a' }, { id: 'Y', state: 'b' }]);
});

// A book of components A and B whose pictures place one another as a test needs.
const cycleBook = () => {
  const book = fixture();
  book.screens.push(
    { id: 'SCR-A', name: 'A', kind: 'component', states: [{ id: 's', name: 'S', mockup: 'mockups/a.html' }, { id: 'gone', name: 'Gone', absent: true }, { id: 'like', name: 'Like', sameAs: 'gone' }] },
    { id: 'SCR-B', name: 'B', kind: 'component', states: [{ id: 't', name: 'T', mockup: 'mockups/b.html' }] }
  );
  return book;
};
const cycleProblem = (a, b) => M.screenProblem(cycleBook(), all, { ...mockups(), 'mockups/a.html': a, 'mockups/b.html': b });

test('screenProblem fails a component cycle, naming it, and a placed state that draws no picture', () => {
  assert.equal(cycleProblem('<sb-component id="SCR-B" state="t"></sb-component>', '<i>b</i>'), null);
  assert.equal(cycleProblem('<sb-component id="SCR-A" state="s"></sb-component>', '<i>b</i>'),
    'The picture mockups/a.html places SCR-A.s, a component cycle: SCR-A.s → SCR-A.s');
  assert.equal(cycleProblem('<sb-component id="SCR-B" state="t"></sb-component>', '<sb-component id="SCR-A" state="s"></sb-component>'),
    'The picture mockups/b.html places SCR-A.s, a component cycle: SCR-A.s → SCR-B.t → SCR-A.s');
  assert.equal(cycleProblem('<i>a</i>', '<sb-component id="SCR-A" state="gone"></sb-component>'),
    'The picture mockups/b.html places SCR-A.gone, which draws no picture');
  assert.equal(cycleProblem('<i>a</i>', '<sb-component id="SCR-A" state="like"></sb-component>'),
    'The picture mockups/b.html places SCR-A.like, which draws no picture');
  // A cycle reached from a screen's picture is named from where it starts.
  const m = { ...mockups(), 'mockups/card-waiting.html': '<sb-component id="SCR-CARD" state="waiting"></sb-component>' };
  assert.match(M.screenProblem(fixture(), all, m), /a component cycle: SCR-CARD\.waiting → SCR-CARD\.waiting$/);
});

test('expandMockup stops a chain of components deeper than its cap with a missing marker', () => {
  const book = { screens: [], chapters: [] };
  const m = {};
  for (let i = 0; i < 10; i++) {
    book.screens.push({ id: `SCR-C${i}`, name: `C${i}`, kind: 'component', states: [{ id: 's', name: 'S', mockup: `mockups/c${i}.html` }] });
    m[`mockups/c${i}.html`] = i < 9 ? `<p>${i}</p><sb-component id="SCR-C${i + 1}" state="s"></sb-component>` : '<p>9</p>';
  }
  const out = M.expandMockup(book, m, '<sb-component id="SCR-C0" state="s"></sb-component>');
  assert.equal((out.match(/class="sb-component"/g) || []).length, 8);
  assert.match(out, /<p>7<\/p><div class="sb-missing" data-key="SCR-C8\.s">Missing component SCR-C8\.s<\/div>/);
  assert.doesNotMatch(out, /<p>8<\/p>/);
});

test('screenProblem accepts the role "anyone" whether or not the book lists it', () => {
  const book = fixture();
  book.screens[0].states[0].when.role = 'anyone';
  assert.equal(M.screenProblem(book, all, mockups()), null);
  book.roles.push({ id: 'anyone' });
  assert.equal(M.screenProblem(book, all, mockups()), null);
});

test('screenProblem fails a state whose change is not add, change or remove', () => {
  const book = fixture();
  book.screens[0].states[1].change = 'remove';
  assert.equal(M.screenProblem(book, all, mockups()), null);
  book.screens[0].states[1].change = 'changed';
  assert.equal(M.screenProblem(book, all, mockups()), 'State SCR-HOME.admin has the change changed, which is not add, change or remove');
});
