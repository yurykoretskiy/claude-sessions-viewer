// Shared inline SVG icons for the extension's webviews. The tree title bar
// uses the built-in $(search) codicon; webviews cannot reference the codicon
// font, so they embed this equivalent magnifier and inherit currentColor.

const SEARCH_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<circle cx="6.5" cy="6.5" r="4.75"/><path d="M10.3 10.3 14.5 14.5" stroke-linecap="round"/></svg>';

// "Layers" — represents the model strip (which model handled which layer
// of the conversation): a diamond over two chevrons, the standard icon
// for stacked/versioned content.
const MODEL_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M8 2 13.5 5 8 8 2.5 5Z"/><path d="M2.5 8 8 11 13.5 8" stroke-linecap="round"/>' +
  '<path d="M2.5 11 8 14 13.5 11" stroke-linecap="round"/></svg>';

module.exports = { SEARCH_SVG, MODEL_SVG };
