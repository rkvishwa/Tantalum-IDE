import type { Monaco } from '@monaco-editor/react';
import type { editor, languages, MarkerSeverity, Position } from 'monaco-editor';

const CPP_LINT_OWNER = 'tantalum-cpp';
const QUICK_FIX_CODE_ACTION_KIND = 'quickfix';
const CPP_FILE_EXTENSIONS = new Set(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'ino']);

type CompletionEntry = {
  label: string;
  kind: keyof typeof languages.CompletionItemKind;
  insertText: string;
  detail: string;
  documentation: string;
  snippet?: boolean;
};

type ArduinoDoc = {
  signature: string;
  documentation: string;
  parameters?: string[];
};

type SanitizedLine = {
  raw: string;
  code: string;
};

type LintMarker = editor.IMarkerData & {
  code?: string;
  quickFixText?: string;
};

const CONTROL_WORDS = new Set([
  'catch',
  'do',
  'else',
  'for',
  'if',
  'switch',
  'try',
  'while',
]);

const PREPROCESSOR_DIRECTIVES = new Set([
  'define',
  'elif',
  'else',
  'endif',
  'error',
  'if',
  'ifdef',
  'ifndef',
  'include',
  'pragma',
  'undef',
  'warning',
]);

const ARDUINO_DOCS: Record<string, ArduinoDoc> = {
  setup: {
    signature: 'void setup()',
    documentation: 'Runs once when the sketch starts. Configure pins, serial ports, sensors, and other initial state here.',
  },
  loop: {
    signature: 'void loop()',
    documentation: 'Runs repeatedly after setup finishes. Put the main behavior of the sketch here.',
  },
  pinMode: {
    signature: 'void pinMode(uint8_t pin, uint8_t mode)',
    documentation: 'Configures a digital pin as INPUT, INPUT_PULLUP, or OUTPUT.',
    parameters: ['pin', 'mode'],
  },
  digitalWrite: {
    signature: 'void digitalWrite(uint8_t pin, uint8_t value)',
    documentation: 'Writes HIGH or LOW to a digital pin configured as an output.',
    parameters: ['pin', 'value'],
  },
  digitalRead: {
    signature: 'int digitalRead(uint8_t pin)',
    documentation: 'Reads HIGH or LOW from a digital pin.',
    parameters: ['pin'],
  },
  analogRead: {
    signature: 'int analogRead(uint8_t pin)',
    documentation: 'Reads an analog value from an analog-capable pin.',
    parameters: ['pin'],
  },
  analogWrite: {
    signature: 'void analogWrite(uint8_t pin, int value)',
    documentation: 'Writes a PWM value to a supported pin.',
    parameters: ['pin', 'value'],
  },
  delay: {
    signature: 'void delay(unsigned long ms)',
    documentation: 'Pauses execution for the specified number of milliseconds.',
    parameters: ['ms'],
  },
  delayMicroseconds: {
    signature: 'void delayMicroseconds(unsigned int us)',
    documentation: 'Pauses execution for the specified number of microseconds.',
    parameters: ['us'],
  },
  millis: {
    signature: 'unsigned long millis()',
    documentation: 'Returns the number of milliseconds since the board started running the current program.',
  },
  micros: {
    signature: 'unsigned long micros()',
    documentation: 'Returns the number of microseconds since the board started running the current program.',
  },
  attachInterrupt: {
    signature: 'void attachInterrupt(uint8_t interrupt, void (*isr)(), int mode)',
    documentation: 'Registers a function to run when an external interrupt is triggered.',
    parameters: ['interrupt', 'isr', 'mode'],
  },
  detachInterrupt: {
    signature: 'void detachInterrupt(uint8_t interrupt)',
    documentation: 'Disables a previously attached external interrupt.',
    parameters: ['interrupt'],
  },
  tone: {
    signature: 'void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0)',
    documentation: 'Generates a square wave of the specified frequency on a pin.',
    parameters: ['pin', 'frequency', 'duration'],
  },
  noTone: {
    signature: 'void noTone(uint8_t pin)',
    documentation: 'Stops tone generation on a pin.',
    parameters: ['pin'],
  },
  map: {
    signature: 'long map(long value, long fromLow, long fromHigh, long toLow, long toHigh)',
    documentation: 'Re-maps a number from one range to another.',
    parameters: ['value', 'fromLow', 'fromHigh', 'toLow', 'toHigh'],
  },
  constrain: {
    signature: 'long constrain(long value, long min, long max)',
    documentation: 'Constrains a value to stay between a minimum and maximum.',
    parameters: ['value', 'min', 'max'],
  },
  random: {
    signature: 'long random(long min, long max)',
    documentation: 'Returns a pseudo-random number in the requested range.',
    parameters: ['min', 'max'],
  },
  randomSeed: {
    signature: 'void randomSeed(unsigned long seed)',
    documentation: 'Initializes the pseudo-random number generator.',
    parameters: ['seed'],
  },
  'Serial.begin': {
    signature: 'Serial.begin(unsigned long baud)',
    documentation: 'Starts serial communication at the selected baud rate.',
    parameters: ['baud'],
  },
  'Serial.print': {
    signature: 'Serial.print(value)',
    documentation: 'Prints a value to the serial port without a trailing newline.',
    parameters: ['value'],
  },
  'Serial.println': {
    signature: 'Serial.println(value)',
    documentation: 'Prints a value to the serial port followed by a newline.',
    parameters: ['value'],
  },
  'Serial.available': {
    signature: 'int Serial.available()',
    documentation: 'Returns the number of bytes available to read from the serial buffer.',
  },
  'Serial.read': {
    signature: 'int Serial.read()',
    documentation: 'Reads the next byte from the serial buffer.',
  },
  'Serial.write': {
    signature: 'size_t Serial.write(value)',
    documentation: 'Writes binary data to the serial port.',
    parameters: ['value'],
  },
};

