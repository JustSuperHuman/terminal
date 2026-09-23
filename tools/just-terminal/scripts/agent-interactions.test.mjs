import { mock, test, expect } from "bun:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { normalizeSessionPrompt } from "../src/lib/sessionPrompt.ts";
import { fetchInputContext } from "../src/lib/composerApi.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class Value { setValue() {} interpolate() { return 0; } }
mock.module("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View",
  Animated: { Value, View: "View", timing: () => ({ start() {}, stop() {} }) },
  Easing: { out: (v) => v, cubic: 0 }, StyleSheet: { create: (v) => v }, Platform: { OS: "ios", select: (v) => v.ios ?? v.default },
  useWindowDimensions: () => ({ width: 390, height: 844 }), Linking: { canOpenURL: async () => true, openURL: async () => {} },
}));
mock.module("expo-haptics", () => ({ notificationAsync: async () => {}, selectionAsync: async () => {}, NotificationFeedbackType: { Success: 1, Error: 2 } }));
mock.module("react-native-svg", () => Object.fromEntries(["default", "Svg", "SvgXml", "Path", "Circle", "Rect", "Line", "Polyline", "Polygon", "G", "Defs", "ClipPath", "Ellipse"].map((name) => [name, name === "default" ? "Svg" : name])));
const { AgentPromptCard } = await import("../src/components/AgentPromptCard.tsx");
const { AcpRequestCard } = await import("../src/components/AcpRequestCard.tsx");
const { AgentErrorBoundary } = await import("../src/components/AgentErrorBoundary.tsx");
const legacy = { id: "native-question", kind: "single-select", title: "Continue?", options: [
  { id: "option-1", label: "Yes", key: "1", index: 0, focused: true },
  { id: "option-2", label: "No", key: "2", index: 1, focused: false },
], submit: "enter", cancel: true };

test("legacy native question reproduces the reported render crash", async () => {
  const previous = console.error; console.error = () => {};
  try {
    let failure;
    try { await act(() => { create(createElement(AgentPromptCard, { prompt: legacy, onRespond: async () => {}, onError() {}, disabled: false, agentLabel: "Codex", agent: "codex" })); }); }
    catch (error) { failure = error; }
    expect(failure?.message).toContain("details.length");
  }
  finally { console.error = previous; }
});

test("REST normalizes legacy questions, renders, and sends the original option identity", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ sessionId: "native", agent: "codex", prompt: legacy }));
  let renderer;
  try {
    const context = await fetchInputContext({ httpBase: "http://test", id: "test" }, "native");
    expect(context.prompt.details).toEqual([]);
    expect(context.prompt.cancelLabel).toBe("Cancel");
    const responses = [];
    await act(() => { renderer = create(createElement(AgentPromptCard, { prompt: context.prompt, agent: "codex", agentLabel: "Codex", disabled: false, onRespond: async (response) => responses.push(response), onError: (e) => { throw e; } })); });
    await act(async () => renderer.root.findAllByType("Pressable").find((node) => node.props.accessibilityLabel === "Yes").props.onPress());
    expect(responses).toEqual([{ action: "select", optionId: "option-1" }]);
  } finally { globalThis.fetch = original; if (renderer) await act(() => renderer.unmount()); }
});

test("empty or malformed prompts are ignored; valid multi-select and free text survive", () => {
  for (const value of [null, {}, { ...legacy, options: null }, { ...legacy, options: [null, { label: {} }] }]) expect(normalizeSessionPrompt(value)).toBeUndefined();
  const multi = normalizeSessionPrompt({ ...legacy, kind: "multi-select", interaction: "numeric-input", canSubmit: true, details: ["Pick", null], progress: { current: 1, total: 0 } });
  expect(multi.details).toEqual(["Pick"]); expect(multi.interaction).toBe("numeric-input"); expect(multi.canSubmit).toBe(true); expect(multi.progress).toBeUndefined();
  expect(normalizeSessionPrompt({ ...legacy, kind: "freeform", options: [], textInput: { kind: "answer", placeholder: "Explain", optional: false } }).textInput.placeholder).toBe("Explain");
});

test("ACP permission and elicitation cards render and submit", async () => {
  const responses = [];
  for (const request of [
    { id: "permission", agent: "claude", kind: "permission", title: "Read source?", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] },
    { id: "form", agent: "codex", kind: "elicitation_form", title: "Choose environment", requestedSchema: { type: "object", properties: { environment: { type: "string", enum: ["local", "test"], default: "local" } }, required: ["environment"] } },
    { id: "url", agent: "claude", kind: "elicitation_url", title: "Sign in", url: "https://example.com/auth" },
  ]) {
    let renderer;
    await act(() => { renderer = create(createElement(AcpRequestCard, { request, onRespond: async (...args) => responses.push(args), onError: (e) => { throw e; } })); });
    const buttons = renderer.root.findAllByType("Pressable");
    if (request.kind === "permission") await act(async () => buttons.find((node) => node.props.accessibilityLabel?.includes("Allow once")).props.onPress());
    if (request.kind === "elicitation_form") await act(async () => buttons.find((node) => node.props.accessibilityLabel === "Submit response").props.onPress());
    expect(renderer.toJSON()).toBeTruthy();
    await act(() => renderer.unmount());
  }
  expect(responses[0][0]).toBe("permission"); expect(responses[0][1].optionId).toBe("allow");
  expect(responses[1]).toEqual(["form", { action: "accept", content: { environment: "local" } }]);
});

test("an agent render failure stays inside its boundary and can return to the terminal", async () => {
  function Broken() { throw new Error("bad adapter payload"); }
  const error = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {};
  let renderer;
  try {
    await act(() => { renderer = create(createElement(AgentErrorBoundary, { resetKey: "open", visible: true }, createElement(Broken))); });
    expect(JSON.stringify(renderer.toJSON())).toContain("terminal is still connected");
    await act(() => renderer.update(createElement(AgentErrorBoundary, { resetKey: "closed", visible: false }, createElement(Broken))));
    expect(renderer.toJSON()).toBeNull();
    await act(() => renderer.update(createElement(AgentErrorBoundary, { resetKey: "reopened", visible: true }, createElement("Text", {}, "Ready"))));
    expect(JSON.stringify(renderer.toJSON())).toContain("Ready");
  } finally { console.error = error; console.warn = warn; if (renderer) await act(() => renderer.unmount()); }
});
