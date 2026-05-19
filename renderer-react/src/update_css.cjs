const fs = require('fs');

let css = fs.readFileSync('app-shell.css', 'utf8');

const newStyles = `
/* Cursor-Style Agent Panel */

.agent-message-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}

.agent-message {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
  border: none !important;
  background: transparent !important;
  padding: 0.75rem 1rem !important;
  margin: 0 !important;
  border-bottom: 1px solid var(--line) !important;
}

.agent-message-user {
  align-self: stretch;
  background-color: var(--bg-panel-alt) !important;
}

.agent-message-assistant {
  align-self: stretch;
  background-color: transparent !important;
}

.agent-message-meta {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 0.4rem;
  padding: 0;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.agent-message-user .agent-message-meta {
  display: block; /* Show label for user */
  text-align: left;
}

.agent-message-body {
  padding: 0;
  border-radius: 0;
  line-height: 1.6;
  font-size: 0.9rem;
}

.agent-message-user .agent-message-body {
  background-color: transparent;
  color: var(--text);
}

.agent-message-assistant .agent-message-body {
  background-color: transparent;
  color: var(--text);
  border: none;
}

.agent-message-body p {
  margin: 0 0 0.5rem 0;
}

.agent-message-body p:last-child {
  margin: 0;
}

.agent-message-body pre, 
.agent-message-body code {
  background-color: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  border: 1px solid var(--line);
}

.agent-message-body pre {
  padding: 0.75rem;
  margin: 0.5rem 0;
}

/* Cursor-style Composer */
.agent-composer {
  position: relative;
  margin: 0.75rem;
  background-color: var(--bg-alt);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s;
}

.agent-composer:focus-within {
  border-color: var(--text-soft);
}

.agent-composer textarea {
  background: transparent;
  border: none;
  resize: none;
  padding: 0.5rem;
  color: var(--text);
  font-family: inherit;
  font-size: 0.9rem;
  max-height: 300px;
}

.agent-composer textarea:focus {
  outline: none;
  border: none;
  box-shadow: none;
}

.agent-composer-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.25rem 0.5rem;
}

.agent-composer-hint {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.agent-composer .primary-button {
  border-radius: 4px;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
}

/* Chat Header for Threads */
.chat-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
}

.chat-panel-header .header-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-soft);
}

.chat-panel-header .header-actions {
  display: flex;
  gap: 0.25rem;
}

.chat-panel-header button {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  color: var(--text-soft);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: transparent;
}

.chat-panel-header button:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}

/* Thread History View */
.thread-history-view {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.thread-item {
  display: flex;
  flex-direction: column;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  background: transparent;
  transition: background 0.1s;
  text-align: left;
}

.thread-item:hover {
  background: var(--bg-hover);
}

.thread-item.active {
  background: rgba(108, 166, 255, 0.08);
  border-left: 2px solid var(--accent);
}

.thread-item-title {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text);
  margin-bottom: 0.25rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-item-date {
  font-size: 0.7rem;
  color: var(--text-muted);
}
`;

css = css.replace(/\/\* Modern Agent Panel Styles \*\/[\s\S]*?(?=\n\n|$)/, newStyles);

fs.writeFileSync('app-shell.css', css);
console.log("Done");