const COMPLETION_ENTRIES: CompletionEntry[] = [
  {
    label: 'setup',
    kind: 'Function',
    insertText: 'void setup() {\n\t$0\n}',
    detail: 'Arduino sketch entry point',
    documentation: ARDUINO_DOCS.setup.documentation,
    snippet: true,
  },
  {
    label: 'loop',
    kind: 'Function',
    insertText: 'void loop() {\n\t$0\n}',
    detail: 'Arduino sketch loop',
    documentation: ARDUINO_DOCS.loop.documentation,
    snippet: true,
  },
  {
    label: 'pinMode',
    kind: 'Function',
    insertText: 'pinMode(${1:pin}, ${2:OUTPUT});',
    detail: ARDUINO_DOCS.pinMode.signature,
    documentation: ARDUINO_DOCS.pinMode.documentation,
    snippet: true,
  },
  {
    label: 'digitalWrite',
    kind: 'Function',
    insertText: 'digitalWrite(${1:pin}, ${2:HIGH});',
    detail: ARDUINO_DOCS.digitalWrite.signature,
    documentation: ARDUINO_DOCS.digitalWrite.documentation,
    snippet: true,
  },
  {
    label: 'digitalRead',
    kind: 'Function',
    insertText: 'digitalRead(${1:pin})',
    detail: ARDUINO_DOCS.digitalRead.signature,
    documentation: ARDUINO_DOCS.digitalRead.documentation,
    snippet: true,
  },
  {
    label: 'analogRead',
    kind: 'Function',
    insertText: 'analogRead(${1:pin})',
    detail: ARDUINO_DOCS.analogRead.signature,
    documentation: ARDUINO_DOCS.analogRead.documentation,
    snippet: true,
  },
  {
    label: 'analogWrite',
    kind: 'Function',
    insertText: 'analogWrite(${1:pin}, ${2:value});',
    detail: ARDUINO_DOCS.analogWrite.signature,
    documentation: ARDUINO_DOCS.analogWrite.documentation,
    snippet: true,
  },
  {
    label: 'delay',
    kind: 'Function',
    insertText: 'delay(${1:1000});',
    detail: ARDUINO_DOCS.delay.signature,
    documentation: ARDUINO_DOCS.delay.documentation,
    snippet: true,
  },
  {
    label: 'delayMicroseconds',
    kind: 'Function',
    insertText: 'delayMicroseconds(${1:100});',
    detail: ARDUINO_DOCS.delayMicroseconds.signature,
    documentation: ARDUINO_DOCS.delayMicroseconds.documentation,
    snippet: true,
  },
  {
    label: 'millis',
    kind: 'Function',
    insertText: 'millis()',
    detail: ARDUINO_DOCS.millis.signature,
    documentation: ARDUINO_DOCS.millis.documentation,
  },
  {
    label: 'micros',
    kind: 'Function',
    insertText: 'micros()',
    detail: ARDUINO_DOCS.micros.signature,
    documentation: ARDUINO_DOCS.micros.documentation,
  },
  {
    label: 'attachInterrupt',
    kind: 'Function',
    insertText: 'attachInterrupt(digitalPinToInterrupt(${1:pin}), ${2:isr}, ${3:CHANGE});',
    detail: ARDUINO_DOCS.attachInterrupt.signature,
    documentation: ARDUINO_DOCS.attachInterrupt.documentation,
    snippet: true,
  },
  {
    label: 'Serial.begin',
    kind: 'Method',
    insertText: 'Serial.begin(${1:115200});',
    detail: ARDUINO_DOCS['Serial.begin'].signature,
    documentation: ARDUINO_DOCS['Serial.begin'].documentation,
    snippet: true,
  },
  {
    label: 'Serial.print',
    kind: 'Method',
    insertText: 'Serial.print(${1:value});',
    detail: ARDUINO_DOCS['Serial.print'].signature,
    documentation: ARDUINO_DOCS['Serial.print'].documentation,
    snippet: true,
  },
  {
    label: 'Serial.println',
    kind: 'Method',
    insertText: 'Serial.println(${1:value});',
    detail: ARDUINO_DOCS['Serial.println'].signature,
    documentation: ARDUINO_DOCS['Serial.println'].documentation,
    snippet: true,
  },
  ...['INPUT', 'INPUT_PULLUP', 'OUTPUT', 'HIGH', 'LOW', 'LED_BUILTIN', 'CHANGE', 'RISING', 'FALLING'].map(
    (label) => ({
      label,
      kind: 'Constant' as const,
      insertText: label,
      detail: 'Arduino constant',
      documentation: `Arduino ${label} constant.`,
    }),
  ),
  ...['uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'size_t', 'String', 'byte', 'boolean'].map(
    (label) => ({
      label,
      kind: 'Struct' as const,
      insertText: label,
      detail: 'Arduino/C++ type',
      documentation: `${label} type.`,
    }),
  ),
  {
    label: '#include <Arduino.h>',
    kind: 'Snippet',
    insertText: '#include <Arduino.h>',
    detail: 'Arduino include',
    documentation: 'Includes the Arduino core declarations in C++ source/header files.',
  },
  {
    label: '#include <Wire.h>',
    kind: 'Snippet',
    insertText: '#include <Wire.h>',
    detail: 'I2C include',
    documentation: 'Includes the Arduino Wire library for I2C communication.',
  },
  {
    label: '#include <SPI.h>',
    kind: 'Snippet',
    insertText: '#include <SPI.h>',
    detail: 'SPI include',
    documentation: 'Includes the Arduino SPI library.',
  },
  {
    label: 'if',
    kind: 'Snippet',
    insertText: 'if (${1:condition}) {\n\t$0\n}',
    detail: 'C++ if statement',
    documentation: 'Insert an if block.',
    snippet: true,
  },
  {
    label: 'for',
    kind: 'Snippet',
    insertText: 'for (${1:int i = 0}; ${2:i < count}; ${3:i++}) {\n\t$0\n}',
    detail: 'C++ for loop',
    documentation: 'Insert a for loop.',
    snippet: true,
  },
  {
    label: 'while',
    kind: 'Snippet',
    insertText: 'while (${1:condition}) {\n\t$0\n}',
    detail: 'C++ while loop',
    documentation: 'Insert a while loop.',
    snippet: true,
  },
  {
    label: 'function',
    kind: 'Snippet',
    insertText: '${1:void} ${2:name}(${3:}) {\n\t$0\n}',
    detail: 'C++ function',
    documentation: 'Insert a function definition.',
    snippet: true,
  },
];

