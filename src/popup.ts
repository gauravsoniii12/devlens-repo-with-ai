import "./style.css";
import { generateAiReport, type AiReport } from "./ai";

type CapturedError = {
  message: string;
  timestamp: string;
  kind: "runtime" | "console" | "promise";
  source?: string;
  page?: string;
  line?: number;
  column?: number;
};

type CapturedRequest = {
  method: string;
  url: string;
  status?: number;
  error?: string;
  timestamp: string;
};

type ElementContext = {
  tag: string;
  id?: string;
  role?: string;
  testId?: string;
  classes: string[];
};

type CaptureState = {
  startedAt: string;
  errors: CapturedError[];
  requests: CapturedRequest[];
  lastInteraction?: ElementContext[];
};

type ReportData = {
  url: string;
  title: string;
  capturedAt: string;
  state?: CaptureState;
};

type FrameReportData = ReportData & {
  frameId: number;
};

type FrameErrorData = {
  frameId: number;
  url: string;
  startedAt: string;
  errors: CapturedError[];
};

declare global {
  interface Window {
    __devLensCapture?: CaptureState;
  }
}

const startButton = document.querySelector<HTMLButtonElement>("#start-capture")!;
const generateButton = document.querySelector<HTMLButtonElement>("#generate-report")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy-report")!;
const downloadButton = document.querySelector<HTMLButtonElement>("#download-report")!;
const downloadScreenshotButton = document.querySelector<HTMLButtonElement>("#download-screenshot")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const reportSection = document.querySelector<HTMLElement>("#report-section")!;
const reportField = document.querySelector<HTMLTextAreaElement>("#report")!;
const screenshotPreview = document.querySelector<HTMLElement>("#screenshot-preview")!;
const screenshotImage = document.querySelector<HTMLImageElement>("#screenshot")!;
const aiEnabled = document.querySelector<HTMLInputElement>("#ai-enabled")!;
const aiFields = document.querySelector<HTMLElement>("#ai-fields")!;
const aiKey = document.querySelector<HTMLInputElement>("#ai-key")!;

const AI_ENABLED_KEY = "devlens.ai.enabled";
const AI_KEY_KEY = "devlens.ai.key";

function loadAiSettings() {
  try {
    aiEnabled.checked = localStorage.getItem(AI_ENABLED_KEY) === "1";
    aiKey.value = localStorage.getItem(AI_KEY_KEY) ?? "";
  } catch {
    // storage unavailable: keep defaults
  }
  aiFields.hidden = !aiEnabled.checked;
}

function saveAiSettings() {
  aiFields.hidden = !aiEnabled.checked;
  try {
    localStorage.setItem(AI_ENABLED_KEY, aiEnabled.checked ? "1" : "0");
    localStorage.setItem(AI_KEY_KEY, aiKey.value.trim());
  } catch {
    // ignore storage failures
  }
}

function setStatus(message: string, isError = false) {
  status.textContent = message;
  status.classList.toggle("status-error", isError);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
    throw new Error("Open an HTTP or HTTPS page before using DevLens.");
  }
  return tab;
}

async function startCapture() {
  startButton.disabled = true;
  try {
    const tab = await getActiveTab();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id!, allFrames: true },
      files: ["capture.js"],
      world: "MAIN"
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id!, allFrames: true },
      files: ["error-capture.js"],
      world: "ISOLATED"
    });
    setStatus("DevLens is monitoring this page. Reproduce the issue, then generate a report.");
    generateButton.disabled = false;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not start capture.", true);
  } finally {
    startButton.disabled = false;
  }
}

