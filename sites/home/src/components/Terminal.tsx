"use client";

import { useEffect, useRef, useState } from "react";

const TERMINAL_LINES = [
  { text: "$ git status", color: "text-green-500", delay: 600 },
  { text: "On branch main", color: "text-muted", delay: 200 },
  { text: "Your branch is up to date with 'origin/main'", color: "text-muted", delay: 400 },
  { text: "", color: "", delay: 150 },
  { text: "$ cat README.md", color: "text-green-500", delay: 600 },
  { text: "# Knurdz - Building the Future", color: "text-foreground", delay: 300 },
  { text: "Innovation happens here.", color: "text-muted", delay: 300 },
  { text: "", color: "", delay: 150 },
  { text: "$ npm run build", color: "text-green-500", delay: 600 },
  { text: "✓ Building amazing things...", color: "text-muted", delay: 400 },
  { text: "✓ Server running at localhost:3000", color: "text-green-500", delay: 450 },
];

const NAV_COMMANDS: Record<string, string> = {
  home: "top",
  projects: "#projects",
  partners: "#partners",
  contact: "#cta",
  footer: "footer",
};

export default function Terminal() {
  const inputElRef = useRef<HTMLInputElement>(null);
  const [lines, setLines] = useState<{ text: string; color: string }[]>([]);
  const [isTyping, setIsTyping] = useState(true);
  const [showInput, setShowInput] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [currentInput, setCurrentInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);

  // Refs – always reflect latest values, safe to read inside any event handler
  const suggestionsRef = useRef<string[]>([]);
  const selectedRef = useRef(-1);
  const showInputRef = useRef(false);
  const currentInputRef = useRef("");

  // Keep refs in sync with state
  const updateSuggestions = (matches: string[]) => {
    suggestionsRef.current = matches;
    setSuggestions(matches);
  };
  const updateSelected = (idx: number) => {
    selectedRef.current = idx;
    setSelectedSuggestion(idx);
  };
  const updateCurrentInput = (val: string) => {
    currentInputRef.current = val;
    setCurrentInput(val);
  };

  // ── Typewriter animation ──────────────────────────────────────────────────
  useEffect(() => {
    let lineIdx = 0;
    let charIdx = 0;
    let builtText = "";
    const committed: { text: string; color: string }[] = [];
    let tid: ReturnType<typeof setTimeout>;

    const tick = () => {
      if (lineIdx >= TERMINAL_LINES.length) {
        showInputRef.current = true;
        setShowInput(true);
        setIsTyping(false);
        return;
      }
      const line = TERMINAL_LINES[lineIdx];
      if (charIdx === 0) builtText = "";

      if (charIdx < line.text.length) {
        builtText += line.text[charIdx++];
        setLines([...committed, { text: builtText, color: line.color }]);
        tid = setTimeout(tick, 30);
      } else {
        committed.push({ text: builtText, color: line.color });
        setLines([...committed]);
        charIdx = 0;
        lineIdx++;
        tid = setTimeout(tick, line.delay);
      }
    };

    tid = setTimeout(tick, 500);
    return () => clearTimeout(tid);
  }, []);

  // Auto-focus hidden input after animation
  useEffect(() => {
    if (showInput) inputElRef.current?.focus({ preventScroll: true });
  }, [showInput]);

  // ── Suggestion computation ────────────────────────────────────────────────
  const computeSuggestions = (input: string) => {
    if (input.startsWith("/")) {
      const term = input.slice(1).toLowerCase();
      updateSuggestions(Object.keys(NAV_COMMANDS).filter(cmd => cmd.startsWith(term)));
    } else {
      updateSuggestions([]);
    }
    updateSelected(-1);
  };

  // ── Command execution ─────────────────────────────────────────────────────
  const execute = (raw: string) => {
    const key = raw.replace(/^\//, "").trim().toLowerCase();
    updateSuggestions([]);
    updateSelected(-1);
    if (!key) return;

    if (NAV_COMMANDS[key]) {
      setMessage({ text: `→ Navigating to ${key}...`, type: "success" });
      setTimeout(() => {
        if (NAV_COMMANDS[key] === "top") {
          window.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          document.querySelector(NAV_COMMANDS[key])?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        setTimeout(() => { updateCurrentInput(""); setMessage(null); }, 1000);
      }, 300);
    } else {
      setMessage({ text: `command not found: ${key}`, type: "error" });
      setTimeout(() => { updateCurrentInput(""); setMessage(null); }, 2000);
    }
  };

  // ── Document-level keydown (capture phase) ───────────────────────────────
  // This fires BEFORE anything else – handles all terminal keys reliably
  // regardless of which element has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only act when the terminal prompt is active
      if (!showInputRef.current) return;

      // Only act when our hidden input is focused OR the active element is body/null
      const active = document.activeElement;
      const isOurInput = active === inputElRef.current;
      const isNeutral = !active || active === document.body;
      if (!isOurInput && !isNeutral) return;

      const suggs = suggestionsRef.current;
      const sel   = selectedRef.current;

      if (e.key === "ArrowDown" && suggs.length > 0) {
        e.preventDefault();
        updateSelected(sel < 0 || sel >= suggs.length - 1 ? 0 : sel + 1);
      } else if (e.key === "ArrowUp" && suggs.length > 0) {
        e.preventDefault();
        updateSelected(sel <= 0 ? suggs.length - 1 : sel - 1);
      } else if (e.key === "Enter") {
        if (sel >= 0 && suggs.length > 0) {
          e.preventDefault();
          const cmd = `/${suggs[sel]}`;
          updateCurrentInput(cmd);
          updateSuggestions([]);
          updateSelected(-1);
          // re-focus so the user can type or press Enter again
          inputElRef.current?.focus();
        }
        // else: let form submit handle it
      } else if (e.key === "Escape") {
        e.preventDefault();
        updateSuggestions([]);
        updateSelected(-1);
      } else if (e.key === "Tab" && suggs.length > 0) {
        e.preventDefault();
        const cmd = sel >= 0 ? suggs[sel] : suggs[0];
        updateCurrentInput(`/${cmd}`);
        updateSuggestions([]);
        updateSelected(-1);
        inputElRef.current?.focus();
      } else if (e.key === "/" && !isOurInput) {
        e.preventDefault();
        inputElRef.current?.focus();
        updateCurrentInput("/");
        computeSuggestions("/");
      }
    };

    // Capture phase: fires before any other handler, including React synthetic events
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hidden input: only handles regular character input ───────────────────
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    updateCurrentInput(val);
    computeSuggestions(val);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    execute(currentInputRef.current);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div data-terminal="true" className="bg-background-alt/95 backdrop-blur-sm rounded-xl border border-border shadow-2xl overflow-visible">
      {/* Header */}
      <div className="bg-card/90 backdrop-blur-sm px-6 py-3.5 flex items-center justify-between border-b border-border rounded-t-xl">
        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-400 transition-colors cursor-pointer" />
            <div className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-400 transition-colors cursor-pointer" />
            <div className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-400 transition-colors cursor-pointer" />
          </div>
          <span className="text-muted text-xs mono-font tracking-wide">knurdz@terminal</span>
        </div>
        <span className="text-muted text-xs mono-font tracking-wide">~/projects</span>
      </div>

      {/* Body */}
      <div
        className="p-8 mono-font text-sm cursor-text transition-all duration-300"
        onClick={() => inputElRef.current?.focus()}
      >
        <div className="space-y-1 leading-relaxed">
          {lines.map((line, i) => (
            <div key={i} className={line.text ? line.color : "h-3.5"}>
              {line.text || ""}
              {isTyping && i === lines.length - 1 && (
                <span className="blinking-cursor">█</span>
              )}
            </div>
          ))}

          {showInput && (
            <div className="text-green-500 mt-2 flex items-center relative">
              <span>$&nbsp;</span>
              <span className="text-foreground">{currentInput}</span>
              <span className="blinking-cursor">█</span>
              {currentInput.length === 0 && (
                <span className="text-muted">type / to navigate...</span>
              )}

              {/* Hidden input – only used for reliable character capture */}
              <form onSubmit={handleSubmit} className="contents">
                <input
                  ref={inputElRef}
                  type="text"
                  value={currentInput}
                  onChange={handleChange}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                  className="absolute opacity-0 w-px h-px"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-hidden="true"
                />
              </form>

              {/* Suggestion dropdown */}
              {suggestions.length > 0 && (
                <div
                  className="suggestion-box absolute left-4 px-1 py-3 z-50 bg-card border border-border"
                  style={{ bottom: "100%", marginBottom: "8px" }}
                >
                  {suggestions.map((cmd, idx) => (
                    <div
                      key={cmd}
                      className={`cursor-pointer py-1 px-2.5 text-xs mono-font transition-colors rounded ${
                        idx === selectedSuggestion ? "text-green-500 bg-foreground/10" : "text-muted"
                      }`}
                      onMouseEnter={() => updateSelected(idx)}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateCurrentInput(`/${cmd}`);
                        updateSuggestions([]);
                        updateSelected(-1);
                        inputElRef.current?.focus();
                      }}
                    >
                      /{cmd}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {message && (
            <div className={`text-xs mt-2 ${message.type === "error" ? "text-red-400" : "text-muted"}`}>
              {message.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