const CANONICAL_ARDUINO_SYMBOLS = [
  'INPUT',
  'INPUT_PULLUP',
  'OUTPUT',
  'HIGH',
  'LOW',
  'LED_BUILTIN',
  'CHANGE',
  'RISING',
  'FALLING',
  'pinMode',
  'digitalWrite',
  'digitalRead',
  'analogRead',
  'analogWrite',
  'delay',
  'delayMicroseconds',
  'millis',
  'micros',
  'attachInterrupt',
  'detachInterrupt',
  'Serial',
];

const CANONICAL_SYMBOL_BY_LOWER = new Map(CANONICAL_ARDUINO_SYMBOLS.map((symbol) => [symbol.toLowerCase(), symbol]));

function getExtension(filePath?: string | null) {
  const normalizedPath = filePath?.split(/[?#]/)[0] ?? '';
  const match = /\.([A-Za-z0-9_]+)$/.exec(normalizedPath);
  return match?.[1]?.toLowerCase() ?? '';
}

export function isArduinoCppFile(filePath?: string | null) {
  return CPP_FILE_EXTENSIONS.has(getExtension(filePath));
}

function isArduinoSketch(filePath?: string | null) {
  return getExtension(filePath) === 'ino';
}

function shouldUseCppSupport(model: editor.ITextModel, filePath?: string | null) {
  return isArduinoCppFile(filePath) || model.getLanguageId() === 'cpp' || model.getLanguageId() === 'c';
}

function createCompletionProvider(monaco: Monaco): languages.CompletionItemProvider {
  return {
    triggerCharacters: ['.', '#', '<'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      return {
        suggestions: COMPLETION_ENTRIES.map((entry) => ({
          label: entry.label,
          kind: monaco.languages.CompletionItemKind[entry.kind],
          insertText: entry.insertText,
          insertTextRules: entry.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          detail: entry.detail,
          documentation: entry.documentation,
          range,
        })),
      };
    },
  };
}

function getQualifiedTokenAtPosition(model: editor.ITextModel, position: Position) {
  const line = model.getLineContent(position.lineNumber);
  const tokenPattern = /(?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(line))) {
    const startColumn = match.index + 1;
    const endColumn = startColumn + match[0].length;
    if (position.column >= startColumn && position.column <= endColumn) {
      return match[0];
    }
  }

  return null;
}

function createHoverProvider(): languages.HoverProvider {
  return {
    provideHover(model, position) {
      const token = getQualifiedTokenAtPosition(model, position);
      const doc = token ? ARDUINO_DOCS[token] : null;

      if (!token || !doc) {
        return null;
      }

      const word = model.getWordAtPosition(position);
      const range = word
        ? {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          }
        : undefined;

      return {
        range,
        contents: [
          { value: `\`\`\`cpp\n${doc.signature}\n\`\`\`` },
          { value: doc.documentation },
        ],
      };
    },
  };
}

function createSignatureHelpProvider(): languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp(model, position) {
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const callMatch = /((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*)\s*\(([^()]*)$/.exec(linePrefix);
      if (!callMatch) {
        return null;
      }

      const doc = ARDUINO_DOCS[callMatch[1]];
      if (!doc) {
        return null;
      }

      const activeParameter = callMatch[2].trim() ? callMatch[2].split(',').length - 1 : 0;

      return {
        value: {
          activeSignature: 0,
          activeParameter,
          signatures: [
            {
              label: doc.signature,
              documentation: doc.documentation,
              parameters: (doc.parameters ?? []).map((parameter) => ({
                label: parameter,
              })),
            },
          ],
        },
        dispose: () => {},
      };
    },
  };
}

function symbolRange(monaco: Monaco, lineNumber: number, line: string, startIndex = 0) {
  return new monaco.Range(lineNumber, startIndex + 1, lineNumber, Math.max(startIndex + 2, line.length + 1));
}

function createDocumentSymbolProvider(monaco: Monaco): languages.DocumentSymbolProvider {
  return {
    provideDocumentSymbols(model) {
      const symbols: languages.DocumentSymbol[] = [];

      for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
        const line = model.getLineContent(lineNumber);
        const trimmed = line.trim();
        const typeMatch = /^\s*(class|struct|enum)\s+([A-Za-z_]\w*)/.exec(line);
        const defineMatch = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(line);
        const functionMatch = /^\s*(?:template\s*<[^>]+>\s*)?(?:(?:[\w:<>~*&]+\s+)+)([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{|$)/.exec(line);

        if (typeMatch) {
          const name = typeMatch[2];
          const startIndex = line.indexOf(name);
          const range = symbolRange(monaco, lineNumber, line, startIndex);
          symbols.push({
            name,
            detail: typeMatch[1],
            kind: typeMatch[1] === 'enum' ? monaco.languages.SymbolKind.Enum : monaco.languages.SymbolKind.Class,
            tags: [],
            range,
            selectionRange: range,
          });
          continue;
        }

        if (defineMatch) {
          const name = defineMatch[1];
          const startIndex = line.indexOf(name);
          const range = symbolRange(monaco, lineNumber, line, startIndex);
          symbols.push({
            name,
            detail: '#define',
            kind: monaco.languages.SymbolKind.Constant,
            tags: [],
            range,
            selectionRange: range,
          });
          continue;
        }

        if (functionMatch && !CONTROL_WORDS.has(functionMatch[1]) && !trimmed.startsWith('#')) {
          const name = functionMatch[1];
          const startIndex = line.indexOf(name);
          const range = symbolRange(monaco, lineNumber, line, startIndex);
          symbols.push({
            name,
            detail: 'function',
            kind: monaco.languages.SymbolKind.Function,
            tags: [],
            range,
            selectionRange: range,
          });
        }
      }

      return symbols;
    },
  };
}

function createFormattingProvider(): languages.DocumentFormattingEditProvider {
  return {
    provideDocumentFormattingEdits(model, options) {
      const formatted = formatArduinoCppDocument(model.getValue(), options);
      if (formatted === model.getValue()) {
        return [];
      }

      return [
        {
          range: model.getFullModelRange(),
          text: formatted,
        },
      ];
    },
  };
}

function createCodeActionProvider(monaco: Monaco): languages.CodeActionProvider {
  return {
    provideCodeActions(model, _range, context) {
      const actions: languages.CodeAction[] = [];

      for (const marker of context.markers) {
        if (marker.source !== 'Tantalum C++') {
          continue;
        }

        if (marker.code === 'tantalum.missingSemicolon') {
          actions.push({
            title: 'Add missing semicolon',
            kind: QUICK_FIX_CODE_ACTION_KIND,
            diagnostics: [marker],
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: {
                    range: new monaco.Range(marker.startLineNumber, marker.endColumn, marker.startLineNumber, marker.endColumn),
                    text: ';',
                  },
                },
              ],
            },
          });
        }

        if (marker.code === 'tantalum.arduinoCase') {
          const markerRange = new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
          const currentText = model.getValueInRange(markerRange);
          const quickFixText = CANONICAL_SYMBOL_BY_LOWER.get(currentText.toLowerCase());
          if (!quickFixText) {
            continue;
          }

          actions.push({
            title: `Change to ${quickFixText}`,
            kind: QUICK_FIX_CODE_ACTION_KIND,
            diagnostics: [marker],
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: {
                    range: markerRange,
                    text: quickFixText,
                  },
                },
              ],
            },
          });
        }
      }

      return {
        actions,
        dispose: () => {},
      };
    },
  };
}

