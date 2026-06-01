const crypto = require("node:crypto");
const { canonicalizeCommandVerbsInText } = require("./commandCanonicalizer");
const { normalizeToolRequest } = require("./toolRegistry");

const LOCAL_ENGINE = "local";
const DIRECT_LLM_ENGINE = "direct_llm";
const OPENCODE_ASK_ENGINE = "opencode_ask";
const OPENCODE_EDIT_ENGINE = "opencode_edit";

function normalizePrompt(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function titleFromPrompt(prompt) {
  const compact = normalizePrompt(prompt);
  return compact.length > 64 ? `${compact.slice(0, 61).trimEnd()}...` : compact || "New thread";
}

function isGreetingPrompt(prompt) {
  const normalized = normalizePrompt(prompt).toLowerCase().replace(/[.!?]+$/g, "");
  return /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay)$/.test(normalized);
}

function buildGreetingResponse(prompt) {
  const normalized = normalizePrompt(prompt).toLowerCase();
  if (normalized.startsWith("thank")) {
    return "You got it. What would you like to work on next?";
  }

  if (normalized === "ok" || normalized === "okay") {
    return "Ready when you are. Tell me what you want to inspect, explain, or change.";
  }

  return "Hello! What would you like to work on in this project space?";
}

function isLowSignalPrompt(prompt) {
  const compact = normalizePrompt(prompt).toLowerCase();
  if (!compact) {
    return true;
  }

  if (compact.length <= 2) {
    return true;
  }

  const alpha = compact.replace(/[^a-z]/g, "");
  if (alpha.length >= 5 && !/[aeiou]/.test(alpha)) {
    return true;
  }

  const words = compact.split(/\s+/).filter(Boolean);
  return words.length === 1 && alpha.length >= 5 && /(.)\1{2,}/.test(alpha);
}

function isExplicitEditRequest(prompt) {
  const normalized = normalizePrompt(canonicalizeCommandVerbsInText(prompt)).toLowerCase();
  return /\b(add|apply|build|change|clean up|convert|create|delete|edit|fix|implement|install|make|modify|move|patch|refactor|remove|rename|replace|rewrite|scaffold|update|write)\b/.test(normalized);
}

function isCompletedTaskReferencePrompt(prompt) {
  const normalized = normalizePrompt(prompt).toLowerCase();
  return (
    /\b(do|make|apply|repeat|use)\s+(?:it|that|this|the same|same)\s+(?:again|like|to|for|here)?\b/.test(normalized) ||
    /\b(?:same as before|same thing|like before|like that|like this|similar to before|similar to that|previous task|last task)\b/.test(normalized) ||
    /^(?:again|same again|repeat that|repeat it|do that again|do it again)$/.test(normalized)
  );
}

function hasCompletedTaskReferences(value) {
  return Array.isArray(value) && value.some((reference) => Array.isArray(reference?.items) && reference.items.length > 0);
}

function classifyReferenceEditRisk(prompt, completedTaskReferences) {
  const baseRisk = classifyEditRisk(prompt);
  if (baseRisk.requiresApproval) {
    return baseRisk;
  }

  const itemTexts = Array.isArray(completedTaskReferences)
    ? completedTaskReferences
        .flatMap((reference) => (Array.isArray(reference?.items) ? reference.items : []))
        .map((item) => [item?.kind, item?.title, item?.instruction, item?.result].filter(Boolean).join(" ").toLowerCase())
    : [];
  const destructive = itemTexts.some((text) => /\b(delete|remove|rm|rename|move|replace|overwrite|discard)\b/.test(text));
  if (destructive) {
    return { requiresApproval: true, riskLevel: "high", reason: "reference_destructive_edit" };
  }

  return { requiresApproval: false, riskLevel: "low", reason: "reference_workspace_edit" };
}

function isContinuationPrompt(prompt) {
  const normalized = normalizePrompt(prompt).toLowerCase().replace(/[.!?]+$/g, "");
  return /^(proceed|yes|yep|yeah|confirm|do it|go ahead|continue|run it|execute|approved?|ok do it|okay do it)$/.test(normalized);
}

function countEditVerbs(prompt) {
  const normalized = normalizePrompt(canonicalizeCommandVerbsInText(prompt)).toLowerCase();
  const matches = normalized.match(/\b(add|apply|build|change|convert|create|delete|edit|fix|implement|install|make|modify|move|patch|refactor|remove|rename|replace|rewrite|scaffold|update|write)\b/g);
  return new Set(matches || []).size;
}

