// thanks https://github.com/borkdude/nbb-action-example !

child = require('child_process');
path = require('path');

child.fork(path.resolve(__dirname, 'dist/index.js'), [], {execPath: "node"});
