import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { colors } from "../theme";

/** A bad adapter update must not unmount the terminal or close the app. */
export class AgentErrorBoundary extends Component<{
  children: ReactNode;
  resetKey: string;
  visible?: boolean;
  onDismiss?: () => void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("Agent view failed", error.message, info.componentStack);
  }
  componentDidUpdate(previous: Readonly<AgentErrorBoundary["props"]>) {
    if (this.state.failed && this.props.visible !== false && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.visible === false) return null;
    return <View style={{ padding: 16, gap: 12, backgroundColor: colors.surface }}>
      <Text style={{ color: colors.foreground }}>This agent update could not be displayed. Your terminal is still connected.</Text>
      <Pressable accessibilityRole="button" onPress={this.props.onDismiss ?? (() => this.setState({ failed: false }))}>
        <Text style={{ color: colors.primary }}>{this.props.onDismiss ? "Back to terminal" : "Retry question"}</Text>
      </Pressable>
    </View>;
  }
}
