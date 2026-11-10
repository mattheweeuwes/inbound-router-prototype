// The cockpit's address (public/address-model.js): the tab and the view in location.hash, read and written without a browser, and the
// time words every tab shares (public/time.js).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TAB_IDS, buildAddress, isOn, oneOf, parseAddress, sameAddress, slugOf, tabOfSlug } from '../public/address-model.js';
import { cellTime, fullTime, shortParts, timeTag, utcExact, withLocalTimes } from '../public/time.js';

describe('the address', () => {
  it('names a tab by a short word, and Feature to pipeline is "feature"', () => {
    assert.deepEqual(TAB_IDS.map(slugOf), ['overview', 'today', 'stream', 'review', 'outbound', 'feature', 'evals', 'quality', 'how']);
    for (const t of TAB_IDS) assert.equal(tabOfSlug(slugOf(t)), t);
    assert.equal(tabOfSlug('feature-pipeline'), null, 'the long id is not an address word');
    assert.equal(tabOfSlug('nope'), null);
  });

  it('reads the examples the page links to', () => {
    assert.deepEqual(parseAddress('#stream?lead=abc&enterprise=1&sort=score'), { tab: 'stream', params: { lead: 'abc', enterprise: '1', sort: 'score' } });
    assert.deepEqual(parseAddress('#outbound?ein=900000014&status=link'), { tab: 'outbound', params: { ein: '900000014', status: 'link' } });
    assert.deepEqual(parseAddress('#feature?f=network_benchmarking'), { tab: 'feature-pipeline', params: { f: 'network_benchmarking' } });
    assert.deepEqual(parseAddress('#today'), { tab: 'today', params: {} });
    assert.deepEqual(parseAddress('#review'), { tab: 'review', params: {} });
  });

  it('lands on the Overview when it names no tab, so an old or mistyped link still opens the page', () => {
    for (const h of ['', '#', '#nope', '#nope?lead=1', '#/']) assert.deepEqual(parseAddress(h), { tab: 'overview', params: {} }, h);
    assert.deepEqual(parseAddress('#/stream?lead=1'), { tab: 'stream', params: { lead: '1' } }, 'a leading slash is allowed');
  });

  it('decodes spaces and symbols, keeps a bare key as on, and survives a piece that does not decode', () => {
    assert.deepEqual(parseAddress('#stream?list=HLTH%202026&q=a+b&referrer=Wren%26Co&enterprise').params, { list: 'HLTH 2026', q: 'a b', referrer: 'Wren&Co', enterprise: '1' });
    assert.equal(parseAddress('#stream?q=100%').params.q, '100%');
    assert.deepEqual(parseAddress('#stream?&&=x&a=1').params, { a: '1' });
  });

  it('writes parameters in the order given, leaves out what is empty or false, and writes true as 1', () => {
    assert.equal(buildAddress('stream', { lead: 'abc', enterprise: true, referral: false, tier: '', team: undefined, q: null, sort: 'score' }), '#stream?lead=abc&enterprise=1&sort=score');
    assert.equal(buildAddress('feature-pipeline', { f: 'signal_ask' }), '#feature?f=signal_ask');
    assert.equal(buildAddress('today'), '#today');
    assert.equal(buildAddress('stream', { list: 'HLTH 2026', q: 'a&b=c' }), '#stream?list=HLTH%202026&q=a%26b%3Dc');
  });

  it('writes and reads back to the same view, whatever is in the values', () => {
    const params = { lead: 'a-b_c.1', q: 'R10 & "quotes" + plus 100%', list: 'ünï cödé', referrer: 'Wren, Inc.' };
    assert.deepEqual(parseAddress(buildAddress('stream', params)), { tab: 'stream', params });
  });

  it('two addresses are the same view when they name the same tab and parameters, in any order', () => {
    assert.ok(sameAddress('#stream?a=1&b=2', '#stream?b=2&a=1'));
    assert.ok(sameAddress('', '#overview'));
    assert.ok(!sameAddress('#stream?a=1', '#stream?a=2'));
    assert.ok(!sameAddress('#stream?a=1', '#stream'));
    assert.ok(!sameAddress('#stream', '#outbound'));
  });

  it('a hand-edited value cannot put a view in a state it does not have', () => {
    assert.deepEqual(['1', 'true', 'yes', '0', '', undefined, 'no'].map(isOn), [true, true, true, false, false, false, false]);
    assert.equal(oneOf('score', ['score', 'tier'], 'received'), 'score');
    assert.equal(oneOf('bogus', ['score', 'tier'], 'received'), 'received');
    assert.equal(oneOf(undefined, ['score'], 'received'), 'received');
  });
});

describe('times read the same way everywhere', () => {
  // 2026-11-10 21:30:07 UTC is 4:30 PM Eastern (standard time)
  const iso = '2026-11-10T21:30:07.000Z';
  it('prints Eastern time, and the exact UTC time is what the hover says', () => {
    assert.deepEqual(shortParts(iso), { day: 'Tue, Nov 10', time: '4:30 PM' });
    assert.equal(fullTime(iso), 'Tue, Nov 10, 4:30:07 PM ET');
    assert.equal(cellTime(iso), 'Nov 10, 4:30 PM');
    assert.equal(utcExact(iso), '2026-11-10 21:30:07 UTC');
  });
  it('summer time is Eastern too, so the offset follows the date', () => {
    assert.equal(cellTime('2026-07-10T21:30:00.000Z'), 'Jul 10, 5:30 PM');
  });
  it('a time as markup carries the exact time in its title and its machine time, and escapes nothing it should not', () => {
    assert.equal(timeTag(iso), '<time datetime="2026-11-10T21:30:07.000Z" title="2026-11-10 21:30:07 UTC">Nov 10, 4:30 PM</time>');
    assert.equal(timeTag(iso, 'full'), '<time datetime="2026-11-10T21:30:07.000Z" title="2026-11-10 21:30:07 UTC">Tue, Nov 10, 4:30:07 PM ET</time>');
    assert.equal(timeTag(iso, 'short'), '<time datetime="2026-11-10T21:30:07.000Z" title="2026-11-10 21:30:07 UTC">Tue 4:30 PM</time>');
  });
  it('a missing or unreadable time is a dash, not "Invalid Date"', () => {
    for (const bad of [null, undefined, '', 'not a time']) {
      assert.equal(timeTag(bad), '—');
      assert.equal(fullTime(bad), '—');
      assert.equal(cellTime(bad), '—');
      assert.equal(utcExact(bad), '');
      assert.deepEqual(shortParts(bad), { day: '', time: '—' });
    }
  });
  it('a time the server wrote as text is turned into the same thing, and only the time is', () => {
    assert.equal(withLocalTimes('due 2026-11-10 21:30 UTC, then <i>again</i> 2026-11-11 14:00 UTC'),
      'due <time datetime="2026-11-10T21:30:00.000Z" title="2026-11-10 21:30:00 UTC">Tue 4:30 PM</time>, then &lt;i&gt;again&lt;/i&gt; <time datetime="2026-11-11T14:00:00.000Z" title="2026-11-11 14:00:00 UTC">Wed 9:00 AM</time>');
  });
});
