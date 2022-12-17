/*eslint-env node */

const webpack = require("webpack");

const BANNER_TEXT = `'[name].js is part of the ArchiveWeb.page system (https://archiveweb.page) Copyright (C) 2020-${new Date().getFullYear()}, Webrecorder Software. Licensed under the Affero General Public License v3.'`;


module.exports = {
  output: {
    filename: "sw.js",
  },
  plugins: [
    new webpack.NormalModuleReplacementPlugin(
      /^node:*/,
      (resource) => {
        switch (resource.request) {
        case "node:stream":
          resource.request = "stream-browserify";
          break;
        }
      },
    ),

    new webpack.BannerPlugin(BANNER_TEXT),
  ],
    
  module: {
    rules: [
      {
        test: /wombat.js|wombatWorkers.js|index.html$/i,
        use: ["raw-loader"],
      }
    ]
  },
};


