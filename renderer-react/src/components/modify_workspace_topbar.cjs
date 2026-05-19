const fs = require('fs');

let c = fs.readFileSync('IDEWorkspace.tsx', 'utf8');

c = c.replace(/<header className="topbar">[\s\S]*?<\/header>/, '<header className="topbar" style={{ display: \'none\' }}></header>');

fs.writeFileSync('IDEWorkspace.tsx', c);
console.log("Done");
