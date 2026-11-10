// The outbound module's pure parts: the CSV reader, the rate file's rows, and the card and factor searches ported from
// the take-home's analysis.py.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvRecords, parseCsv } from '../src/outbound/csv';
import {
  baseSearch, bestPattern, contractForm, factor, median, MIN_PATTERN_HITS, roundHalfEven, tier, unitSearch,
} from '../src/outbound/patterns';
import { parseRateFile, placeOf, titleCase } from '../src/outbound/rateFile';

describe('CSV reader (RFC 4180)', () => {
  it('reads quoted fields holding commas, line breaks and doubled quotes', () => {
    const rows = parseCsv('a,b,c\r\n"1, 2","line\r\nbreak","say ""hi"""\r\n');
    assert.deepEqual(rows, [['a', 'b', 'c'], ['1, 2', 'line\r\nbreak', 'say "hi"']]);
  });
  it('takes LF or CRLF, skips a BOM, keeps empty fields, and makes no record of a trailing line break', () => {
    assert.deepEqual(parseCsv('﻿a,b\n,x\n'), [['a', 'b'], ['', 'x']]);
    assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a,\n'), [['a', '']]);
    assert.deepEqual(parseCsv(''), []);
  });
  it('refuses a stray quote, text after a closing quote and an unclosed quote, naming the line', () => {
    assert.throws(() => parseCsv('a,b\nx"y,z\n'), /line 2: a quote inside an unquoted field/);
    assert.throws(() => parseCsv('"a"b,c\n'), /line 1: text after a closing quote/);
    assert.throws(() => parseCsv('a,"b\nc\n'), /never closed/);
  });
  it('keys records by the header and refuses a record of the wrong width', () => {
    assert.deepEqual(csvRecords('x,y\n1,2\n'), [{ x: '1', y: '2' }]);
    assert.throws(() => csvRecords('x,y\n1,2,3\n'), /record 1: 3 fields, the header has 2/);
  });
});

describe('rate file rows', () => {
  it('takes the state from the street address and the city from the part before it, as analysis.py does', () => {
    assert.deepEqual(placeOf('6410 FANNIN ST 1500, HOUSTON, TX 77030', 'OK'), { state: 'TX', city: 'HOUSTON' });
    assert.deepEqual(placeOf('PO BOX 9, SOMEWHERE', 'NM'), { state: 'NM', city: '' });
  });
  it('title-cases a city the way Python str.title does', () => {
    assert.equal(titleCase('OKLAHOMA CITY'), 'Oklahoma City');
    assert.equal(titleCase("COEUR D'ALENE"), "Coeur D'Alene");
  });
  const header = 'Payer,NetworkName,NetworkYearMonth,EntityName,EIN,FilteredNPIListLength,PayerSourceNPIListLength,AllPayerIndividualNPIs,MostCommonPayerNPITaxonomyName,MostCommonPayerNPIRegion,EntityAddress,Code,PlaceOfServiceList,IsBillableClaims,Rate,IsMostNpisPerEinCode,Baseline,RelativeToBaseline';
  const row = (over: Partial<Record<string, string>> = {}) => {
    const v: Record<string, string> = {
      Payer: 'UnitedHealthcare', NetworkName: 'Choice Plus', NetworkYearMonth: '202608', EntityName: 'A GROUP', EIN: '1', FilteredNPIListLength: '2',
      PayerSourceNPIListLength: '3', AllPayerIndividualNPIs: '4', MostCommonPayerNPITaxonomyName: 'Psychiatry Physician', MostCommonPayerNPIRegion: 'TX',
      EntityAddress: '"1 MAIN ST, DALLAS, TX 75201"', Code: '90837', PlaceOfServiceList: '11', IsBillableClaims: 'true', Rate: '"$1,163.09"',
      IsMostNpisPerEinCode: 'false', Baseline: '$168', RelativeToBaseline: '97%', ...over,
    };
    return header.split(',').map(h => v[h]).join(',');
  };
  it('reads amounts with a dollar sign and thousands separator, percents as fractions and flags as booleans', () => {
    const { scope, rows } = parseRateFile(`${header}\n${row()}\n`);
    assert.deepEqual(scope, { payer: 'UnitedHealthcare', network: 'Choice Plus', networkMonth: '202608', code: '90837' });
    assert.equal(rows[0].rate, 1163.09);
    assert.equal(rows[0].medicare, 168);
    assert.equal(rows[0].pctMedicare, 0.97);
    assert.equal(rows[0].mostNpis, false);
    assert.equal(rows[0].claimsEvidence, true);
    assert.equal(rows[0].nameNorm, 'a group');
  });
  it('refuses a missing column, a bad amount, and a file that mixes codes', () => {
    assert.throws(() => parseRateFile('EIN,Rate\n1,$2\n'), /missing Payer/);
    assert.throws(() => parseRateFile(`${header}\n${row({ Rate: 'n/a' })}\n`), /record 1: Rate is not an amount/);
    assert.throws(() => parseRateFile(`${header}\n${row()}\n${row({ Code: '90834' })}\n`), /mixes 2/);
    assert.throws(() => parseRateFile(`${header}\n`), /no rows/);
  });
});