export function configureArduinoCppLanguageSupport(monaco: Monaco) {
  const configuredMonaco = monaco as Monaco & { __tantalumArduinoCppConfigured?: boolean };
  if (configuredMonaco.__tantalumArduinoCppConfigured) {
    return;
  }

  configuredMonaco.__tantalumArduinoCppConfigured = true;

  for (const languageId of ['c', 'cpp']) {
    monaco.languages.setLanguageConfiguration(languageId, {
      comments: {
        lineComment: '//',
        blockComment: ['/*', '*/'],
      },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
        ['<', '>'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
      ],
      surroundingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
      folding: {
        markers: {
          start: /^\s*#\s*pragma\s+region\b/,
          end: /^\s*#\s*pragma\s+endregion\b/,
        },
      },
    });

    monaco.languages.registerCompletionItemProvider(languageId, createCompletionProvider(monaco));
    monaco.languages.registerHoverProvider(languageId, createHoverProvider());
    monaco.languages.registerSignatureHelpProvider(languageId, createSignatureHelpProvider());
    monaco.languages.registerDocumentSymbolProvider(languageId, createDocumentSymbolProvider(monaco));
    monaco.languages.registerDocumentFormattingEditProvider(languageId, createFormattingProvider());
    monaco.languages.registerCodeActionProvider(languageId, createCodeActionProvider(monaco), {
      providedCodeActionKinds: [QUICK_FIX_CODE_ACTION_KIND],
    });
  }
}