async function refreshCaptureStatus() {
  generateButton.disabled = true;
  try {
    const tab = await getActiveTab();
    const [mainResults, errorResults] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId: tab.id!, allFrames: true },
        world: "MAIN",
        func: () => ({
          started: Boolean(window.__devLensCapture),
          errors: window.__devLensCapture?.errors.length ?? 0,
          requests: window.__devLensCapture?.requests.length ?? 0
        })
      }),
      chrome.scripting.executeScript({
        target: { tabId: tab.id!, allFrames: true },
        world: "ISOLATED",
        func: () => ({
          startedAt: window.__devLensIsolatedErrors?.startedAt,
          errors: window.__devLensIsolatedErrors?.errors.length ?? 0
        })
      })
    ]);
    const mainCaptures = mainResults.flatMap(({ result }) => (result?.started ? [result] : []));
    const errorCaptures = errorResults.flatMap(({ result }) => (result?.startedAt ? [result] : []));
    if (!mainCaptures.length && !errorCaptures.length) {
      setStatus("This page is not being monitored yet. Reload it, or start monitoring here before reproducing the issue.");
      return;
    }

    generateButton.disabled = false;
    const errors =
      mainCaptures.reduce((total, capture) => total + capture.errors, 0) +
      errorCaptures.reduce((total, capture) => total + capture.errors, 0);
    const requests = mainCaptures.reduce((total, capture) => total + capture.requests, 0);
    setStatus(`Monitoring this page: ${errors} errors detected and ${requests} failed requests captured.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not check the active page.", true);
  }
}

async function generateReport() {
  generateButton.disabled = true;
  try {
    const tab = await getActiveTab();
    const [mainResults, errorResults] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId: tab.id!, allFrames: true },
        world: "MAIN",
        func: (): Omit<FrameReportData, "frameId"> => ({
          url: `${window.location.origin}${window.location.pathname}`,
          title: document.title,
          capturedAt: new Date().toISOString(),
          state: window.__devLensCapture
        })
      }),
      chrome.scripting.executeScript({
        target: { tabId: tab.id!, allFrames: true },
        world: "ISOLATED",
        func: () => ({
          url: `${window.location.origin}${window.location.pathname}`,
          startedAt: window.__devLensIsolatedErrors?.startedAt,
          errors: window.__devLensIsolatedErrors?.errors ?? []
        })
      })
    ]);
    const frames = mainResults.flatMap(({ result, frameId }) => (result ? [{ ...result, frameId }] : []));
    const frameErrors = errorResults.flatMap(({ result, frameId }) =>
      result?.startedAt
        ? [{ frameId, url: result.url, startedAt: result.startedAt, errors: result.errors }]
        : []
    );
    if (!frames.length && !frameErrors.length) throw new Error("No page data was returned.");
    const data = combineFrameReports(frames, frameErrors);
    if (!data.state) {
      throw new Error("No capture session found. Reload the page after installing DevLens, then reproduce the issue.");
    }

    let screenshot: string | undefined;
    try {
      const pageScreenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      screenshot = await addDiagnosticsPanel(pageScreenshot, data);
    } catch (error) {
      setStatus(
        `Report generated; combined screenshot unavailable: ${error instanceof Error ? error.message : "capture failed"}.`,
        true
      );
    }

    if (screenshot) {
      screenshotImage.src = screenshot;
      screenshotPreview.hidden = false;
      downloadScreenshotButton.disabled = false;
    } else {
      screenshotPreview.hidden = true;
      downloadScreenshotButton.disabled = true;
    }
    let ai: AiReport | undefined;
    let aiProblem: string | undefined;
    const apiKey = aiKey.value.trim();
    if (aiEnabled.checked) {
      if (!apiKey) {
        aiProblem = "AI is enabled but no API key is set.";
      } else {
        setStatus("Asking the AI to structure the report…");
        try {
          ai = await generateAiReport(
            {
              url: data.url,
              title: data.title,
              errors: (data.state?.errors ?? []).slice(-20),
              requests: (data.state?.requests ?? []).slice(-20),
              lastInteraction: data.state?.lastInteraction ?? []
            },
            apiKey,
            AbortSignal.timeout(45000)
          );
        } catch (error) {
          aiProblem = error instanceof Error ? error.message : "The AI step failed.";
        }
      }
    }
    reportField.value = formatReport(data, Boolean(screenshot), ai);
    reportSection.hidden = false;
    setStatus(
      `Report ready: ${data.state?.errors.length ?? 0} errors and ${data.state?.requests.length ?? 0} failed requests.${screenshot ? " Screenshot captured." : " Screenshot unavailable."}${ai ? " AI-structured." : ""}${aiProblem ? ` ${aiProblem} Used the local template instead.` : ""}`,
      Boolean(aiProblem)
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not generate the report.", true);
  } finally {
    generateButton.disabled = false;
  }
}

async function addDiagnosticsPanel(pageScreenshot: string, data: ReportData): Promise<string> {
  const image = new Image();
  image.src = pageScreenshot;
  await image.decode();

  const errors = data.state?.errors ?? [];
  const width = image.naturalWidth;
  const padding = Math.max(20, Math.round(width * 0.025));
  const fontSize = Math.max(14, Math.round(width / 75));
  const lineHeight = Math.round(fontSize * 1.5);
  const maxTextWidth = width - padding * 2;
  const visibleErrors = errors.slice(0, 20);
  const panelLines = visibleErrors.flatMap((error) => {
    const location = error.source
      ? ` (${error.source}${error.line ? `:${error.line}` : ""}${error.column ? `:${error.column}` : ""})`
      : "";
    return wrapCanvasText(`${error.kind.toUpperCase()}: ${error.message}${location}`, maxTextWidth, fontSize);
  });
  const panelHeight = padding * 2 + lineHeight * (3 + Math.max(panelLines.length, 1)) + fontSize;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = image.naturalHeight + panelHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas for the combined screenshot.");

  context.drawImage(image, 0, 0);
  context.fillStyle = "#11141b";
  context.fillRect(0, image.naturalHeight, width, panelHeight);
  context.fillStyle = "#c1bbff";
  context.font = `700 ${fontSize}px system-ui, sans-serif`;
  context.fillText("DEVLENS CAPTURED DIAGNOSTICS", padding, image.naturalHeight + padding + fontSize);
  context.fillStyle = "#a8adba";
  context.font = `${fontSize}px system-ui, sans-serif`;
  context.fillText(
    "Captured by DevLens; this is not a screenshot of Chrome DevTools.",
    padding,
    image.naturalHeight + padding + lineHeight + fontSize
  );
  context.fillStyle = "#e7eaf1";
  context.font = `${fontSize}px ui-monospace, Consolas, monospace`;

  if (panelLines.length) {
    panelLines.forEach((line, index) => {
      context.fillText(line, padding, image.naturalHeight + padding + lineHeight * (index + 2) + fontSize);
    });
    if (errors.length > visibleErrors.length) {
      const omitted = errors.length - visibleErrors.length;
      context.fillStyle = "#a8adba";
      context.fillText(
        `…and ${omitted} more captured error${omitted === 1 ? "" : "s"}.`,
        padding,
        image.naturalHeight + padding + lineHeight * (panelLines.length + 2) + fontSize
      );
    }
  } else {
    context.fillStyle = "#a8adba";
    context.fillText(
      "No console, runtime, or promise errors were captured during this monitoring session.",
      padding,
      image.naturalHeight + padding + lineHeight * 2 + fontSize
    );
    context.fillText(
      "Earlier browser-console history is not available to extensions.",
      padding,
      image.naturalHeight + padding + lineHeight * 3 + fontSize
    );
  }

  return canvas.toDataURL("image/png");
}

function wrapCanvasText(text: string, maxWidth: number, fontSize: number): string[] {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare text for the combined screenshot.");
  context.font = `${fontSize}px ui-monospace, Consolas, monospace`;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function combineFrameReports(frames: FrameReportData[], frameErrors: FrameErrorData[]): ReportData {
  const mainFrame = frames.find((frame) => frame.frameId === 0) ?? frames[0];
  if (!mainFrame) {
    const mainErrorFrame = frameErrors.find((frame) => frame.frameId === 0) ?? frameErrors[0];
    if (!mainErrorFrame) throw new Error("No monitored page frames were returned.");
    return {
      url: mainErrorFrame.url,
      title: "Untitled page",
      capturedAt: new Date().toISOString(),
      state: {
        startedAt: mainErrorFrame.startedAt,
        errors: mainErrorFrame.errors,
        requests: []
      }
    };
  }
  const isolatedByFrame = new Map(frameErrors.map((frame) => [frame.frameId, frame]));
  const states = frames.flatMap((frame) => {
    const state = frame.state;
    const isolated = isolatedByFrame.get(frame.frameId);
    if (!state && !isolated) return [];
    const errors = [...(state?.errors ?? []), ...(isolated?.errors ?? [])];
    const uniqueErrors = errors.filter(
      (error, index) =>
        errors.findIndex(
          (other) =>
            other.kind === error.kind &&
            other.message === error.message &&
            other.source === error.source &&
            other.line === error.line &&
            other.column === error.column
        ) === index
    );
    return [
      {
        frame,
        state: {
          startedAt: state?.startedAt ?? isolated!.startedAt,
          errors: uniqueErrors,
          requests: state?.requests ?? [],
          ...(state?.lastInteraction ? { lastInteraction: state.lastInteraction } : {})
        }
      }
    ];
  });
  if (!states.length) return mainFrame;

  const mainState = states.find(({ frame }) => frame.frameId === 0)?.state;
  const mostRecentInteraction = states
    .map(({ state }) => state.lastInteraction)
    .find((interaction) => interaction?.length);

  return {
    ...mainFrame,
    state: {
      startedAt: mainState?.startedAt ?? states[0].state.startedAt,
      errors: states
        .flatMap(({ frame, state }) =>
          state.errors.map((error) =>
            frame.frameId === 0 || error.page ? error : { ...error, page: frame.url }
          )
        )
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
      requests: states.flatMap(({ state }) => state.requests),
      ...(mostRecentInteraction ? { lastInteraction: mostRecentInteraction } : {})
    }
  };
}

function explainError(error: CapturedError): string {
  const message = error.message;
  const reference = message.match(/ReferenceError:\s*([$\w]+)\s+is not defined/i);
  if (reference) {
    return `The page tried to use “${reference[1]}”, but that name was not available. This is often caused by a typo or by a value not being created before it is used.`;
  }
  if (/TypeError:.*cannot read propert(?:y|ies) of (?:undefined|null)/i.test(message)) {
    return "The page tried to read a value from something that was missing. A value it expected may not have loaded or been set yet.";
  }
  if (/TypeError:.*is not a function/i.test(message)) {
    return "The page tried to run something as a function, but that value was not a function.";
  }
  if (/SyntaxError:/i.test(message)) {
    return "The browser could not understand part of the page's code, usually because of a code formatting or typing mistake.";
  }
  if (error.kind === "promise") {
    return "A background task failed and the page did not handle that failure.";
  }
  if (error.kind === "console") {
    return "The page or one of its libraries reported a problem in the browser console.";
  }
  return "The browser stopped part of the page's code because it encountered an error.";
}

function formatReport(data: ReportData, screenshotAvailable: boolean, ai?: AiReport): string {
  const state = data.state;
  const errors = state?.errors ?? [];
  const requests = state?.requests ?? [];
  const interaction = state?.lastInteraction ?? [];
  const primaryError = errors.find((item) => item.kind !== "console") ?? errors[0];
  const lines = [
    `# ${ai ? ai.title : `Bug report: ${data.title || "Untitled page"}`}`,
    "",
    ...(ai ? [`**Severity (AI estimate):** ${ai.severity}`, ""] : []),
    "## Summary",
    ai
      ? ai.summary
      : primaryError?.message
      ? `The page encountered a problem: ${explainError(primaryError)}`
      : requests[0]
        ? `A network request failed: ${requests[0].method} ${requests[0].url}`
        : "Describe the unexpected behavior.",
    "",
    ...(ai ? ["## Likely cause (AI inference)", ai.likelyCause, ""] : []),
    ai ? "## Steps to reproduce (inferred by AI; verify before filing)" : "## Steps to reproduce",
    ...(ai
      ? ai.stepsToReproduce.map((step, index) => `${index + 1}. ${step}`)
      : [
          "1. Open the page below.",
          "2. Reproduce the issue (steps were not inferred; add the exact actions here)."
        ]),
    "",
    "## Expected behavior",
    ai ? ai.expectedBehavior : "Describe what you expected to happen.",
    "",
    "## Actual behavior",
    ai ? ai.actualBehavior : "Describe what happened instead.",
    "",
    ...(ai?.suspectedAreas.length ? ["## Suspected areas (AI inference)", ...ai.suspectedAreas.map((item) => `- ${item}`), ""] : []),
    "## What the captured error means",
    ...(errors.length
      ? errors.map((item) => `- ${explainError(item)} (Technical detail: ${item.message})`)
      : ["- No browser errors were captured while DevLens was monitoring this page."]),
    "",
    "## Page",
    `- URL: ${data.url}`,
    `- Captured: ${data.capturedAt}`,
    `- Capture started: ${state?.startedAt ?? "Not started"}`,
    "",
    "## Captured errors",
    ...(errors.length
      ? errors.map((item) => {
          const location = item.source
            ? ` (${item.source}${item.line ? `:${item.line}` : ""}${item.column ? `:${item.column}` : ""})`
            : "";
          const page = item.page ? ` on ${item.page}` : "";
          return `- [${item.timestamp}] [${item.kind}] ${item.message}${location}${page}`;
        })
      : ["- None captured"]),
    "",
    "## Failed network requests",
    ...(requests.length
      ? requests.map(
          (item) =>
            `- [${item.timestamp}] ${item.method} ${item.url}${item.status ? ` — HTTP ${item.status}` : ""}${item.error ? ` — ${item.error}` : ""}`
        )
      : ["- None captured"]),
    "",
    "## Last clicked element context",
    ...(interaction.length
      ? interaction.map(
          (item) =>
            `- \`${item.tag}${item.id ? `#${item.id}` : ""}${item.role ? ` [role=${item.role}]` : ""}${item.testId ? ` [data-testid=${item.testId}]` : ""}${item.classes.length ? ` .${item.classes.join(".")}` : ""}\``
        )
      : ["- None captured"]),
    "",
    "## Screenshot",
    screenshotAvailable ? "A viewport screenshot was captured and is shown in the DevLens popup. Use **Save screenshot** to download it separately." : "Unavailable",
    "",
    "> Review this report for sensitive information before sharing. Request bodies and page text are not captured."
  ];
  return lines.join("\n");
}

aiEnabled.addEventListener("change", saveAiSettings);
aiKey.addEventListener("change", saveAiSettings);
loadAiSettings();

startButton.addEventListener("click", () => void startCapture());
generateButton.addEventListener("click", () => void generateReport());
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(reportField.value);
    setStatus("Report copied to clipboard.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not copy report.", true);
  }
});
downloadButton.addEventListener("click", () => {
  const blob = new Blob([reportField.value], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "devlens-bug-report.md";
  link.click();
  URL.revokeObjectURL(url);
});
downloadScreenshotButton.addEventListener("click", () => {
  if (!screenshotImage.src) return;
  const link = document.createElement("a");
  link.href = screenshotImage.src;
  link.download = "devlens-screenshot.png";
  link.click();
});

void refreshCaptureStatus();
