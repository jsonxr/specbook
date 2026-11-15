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
  assert.match(out, /data-key="SCR-CARD\.waiting"/);
  assert.match(out, /<b>3 waiting<\/b>/);
  assert.doesNotMatch(out, /sb-hl/);
  assert.match(M.expandMockup(book, m, m['mockups/home-admin.html'], { highlight: 'SCR-CARD' }), /class="[^"]*sb-hl/);

  m['mockups/card-waiting.html'] = '<sb-component id="SCR-CARD" state="waiting"></sb-component>';
  const loop = M.expandMockup(book, m, m['mockups/card-waiting.html']);
  assert.match(loop, /sb-missing/);
  assert.match(loop, /SCR-CARD\.waiting/);

  const gone = M.expandMockup(book, m, '<sb-component id="SCR-CARD" state="gone"></sb-component>');
  assert.match(gone, /sb-missing/);
  assert.match(gone, /SCR-CARD\.gone/);
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
  bad(b => { b.screens[1].id = 'SCR-HOME'; }, /SCR-HOME/);
  bad(b => { b.screens[1].name = 'HomeScreen'; }, /HomeScreen/);
  bad(b => { b.screens[0].states[1].id = 'member'; }, /SCR-HOME.*member/);
  bad(b => { b.screens[0].states[0].sameAs = 'admin'; }, /SCR-HOME\.member/);
  bad(b => { b.screens[0].states[2].sameAs = 'visitor'; }, /SCR-HOME\.visitor/);
  bad(b => { b.screens[0].states[2].sameAs = 'ghost'; }, /ghost/);
  bad(b => { b.screens[0].states.push({ id: 'x', name: 'X', sameAs: 'visitor' }); }, /SCR-HOME\.x.*sameAs/);
  bad(b => { b.screens[0].states[0].sameAs = 'visitor'; delete b.screens[0].states[0].mockup; b.screens[0].states[2].sameAs = 'member'; }, /cycle/);
  bad(b => { b.screens[0].states[0].when.role = 'wizard'; }, /wizard/);
  bad(b => {}, /home-admin\.html/, p => p !== 'mockups/home-admin.html');
  bad(b => {}, /SCR-NOPE/, all, { ...m, 'mockups/home-member.html': '<sb-component id="SCR-NOPE" state="a"></sb-component>' });
  bad(b => {}, /SCR-CARD\.gone/, all, { ...m, 'mockups/home-member.html': '<sb-component id="SCR-CARD" state="gone"></sb-component>' });
  bad(b => { b.chapters[0].sections[0].requirements[0].screens = [{ screen: 'SCR-HOME', state: 'ghost' }]; }, /R1.*ghost/);
  bad(b => { b.chapters[0].sections[0].shows[0].state = 'SCR-HOME.ghost'; }, /SCR-HOME\.ghost/);
  bad(b => { b.chapters[0].sections[1].shows[0].highlight = 'SCR-CARD'; b.chapters[0].sections[1].shows[0].state = 'SCR-HOME.member'; }, /SCR-CARD.*SCR-HOME\.member/);
});
