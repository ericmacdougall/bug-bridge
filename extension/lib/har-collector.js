/**
 * Accumulates network requests into HAR 1.2 format.
 * Used by the DevTools panel to collect network data.
 * @module har-collector
 */

class HarCollector {
  constructor() {
    /** @type {Array<object>} HAR entries */
    this.entries = [];
    /** @type {number} Maximum entries to store */
    this.maxEntries = 1000;
  }

  /**
   * Adds a HAR entry.
   * @param {object} harEntry - A HAR 1.2 entry object
   */
  addEntry(harEntry) {
    this.entries.push(harEntry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift(); // FIFO eviction
    }
  }

  /**
   * Returns a complete HAR object.
   * @returns {object} HAR 1.2 compliant object
   */
  getHar() {
    return {
      log: {
        version: '1.2',
        creator: {
          name: 'Bug Bridge',
          version: '0.1.0'
        },
        entries: [...this.entries]
      }
    };
  }

  /**
   * Returns only entries where the response indicates an error.
   * Error = response.status >= 400 or status 0 (failed/blocked/CORS).
   * @returns {Array<object>} Error HAR entries
   */
  getErrorsOnly() {
    return this.entries.filter((entry) => {
      const status = entry.response ? entry.response.status : 0;
      return status === 0 || status >= 400;
    });
  }

  /**
   * Returns the total number of entries.
   * @returns {number}
   */
  getCount() {
    return this.entries.length;
  }

  /**
   * Returns the number of error entries.
   * @returns {number}
   */
  getErrorCount() {
    return this.getErrorsOnly().length;
  }

  /**
   * Resets the collector.
   */
  clear() {
    this.entries = [];
  }
}
