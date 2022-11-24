/*eslint-env node */

const webpack = require("webpack");

const fallback = {"stream": false, "querystring": false, "url": false};

const BANNER_TEXT = "'[name].js is part of the ArchiveWeb.page system (https://archiveweb.page) Copyright (C) 2020-2022, Webrecorder Software. Licensed under the Affero General Public License v3.'";


module.exports = {
  resolve: { fallback },

  output: {
    filename: "sw.js",
  },
  plugins: [
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


