// The DOM bundle portals its overlays to <body> (the engine scales its pages with
// a transform, and a transformed ancestor captures `position: fixed`). react-dom
// is installed — Expo's DOM components run on it — but its types are not, and
// adding @types/react-dom for one function would be a package.json change. This
// declares exactly the one function the overlays use, with React's own types.
declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react";
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal;
}