function classifyEditRisk(prompt) {
  const normalized = normalizePrompt(canonicalizeCommandVerbsInText(prompt)).toLowerCase();
  const destructive = /\b(delete|remove|rm|rename|move|replace|overwrite|discard)\b/.test(normalized);
  const shell = /\b(run|execute)\b.*\b(command|terminal|shell|cmd|powershell|bash|script)\b/.test(normalized);
  const broad = /\b(all files|entire project|whole repo|whole repository|everything|mass|globally|everywhere)\b/.test(normalized);
  const broadRewrite = /\b(rewrite|refactor|replace)\b/.test(normalized) && /\b(project|repo|repository|workspace|all|entire|whole|multiple)\b/.test(normalized);
  const multiFile = /\b(multiple files|several files|many files|across files|in every file|all matching files)\b/.test(normalized);
  const fuzzyTarget = /\b(the file|that file|this file|it)\b/.test(normalized) && !/\b[\w.-]+\.(md|js|ts|tsx|jsx|json|css|html|ino|cpp|h|hpp|c|py|yml|yaml|toml|txt)\b/.test(normalized);

  if (destructive || shell || broad || broadRewrite || multiFile) {
    return { requiresApproval: true, riskLevel: "high", reason: destructive ? "destructive_edit" : shell ? "shell_or_command" : "broad_edit" };
  }

  if (fuzzyTarget) {
    return { requiresApproval: true, riskLevel: "medium", reason: "ambiguous_target" };
  }

  return { requiresApproval: false, riskLevel: "low", reason: "simple_edit" };
}

function normalizePendingAction(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = String(value.id || "").trim();
  const originalPrompt = normalizePrompt(value.originalPrompt);
  if (!id || !originalPrompt) {
    return null;
  }

  const toolRequest = normalizeToolRequest(value.toolRequest);

  return {
    id,
    threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
    kind: String(value.kind || "edit"),
    originalPrompt,
    normalizedPrompt: normalizePrompt(value.normalizedPrompt || originalPrompt).toLowerCase(),
    riskLevel: String(value.riskLevel || "medium"),
    reason: String(value.reason || "pending_action"),
    createdAt: String(value.createdAt || new Date().toISOString()),
    status: String(value.status || "pending"),
    ...(toolRequest ? { toolRequest } : {}),
  };
}

