// Shared inline SVG icons for the extension's webviews. The tree title bar
// uses the built-in $(search) codicon; webviews cannot reference the codicon
// font, so they embed this equivalent magnifier and inherit currentColor.

const SEARCH_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<circle cx="6.5" cy="6.5" r="4.75"/><path d="M10.3 10.3 14.5 14.5" stroke-linecap="round"/></svg>';

module.exports = { SEARCH_SVG };
