/*eslint-env node */
const path = require("path");
const webpack = require("webpack");
const TerserPlugin = require("terser-webpack-plugin");
const TsconfigPathsPlugin = require("tsconfig-paths-webpack-plugin");

const BANNER_TEXT = `'[name].js is part of the ArchiveWeb.page system (https://archiveweb.page) Copyright (C) 2020-${new Date().getFullYear()}, Webrecorder Software. Licensed under the Affero General Public License v3.'`;


module.exports = {
  target: "webworker",
  entry: {
    "main": "./src/index.ts",
  },
  output: {
    filename: "sw.js",
    library: {
      type: "self"
    }
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
      }),
    ]
  },

  resolve: {
    extensions: [".ts", ".js"],
    plugins: [new TsconfigPathsPlugin()],
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
      },
      {
        test: /\.tsx?$/,
        loader: "ts-loader",
        include: path.resolve(__dirname, "src"),
        options: {
          onlyCompileBundledFiles: false,
        },
      },
    ],
  },
};


