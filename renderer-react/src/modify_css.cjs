const fs = require('fs');
const css = `
/* Modern Agent Panel Styles */

.agent-message-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  overflow-y: auto;
  flex: 1;
}

.agent-message {
  display: flex;
  flex-direction: column;
  max-width: 85%;
  border: none !important;
  background: transparent !important;
  padding: 0 !important;
  margin: 0 !important;
}

.agent-message-user {
  align-self: flex-end;
}

.agent-message-assistant {
  align-self: flex-start;
}

.agent-message-meta {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 0.25rem;
  padding: 0 0.5rem;
}

.agent-message-user .agent-message-meta {
  text-align: right;
  display: none; /* Hide 'You' text to look cleaner */
}

.agent-message-body {
  padding: 0.85rem 1rem;
  border-radius: 12px;
  line-height: 1.5;
  font-size: 0.95rem;
}

.agent-message-user .agent-message-body {
  background-color: var(--color-accent, #5e9cf9);
  color: #fff;
  border-bottom-right-radius: 2px;
}

.agent-message-assistant .agent-message-body {
  background-color: var(--bg-panel-alt);
  color: var(--text);
  border-bottom-left-radius: 2px;
  border: 1px solid var(--line);
}

.agent-message-body p {
  margin: 0 0 0.75rem 0;
}

.agent-message-body p:last-child {
  margin: 0;
}

.agent-message-body pre, 
.agent-message-body code {
  background-color: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
}

/* Modern Composer */
.agent-composer {
  position: relative;
  margin: 1rem;
  background-color: var(--bg-panel-alt);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 0.5rem 0.75rem;
  display: flex;
  flex-direction: column;
  transition: border-color 0.2s;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.agent-composer:focus-within {
  border-color: var(--color-accent, #5e9cf9);
}

.agent-composer textarea {
  background: transparent;
  border: none;
  resize: none;
  padding: 0.5rem;
  color: var(--text);
  font-family: inherit;
  font-size: 0.95rem;
  max-height: 200px;
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
  padding: 0.25rem 0.5rem 0.25rem;
}

.agent-composer-hint {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.agent-composer .primary-button {
  border-radius: 999px;
  padding: 0.4rem 1rem;
}

/* Hide header if chatOnly is set */
.chat-panel .agent-panel-header, 
.chat-panel .agent-status-strip, 
.chat-panel .agent-mode-grid {
  display: none !important;
}

.chat-panel .agent-panel {
  border: none;
  background: transparent;
  height: 100%;
}
`;

fs.appendFileSync('app-shell.css', css);
console.log("Done");