function createPendingAction(prompt, risk) {
  const originalPrompt = normalizePrompt(prompt);
  return {
    id: crypto.randomUUID(),
    threadId: null,
    kind: "edit",
    originalPrompt,
    normalizedPrompt: originalPrompt.toLowerCase(),
    riskLevel: risk.riskLevel,
    reason: risk.reason,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}

function isReadOnlyWorkspaceQuestion(prompt) {
  const normalized = normalizePrompt(prompt).toLowerCase();
  const asksAboutWorkspace = /\b(codebase|repo|repository|workspace|project|files?|folder|directory|component|function|class|module|import|where|usage|uses|defined|definition|bug|error|stack|build|test|config)\b/.test(normalized);
  const readOnlyVerb = /\b(analy[sz]e|describe|explain|find|inspect|list|locate|review|search|show|summari[sz]e|trace|what|where|why|how)\b/.test(normalized);
  return asksAboutWorkspace && readOnlyVerb;
}

function normalizeContextPath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function hasExplicitContext(contextItems) {
  return Array.isArray(contextItems) && contextItems.some((item) => (item?.content && item?.path) || (item?.kind === "image" && item?.dataUrl));
}

function promptReferencesContextItem(prompt, item) {
  const normalizedPrompt = normalizePrompt(prompt).toLowerCase();
  const pathValue = normalizeContextPath(item?.relativePath || item?.path || "");
  const nameValue = String(item?.name || pathValue.split("/").at(-1) || "").toLowerCase();
  const basename = pathValue.split("/").filter(Boolean).at(-1) || nameValue;

  return Boolean(
    (nameValue && normalizedPrompt.includes(nameValue)) ||
      (basename && normalizedPrompt.includes(basename)) ||
      (pathValue && normalizedPrompt.includes(pathValue)),
  );
}

function canAnswerFromContextItems(prompt, contextItems) {
  if (!hasExplicitContext(contextItems)) {
    return false;
  }

  const normalized = normalizePrompt(prompt).toLowerCase();
  if (
    /\b(this file|active file|current file|this code|selected file|selected lines|attached context|added context|user-added context|context|explain this|summari[sz]e this)\b/.test(normalized) ||
    /\b(this image|attached image|this photo|attached photo|this picture|attached picture|this screenshot|attached screenshot)\b/.test(normalized)
  ) {
    return true;
  }

  return contextItems.some((item) => promptReferencesContextItem(prompt, item));
}

function routeAgentPrompt(payload = {}) {
  const prompt = normalizePrompt(payload.prompt);
  const titleSuggestion = titleFromPrompt(prompt);
  const pendingAction = normalizePendingAction(payload.pendingAction);
  const bypassApproval = payload.permissionMode === "bypass";

  if (isContinuationPrompt(prompt)) {
    if (!pendingAction || !["pending", "blocked"].includes(pendingAction.status)) {
      return {
        engine: LOCAL_ENGINE,
        reason: "no_pending_action",
        confidence: 0.96,
        persistThread: false,
        titleSuggestion,
        userMessage: "There is nothing pending to approve.",
        requiresUserDecision: false,
        decisionKind: "none",
      };
    }

    if (payload.intent === "ask") {
      return {
        engine: LOCAL_ENGINE,
        reason: "ask_mode_blocks_pending_action",
        confidence: 0.92,
        persistThread: false,
        titleSuggestion,
        userMessage: "Ask mode is read-only. Switch to Agent mode to approve pending project space changes.",
        requiresUserDecision: false,
        decisionKind: "none",
      };
    }

    return {
      engine: OPENCODE_EDIT_ENGINE,
      reason: "approved_pending_action",
      confidence: 0.96,
      persistThread: true,
      titleSuggestion: titleFromPrompt(pendingAction.originalPrompt),
      pendingAction,
      requiresUserDecision: false,
      decisionKind: "none",
    };
  }

  if (isLowSignalPrompt(prompt)) {
    return {
      engine: LOCAL_ENGINE,
      reason: "low_signal_prompt",
      confidence: 0.94,
      persistThread: false,
      titleSuggestion,
      userMessage: "I could not tell what you want me to do yet. Try asking a question or describe the code change you want.",
      requiresUserDecision: false,
      decisionKind: "none",
    };
  }

  if (isGreetingPrompt(prompt)) {
    return {
      engine: LOCAL_ENGINE,
      reason: "casual_message",
      confidence: 0.98,
      persistThread: false,
      titleSuggestion,
      userMessage: buildGreetingResponse(prompt),
      requiresUserDecision: false,
      decisionKind: "none",
    };
  }

  const wantsReferenceEdit =
    payload.intent !== "ask" && hasCompletedTaskReferences(payload.completedTaskReferences) && isCompletedTaskReferencePrompt(prompt);
  const wantsEdit = isExplicitEditRequest(prompt) || wantsReferenceEdit;
  if (wantsEdit && payload.intent === "ask") {
    return {
      engine: LOCAL_ENGINE,
      reason: "ask_mode_blocks_edit",
      confidence: 0.88,
      persistThread: false,
      titleSuggestion,
      userMessage: "Ask mode is read-only. Switch to Agent mode when you want me to apply project space changes.",
      requiresUserDecision: false,
      decisionKind: "none",
    };
  }

  if (wantsEdit) {
    const risk = wantsReferenceEdit ? classifyReferenceEditRisk(prompt, payload.completedTaskReferences) : classifyEditRisk(prompt);
    if (risk.requiresApproval && !bypassApproval) {
      const nextPendingAction = createPendingAction(prompt, risk);
      return {
        engine: OPENCODE_EDIT_ENGINE,
        reason: risk.reason,
        confidence: 0.9,
        persistThread: true,
        titleSuggestion,
        userMessage: `This looks like a ${risk.riskLevel}-risk Project Space change. Approve to run it, or skip it.`,
        pendingAction: nextPendingAction,
        requiresUserDecision: true,
        decisionKind: "approve_skip",
      };
    }

    return {
      engine: OPENCODE_EDIT_ENGINE,
      reason: risk.requiresApproval ? `${risk.reason}_bypassed` : "explicit_workspace_edit",
      confidence: risk.requiresApproval ? 0.9 : 0.86,
      persistThread: true,
      titleSuggestion,
      requiresUserDecision: false,
      decisionKind: "none",
    };
  }

  const canAnswerFromExplicitContext = canAnswerFromContextItems(prompt, payload.contextItems);
  if (isReadOnlyWorkspaceQuestion(prompt) && !canAnswerFromExplicitContext) {
    return {
      engine: OPENCODE_ASK_ENGINE,
      reason: "read_only_workspace_question",
      confidence: 0.8,
      persistThread: true,
      titleSuggestion,
      requiresUserDecision: false,
      decisionKind: "none",
    };
  }

  return {
    engine: DIRECT_LLM_ENGINE,
    reason: canAnswerFromExplicitContext ? "explicit_context_direct_question" : "general_direct_question",
    confidence: 0.72,
    persistThread: true,
    titleSuggestion,
    requiresUserDecision: false,
    decisionKind: "none",
  };
}

module.exports = {
  DIRECT_LLM_ENGINE,
  LOCAL_ENGINE,
  OPENCODE_ASK_ENGINE,
  OPENCODE_EDIT_ENGINE,
  isContinuationPrompt,
  normalizePendingAction,
  routeAgentPrompt,
};