export type ArduinoCppDiagnosticOptions = {
  projectEntry?: boolean;
  lifecycleConflict?: boolean;
  requireLifecycle?: boolean;
};

export function updateArduinoCppDiagnostics(monaco: Monaco, model: editor.ITextModel | null, filePath?: string | null, options: ArduinoCppDiagnosticOptions = {}) {
  if (!model) {
    return;
  }

  if (!shouldUseCppSupport(model, filePath)) {
    monaco.editor.setModelMarkers(model, CPP_LINT_OWNER, []);
    return;
  }

  monaco.editor.setModelMarkers(model, CPP_LINT_OWNER, lintArduinoCppModel(monaco, model, filePath, options));
}

function lintArduinoCppModel(monaco: Monaco, model: editor.ITextModel, filePath?: string | null, options: ArduinoCppDiagnosticOptions = {}): LintMarker[] {
  const sanitizedLines = sanitizeCppLines(model.getValue());
  const markers: LintMarker[] = [];

  markers.push(...lintBalancedDelimiters(monaco, sanitizedLines));
  markers.push(...lintPreprocessor(monaco, sanitizedLines));
  markers.push(...lintMissingSemicolons(monaco, sanitizedLines));
  markers.push(...lintArduinoSymbolCasing(monaco, sanitizedLines));

  if (isArduinoSketch(filePath)) {
    markers.push(...lintArduinoSketchShape(monaco, model, options));
  }

  markers.push(...lintSerialSetup(monaco, model));

  return markers;
}

