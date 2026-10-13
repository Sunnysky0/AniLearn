import type { BookImportDraft, ReaderNode } from "@/lib/types";

// A published version is immutable. Cloning changes reader identity while
// preserving source hrefs, stable asset/note keys and the original draft.
export function remapBookImportDraft(draft: BookImportDraft, versionId: number): BookImportDraft {
  const metadata = { ...draft.metadata } as BookImportDraft["metadata"] & { requestId?: string; inputHash?: string };
  // These identify the upload operation, not a later directory publication.
  delete metadata.requestId;
  delete metadata.inputHash;
  const id = (value: string) => value.replace(/^v\d+-/u, `v${versionId}-`);
  const ids = new Map([...draft.blocks.map(block => block.id), ...draft.chapters.map(chapter => chapter.id)].map(value => [value, id(value)]));
  const reference = (value: string) => {
    if (ids.has(value)) return ids.get(value)!;
    const separator = value.indexOf("#");
    if (separator < 0) return value;
    const unit = value.slice(0, separator);
    const block = value.slice(separator + 1);
    return `${ids.get(unit) ?? unit}#${ids.get(block) ?? block}`;
  };
  const nodes = (values: ReaderNode[]): ReaderNode[] => values.map(node => ({ ...node,
    ...(node.children ? { children: nodes(node.children) } : {}),
    ...(node.target ? { target: reference(node.target) } : {}),
    ...(node.href ? { href: reference(node.href) } : {}),
  }));
  return { ...draft, metadata,
    blocks: draft.blocks.map(block => ({ ...block, id: id(block.id), nodes: nodes(block.nodes),
      ...(block.items ? { items: block.items.map(nodes) } : {}),
      ...(block.rows ? { rows: block.rows.map(row => row.map(nodes)) } : {}),
    })),
    chapters: draft.chapters.map(chapter => ({ ...chapter, id: id(chapter.id), parentId: chapter.parentId ? id(chapter.parentId) : null, blockIds: chapter.blockIds.map(id) })),
    footnotes: Object.fromEntries(Object.entries(draft.footnotes).map(([key, note]) => [key, { ...note, nodes: nodes(note.nodes), ...(note.unitId ? { unitId: id(note.unitId) } : {}), ...(note.blockId ? { blockId: id(note.blockId) } : {}) }])),
  };
}
