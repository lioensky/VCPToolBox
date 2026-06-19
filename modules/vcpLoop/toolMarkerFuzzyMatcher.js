// modules/vcpLoop/toolMarkerFuzzyMatcher.js

class ToolMarkerFuzzyMatcher {
  constructor() {
    this.enabled = false;
    this.debugMode = false;
  }

  configure(options = {}) {
    this.enabled = options.enabled === true;
    this.debugMode = options.debugMode === true;
  }

  isEnabled() {
    return this.enabled === true;
  }

  _log(message) {
    if (this.debugMode) {
      console.log(`[ToolMarkerFuzzyMatcher] ${message}`);
    }
  }

  getEscapeStartRegex(anchor = false) {
    return new RegExp(`${anchor ? '^' : ''}[「{]始ESCAPE[」}]`, 'i');
  }

  getEscapeEndRegex(anchor = false) {
    return new RegExp(`${anchor ? '^' : ''}[「{]末ESCAPE[」}]`, 'i');
  }

  _findToolBlockMarker(content, cursor, label, canonicalMarker) {
    if (!content || typeof content !== 'string') {
      return null;
    }

    if (!this.enabled) {
      const index = content.indexOf(canonicalMarker, cursor);
      return index === -1
        ? null
        : {
            index,
            marker: canonicalMarker,
            fuzzy: false
          };
    }

    const markerRegex = new RegExp(`<{2,4}\\[${label}\\]>{2,4}`, 'gi');
    markerRegex.lastIndex = cursor;

    const match = markerRegex.exec(content);
    if (!match) {
      return null;
    }

    const fuzzy = match[0] !== canonicalMarker;
    if (fuzzy) {
      this._log(`Fuzzy block marker matched for ${label}: ${JSON.stringify(match[0])}`);
    }

    return {
      index: match.index,
      marker: match[0],
      fuzzy
    };
  }

  findBlockStartMarker(content, cursor) {
    return this._findToolBlockMarker(content, cursor, 'TOOL_REQUEST', '<<<[TOOL_REQUEST]>>>');
  }

  findBlockEndMarker(content, cursor) {
    return this._findToolBlockMarker(content, cursor, 'END_TOOL_REQUEST', '<<<[END_TOOL_REQUEST]>>>');
  }

  matchFieldStartMarker(content, cursor) {
    if (!content || typeof content !== 'string') {
      return null;
    }

    const slice = content.slice(cursor);
    const strictCandidates = this.enabled
      ? ['「始」', '{始}', '{始」', '「始}']
      : ['「始」'];

    for (const candidate of strictCandidates) {
      if (slice.startsWith(candidate)) {
        return {
          marker: candidate,
          fuzzy: false
        };
      }
    }

    if (!this.enabled) {
      return null;
    }

    const fuzzyMatch = /^[「{]始(?!ESCAPE)(?:[^\r\n「{]*?[」}])/.exec(slice);
    if (!fuzzyMatch) {
      return null;
    }

    this._log(`Fuzzy start marker matched: ${JSON.stringify(fuzzyMatch[0])}`);
    return {
      marker: fuzzyMatch[0],
      fuzzy: true
    };
  }

  findFieldEndMarker(content, cursor) {
    if (!content || typeof content !== 'string') {
      return null;
    }

    const strictCandidates = this.enabled
      ? ['「末」', '{末}', '{末」', '「末}']
      : ['「末」'];

    let bestMatch = null;

    for (const candidate of strictCandidates) {
      const index = content.indexOf(candidate, cursor);
      if (index !== -1 && (!bestMatch || index < bestMatch.index)) {
        bestMatch = {
          index,
          marker: candidate,
          fuzzy: false
        };
      }
    }

    if (this.enabled) {
      const fuzzyEndRegex = /[「{]末(?!ESCAPE)(?:[^\r\n「{]*?[」}])/g;
      fuzzyEndRegex.lastIndex = cursor;
      const fuzzyMatch = fuzzyEndRegex.exec(content);
      if (fuzzyMatch && (!bestMatch || fuzzyMatch.index < bestMatch.index)) {
        bestMatch = {
          index: fuzzyMatch.index,
          marker: fuzzyMatch[0],
          fuzzy: true
        };
      }
    }

    if (bestMatch && bestMatch.fuzzy) {
      this._log(`Fuzzy end marker matched: ${JSON.stringify(bestMatch.marker)}`);
    }

    return bestMatch;
  }
}

module.exports = new ToolMarkerFuzzyMatcher();