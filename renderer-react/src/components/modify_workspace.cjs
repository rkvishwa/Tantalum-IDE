const fs = require('fs');

let c = fs.readFileSync('IDEWorkspace.tsx', 'utf8');

c = c.replace(/<div className="inspector-tabs">[\s\S]*?<\/div>/, '<div className="inspector-tabs" style={{ display: \'none\' }}></div>');

c = c.replace(/{inspectorView === 'agent' \? \([\s\S]*?renderBoardDetails\(\)\s*\)}/g, '<AgentPanel user={user} workspacePath={workspacePath} activeTab={activeTab && !activeTab.path.startsWith(\'untitled:\') ? { path: activeTab.path, name: activeTab.name, content: editorValue, isDirty: Boolean(activeTab.isDirty) } : null} onFileContentApplied={applyAgentFileContent} onPathDeleted={handleAgentDeletedPath} onRefreshWorkspace={refreshFileTree} pushConsole={pushConsole} pushToast={pushToast} defaultView="chat" chatOnly={true} />');

fs.writeFileSync('IDEWorkspace.tsx', c);
console.log("Done");
