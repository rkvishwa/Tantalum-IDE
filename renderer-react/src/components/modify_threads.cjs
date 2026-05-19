const fs = require('fs');

let c = fs.readFileSync('AgentPanel.tsx', 'utf8');

// Add imports
c = c.replace(/import \{([^}]+)\} from 'lucide-react';/, (match, p1) => {
  return `import { ${p1}, History, ChevronLeft } from 'lucide-react';`;
});

// Add ChatThread type
c = c.replace(/type AgentView = 'chat' \| 'settings' \| 'usage';/, `type AgentView = 'chat' | 'settings' | 'usage' | 'history';

type ChatThread = {
  id: string;
  title: string;
  messages: AgentUiMessage[];
  updatedAt: number;
};
`);

// Replace state
const oldState = `  const [messages, setMessages] = useState<AgentUiMessage[]>([INITIAL_MESSAGE]);`;
const newState = `  const [threads, setThreads] = useState<ChatThread[]>(() => {
    try {
      const stored = localStorage.getItem('tantalum-agent-threads');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return [{ id: Date.now().toString(), title: 'New Chat', messages: [INITIAL_MESSAGE], updatedAt: Date.now() }];
  });
  const [activeThreadId, setActiveThreadId] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('tantalum-agent-threads-active');
      if (stored) return stored;
    } catch {}
    return '';
  });

  useEffect(() => {
    localStorage.setItem('tantalum-agent-threads', JSON.stringify(threads));
    localStorage.setItem('tantalum-agent-threads-active', activeThreadId);
  }, [threads, activeThreadId]);

  const activeThread = useMemo(() => threads.find(t => t.id === activeThreadId) || threads[0], [threads, activeThreadId]);
  const messages = activeThread?.messages || [];

  const updateActiveThreadMessages = useCallback((updater: (prev: AgentUiMessage[]) => AgentUiMessage[]) => {
    setThreads(current => current.map(t => {
      if (t.id === activeThreadId) {
        const newMessages = updater(t.messages);
        const title = newMessages.length > 1 ? newMessages[1].content.substring(0, 30) + '...' : t.title;
        return { ...t, messages: newMessages, title, updatedAt: Date.now() };
      }
      return t;
    }));
  }, [activeThreadId]);

  const createNewThread = useCallback(() => {
    const newThread = { id: Date.now().toString(), title: 'New Chat', messages: [INITIAL_MESSAGE], updatedAt: Date.now() };
    setThreads(current => [newThread, ...current]);
    setActiveThreadId(newThread.id);
    setView('chat');
  }, []);
`;
c = c.replace(oldState, newState);

// Update setMessages usages
c = c.replace(/setMessages\(\(current\) => \[\.\.\.current, message\]\);/g, `updateActiveThreadMessages(current => [...current, message]);`);
c = c.replace(/setMessages\(\[INITIAL_MESSAGE\]\);/g, `updateActiveThreadMessages(() => [INITIAL_MESSAGE]);`);

// Add Header for Chat Threads
const chatViewMatch = `{view === 'chat' ? (`;
const chatViewReplacement = `{view === 'history' ? (
          <div className="thread-history-view">
            <div className="chat-panel-header">
              <button onClick={() => setView('chat')}><ChevronLeft size={16} /> Back</button>
              <button className="primary-button compact" onClick={createNewThread}><Plus size={14} /> New Chat</button>
            </div>
            {threads.map(thread => (
              <div key={thread.id} className={\`thread-item \${thread.id === activeThreadId ? 'active' : ''}\`} onClick={() => { setActiveThreadId(thread.id); setView('chat'); }}>
                <div className="thread-item-title">{thread.title}</div>
                <div className="thread-item-date">{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(thread.updatedAt))}</div>
              </div>
            ))}
          </div>
        ) : view === 'chat' ? (
          <>
            <div className="chat-panel-header">
              <button onClick={() => setView('history')}><History size={16} /> History</button>
              <button className="primary-button compact" onClick={createNewThread}><Plus size={14} /> New Chat</button>
            </div>`;
c = c.replace(chatViewMatch, chatViewReplacement);

fs.writeFileSync('AgentPanel.tsx', c);
console.log("Done");
