const fs = require('fs');

let c = fs.readFileSync('IDEWorkspace.tsx', 'utf8');
c = c.replace('<aside className="right-panel inspector-panel">', '<aside className="right-panel inspector-panel chat-panel">');
fs.writeFileSync('IDEWorkspace.tsx', c);
console.log("Done");
