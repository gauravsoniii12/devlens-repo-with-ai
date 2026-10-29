# DevLens

DevLens is a Manifest V3 Chrome extension prototype for collecting browser diagnostics and drafting a local bug report.

## What it captures

- `console.error` messages, uncaught runtime errors (including source location when available), and unhandled promise rejections from page load onward, including matching embedded frames
- Failed `fetch` and `XMLHttpRequest` request URLs, methods, statuses, and network error messages (request and response bodies are not collected)
- A compact hierarchy of the last clicked elements (tag, id, role, test id, and class names)
- An explicitly requested screenshot of the current viewport

DevLens starts monitoring matching pages and embedded frames when they load. It captures console messages in the page's main world and listens for uncaught runtime errors in a separate isolated world; the report combines those results. If a page was already open when the extension was installed or reloaded, reload that page before reproducing the issue. For an already-open page, **Start on this page** starts monitoring from that point onward. Click **Generate report** after reproducing the issue to capture the current viewport and draft a report. The saved PNG combines the webpage screenshot with a clearly labeled DevLens diagnostics panel; Chrome does not allow extensions to screenshot the separate DevTools console window. The report includes plain-language explanations for common JavaScript errors, along with their technical details. Reports can be copied or downloaded as Markdown; combined screenshots can be saved separately. Steps to reproduce are a template, not AI-inferred facts.

Monitoring and diagnostics are processed locally. Nothing leaves your browser unless you turn on the optional **AI** step (off by default; see below). The extension requests access to all websites so it can observe errors from page load. Captured data is held in the page and is not persisted across reloads. Review diagnostics and screenshots for sensitive information before sharing.

## Develop

```bash
npm install
npm run build
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `dist` directory. After rebuilding, reload the extension from the extensions page. Press **Alt + Shift + D** (or click the toolbar icon) to open DevLens; you can change the shortcut at `chrome://extensions/shortcuts`.

The extension requests `activeTab`, `scripting`, and access to all websites for automatic error monitoring from page load.

## Status and limitations

- Tested in Chrome with a deliberately broken page: console errors, uncaught exceptions, unhandled promise rejections, failed `fetch`/XHR requests (404/500), last-clicked element context, iframe errors, and the combined screenshot all appear in the generated report. Restricted pages (`chrome://…`) show a clear message instead of failing.
- **Optional AI step:** tick *Improve the report with AI* in the popup and paste your own Anthropic API key. DevLens then sends the captured errors, failed-request URLs (query strings removed), click context, page URL and title to the Anthropic API and gets back a schema-validated report (title, summary, severity, likely cause, inferred steps, suspected areas). The screenshot and request/response bodies are never sent. The key is stored only in this browser's local storage, and if the AI call fails or returns invalid JSON the local template report is used instead. Tested against a mocked API (success, invalid output, rejected key); not yet tried against the live service. The model name is the `AI_MODEL` constant in `src/ai.ts`.
- Because errors are captured from page load, the extension declares `<all_urls>` host access and injects small content scripts into every page. That is broader than a strictly "on demand" `activeTab`-only design.
