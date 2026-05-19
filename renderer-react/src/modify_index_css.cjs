const fs = require('fs');

let c = fs.readFileSync('index.css', 'utf8');

c = `@import './app-shell.css';\n` + c;

fs.writeFileSync('index.css', c);
console.log("Done");
