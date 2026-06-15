export function readTerminalTheme() {
  const root = getComputedStyle(document.documentElement);
  const resolvedTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  return {
    background: '#00000000',
    foreground: root.getPropertyValue('--text').trim() || (resolvedTheme === 'light' ? '#1f1f1f' : '#e3eaf2'),
    cursor: root.getPropertyValue('--accent').trim() || '#0078d4',
    selectionBackground: root.getPropertyValue('--accent-soft').trim() || (resolvedTheme === 'light' ? '#cce4f7' : '#182434'),
  };
}
