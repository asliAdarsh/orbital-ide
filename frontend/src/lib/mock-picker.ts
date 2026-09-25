/**
 * Element picking inside a design mock.
 *
 * The mock renders in an `iframe` with `sandbox="allow-scripts"` and **no** `allow-same-origin`, so
 * this app cannot read a single node of it — that isolation is what stops model-written markup from
 * reaching the parent's DOM, cookies or storage, and it is not negotiable. Picking therefore runs
 * *inside* the frame: this script is injected into the mock, it reads its own document, and it
 * reports through `postMessage`, which is the one door a sandboxed frame is allowed to use.
 *
 * Two consequences worth knowing:
 *
 * * Everything arriving from the frame is treated as untrusted data. The parent checks the message
 *   came from that frame's window and shapes it here, and never eval's or injects what it receives.
 * * The injected script has exactly the privileges the mock already had. It cannot read the app,
 *   the filesystem or the network; it can only describe the elements it is already sitting in.
 */

/** What the frame sends back about one element. Field names are the wire contract. */
export interface PickedElement {
  selector: string;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** Which tool the user armed. `null` leaves the mock interactive as written. */
export type PickerMode = "comment" | "grab";

export const PICK_MESSAGE_SOURCE = "orbital-mock";
export const COMMAND_MESSAGE_SOURCE = "orbital-parent";

/** Messages the parent accepts from a mock frame. */
export interface PickMessage {
  source: typeof PICK_MESSAGE_SOURCE;
  kind: "pick" | "cancelled";
  payload: { mode: PickerMode; element: PickedElement } | Record<string, never>;
}

/**
 * Narrow a `message` event to something this app will act on.
 *
 * `expectedWindow` is the frame's `contentWindow`: a sandboxed mock has an opaque origin, so the
 * origin check that would normally identify a sender is useless here, and the window identity is
 * what actually proves which document spoke.
 */
export function parsePickMessage(data: unknown, fromFrame: boolean): PickMessage | null {
  if (!fromFrame || typeof data !== "object" || data === null) return null;
  const candidate = data as { source?: unknown; kind?: unknown; payload?: unknown };
  if (candidate.source !== PICK_MESSAGE_SOURCE) return null;
  if (candidate.kind !== "pick" && candidate.kind !== "cancelled") return null;
  if (candidate.kind === "cancelled") {
    return { source: PICK_MESSAGE_SOURCE, kind: "cancelled", payload: {} };
  }
  const payload = candidate.payload as { mode?: unknown; element?: unknown } | null;
  const element = payload?.element as Partial<PickedElement> | null | undefined;
  if (payload?.mode !== "comment" && payload?.mode !== "grab") return null;
  if (!element || typeof element.selector !== "string" || typeof element.tag !== "string") return null;
  return {
    source: PICK_MESSAGE_SOURCE,
    kind: "pick",
    payload: {
      mode: payload.mode,
      element: {
        selector: element.selector.slice(0, 300),
        tag: element.tag.slice(0, 40),
        id: typeof element.id === "string" ? element.id.slice(0, 120) : null,
        classes: Array.isArray(element.classes)
          ? element.classes.filter((name): name is string => typeof name === "string").slice(0, 12)
          : [],
        text: typeof element.text === "string" ? element.text.slice(0, 200) : "",
        rect: {
          x: Number(element.rect?.x) || 0,
          y: Number(element.rect?.y) || 0,
          width: Number(element.rect?.width) || 0,
          height: Number(element.rect?.height) || 0,
        },
      },
    },
  };
}

/** A human line for the clipboard, in the shape a person would paste into a chat. */
export function describeElement(element: PickedElement): string {
  const lines = [
    `tag: ${element.tag}${element.id ? `#${element.id}` : ""}`,
    `selector: ${element.selector}`,
    element.classes.length > 0 ? `classes: ${element.classes.join(" ")}` : "",
    `size: ${element.rect.width}×${element.rect.height} at ${element.rect.x},${element.rect.y}`,
    element.text ? `text: ${element.text}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * The script injected into a mock.
 *
 * Written without template literals on purpose: it is embedded in one, and a stray `${` here would
 * interpolate the app's own scope into a document that is not trusted.
 */
export const PICKER_SCRIPT = [
  "(function () {",
  "  if (window.__orbitalPicker) return;",
  "  window.__orbitalPicker = true;",
  "  var mode = null;",
  "  var OUTLINE = 'data-orbital-outline';",
  "  var outline = document.createElement('div');",
  "  outline.setAttribute(OUTLINE, '1');",
  "  outline.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;"
  + "border:1px solid #4c9aff;background:rgba(76,154,255,.16)';",
  "  var label = document.createElement('div');",
  "  label.setAttribute('data-orbital-label', '1');",
  "  label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;"
  + "font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1114;color:#e9edf1;"
  + "border:1px solid #4c9aff;padding:1px 4px;max-width:70vw;overflow:hidden;text-overflow:ellipsis;"
  + "white-space:nowrap';",
  "  function send(kind, payload) { parent.postMessage({ source: 'orbital-mock', kind: kind, payload: payload }, '*'); }",
  "  function ours(el) { return el && el.nodeType === 1 && (el.hasAttribute(OUTLINE) || el.hasAttribute('data-orbital-label')); }",
  "  function selectorFor(el) {",
  "    if (!el || el.nodeType !== 1) return '';",
  "    if (el.id) return '#' + el.id;",
  "    var parts = [];",
  "    var node = el;",
  "    while (node && node.nodeType === 1 && parts.length < 4) {",
  "      var part = node.tagName.toLowerCase();",
  "      if (node.classList && node.classList.length > 0) {",
  "        part += '.' + Array.prototype.slice.call(node.classList, 0, 2).join('.');",
  "      }",
  "      var parentEl = node.parentElement;",
  "      if (parentEl) {",
  "        var siblings = Array.prototype.filter.call(parentEl.children, function (child) {",
  "          return child.tagName === node.tagName;",
  "        });",
  "        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';",
  "      }",
  "      parts.unshift(part);",
  "      node = parentEl;",
  "    }",
  "    return parts.join(' > ');",
  "  }",
  // Rendered text, not textContent: the mock carries its own <script> and <style> blocks, and
  // one of them is this picker, so textContent would paste the picker's source into the note.
  "  function visibleText(el) {",
  "    var text = typeof el.innerText === 'string' ? el.innerText : '';",
  "    if (!text) {",
  "      var clone = el.cloneNode(true);",
  "      Array.prototype.forEach.call(clone.querySelectorAll('script,style,template'), function (node) {",
  "        node.parentNode.removeChild(node);",
  "      });",
  "      text = clone.textContent || '';",
  "    }",
  "    return text.replace(/\\s+/g, ' ').trim().slice(0, 200);",
  "  }",
  "  function describe(el) {",
  "    var rect = el.getBoundingClientRect();",
  "    return {",
  "      selector: selectorFor(el),",
  "      tag: el.tagName.toLowerCase(),",
  "      id: el.id || null,",
  "      classes: el.classList ? Array.prototype.slice.call(el.classList, 0, 12) : [],",
  "      text: visibleText(el),",
  "      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },",
  "    };",
  "  }",
  "  function place(box, rect, above) {",
  "    box.style.left = rect.left + 'px';",
  "    box.style.top = (above ? rect.top - 20 : rect.top) + 'px';",
  "    if (!above) { box.style.height = rect.height + 'px'; box.style.width = rect.width + 'px'; }",
  "    box.style.display = 'block';",
  "  }",
  "  function clear() { outline.style.display = 'none'; label.style.display = 'none'; }",
  "  function setMode(next) {",
  "    mode = next === 'comment' || next === 'grab' ? next : null;",
  "    if (!mode) { clear(); document.body.style.cursor = ''; return; }",
  "    if (!outline.parentNode) document.documentElement.appendChild(outline);",
  "    if (!label.parentNode) document.documentElement.appendChild(label);",
  "    document.body.style.cursor = 'crosshair';",
  "  }",
  "  document.addEventListener('mousemove', function (event) {",
  "    if (!mode) return;",
  "    var el = event.target;",
  "    if (!el || el.nodeType !== 1 || ours(el)) return;",
  "    var rect = el.getBoundingClientRect();",
  "    place(outline, rect, false);",
  "    place(label, rect, true);",
  "    label.textContent = selectorFor(el) + '  ' + Math.round(rect.width) + 'x' + Math.round(rect.height);",
  "  }, true);",
  "  document.addEventListener('click', function (event) {",
  "    if (!mode) return;",
  "    event.preventDefault();",
  "    event.stopPropagation();",
  "    var el = event.target;",
  "    if (ours(el)) return;",
  "    send('pick', { mode: mode, element: describe(el) });",
  "    setMode(null);",
  "  }, true);",
  "  document.addEventListener('keydown', function (event) {",
  "    if (!mode || event.key !== 'Escape') return;",
  "    setMode(null);",
  "    send('cancelled', {});",
  "  }, true);",
  "  window.addEventListener('message', function (event) {",
  "    var data = event.data;",
  "    if (!data || data.source !== 'orbital-parent') return;",
  "    setMode(data.mode || null);",
  "  });",
  "})();",
].join("\n");

/** Put the picker inside a mock, last so it listens to everything the mock itself registered. */
export function instrumentMock(html: string): string {
  const tag = `<script data-orbital-picker="1">${PICKER_SCRIPT}</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : html + tag;
}
