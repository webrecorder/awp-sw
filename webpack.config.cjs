/*eslint-env node */

const fallback = {"stream": false, "querystring": false, "url": false};

module.exports = {
  resolve: { fallback },
    
  module: {
    rules: [
      {
        test: /wombat.js|wombatWorkers.js|index.html$/i,
        use: ["raw-loader"],
      }
    ]
  },
};


