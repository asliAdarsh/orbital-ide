import { Component, type ErrorInfo, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Orbital render error:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-lg">
          <AlertTitle>{this.props.fallbackTitle ?? "This view failed to render"}</AlertTitle>
          <AlertDescription>
            <p className="break-words font-mono">{error.message || error.name}</p>
            <Button className="mt-2" size="xs" variant="outline" onClick={this.handleReset}>
              Reset view
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}

export default ErrorBoundary;
