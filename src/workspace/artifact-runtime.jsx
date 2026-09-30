// Mounts an artifact's default export into the sandboxed page, with an error
// boundary that reports failures to the Artifacts space (which can pass them
// to the agent).
import { Component, StrictMode } from "react";
import { createRoot } from "react-dom/client";

const report = (kind, error) => {
  const message = error?.stack || error?.message || String(error);
  parent.postMessage({ source: "mw-artifact", type: "error", kind, message }, "*");
};

class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { report("render", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ font: "14px/1.5 system-ui, sans-serif", padding: 24, color: "#b42318" }}>
        <strong>This artifact crashed.</strong>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#5b6272" }}>{String(this.state.error?.stack || this.state.error)}</pre>
      </div>
    );
  }
}

addEventListener("error", (event) => report("runtime", event.error ?? event.message));
addEventListener("unhandledrejection", (event) => report("promise", event.reason));

export function mount(App) {
  const root = createRoot(document.getElementById("root"));
  root.render(<StrictMode><Boundary><App /></Boundary></StrictMode>);
  parent.postMessage({ source: "mw-artifact", type: "ready" }, "*");
}
