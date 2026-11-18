'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../modules/vcpLoop/toolMarkerFuzzyMatcher');

test('fuzzy field marker negative lookahead treats ESCAPE case-insensitively', () => {
    const prevEnabled = matcher.isEnabled();
    const prevDebug = matcher.debugMode;
    try {
        matcher.configure({ enabled: true, debugMode: false });

        assert.equal(matcher.matchFieldStartMarker('「始escape」abc', 0), null);
        assert.equal(matcher.matchFieldStartMarker('「始ESCAPE」abc', 0), null);
        assert.deepEqual(matcher.matchFieldStartMarker('「始fuzzy」abc', 0), {
            marker: '「始fuzzy」',
            fuzzy: true
        });

        assert.deepEqual(
            matcher.findFieldEndMarker('foo「末escape」bar「末」', 0),
            { index: 15, marker: '「末」', fuzzy: false }
        );
        assert.deepEqual(
            matcher.findFieldEndMarker('foo「末ESCAPE」bar「末fuzzy」', 0),
            { index: 15, marker: '「末fuzzy」', fuzzy: true }
        );
    } finally {
        matcher.configure({ enabled: prevEnabled, debugMode: prevDebug });
    }
});
