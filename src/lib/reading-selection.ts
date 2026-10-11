/** Visible text shared by the reader's DOM selection and server-side anchors. */
export function visibleMarkdownText(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[^\n]*\n([\s\S]*?)\n```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\$\$?([\s\S]*?)\$\$?/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\*\*|__|~~|(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
