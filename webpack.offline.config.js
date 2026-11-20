const path = require('path');

// Builds the offline tool (src/offline) into one script; scripts/build-offline-html.js
// then inlines it into docs/offline.html, a single self-contained page.
module.exports = {
    entry: './src/offline/index.tsx',
    module: {
        rules: [
            {
                test: /\.ts|\.tsx$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.s[ac]ss$/i,
                use: ['style-loader', 'css-loader', 'sass-loader'],
            },
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js', '.jsx'],
        alias: {
            react: 'preact/compat',
            'react-dom': 'preact/compat',
        },
    },
    output: {
        filename: 'offline.js',
        path: path.resolve(__dirname, 'offline-dist'),
    },
};