function sanitizeCppLines(text: string): SanitizedLine[] {
  const lines = text.split(/\r?\n/);
  const sanitizedLines: SanitizedLine[] = [];
  let inBlockComment = false;

  for (const raw of lines) {
    let code = '';
    let stringDelimiter: '"' | "'" | null = null;
    let escaped = false;

    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      const nextChar = raw[index + 1];

      if (inBlockComment) {
        if (char === '*' && nextChar === '/') {
          code += '  ';
          index += 1;
          inBlockComment = false;
        } else {
          code += ' ';
        }
        continue;
      }

      if (stringDelimiter) {
        code += ' ';
        if (!escaped && char === stringDelimiter) {
          stringDelimiter = null;
        }
        escaped = !escaped && char === '\\';
        if (char !== '\\') {
          escaped = false;
        }
        continue;
      }

      if (char === '/' && nextChar === '/') {
        code += ' '.repeat(raw.length - index);
        break;
      }

      if (char === '/' && nextChar === '*') {
        code += '  ';
        index += 1;
        inBlockComment = true;
        continue;
      }

      if (char === '"' || char === "'") {
        stringDelimiter = char;
        code += ' ';
        continue;
      }

      code += char;
    }

    sanitizedLines.push({ raw, code });
  }

  return sanitizedLines;
}

function markerAt(
  monaco: Monaco,
  lineNumber: number,
  startColumn: number,
  endColumn: number,
  message: string,
  severity: MarkerSeverity,
  code?: string,
  quickFixText?: string,
): LintMarker {
  void monaco;

  return {
    severity,
    message,
    startLineNumber: lineNumber,
    endLineNumber: lineNumber,
    startColumn,
    endColumn: Math.max(endColumn, startColumn + 1),
    source: 'Tantalum C++',
    code,
    quickFixText,
  };
}

function lintBalancedDelimiters(monaco: Monaco, lines: SanitizedLine[]) {
  const markers: LintMarker[] = [];
  const stack: Array<{ char: string; lineNumber: number; column: number }> = [];
  const openingByClosing: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
  };
  const closingByOpening: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
  };

  lines.forEach((line, lineIndex) => {
    const lineNumber = lineIndex + 1;
    for (let index = 0; index < line.code.length; index += 1) {
      const char = line.code[index];
      if (closingByOpening[char]) {
        stack.push({ char, lineNumber, column: index + 1 });
        continue;
      }

      if (!openingByClosing[char]) {
        continue;
      }

      const expectedOpening = openingByClosing[char];
      const lastOpening = stack.at(-1);
      if (lastOpening?.char === expectedOpening) {
        stack.pop();
        continue;
      }

      markers.push(
        markerAt(
          monaco,
          lineNumber,
          index + 1,
          index + 2,
          `Unexpected '${char}'. Expected '${lastOpening ? closingByOpening[lastOpening.char] : expectedOpening}'.`,
          monaco.MarkerSeverity.Error,
        ),
      );
    }
  });

  for (const opening of stack) {
    markers.push(
      markerAt(
        monaco,
        opening.lineNumber,
        opening.column,
        opening.column + 1,
        `Unclosed '${opening.char}'. Expected '${closingByOpening[opening.char]}'.`,
        monaco.MarkerSeverity.Error,
      ),
    );
  }

  return markers;
}

