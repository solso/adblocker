const path = require('path');

const { FiltersEngine } = require(path.resolve(__dirname, '../../'));

module.exports = class Cliqz {
  static parse(rawLists) {
    return new Cliqz(FiltersEngine.parse(rawLists, { loadCosmeticFilters: false }));
  }

  constructor(engine) {
    this.engine = engine;
  }

  serialize() {
    return this.engine.serialize();
  }

  deserialize(serialized) {
    this.engine = FiltersEngine.deserialize(serialized);
  }

  match(request) {
    return this.engine.match(request).match;
  }
};
