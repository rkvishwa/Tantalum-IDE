import { useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

export type BoardsHubSelectOption = {
  value: string;
  label: string;
  group?: string;
};

type BoardsHubSelectProps = {
  value: string;
  options: BoardsHubSelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function BoardsHubSelect({ value, options, onChange, placeholder, open, onOpenChange }: BoardsHubSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const groupedOptions = options.reduce<Array<{ label: string; options: BoardsHubSelectOption[] }>>((groups, option) => {
    const groupLabel = option.group || 'Options';
    const existing = groups.find((group) => group.label === groupLabel);
    if (existing) {
      existing.options.push(option);
      return groups;
    }
    groups.push({ label: groupLabel, options: [option] });
    return groups;
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className={`boards-hub-select ${open ? 'open' : ''}`}>
      <button
        className="boards-hub-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{selectedOption?.label || placeholder}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="boards-hub-select-menu" role="listbox">
          {groupedOptions.map((group) => (
            <div key={group.label} className="boards-hub-select-group-block">
              <div className="boards-hub-select-group">{group.label}</div>
              {group.options.map((option) => (
                <button
                  key={option.value}
                  className={`boards-hub-select-item ${option.value === value ? 'active' : ''}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  onClick={() => {
                    onChange(option.value);
                    onOpenChange(false);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type BoardsHubToggleProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
};

export function BoardsHubToggle({ checked, onChange, label, description }: BoardsHubToggleProps) {
  return (
    <div className="boards-hub-toggle-row">
      <div className="boards-hub-toggle-copy">
        <span>{label}</span>
        {description ? <small>{description}</small> : null}
      </div>
      <button
        className={`boards-hub-toggle ${checked ? 'active' : ''}`}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
      >
        <span className="boards-hub-toggle-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}
