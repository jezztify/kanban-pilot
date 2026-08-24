//@ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const { sources } = require('webpack');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

const typescriptRule = {
  test: /\.ts$/,
  exclude: /node_modules/,
  use: [
    {
      loader: 'ts-loader'
    }
  ]
};

const resolveConfig = {
  extensions: ['.ts', '.js', '.mjs']
};

class MermaidRuntimePlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('MermaidRuntimePlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'MermaidRuntimePlugin',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          const runtime = fs.readFileSync(require.resolve('mermaid/dist/mermaid.min.js'));
          compilation.emitAsset('mermaid-runtime.js', new sources.RawSource(runtime));
        },
      );
    });
  }
}

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: resolveConfig,
  module: {
    rules: [typescriptRule]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};

/** @type WebpackConfig */
const mermaidWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/board/mermaidWebview.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'mermaid-webview.js',
    chunkFilename: 'mermaid-webview.[name].js',
    publicPath: 'auto',
  },
  resolve: resolveConfig,
  module: {
    rules: [typescriptRule]
  },
  plugins: [new MermaidRuntimePlugin()],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};

module.exports = [extensionConfig, mermaidWebviewConfig];