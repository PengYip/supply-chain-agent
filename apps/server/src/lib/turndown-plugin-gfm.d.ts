// Ambient types for turndown-plugin-gfm (untyped UMD/CJS package; no
// @types package exists on npm). Only the members we consume are declared.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export type TurndownPluginFn = (service: TurndownService) => void;

  export const tables: TurndownPluginFn;
  export const strikethrough: TurndownPluginFn;
  export const taskListItems: TurndownPluginFn;
  export const highlightedCodeBlock: TurndownPluginFn;
  /** All-of-the-above combo plugin. */
  export const gfm: TurndownPluginFn;
}
