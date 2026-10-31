// createPortal, typed locally. react-dom is in the DOM bundle already (it renders
// the engine), but the app ships no @types/react-dom — the native side never needs
// it — so `import … from "react-dom"` fails tsc. This is the one function the
// overlay layer uses from it.

import type { ReactNode, ReactPortal } from "react";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const ReactDOM = require("react-dom") as { createPortal(children: ReactNode, container: Element): ReactPortal };

export const createPortal = ReactDOM.createPortal;