function lintPreprocessor(monaco: Monaco, lines: SanitizedLine[]) {
  const markers: LintMarker[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.code.trim();
    if (!trimmed.startsWith('#')) {
      return;
    }

    const lineNumber = index + 1;
    const directive = /^#\s*([A-Za-z_]\w*)/.exec(trimmed)?.[1];
    if (!directive) {
      markers.push(markerAt(monaco, lineNumber, 1, line.raw.length + 1, 'Expected a preprocessor directive after #.', monaco.MarkerSeverity.Error));
      return;
    }

    if (!PREPROCESSOR_DIRECTIVES.has(directive)) {
      markers.push(
        markerAt(monaco, lineNumber, 1, line.raw.length + 1, `Unknown preprocessor directive '#${directive}'.`, monaco.MarkerSeverity.Warning),
      );
      return;
    }

    if (directive === 'include' && !/^#\s*include\s*(?:<[^>]+>|"[^"]+")\s*$/.test(trimmed)) {
      markers.push(
        markerAt(
          monaco,
          lineNumber,
          1,
          line.raw.length + 1,
          'Use #include <Library.h> or #include "local.h".',
          monaco.MarkerSeverity.Error,
          'tantalum.includeSyntax',
        ),
      );
    }

    if (directive === 'define' && !/^#\s*define\s+[A-Za-z_]\w*/.test(trimmed)) {
      markers.push(
        markerAt(monaco, lineNumber, 1, line.raw.length + 1, 'Expected a macro name after #define.', monaco.MarkerSeverity.Error),
      );
    }
  });

  return markers;
}

function lintMissingSemicolons(monaco: Monaco, lines: SanitizedLine[]) {
  const markers: LintMarker[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.code.trim();
    if (!looksLikeStatementMissingSemicolon(trimmed, lines[index + 1]?.code.trim() ?? '')) {
      return;
    }

    const lineNumber = index + 1;
    markers.push(
      markerAt(
        monaco,
        lineNumber,
        line.raw.length + 1,
        line.raw.length + 1,
        'Possible missing semicolon.',
        monaco.MarkerSeverity.Warning,
        'tantalum.missingSemicolon',
      ),
    );
  });

  return markers;
}

function looksLikeStatementMissingSemicolon(trimmed: string, nextTrimmed: string) {
  if (!trimmed || trimmed.startsWith('#')) {
    return false;
  }

  if (/[;{}:,\\]$/.test(trimmed) || /(?:&&|\|\||[+\-*/%=&|^<>?])$/.test(trimmed)) {
    return false;
  }

  if (/^(?:public|private|protected)\s*:/.test(trimmed)) {
    return false;
  }

  if (/^(?:class|struct|enum|namespace|template)\b/.test(trimmed)) {
    return false;
  }

  if (/^(?:else|do|try)\b/.test(trimmed)) {
    return false;
  }

  if (/^(?:if|for|while|switch|catch)\s*\(.*\)$/.test(trimmed)) {
    return false;
  }

  if (/^[A-Za-z_]\w*\s*:/.test(trimmed)) {
    return false;
  }

  if (/^\s*\}\s*(?:else|while\b)/.test(trimmed)) {
    return false;
  }

  if (/[\w:<>~*&\]]+\s+[A-Za-z_]\w*\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?$/.test(trimmed)) {
    return nextTrimmed !== '{';
  }

  return (
    /^(?:return|break|continue|goto)\b/.test(trimmed) ||
    /(?:^|[^=!<>])=(?:[^=]|$)/.test(trimmed) ||
    /(?:\+\+|--)$/.test(trimmed) ||
    /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?\s*\([^;{}]*\)$/.test(trimmed) ||
    /^(?:const\s+|constexpr\s+|static\s+|volatile\s+|unsigned\s+|signed\s+|long\s+|short\s+|auto\s+)*[A-Za-z_:]\w*(?:<[^>]+>)?(?:\s*[*&]\s*|\s+)+[A-Za-z_]\w*(?:\s*\[[^\]]*\])?(?:\s*=.*)?$/.test(trimmed)
  );
}

