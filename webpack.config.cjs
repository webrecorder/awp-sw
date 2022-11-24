const fallback2 = {
  "stream": require.resolve("stream-browserify"),
  "querystring": require.resolve("querystring-es3"),
  "url": require.resolve("url/")
};

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