describe('rate card and conversion factor (ported from analysis.py)', () => {
  it('rounds half to even, like Python round()', () => {
    assert.deepEqual([0.5, 1.5, 2.5, 3.49, 3.51].map(roundHalfEven), [0, 2, 2, 3, 4]);
  });
  it('tier: a whole percent of the base to the cent, from 50% to 300%', () => {
    assert.equal(tier(113.18, 141.47), 80); // 141.47 x 0.80 = 113.176
    assert.equal(tier(106.10, 141.47), 75); // 106.1025
    assert.equal(tier(148.54, 141.47), 105); // 148.5435
    assert.equal(tier(183.91, 141.47), 130);
    assert.equal(tier(113.20, 141.47), null, 'two cents off is not on the card');
    assert.equal(tier(70.0, 141.47), null, '49%: below the range');
    assert.equal(tier(141.47 * 3.01, 141.47), null, '301%: above the range');
  });
  it('factor: an exact whole multiple of the unit, in cents', () => {
    assert.equal(factor(163.09, 3.47), 47);
    assert.equal(factor(183.91, 3.47), 53);
    assert.equal(factor(163.10, 3.47), null);
  });
  it('base search: every distinct rate from $100 to $200 as a base, most hits first, then the larger base', () => {
    const rates = [113.18, 127.32, 141.47, 148.54, 250.0, 90.0];
    const ranked = baseSearch(rates);
    assert.deepEqual(ranked[0], { value: 141.47, hits: 4 });
    assert.ok(ranked.every(h => h.value >= 100 && h.value <= 200), 'only bases from $100 to $200');
    const tie = baseSearch([120.0, 130.0]); // each explains only itself
    assert.deepEqual(tie.map(h => h.value), [130.0, 120.0], 'a tie goes to the larger base, as Python sorts (hits, base) in reverse');
  });
  it('unit search: every amount from $2.00 to $10.00, most exact multiples first', () => {
    const ranked = unitSearch([163.09, 183.91, 114.51, 113.19]);
    assert.deepEqual(ranked[0], { value: 3.47, hits: 3 });
    assert.equal(ranked.length, 801, '$2.00 to $10.00 by the cent');
  });
  it('a pattern needs MIN_PATTERN_HITS rates, because every base explains itself', () => {
    assert.equal(bestPattern([{ value: 1, hits: MIN_PATTERN_HITS - 1 }]), null);
    assert.deepEqual(bestPattern([{ value: 1, hits: MIN_PATTERN_HITS }]), { value: 1, hits: MIN_PATTERN_HITS });
    assert.equal(bestPattern([]), null);
  });
  it('contract form: card, factor, both or neither, and nothing when a pattern is absent', () => {
    assert.deepEqual(contractForm(183.91, 141.47, 3.47), { form: 'both', cardTier: 130, factorMultiple: 53 });
    assert.deepEqual(contractForm(113.18, 141.47, 3.47), { form: 'card', cardTier: 80, factorMultiple: null });
    assert.deepEqual(contractForm(163.09, 141.47, 3.47), { form: 'factor', cardTier: null, factorMultiple: 47 });
    assert.deepEqual(contractForm(147.64, 141.47, 3.47), { form: 'neither', cardTier: null, factorMultiple: null });
    assert.deepEqual(contractForm(183.91, null, null), { form: 'neither', cardTier: null, factorMultiple: null });
  });
  it('median: the middle value, or the mean of the two middle values', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.ok(Number.isNaN(median([])));
  });
});