function lintArduinoSymbolCasing(monaco: Monaco, lines: SanitizedLine[]) {
  const markers: LintMarker[] = [];
  const tokenPattern = /\b[A-Za-z_]\w*\b/g;

  lines.forEach((line, index) => {
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(line.code))) {
      const token = match[0];
      const canonical = CANONICAL_SYMBOL_BY_LOWER.get(token.toLowerCase());
      if (!canonical || canonical === token) {
        continue;
      }

      markers.push(
        markerAt(
          monaco,
          index + 1,
          match.index + 1,
          match.index + token.length + 1,
          `Arduino API names are case-sensitive. Did you mean '${canonical}'?`,
          monaco.MarkerSeverity.Warning,
          'tantalum.arduinoCase',
          canonical,
        ),
      );
    }
  });

  return markers;
}

function lintArduinoSketchShape(monaco: Monaco, model: editor.ITextModel, options: ArduinoCppDiagnosticOptions = {}) {
  const markers: LintMarker[] = [];
  const text = model.getValue();
  const setupMatches = [...text.matchAll(/\bvoid\s+setup\s*\(/g)];
  const loopMatches = [...text.matchAll(/\bvoid\s+loop\s*\(/g)];

  if (options.lifecycleConflict) {
    markers.push(markerAt(monaco, 1, 1, 1, 'Only the Project entry file can define setup() or loop().', monaco.MarkerSeverity.Error));
  }

  if (options.requireLifecycle && setupMatches.length === 0) {
    markers.push(markerAt(monaco, 1, 1, 1, 'Arduino sketches usually need a void setup() function.', monaco.MarkerSeverity.Warning));
  }

  if (options.requireLifecycle && loopMatches.length === 0) {
    markers.push(markerAt(monaco, 1, 1, 1, 'Arduino sketches usually need a void loop() function.', monaco.MarkerSeverity.Warning));
  }

  for (const duplicate of setupMatches.slice(1)) {
    const position = model.getPositionAt(duplicate.index ?? 0);
    markers.push(markerAt(monaco, position.lineNumber, position.column, position.column + 10, 'Duplicate setup() function.', monaco.MarkerSeverity.Error));
  }

  for (const duplicate of loopMatches.slice(1)) {
    const position = model.getPositionAt(duplicate.index ?? 0);
    markers.push(markerAt(monaco, position.lineNumber, position.column, position.column + 9, 'Duplicate loop() function.', monaco.MarkerSeverity.Error));
  }

  return markers;
}

function lintSerialSetup(monaco: Monaco, model: editor.ITextModel) {
  const text = model.getValue();
  const serialUse = /\bSerial\.(?:print|println|write|read|available|flush)\s*\(/.exec(text);

  if (!serialUse || /\bSerial\.begin\s*\(/.test(text)) {
    return [];
  }

  const position = model.getPositionAt(serialUse.index);
  return [
    markerAt(
      monaco,
      position.lineNumber,
      position.column,
      position.column + 'Serial'.length,
      'Serial is used before Serial.begin() appears in this file.',
      monaco.MarkerSeverity.Warning,
    ),
  ];
}

function formatArduinoCppDocument(text: string, options: languages.FormattingOptions) {
  const lines = text.split(/\r?\n/);
  const indentUnit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
  let indentLevel = 0;

  return lines
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return '';
      }

      if (/^(?:\}|case\b|default\s*:)/.test(trimmed)) {
        indentLevel = Math.max(0, indentLevel - 1);
      }

      const formattedLine = `${indentUnit.repeat(indentLevel)}${trimmed}`;
      const sanitized = sanitizeCppLines(trimmed)[0]?.code ?? trimmed;
      const opens = (sanitized.match(/\{/g) ?? []).length;
      const closes = (sanitized.match(/\}/g) ?? []).length;
      indentLevel = Math.max(0, indentLevel + opens - closes);

      if (/^(?:case\b.*:|default\s*:)/.test(trimmed) && !/\{\s*$/.test(trimmed)) {
        indentLevel += 1;
      }

      return formattedLine;
    })
    .join('\n');
}
